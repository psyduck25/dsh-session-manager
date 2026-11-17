/**
 * 删除缓冲站的磁盘部分。
 *
 * 为什么不是「归档」：归档只是把会话写进工作区注册表的归档集合，左侧列表是否
 * 显示它取决于用户的「显示归档会话」开关。开关一开，会话就变灰留在原地——那
 * 不是用户要的「看不见」。
 *
 * 这里改成真正的回收站：把会话日志文件从会话目录 **移走**，挪进
 * `$DSH_HOME/session-manager/trash/<会话>/`。文件不在会话目录里，DSH 的存储层
 * 列不出它、左侧列表也就没有这一行；回档时再原样移回去，连工作区位置都不用动，
 * 因为工作区登记里那个 id 一直没被删过。
 *
 * 目录布局：
 *   trash/<编码后的会话 id>/
 *     session.v4.jsonl.zstd        会话日志（原文件名，可能还有 .bak-*）
 *     meta.json                    { sessionId, originalDir, files }
 *
 * 只搬 `session.` 开头的文件；会话目录里别的东西一概不动。
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const META = 'meta.json'

export function trashRoot(home) {
  return path.join(home, 'session-manager', 'trash')
}

/**
 * 会话 id 进路径前编码。
 *
 * 转义非 `[0-9._-]` 的字符是为了杜绝 `../` 和分隔符；连字母一起转义，是因为
 * Windows 的文件系统大小写不敏感，`trash/AbC` 和 `trash/abc` 是同一个目录，
 * 两个 id 只差大小写就会共用一个回收站目录、互相覆盖 meta.json。全转义之后
 * 编码只依赖 id 的字节，注入和碰撞都无从下手。
 */
export function encodeSegment(raw) {
  if (raw === '.' || raw === '..') return raw.replace(/\./g, '~002E')
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (/^[0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out === '' ? '~002D' : out
}

/** 0.4.0 之前的编码：字母原样保留。只用来找回旧版本留下的目录。 */
function encodeSegmentLegacy(raw) {
  if (raw === '.' || raw === '..') return raw.replace(/\./g, '~002E')
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out === '' ? '~002D' : out
}

export function trashDir(home, sessionId) {
  return path.join(trashRoot(home), encodeSegment(sessionId))
}

/**
 * 找这个人真正在用的回收站目录。
 *
 * 编码规则变过，旧版本写下的条目还躺在旧名字下面。新名字存在就用新名字；
 * 否则旧名字存在就用旧名字——这样升级之后缓冲站里的老条目照样能回档。
 */
async function resolveTrashDir(home, sessionId) {
  const current = trashDir(home, sessionId)
  if (await exists(current)) return current
  const legacy = path.join(trashRoot(home), encodeSegmentLegacy(sessionId))
  if (legacy !== current && (await exists(legacy))) return legacy
  return current
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 跨盘符时 rename 会 EXDEV，退回复制再删。 */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await copyFile(from, to)
      await unlink(from)
      return
    }
    throw error
  }
}

async function moveAll(pairs) {
  const done = []
  for (const [from, to] of pairs) {
    try {
      await moveFile(from, to)
      done.push([from, to])
    } catch (error) {
      // 中途失败就回滚，不留半个状态。
      for (const [source, target] of done.reverse()) {
        try {
          await moveFile(target, source)
        } catch {
          // 回滚失败也没别的办法了，把原始错误抛出去让界面显示
        }
      }
      throw error
    }
  }
}

/**
 * 把一个会话的日志搬进回收站。
 * @param home    `$DSH_HOME`
 * @param sessionId 会话 id
 * @param sourceFile 会话日志的绝对路径（来自存储层的 `location.path`）
 */
export async function moveIntoTrash(home, sessionId, sourceFile) {
  const originalDir = path.dirname(sourceFile)
  let entries
  try {
    entries = await readdir(originalDir, { withFileTypes: true })
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { moved: false, code: 'missingLog' }
    return { moved: false, code: 'readdirFailed', detail: messageOf(error) }
  }

  const files = entries.filter((entry) => entry.isFile() && entry.name.startsWith('session.')).map((entry) => entry.name)
  if (files.length === 0) return { moved: false, code: 'missingLog' }

  const target = trashDir(home, sessionId)
  try {
    await mkdir(target, { recursive: true })
    await moveAll(files.map((name) => [path.join(originalDir, name), path.join(target, name)]))
    await writeFile(
      path.join(target, META),
      `${JSON.stringify({ sessionId, originalDir, files }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    return { moved: false, code: 'moveFailed', detail: messageOf(error) }
  }

  // 目录空了就顺手删掉；还留着别的文件就保留。
  try {
    await rmdir(originalDir)
  } catch {
    // ENOTEMPTY / ENOENT 都无所谓
  }
  return { moved: true, originalDir, files }
}

/** 读出回收站目录里的 meta；meta 丢了就用状态文件里记的那份。 */
async function readMeta(source, entry) {
  try {
    const raw = await readFile(path.join(source, META), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      originalDir: typeof parsed.originalDir === 'string' ? parsed.originalDir : entry.originalDir,
      files: Array.isArray(parsed.files) ? parsed.files.filter((name) => typeof name === 'string') : entry.files,
    }
  } catch {
    return { originalDir: entry.originalDir, files: entry.files }
  }
}

/** 把日志搬回原来的会话目录。 */
export async function restoreFromTrash(home, entry) {
  const source = await resolveTrashDir(home, entry.sessionId)
  const meta = await readMeta(source, entry)
  const originalDir = typeof meta.originalDir === 'string' ? meta.originalDir : ''
  const files = Array.isArray(meta.files) ? meta.files : []
  if (originalDir === '' || files.length === 0) return { restored: false, code: 'noMeta' }

  try {
    await mkdir(originalDir, { recursive: true })
    await moveAll(files.map((name) => [path.join(source, name), path.join(originalDir, name)]))
  } catch (error) {
    return { restored: false, code: 'restoreFailed', detail: messageOf(error) }
  }
  try {
    await rm(source, { recursive: true, force: true })
  } catch {
    // 搬都搬回去了，残留目录不影响使用
  }
  return { restored: true }
}

/** 真正删掉：回收站目录整个移除。新旧两种编码都清一次。 */
export async function purgeTrash(home, sessionId) {
  try {
    const source = await resolveTrashDir(home, sessionId)
    await rm(source, { recursive: true, force: true })
    const legacy = path.join(trashRoot(home), encodeSegmentLegacy(sessionId))
    if (legacy !== source) await rm(legacy, { recursive: true, force: true })
    return { purged: true }
  } catch (error) {
    return { purged: false, code: 'purgeFailed', detail: messageOf(error) }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
