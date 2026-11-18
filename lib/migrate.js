// 把一个会话从它所在的工作区迁移到另一个工作区。
//
// 为什么这件事不只是「改一下登记」：DSH 的工作区归属**完全由会话头里的 cwd 决定**。
// `@deepseek-ai/dsh-workspace` 的 `sessionIds` 是个过滤器：
//
//     get sessionIds() {
//       return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path))
//     }
//
// `candidateMatches` 只认「会话头 cwd 的 realpath == 工作区 path」，而 `attachSession`
// 在写入前就显式校验并在不匹配时抛错。所以想让一个会话真的出现在另一个工作区里，
// 必须改会话头的 cwd —— 没有第二条路。
//
// 而会话头的 cwd 不是随便放的字段，它决定了日志文件在磁盘上的位置：
//
//     $DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
//
// 于是「真迁移」必然包含两件磁盘操作：改头 + 移目录。这个文件负责这两件事，
// 并且保证中间任何一步失败都不会让原会话变得更糟：先复制、复制品验证通过之后才删原件。
//
// 日志是**多帧 zstd**，每帧独立压缩（DSH 的读路径按魔数切帧、逐帧解压）。
// 会话头在第 1 帧里，所以只需解压第 1 帧、改掉 cwd、重新压回去，后面的帧原样保留 ——
// 文件其余部分一个字节都不动，比整份重压安全得多。

import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

/** zstd 帧魔数。DSH 的读路径也是靠它切帧的。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志的代数与压缩后缀，对应 DSH 当前的存储格式。 */
const LOG_FILENAME = 'session.v4.jsonl.zstd'

/**
 * 把路径编码成 `--xxx--` 形式的项目目录名。
 *
 * 逐字复刻自 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey`：
 * 分隔符（`/` `\` `:`）连成单个 `-`，不安全字符写成 `~XXXX`，首尾包 `--`，
 * 超过 251 字符截断。**必须完全一致**，否则算出来的目录和 DSH 用的不是同一个。
 * @param {string} cwd - 会话的工作目录。
 * @returns {string} 项目目录名。
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 把任意字符串编码成一个安全的路径段。
 * @param {string} raw - 原始字符串（这里是会话 id）。
 * @returns {string} 编码后的路径段。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 一个会话日志在磁盘上的位置。
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`。
 * @param {string} cwd - 会话的 cwd。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 日志文件的绝对路径。
 */
export function sessionLogPath(sessionsRoot, cwd, sessionId) {
  return path.join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId), LOG_FILENAME)
}

/**
 * 一个会话在磁盘上的目录。
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`。
 * @param {string} cwd - 会话的 cwd。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 目录的绝对路径。
 */
export function sessionDirPath(sessionsRoot, cwd, sessionId) {
  return path.join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId))
}

/**
 * 在缓冲区里找出所有 zstd 帧的起点。
 * @param {Buffer} bytes - 整个文件的内容。
 * @returns {number[]} 每帧起始偏移（升序）。
 */
function frameStarts(bytes) {
  const starts = []
  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    if (
      bytes[index] === ZSTD_MAGIC[0] &&
      bytes[index + 1] === ZSTD_MAGIC[1] &&
      bytes[index + 2] === ZSTD_MAGIC[2] &&
      bytes[index + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(index)
    }
  }
  return starts
}

/** 解压一帧；失败就抛，交给调用方决定怎么报告。 */
function decompressFrame(frame) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw Object.assign(new Error('this Node build has no zstd support'), { code: 'noZstd' })
  }
  return zlib.zstdDecompressSync(frame)
}

/** 压缩一帧。 */
function compressFrame(text) {
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw Object.assign(new Error('this Node build has no zstd support'), { code: 'noZstd' })
  }
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

/**
 * 读一份日志里会话头记录的 cwd。
 *
 * 只解第 1 帧，找到 `"type":"session"` 那一行；找不到就往后面的帧找（正常情况下第一帧就够）。
 * @param {Buffer} bytes - 整个文件的内容。
 * @returns {string | undefined} cwd，或 undefined（头里没有 cwd）。
 */
