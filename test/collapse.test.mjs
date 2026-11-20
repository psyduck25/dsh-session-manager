// 列表折叠的纯逻辑验证。
//
// 规则和 lib/client.js 里的渲染循环一致：
//   每个工作区只展开 showCount 个（默认 5，与 DSH 侧栏的 SESSION_WATERMARK_BASE 对齐），
//   其余折在「展开其余 N 个」里；展开后全部可见，收起回到前 N 个。
//
// showCount 是常量而不是设置项 —— 想改它得连 DSH 自己的侧栏一起换掉，不划算。

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

/** 和 client.js 里的截断规则一致。 */
function planGroup(sessions, { showCount, expanded }) {
  const visible = expanded ? sessions : sessions.slice(0, showCount)
  return {
    visible: visible.map((s) => s.id),
    stillHidden: sessions.length - visible.length,
  }
}

const SHOW = 5
const make = (count) => Array.from({ length: count }, (_, index) => ({ id: `s${index}` }))

// 1. 超过 5 个：只显示前 5 个，其余折叠
{
  const sessions = make(8)
  const plan = planGroup(sessions, { showCount: SHOW, expanded: false })
  check('shows exactly 5', plan.visible.length === 5, plan.visible.length)
  check('reports 3 hidden', plan.stillHidden === 3, plan.stillHidden)
  check('keeps the first ones', plan.visible[0] === 's0' && plan.visible[4] === 's4', plan.visible)
}

// 2. 恰好 5 个：不出现折叠行
{
  const plan = planGroup(make(5), { showCount: SHOW, expanded: false })
  check('exactly 5 needs no collapse row', plan.stillHidden === 0, plan.stillHidden)
  check('all 5 visible', plan.visible.length === 5, plan.visible.length)
}

// 3. 不足 5 个：有几个显示几个
{
  const plan = planGroup(make(3), { showCount: SHOW, expanded: false })
  check('fewer than 5 shows all', plan.visible.length === 3, plan.visible.length)
  check('nothing hidden', plan.stillHidden === 0, plan.stillHidden)
}

// 4. 展开：全部可见
{
  const plan = planGroup(make(8), { showCount: SHOW, expanded: true })
  check('expanded shows all 8', plan.visible.length === 8, plan.visible.length)
  check('expanded hides nothing', plan.stillHidden === 0, plan.stillHidden)
}

// 5. 收起回原状
{
  const open = planGroup(make(8), { showCount: SHOW, expanded: true })
  const closed = planGroup(make(8), { showCount: SHOW, expanded: false })
  check('collapse returns to 5', closed.visible.length === 5, closed.visible.length)
  check('collapse restores the count', closed.stillHidden === 3, closed.stillHidden)
  check('open and closed differ', open.visible.length !== closed.visible.length)
}

// 6. 空工作区
{
  const plan = planGroup([], { showCount: SHOW, expanded: false })
  check('empty group is empty', plan.visible.length === 0 && plan.stillHidden === 0, plan)
}

// 7. 刚好第 6 个
{
  const plan = planGroup(make(6), { showCount: SHOW, expanded: false })
  check('6 shows 5 and hides 1', plan.visible.length === 5 && plan.stillHidden === 1, plan)
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}