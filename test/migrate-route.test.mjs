// 迁移路由的集成测试：真加载 lib/index.js，用假 ctx 驱动真实的 handler。
//
// 全部在临时目录里跑：临时 home、临时 sessions 根、临时工作区目录。
// 不碰用户的 .dsh，也不碰任何真实会话。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { readLogCwd, sessionDirPath } from '../lib/migrate.js'

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sm-migrate-route-'))
const dshHome = path.join(sandbox, 'home')
const sessionsRoot = path.join(dshHome, 'sessions')
const alphaDir = path.join(sandbox, 'alpha')
const betaDir = path.join(sandbox, 'beta')
for (const dir of [dshHome, sessionsRoot, alphaDir, betaDir]) mkdirSync(dir, { recursive: true })

const sessionId = 'session-route-0001'
const alphaWorkspace = {
  id: 'ws-alpha',
  title: 'Alpha',
  path: alphaDir,
  sessionIds: [sessionId],
  attachSession: async () => {},
  detachSession: async () => {},
}
const betaWorkspace = {
  id: 'ws-beta',
  title: 'Beta',
  path: betaDir,
  sessionIds: [],
  attachSession: async () => {},
  detachSession: async () => {},
}
const workspaces = [alphaWorkspace, betaWorkspace]

// 造一个真的会话目录：多帧 zstd 日志 + 一个伴随文件
const alphaSessionDir = sessionDirPath(sessionsRoot, alphaDir, sessionId)
mkdirSync(alphaSessionDir, { recursive: true })
const headerLine = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: alphaDir, isSeeded: false })
const frames = [
  zlib.zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8')),
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } })}\n`, 'utf8')),
]
const logFile = path.join(alphaSessionDir, 'session.v4.jsonl.zstd')
writeFileSync(logFile, Buffer.concat(frames))
writeFileSync(path.join(alphaSessionDir, 'note.txt'), 'companion')

// ---------------------------------------------------------------- 假 ctx
const routes = new Map()
const header = { version: 4, id: sessionId, createdAt: 1, cwd: alphaDir, isSeeded: false }

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on: () => () => {},
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    if (name === 'sessionPersistence') {
      return {
        stat: async (id) => (id === sessionId && existsSync(logFile) ? { header, location: { kind: 'file', path: logFile } } : undefined),
      }
    }
    if (name === 'sessionQuery') return { listSessions: async () => [] }
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'agents') return { get: () => undefined }
    return undefined
  },
}

const request = (body) => ({
  headers: { host: '127.0.0.1:1234' },
  socket: { remoteAddress: '127.0.0.1' },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
  },
})

const respond = () => ({
  headersSent: false,
  status: undefined,
  payload: undefined,
  writeHead(status) {
    this.status = status
    this.headersSent = true
  },
  end(text) {
    this.payload = text === undefined ? undefined : JSON.parse(text)
  },
})

async function call(route, body) {
  const handler = routes.get(`/api/dsh-session-manager/${route}`)
  assert.ok(handler !== undefined, `route ${route} is not registered`)
  const response = respond()
  await handler(request(body), response)
  return response.payload
}

// ---------------------------------------------------------------- 开跑
const { apply } = await import('../lib/index.js')
apply(ctx, { home: dshHome })

check('migrate route registered', routes.has('/api/dsh-session-manager/migrate'))
check('lock route still registered', routes.has('/api/dsh-session-manager/lock'))
check('delete route still registered', routes.has('/api/dsh-session-manager/delete'))

// 1. 预览：只算路径，不动磁盘
{
  const result = await call('migrate', { sessionId, workspaceId: 'ws-beta', mode: 'preview' })
  check('preview ok', result.ok === true, result)
  check('preview reports source workspace', result.plan.fromWorkspaceTitle === 'Alpha', result.plan?.fromWorkspaceTitle)
  check('preview reports target workspace', result.plan.toWorkspaceTitle === 'Beta', result.plan?.toWorkspaceTitle)
  check('preview computes target dir', result.plan.toDir === sessionDirPath(sessionsRoot, betaDir, sessionId), result.plan?.toDir)
  check('preview wrote nothing', existsSync(alphaSessionDir) && !existsSync(result.plan.toDir))
}

// 2. 同一工作区：拒绝
{
  const result = await call('migrate', { sessionId, workspaceId: 'ws-alpha' })
  check('refuses same workspace', result.ok === false && result.code === 'alreadyThere', result)
}

// 3. 不存在的工作区：拒绝
{
  const result = await call('migrate', { sessionId, workspaceId: 'ws-nope' })
  check('refuses unknown workspace', result.ok === false && result.code === 'noWorkspace', result)
}

// 4. 锁定：拒绝（写一把锁进状态文件）
{
  const locked = await call('lock', { sessionId, locked: true })
  check('lock succeeded', locked.ok === true, locked.code)
  const result = await call('migrate', { sessionId, workspaceId: 'ws-beta' })
  check('refuses locked session', result.ok === false && result.code === 'locked', result)
  check('locked session left its files alone', existsSync(alphaSessionDir))
  await call('lock', { sessionId, locked: false })
}

// 5. 真迁移
{
  const result = await call('migrate', { sessionId, workspaceId: 'ws-beta', mode: 'full' })
  check('full migration ok', result.ok === true, result)
  check('full migration reports restartRequired', result.restartRequired === true, result.restartRequired)
  check('old directory removed', !existsSync(alphaSessionDir))
  const target = sessionDirPath(sessionsRoot, betaDir, sessionId)
  check('new directory exists', existsSync(target), target)
  check('companion file moved', existsSync(path.join(target, 'note.txt')))
  const movedBytes = await readFile(path.join(target, 'session.v4.jsonl.zstd'))
  check('header cwd rewritten', readLogCwd(movedBytes) === betaDir, readLogCwd(movedBytes))
  check('second frame preserved', (() => {
    // 第 2 帧必须逐字节相同
    const magic = (buf) => {
      let seen = 0
      for (let i = 0; i + 4 <= buf.length; i += 1) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
          seen += 1
          if (seen === 2) return i
        }
      }
      return -1
    }
    return frames[1].equals(movedBytes.subarray(magic(movedBytes)))
  })())
}

// 6. 迁移后状态文件里不该留下 pending（假 attach 不会抛，所以登记算成功）
{
  const { readState } = await import('../lib/state.js')
  const state = readState(dshHome)
  check('no pending left behind', state.pending.length === 0, state.pending)
}

rmSync(sandbox, { recursive: true, force: true })

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}