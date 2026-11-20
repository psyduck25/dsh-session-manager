// settings 路由的字段校验：新增的 showCount / maxAgeDays 必须和 bufferHours
// 用同一套严格规则，一个字段不合法就整次不写盘。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sm-settings-'))
const dshHome = path.join(sandbox, 'home')

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
  get() {
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
  return { status: response.status, body: response.payload }
}

const { apply } = await import('../lib/index.js')
apply(ctx, { home: dshHome })
const { readState } = await import('../lib/state.js')

check('settings route registered', routes.has('/api/dsh-session-manager/settings'))

// 1. 默认值
{
  const state = readState(dshHome)
  check('default showCount is 5', state.settings.showCount === 5, state.settings.showCount)
  check('default maxAgeDays is 0', state.settings.maxAgeDays === 0, state.settings.maxAgeDays)
}

// 2. 只改 showCount，bufferHours 不受影响
{
  const result = await call('settings', { showCount: 3 })
  check('showCount accepted', result.status === 200, result.status)
  const state = readState(dshHome)
  check('showCount saved', state.settings.showCount === 3, state.settings.showCount)
  check('bufferHours untouched', state.settings.bufferHours === 24, state.settings.bufferHours)
}

// 3. 只改 maxAgeDays
{
  await call('settings', { maxAgeDays: 5 })
  const state = readState(dshHome)
  check('maxAgeDays saved', state.settings.maxAgeDays === 5, state.settings.maxAgeDays)
  check('showCount kept', state.settings.showCount === 3, state.settings.showCount)
}

// 4. 两个一起改
{
  await call('settings', { showCount: 8, maxAgeDays: 2 })
  const state = readState(dshHome)
  check('both saved at once', state.settings.showCount === 8 && state.settings.maxAgeDays === 2, state.settings)
}

// 5. 非法输入逐个拒绝，且不写盘
{
  for (const [label, payload, code] of [
    ['showCount null', { showCount: null }, 'badNumber'],
    ['showCount string', { showCount: '4' }, 'badNumber'],
    ['showCount negative', { showCount: -1 }, 'outOfRange'],
    ['showCount zero', { showCount: 0 }, 'outOfRange'],
    ['showCount too large', { showCount: 201 }, 'outOfRange'],
    ['maxAgeDays negative', { maxAgeDays: -1 }, 'outOfRange'],
    ['maxAgeDays too large', { maxAgeDays: 3651 }, 'outOfRange'],
    ['maxAgeDays string', { maxAgeDays: '5' }, 'badNumber'],
  ]) {
    const before = readState(dshHome)
    const result = await call('settings', payload)
    const after = readState(dshHome)
    check(
      `rejects ${label}`,
      result.status === 400 && result.body.code === code,
      { status: result.status, code: result.body.code },
    )
    check(
      `${label} leaves state untouched`,
      JSON.stringify(before.settings) === JSON.stringify(after.settings),
      after.settings,
    )
  }
}

// 6. 一个合法一个非法：整次不写
{
  const before = readState(dshHome)
  const result = await call('settings', { showCount: 10, maxAgeDays: -5 })
  const after = readState(dshHome)
  check('mixed valid/invalid is rejected', result.status === 400 && result.body.code === 'outOfRange', result.body)
  check('mixed request writes nothing', JSON.stringify(before.settings) === JSON.stringify(after.settings), after.settings)
}

// 7. reset 三个一起回默认
{
  await call('settings', { reset: true })
  const state = readState(dshHome)
  check(
    'reset restores all three',
    state.settings.bufferHours === 24 && state.settings.showCount === 5 && state.settings.maxAgeDays === 0,
    state.settings,
  )
}

// 8. 边界值可用
{
  await call('settings', { showCount: 1, maxAgeDays: 0 })
  let state = readState(dshHome)
  check('lower bounds accepted', state.settings.showCount === 1 && state.settings.maxAgeDays === 0, state.settings)

  await call('settings', { showCount: 200, maxAgeDays: 3650 })
  state = readState(dshHome)
  check('upper bounds accepted', state.settings.showCount === 200 && state.settings.maxAgeDays === 3650, state.settings)
}

// 9. 小数被四舍五入
{
  await call('settings', { showCount: 3.7, maxAgeDays: 2.2 })
  const state = readState(dshHome)
  check('showCount rounds', state.settings.showCount === 4, state.settings.showCount)
  check('maxAgeDays rounds', state.settings.maxAgeDays === 2, state.settings.maxAgeDays)
}

check('state file exists on disk', existsSync(path.join(dshHome, 'session-manager', 'state.json')))

rmSync(sandbox, { recursive: true, force: true })

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}