export function readLogCwd(bytes) {
  const starts = frameStarts(bytes)
  if (starts.length === 0) throw Object.assign(new Error('session log holds no zstd frame'), { code: 'logUnreadable' })
  // 头一定在最前面：先看第 1 帧，退化时才继续往后翻。
  const limit = Math.min(starts.length, 4)
  for (let index = 0; index < limit; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : bytes.length
    let text
    try {
      text = decompressFrame(bytes.subarray(starts[index], end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"session"')) continue
      try {
        const record = JSON.parse(line)
        if (record !== null && typeof record === 'object' && record.type === 'session') {
          return typeof record.cwd === 'string' ? record.cwd : undefined
        }
      } catch {
        // 这一行坏了，往后找
      }
    }
  }
  return undefined
}

/**
 * 把日志里会话头的 cwd 换成新的，返回新的完整字节。
 *
 * 只重压第 1 帧，其余帧原样拼回去 —— 帧之间互不依赖，所以这是安全的。
 * 换值用**定点字符串替换**而不是 JSON 往返：往返会重排键序、改变字段写法，
 * 而这是别人正在用的日志，能不动的字节就不动。
 * @param {Buffer} bytes - 原文件内容。
 * @param {string} oldCwd - 原来的 cwd。
 * @param {string} nextCwd - 新的 cwd。
 * @returns {Buffer} 新的文件内容。
 */
export function rewriteLogCwd(bytes, oldCwd, nextCwd) {
  const starts = frameStarts(bytes)
  if (starts.length === 0) throw Object.assign(new Error('session log holds no zstd frame'), { code: 'logUnreadable' })
  const headEnd = starts.length > 1 ? starts[1] : bytes.length
  const headText = decompressFrame(bytes.subarray(0, headEnd)).toString('utf8')
  const lines = headText.split('\n')

  const oldJson = JSON.stringify(oldCwd)
  const nextJson = JSON.stringify(nextCwd)
  let replaced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.includes('"type":"session"')) continue
    const needle = `"cwd":${oldJson}`
    const at = line.indexOf(needle)
    if (at < 0) continue
    lines[index] = `${line.slice(0, at)}"cwd":${nextJson}${line.slice(at + needle.length)}`
    replaced = true
    break
  }
  if (!replaced) {
    throw Object.assign(new Error(`session header carries no cwd "${oldCwd}" to rewrite`), { code: 'headerMismatch' })
  }

  const nextHead = compressFrame(lines.join('\n'))
  const tail = bytes.subarray(headEnd)
  return Buffer.concat([nextHead, tail])
}

/**
 * 目录里所有文件（含子目录），返回相对路径列表。
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 相对路径。
 */
async function listFiles(dir) {
  const found = []
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative)
      else found.push(relative)
    }
  }
  await walk(dir, '')
  return found
}

/** 这些 errno 说明是「权限不够」，值得让用户确认后再来一次。 */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY'])

/**
 * 判断一个错误是不是权限问题。
 * @param {unknown} error - 捕获到的错误。
 * @returns {boolean} 是权限问题就返回 true。
 */
export function isPermissionError(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return typeof code === 'string' && PERMISSION_CODES.has(code)
}

/**
 * 真迁移：把会话的日志目录整体搬到新 cwd 对应的项目目录，并改写会话头里的 cwd。
 *
 * 顺序是刻意的 —— **先复制、再验证、最后才删原件**：
 *   1. 复制整个会话目录到目标位置（原目录此刻完全没被动过）
 *   2. 只改目标副本里的头
 *   3. 把副本读回来确认 cwd 真的变了、帧也还完整
 *   4. 上面都成立才删旧目录
 * 任何一步抛错都清掉半成品，原会话保持原样。
 * @param {object} options - 迁移参数。
 * @param {string} options.sessionsRoot - `$DSH_HOME/sessions`。
 * @param {string} options.sessionId - 会话 id。
 * @param {string} options.fromCwd - 当前 cwd。
 * @param {string} options.toCwd - 目标 cwd。
 * @returns {Promise<{from: string, to: string, files: number, bytes: number}>} 迁移结果。
 */
export async function migrateOnDisk({ sessionsRoot, sessionId, fromCwd, toCwd }) {
  const fromDir = sessionDirPath(sessionsRoot, fromCwd, sessionId)
  const toDir = sessionDirPath(sessionsRoot, toCwd, sessionId)
  if (fromDir === toDir) return { from: fromDir, to: toDir, files: 0, bytes: 0 }
  if (!existsSync(fromDir)) {
    throw Object.assign(new Error(`session directory is missing: ${fromDir}`), { code: 'noDirectory' })
  }
  if (existsSync(toDir)) {
    throw Object.assign(new Error(`a session directory already exists at the destination: ${toDir}`), { code: 'targetExists' })
  }

  const files = await listFiles(fromDir)
  let bytes = 0
  let created = false
  try {
    mkdirSync(toDir, { recursive: true })
    created = true
    for (const relative of files) {
      const source = path.join(fromDir, relative)
      const destination = path.join(toDir, relative)
      const info = await stat(source)
      bytes += info.size
      mkdirSync(path.dirname(destination), { recursive: true })
      if (relative === LOG_FILENAME) {
        // 日志要改头，不能直连复制。
        const original = await readFile(source)
        const next = rewriteLogCwd(original, fromCwd, toCwd)
        await writeFile(destination, next)
      } else {
        await copyFile(source, destination)
      }
    }

    // 验证副本：cwd 必须是新值，帧数必须和原件一致。
    const copiedLog = await readFile(path.join(toDir, LOG_FILENAME))
    const copiedCwd = readLogCwd(copiedLog)
    if (copiedCwd !== toCwd) {
      throw Object.assign(new Error(`rewritten session header still reports cwd "${copiedCwd}"`), { code: 'verifyFailed' })
    }
    const originalFrames = frameStarts(await readFile(path.join(fromDir, LOG_FILENAME))).length
    const copiedFrames = frameStarts(copiedLog).length
    if (copiedFrames !== originalFrames) {
      throw Object.assign(new Error(`frame count changed: ${originalFrames} -> ${copiedFrames}`), { code: 'verifyFailed' })
    }
  } catch (error) {
    if (created) {
      try {
        await rm(toDir, { recursive: true, force: true })
      } catch {
        // 清不掉半成品也只能留着，但至少要报出原始错误
      }
    }
    throw error
  }

  // 副本已经验证过了，这时删原件才是安全的。
  await rm(fromDir, { recursive: true, force: true })
  return { from: fromDir, to: toDir, files: files.length, bytes }
}