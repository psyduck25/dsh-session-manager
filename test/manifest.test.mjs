// 清单一致性检查：包名、bundle 行、客户端注册 id 必须互相对得上。
//
// 这三处只要有一处不一致，插件就会**静悄悄地坏掉**：
//   - package.json name ≠ cordis.patch.yml 的 name  → Loader 解析不到包
//   - package.json name ≠ lib/client.js 的 id       → 浏览器半侧整个作废，
//                                                     设置页里那一项根本不出现，
//                                                     而且不报错、不崩溃
// 2026-11-18 因为包改名成 @psyduck25/dsh-session-manager，而 client.js 还留着
// 旧名 dsh-session-manager，正是这样把设置页丢掉的。
//
// 用法：node test/manifest.test.mjs
import { readFileSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const manifest = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const client = read('lib/client.js')

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (condition) console.log(`  ok    ${name}`)
  else console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 1. cordis.patch.yml 的 name 必须等于 package.json 的 name
const patchNames = [...patch.matchAll(/^\s*name:\s*'([^']+)'\s*$/gm)].map((m) => m[1])
check('patch declares exactly one row', patchNames.length === 1, patchNames)
check('patch name equals package name', patchNames[0] === manifest.name, {
  patch: patchNames[0],
  package: manifest.name,
})

// 2. 插件的行 id 是不变的标识，改了会和已装副本撞车
const patchIds = [...patch.matchAll(/^\s*(?:-\s*)?id:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1])
check('patch row id is stable', patchIds[0] === 'dsh-session-manager', patchIds)

// 3. lib/client.js 的 __ModuleLoader__.load({ id }) 必须等于 package.json 的 name
//    client-modules 用包名当 entry id，对不上浏览器半侧就不会注册。
const loadIds = [...client.matchAll(/__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/g)].map((m) => m[1])
check('client registers exactly one bundle', loadIds.length === 1, loadIds)
check('client id equals package name', loadIds[0] === manifest.name, {
  client: loadIds[0],
  package: manifest.name,
})

// 4. dsh.client 声明了就必须导出 "./client"，且文件真的存在
const exported = manifest.exports?.['./client']
const clientPath = typeof exported === 'string' ? exported : exported?.default
check('dsh.client declared', manifest.dsh?.client !== undefined)
check('exports "./client"', typeof clientPath === 'string', exported)
if (typeof clientPath === 'string') {
  let readable = false
  try {
    read(clientPath.replace(/^\.\//, ''))
    readable = true
  } catch {
    readable = false
  }
  check('exported client file exists', readable, clientPath)
}

// 5. exports 里每个具体路径都得真的存在（通配符跳过）
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  const path = typeof value === 'string' ? value : value?.default
  if (typeof path !== 'string' || key.includes('*')) continue
  let exists = false
  try {
    read(path.replace(/^\.\//, ''))
    exists = true
  } catch {
    exists = false
  }
  check(`exports "${key}" resolves`, exists, path)
}

// 6. files 列表里的每一项都得真的存在（发布了却缺文件是最难查的那种坏）。
//    目录项也算：`files: ["lib"]` 要求 lib/ 目录在，不要求它是文件。
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) continue
  let exists = false
  try {
    statSync(new URL(`../${entry}`, import.meta.url))
    exists = true
  } catch {
    exists = false
  }
  check(`files "${entry}" exists`, exists, entry)
}

// 7. engines.dsh 得在，不然装到不兼容的版本上没人拦
check('engines.dsh declared', typeof manifest.engines?.dsh === 'string', manifest.engines)

// 8. 每个行内确认条都必须占整行。
//    会话行是两列网格（minmax(0,1fr) auto）。确认条若塞进右侧那列，
//    它本身要 220px 的文字宽度会把左列挤到几乎 0 宽，中文标题和「还剩 16 小时」
//    这类信息就会一个字一行地竖着排。2026-11-20 删除缓冲站就是这么坏的。
{
  const lines = client.split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (!line.includes('style.confirmBar')) return
    if (!line.includes("gridColumn: '1 / -1'")) offenders.push(index + 1)
  })
  const uses = lines.filter((line) => line.includes('style.confirmBar')).length
  check('confirm bars are used at all', uses >= 3, uses)
  check('every confirm bar spans the full row', offenders.length === 0, offenders)
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}
