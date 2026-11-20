// 列表折叠与时间筛选的纯逻辑验证。
//
// 这部分是纯函数，不需要浏览器：把 client.js 里那套规则照搬成可测的形式，
// 断言在数量上限、时间窗口、以及两者叠加时的输出。
//
// 规则（和 lib/client.js 里的渲染循环一致）：
//   1. 先按 maxAgeDays 过滤掉太旧的会话；
//   2. 再按 showCount 截断，多出来的进折叠行；
//   3. 折叠行上的数字 = 被数量截掉的 + 被时间筛掉的，
//      因为用户点「展开」只能看到前者，后者无论点多少次都不会出现。

const DAY = 86_400_000

function planGroup(sessions, { showCount, maxAgeDays, now, expanded }) {
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * DAY : 0
  const inWindow = cutoff === 0 ? sessions : sessions.filter((s) => s.updatedAt > cutoff)
  const staleCount = sessions.length - inWindow.length
  const visible = expanded ? inWindow : inWindow.slice(0, showCount)
  const hiddenByCount = inWindow.length - visible.length
  return {
    visible: visible.map((s) => s.id),
    staleCount,
    hiddenByCount,
    stillHidden: hiddenByCount + staleCount,
  }
}

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

const now = 1_000 * DAY
/** 造 N 个会话，updatedAt 分别落在 daysAgo 给定的天数前。 */
const make = (daysAgoList) =>
  daysAgoList.map((days, index) => ({ id: `s${index}`, updatedAt: now - days * DAY }))

// 1. 不筛时间、显示 5 个
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 0, now, expanded: false })
  check('shows exactly showCount', plan.visible.length === 5, plan.visible.length)
  check('counts the rest as hidden', plan.stillHidden === 3, plan.stillHidden)
  check('no time filtering', plan.staleCount === 0, plan.staleCount)
}

// 2. 用户原话的场景：默认显示 5，但其中有 4 个超过 5 天没聊
{
  // 8 个会话：3 个是近期的，5 个超过 5 天
  const sessions = make([1, 2, 3, 6, 7, 8, 9, 10])
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 5, now, expanded: false })
  check('age filter drops the stale ones first', plan.visible.length === 3, plan.visible.length)
  check('reports 5 filtered by age', plan.staleCount === 5, plan.staleCount)
  check('nothing hidden by count when age already cut it', plan.hiddenByCount === 0, plan.hiddenByCount)
  check('collapse row still shows 5', plan.stillHidden === 5, plan.stillHidden)
}

// 3. 只按时间留：窗口内比 showCount 多
//    注意 3.0 天整会落在边界上（用 > 判定），所以窗口内用 2.9 这种明确在里面的值。
{
  const sessions = make([1, 1, 2, 2, 2.9, 2.9, 30, 40])
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 3, now, expanded: false })
  check('window keeps 6', plan.visible.length === 5, plan.visible.length)
  check('one hidden by count', plan.hiddenByCount === 1, plan.hiddenByCount)
  check('two hidden by age', plan.staleCount === 2, plan.staleCount)
  check('collapse total is 3', plan.stillHidden === 3, plan.stillHidden)
}

// 4. 展开后：只看得到时间窗口内的，被时间筛掉的仍然看不到
{
  const sessions = make([1, 1, 2, 2, 2.9, 2.9, 30, 40])
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 3, now, expanded: true })
  check('expanded shows the whole window', plan.visible.length === 6, plan.visible.length)
  check('expanded leaves only the age-hidden ones', plan.stillHidden === 2, plan.stillHidden)
  check('expanded hides nothing by count', plan.hiddenByCount === 0, plan.hiddenByCount)
}

// 5. 改小数量
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])
  const plan = planGroup(sessions, { showCount: 2, maxAgeDays: 0, now, expanded: false })
  check('showCount 2 works', plan.visible.length === 2, plan.visible.length)
  check('six hidden', plan.stillHidden === 6, plan.stillHidden)
}

// 6. 改大数量
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])
  const plan = planGroup(sessions, { showCount: 50, maxAgeDays: 0, now, expanded: false })
  check('showCount above total shows all', plan.visible.length === 8, plan.visible.length)
  check('nothing left to collapse', plan.stillHidden === 0, plan.stillHidden)
}

// 7. 全部超时 → 一个都不显示，但折叠行要说清楚有多少
{
  const sessions = make([30, 40, 50])
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 5, now, expanded: false })
  check('all stale shows none', plan.visible.length === 0, plan.visible.length)
  check('all stale is reported', plan.stillHidden === 3, plan.stillHidden)
}

// 8. 空工作区
{
  const plan = planGroup([], { showCount: 5, maxAgeDays: 5, now, expanded: false })
  check('empty group shows nothing', plan.visible.length === 0 && plan.stillHidden === 0, plan)
}

// 9. 边界：刚好在窗口边缘
{
  const sessions = [{ id: 'edge', updatedAt: now - 5 * DAY }]
  const plan = planGroup(sessions, { showCount: 5, maxAgeDays: 5, now, expanded: false })
  // 用 > 而不是 >=：正好 5 天整算「超过 5 天」，和文案「超过五天不显示」一致
  check('exactly on the boundary counts as stale', plan.visible.length === 0, plan)
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}