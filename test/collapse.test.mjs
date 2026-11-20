// 列表折叠与排序的纯逻辑验证。
//
// 规则和 lib/client.js 里的渲染循环一致：
//   - 排序先做：'newest' 最新在前（默认），'oldest' 最早在前。
//     它决定「默认露出来的那 5 个是谁」，所以必须排完再截断。
//   - 再按 showCount（固定 5，与 DSH 侧栏的 SESSION_WATERMARK_BASE 对齐）截断。
//   - 展开后整个工作区全部可见，收起回到前 5 个。

const checks = []
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`  ok    ${name}`)
}

const SHOW = 5
const DAY = 86_400_000
const T0 = 1_000 * DAY

/** 造会话：daysAgo 越小越新。 */
const make = (daysAgoList) =>
  daysAgoList.map((days, index) => ({ id: `s${index}`, updatedAt: T0 - days * DAY }))

function planGroup(sessions, { showCount, expanded, sortOrder }) {
  const compare = sortOrder === 'oldest'
    ? (left, right) => left.updatedAt - right.updatedAt
    : (left, right) => right.updatedAt - left.updatedAt
  const sorted = [...sessions].sort(compare)
  const visible = expanded ? sorted : sorted.slice(0, showCount)
  return {
    visible: visible.map((s) => s.id),
    stillHidden: sorted.length - visible.length,
    first: visible[0]?.id,
  }
}

// ---------------------------------------------------------------- 折叠
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])
  const plan = planGroup(sessions, { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('collapsed shows 5', plan.visible.length === 5, plan.visible.length)
  check('collapsed hides 3', plan.stillHidden === 3, plan.stillHidden)
}

{
  const plan = planGroup(make([1, 2, 3]), { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('fewer than 5 shows all', plan.visible.length === 3, plan.visible.length)
  check('nothing hidden when under limit', plan.stillHidden === 0, plan.stillHidden)
}

{
  const plan = planGroup(make([1, 2, 3, 4, 5]), { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('exactly 5 hides nothing', plan.stillHidden === 0, plan.stillHidden)
}

{
  const plan = planGroup(make([1, 2, 3, 4, 5, 6, 7, 8]), { showCount: SHOW, expanded: true, sortOrder: 'newest' })
  check('expanded shows every session', plan.visible.length === 8, plan.visible.length)
  check('expanded hides nothing', plan.stillHidden === 0, plan.stillHidden)
}

{
  const plan = planGroup([], { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('empty group stays empty', plan.visible.length === 0 && plan.stillHidden === 0, plan)
}

// ---------------------------------------------------------------- 排序
// 关键：默认露出的 5 个必须随排序变化，而不是永远取前 5 个 id。
{
  // s0 最新（1 天前）… s7 最旧（8 天前）
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])

  const newest = planGroup(sessions, { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('newest first starts at s0', newest.first === 's0', newest.first)
  check('newest first takes the 5 most recent', newest.visible.join(',') === 's0,s1,s2,s3,s4', newest.visible)

  const oldest = planGroup(sessions, { showCount: SHOW, expanded: false, sortOrder: 'oldest' })
  check('oldest first starts at s7', oldest.first === 's7', oldest.first)
  check('oldest first takes the 5 least recent', oldest.visible.join(',') === 's7,s6,s5,s4,s3', oldest.visible)

  check('the two orders show different sets', newest.visible.join(',') !== oldest.visible.join(','))
}

// 展开后两种排序都完整，只是方向相反
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7, 8])
  const newest = planGroup(sessions, { showCount: SHOW, expanded: true, sortOrder: 'newest' })
  const oldest = planGroup(sessions, { showCount: SHOW, expanded: true, sortOrder: 'oldest' })
  check('expanded newest is all 8', newest.visible.length === 8, newest.visible.length)
  check('expanded oldest is the reverse', oldest.visible.join(',') === [...newest.visible].reverse().join(','))
}

// 时间相同的时候不能崩，也不能丢会话
{
  const same = [
    { id: 'a', updatedAt: T0 },
    { id: 'b', updatedAt: T0 },
    { id: 'c', updatedAt: T0 },
  ]
  const plan = planGroup(same, { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  check('equal timestamps keep all rows', plan.visible.length === 3, plan.visible.length)
}

// 排序改变后隐藏数量不变（总量没变，只是换哪 5 个露出来）
{
  const sessions = make([1, 2, 3, 4, 5, 6, 7])
  const a = planGroup(sessions, { showCount: SHOW, expanded: false, sortOrder: 'newest' })
  const b = planGroup(sessions, { showCount: SHOW, expanded: false, sortOrder: 'oldest' })
  check('hidden count is stable across orders', a.stillHidden === b.stillHidden, {
    newest: a.stillHidden,
    oldest: b.stillHidden,
  })
  check('7 sessions always hide 2', a.stillHidden === 2, a.stillHidden)
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((item) => item.name).join(', '))
  process.exitCode = 1
}