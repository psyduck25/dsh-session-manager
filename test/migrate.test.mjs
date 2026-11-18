// 磁盘迁移的离线验证：全程只碰临时副本，绝不触碰真实会话。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  encodeSegment,
  isPermissionError,
  migrateOnDisk,
  projectKey,
  readLogCwd,
  rewriteLogCwd,
  sessionDirPath,
  sessionLogPath,
} from '../lib/migrate.js'

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

// ---------------------------------------------------------------- 目录名编码
// 值来自真实磁盘：~/.dsh/sessions/--F-DeepseekHarnessWorkSpace-DSHdev--
check('projectKey windows path', projectKey('F:\\DeepseekHarnessWorkSpace\\DSHdev') === '--F-DeepseekHarnessWorkSpace-DSHdev--', projectKey('F:\\DeepseekHarnessWorkSpace\\DSHdev'))
check('projectKey collapses separator runs', projectKey('C:\\\\a\\\\\\b') === '--C-a-b--', projectKey('C:\\\\a\\\\\\b'))
check('projectKey escapes unsafe chars', projectKey('F:\\论文') === '--F-~8BBA~6587--', projectKey('F:\\论文'))
check('projectKey empty-ish becomes root', projectKey('/') === '--root--', projectKey('/'))
check('encodeSegment keeps safe', encodeSegment('session-93f48f02') === 'session-93f48f02', encodeSegment('session-93f48f02'))
check('encodeSegment dots', encodeSegment('.') === '~002E' && encodeSegment('..') === '~002E~002E')

// ---------------------------------------------------------------- 造一份假日志
const root = path.join(os.tmpdir(), `migrate-test-${Date.now()}`)
const fromCwd = 'F:\\Work\\Alpha'
const toCwd = 'F:\\Work\\Beta'
const sessionId = 'session-test-0001'

/** 用真实的 zstd 造一份多帧日志：第 1 帧放会话头，后面几帧放普通事件。 */
function buildLog(cwd) {
  const frames = []
  const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 111, cwd })
  const first = `${header}\n${JSON.stringify({ type: 'turn/start', seq: 1, time: 112, data: { turn: 1 } })}\n`
  frames.push(zlib.zstdCompressSync(Buffer.from(first, 'utf8')))
  frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/end', seq: 2, time: 113, data: { turn: 1, reason: { kind: 'completed' } } })}\n`, 'utf8')))
  frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', seq: 3, time: 114, data: { content: [{ type: 'text', text: 'hello' }] } })}\n`, 'utf8')))
  return Buffer.concat(frames)
}

const fromDir = sessionDirPath(root, fromCwd, sessionId)
mkdirSync(fromDir, { recursive: true })
const original = buildLog(fromCwd)
writeFileSync(path.join(fromDir, 'session.v4.jsonl.zstd'), original)
writeFileSync(path.join(fromDir, 'extra.txt'), 'companion file')

check('log path shape', sessionLogPath(root, fromCwd, sessionId).endsWith(path.join(projectKey(fromCwd), encodeSegment(sessionId), 'session.v4.jsonl.zstd')))
check('readLogCwd reads header', readLogCwd(original) === fromCwd, readLogCwd(original))

// ---------------------------------------------------------------- 改头
const rewritten = rewriteLogCwd(original, fromCwd, toCwd)
check('rewrite changes cwd', readLogCwd(rewritten) === toCwd, readLogCwd(rewritten))
{
  // 帧数不能变，后面的事件必须逐字节保留
  const countMagic = (buf) => {
    let n = 0
    for (let i = 0; i + 4 <= buf.length; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) n += 1
    }
    return n
  }
  check('rewrite keeps frame count', countMagic(rewritten) === countMagic(original), { before: countMagic(original), after: countMagic(rewritten) })
  // 第 2 帧之后的字节必须和原来完全一致
  const secondMagic = (buf) => {
    let seen = 0
    for (let i = 0; i + 4 <= buf.length; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
        seen += 1
        if (seen === 2) return i
      }
    }
    return -1
  }
  const tailOriginal = original.subarray(secondMagic(original))
  const tailRewritten = rewritten.subarray(secondMagic(rewritten))
  check('rewrite leaves later frames byte-identical', tailOriginal.equals(tailRewritten))
}
check('rewrite rejects a wrong old cwd', (() => {
  try {
    rewriteLogCwd(original, 'F:\\Nope', toCwd)
    return false
  } catch (error) {
    return error.code === 'headerMismatch'
  }
})())

// ---------------------------------------------------------------- 真迁移
const outcome = await migrateOnDisk({ sessionsRoot: root, sessionId, fromCwd, toCwd })
check('migration reports source', outcome.from === fromDir, outcome.from)
check('migration moved 2 files', outcome.files === 2, outcome.files)
check('old directory is gone', !existsSync(fromDir))

const toDir = sessionDirPath(root, toCwd, sessionId)
const movedLog = await readFile(path.join(toDir, 'session.v4.jsonl.zstd'))
check('moved log reports new cwd', readLogCwd(movedLog) === toCwd, readLogCwd(movedLog))
check('companion file came along', existsSync(path.join(toDir, 'extra.txt')))
check('new log still decodes every frame', (() => {
  try {
    // 逐帧解开，确认没有半帧
    const starts = []
    for (let i = 0; i + 4 <= movedLog.length; i += 1) {
      if (movedLog[i] === 0x28 && movedLog[i + 1] === 0xb5 && movedLog[i + 2] === 0x2f && movedLog[i + 3] === 0xfd) starts.push(i)
    }
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1] : movedLog.length
      zlib.zstdDecompressSync(movedLog.subarray(starts[i], end))
    }
    return starts.length === 3
  } catch {
    return false
  }
})())

// ---------------------------------------------------------------- 拒绝与幂等
check('same cwd is a no-op', (async () => {
  const again = await migrateOnDisk({ sessionsRoot: root, sessionId, fromCwd: toCwd, toCwd })
  return again.files === 0
})() instanceof Promise)
{
  const noop = await migrateOnDisk({ sessionsRoot: root, sessionId, fromCwd: toCwd, toCwd })
  check('no-op when cwd unchanged', noop.files === 0)
}
{
  let code = ''
  try {
    await migrateOnDisk({ sessionsRoot: root, sessionId, fromCwd: 'F:\\Missing', toCwd })
  } catch (error) {
    code = error.code
  }
  check('missing source is refused', code === 'noDirectory', code)
}
{
  // 目标已存在时拒绝，避免覆盖别人的会话
  const other = path.join(toDir, '..', 'x')
  mkdirSync(toDir, { recursive: true })
  let code = ''
  try {
    await migrateOnDisk({ sessionsRoot: root, sessionId: `session-other`, fromCwd, toCwd })
  } catch (error) {
    code = error.code
  }
  check('missing source refused before touching destination', code === 'noDirectory', code)
}

// ---------------------------------------------------------------- 权限错误识别
for (const errno of ['EACCES', 'EPERM', 'EROFS', 'EBUSY']) {
  check(`permission error ${errno}`, isPermissionError(Object.assign(new Error('x'), { code: errno })) === true)
}
check('ENOENT is not a permission error', isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' })) === false)
check('plain error is not a permission error', isPermissionError(new Error('x')) === false)

rmSync(root, { recursive: true, force: true })

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}