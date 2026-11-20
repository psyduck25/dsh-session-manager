// 「新建工作区会不会让插件失效」的验证。
//
// 关键问题：分组逻辑是不是把工作区列表写死了？
// 答案：不是。宿主每次请求都重新读 registry.list()，前端按 workspaceId 动态分组，
// 标题和路径也都从工作区对象里取，没有任何硬编码的名字或数量。
//
// 这里用一个伪造的 registry 模拟「运行中新增一个工作区」，
// 断言新工作区自动出现在快照里、它的会话被正确归组。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sm-ws-'))
const dshHome = path.join(sandbox, 'home')
for (const dir of ['alpha', 'beta', 'gamma']) mkdirSync(path.join(sandbox, dir), { recursive: true })

// 可变的 registry：测试中途往里面加工作区，模拟用户在 DSH 里新建了一个。
const workspaces = []
function addWorkspace(id, title, dir) {
  workspaces.push({
    id,
    title,
    path: path.join(sandbox, dir),
    sessionIds: [],
    attachSession: async () => {},
    detachSession: async () => {},
  })
}
addWorkspace('ws-alpha', 'Alpha', 'alpha')
addWorkspace('ws-beta', 'Beta', 'beta')

// 会话头也做成可变的，方便中途加会话
const headers = new Map()

const routes = new Map()
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
        stat: async (id) => (headers.has(id) ? { header: headers.get(id) } : undefined),
        list: async () => [...headers.values()].map((header) => ({ header })),
      }
    }
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'agents') return { get: () => undefined }
    if (name === 'sessionQuery') return { listSessions: async () => [] }
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
  assert.ok(handler !== undefined, `route ${route} missing`)
  const response = respond()
  await handler(request(body), response)
  return response.payload
}

const { apply } = await import('../lib/index.js')
apply(ctx, { home: dshHome })

// 1. 初始只有两个工作区
{
  const view = await call('state')
  check('starts with 2 workspaces', view.workspaces.length === 2, view.workspaces.map((w) => w.title))
  check('titles come from the registry', view.workspaces.map((w) => w.title).join(',') === 'Alpha,Beta')
}

// 2. 运行中新建一个工作区：不用重启、不用改插件
{
  addWorkspace('ws-gamma', 'Gamma', 'gamma')
  const view = await call('state')
  check('new workspace appears without a restart', view.workspaces.length === 3, view.workspaces.map((w) => w.title))
  check('the new one is there by name', view.workspaces.some((w) => w.title === 'Gamma'))
  check('workspaceId is stable and unique', new Set(view.workspaces.map((w) => w.workspaceId)).size === 3)
}

// 3. 新工作区里的会话能被正确归组
//    注意：归属来自 `workspace.sessionIds`，而真实 DSH 里那份清单由它自己的
//    登记表维护（attachSession 写入）。这里手动把会话挂进去，模拟那个结果。
{
  const cwd = path.join(sandbox, 'gamma')
  headers.set('session-g1', { version: 4, id: 'session-g1', createdAt: 1, cwd, isSeeded: false })
  const gamma = workspaces.find((w) => w.id === 'ws-gamma')
  gamma.sessionIds = ['session-g1']
  const view = await call('state')
  const found = view.workspaces.find((w) => w.title === 'Gamma')
  check('gamma workspace found by id', found !== undefined)
  const owners = view.sessions.filter((s) => s.workspaceId === found.workspaceId)
  check('session lands in the new workspace', owners.length === 1, owners.length)
  check('session keeps its own id', owners[0]?.sessionId === 'session-g1', owners[0]?.sessionId)
}

// 4. 再建一个，仍然跟着走（没有「最多几个」的隐藏上限）
{
  mkdirSync(path.join(sandbox, 'delta'), { recursive: true })
  addWorkspace('ws-delta', 'Delta', 'delta')
  const view = await call('state')
  check('a fourth workspace also appears', view.workspaces.length === 4, view.workspaces.length)
  check('no hardcoded workspace cap', view.workspaces.map((w) => w.title).join(',') === 'Alpha,Beta,Gamma,Delta')
}

// 5. 工作区被删除后不再出现
{
  workspaces.splice(workspaces.findIndex((w) => w.id === 'ws-delta'), 1)
  const view = await call('state')
  check('deleted workspace disappears', view.workspaces.length === 3, view.workspaces.length)
  check('the remaining ones are intact', view.workspaces.map((w) => w.title).join(',') === 'Alpha,Beta,Gamma')
}

// 6. 标题可以随便改：分组跟着 id 走，不跟标题走
{
  workspaces[0].title = '改了个名字'
  const view = await call('state')
  check('renaming does not break grouping', view.workspaces[0].title === '改了个名字', view.workspaces[0].title)
  check('still three workspaces', view.workspaces.length === 3, view.workspaces.length)
}

rmSync(sandbox, { recursive: true, force: true })

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}