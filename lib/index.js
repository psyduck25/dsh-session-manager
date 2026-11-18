/**
 * dsh-session-manager 的宿主行。
 *
 * 职责：给设置页开一组本地 HTTP 路由，并托管「删除缓冲站」的定时器。
 *
 * 为什么用 `ctx.webServer.register` 而不是 Remote 服务：这里是插件自建的业务接口，
 * 用普通 HTTP 路由更直接（union-search、compaction-ask 也走这条路），
 * 所有路由只接受本机 loopback 请求。
 *
 * 路由：
 *   POST /api/dsh-session-manager/state     页面挂载/刷新时拉一次全量数据
 *   POST /api/dsh-session-manager/settings  改缓冲时长
 *   POST /api/dsh-session-manager/lock      锁定 / 解锁一个会话
 *   POST /api/dsh-session-manager/delete    二次确认后把会话送进缓冲站
 *   POST /api/dsh-session-manager/restore   从缓冲站回档
 *
 * 删除的两段式：
 *   1. 进入缓冲站时先把会话从左侧列表「摘掉」，再**把日志文件搬进回收站**
 *      （`$DSH_HOME/session-manager/trash/<会话>/`）。文件不在会话目录里，
 *      存储层就列不出它——哪怕用户开着「显示归档会话」也看不见（归档只是变灰）。
 *   2. 到期（默认 24 小时）后才真正销毁回收站里的文件、解除工作区归属、清掉归档集合。
 *      会话如果还被本进程活着（正在打开），Windows 上删不掉持有中的文件，
 *      于是标记 pending 并继续重试；下次 DSH 启动时第一件事就是清掉这些欠账。
 *
 * 回档把文件原样搬回去即可：工作区登记里那个 id 自始至终没被删过，位置不用猜。
 */

import { readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULTS,
  LIMITS,
  readState,
  resolveDshHome,
  stateFile,
  writeState,
} from './state.js'
import { moveIntoTrash, purgeTrash, restoreFromTrash } from './trash.js'

export const ROUTE_PREFIX = '/api/dsh-session-manager'

/** 单次请求体上限：这里只收几个数字和 id。 */
const MAX_BODY_BYTES = 64 * 1024

/** 缓冲站巡检间隔：一分钟一次足够，到期的条目最多晚一分钟被清掉。 */
const TICK_MS = 60_000

/**
 * 等一个会话从内存里退出的上限。
 *
 * 归档后客户端会在下一帧放掉主视图的引用，宿主随即释放 Agent——通常几十毫秒。
 * 但「当前正在看的那个会话」不会退出：它还被主视图攥着。那种情况按 deferred
 * 收进缓冲站（归档已经让它从列表消失），等它关掉后由巡检补搬文件。
 */
const DETACH_TIMEOUT_MS = 3_000

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  /** @type {{ home?: unknown }} */
  const rowConfig = config !== null && typeof config === 'object' ? config : {}
  const home = typeof rowConfig.home === 'string' && rowConfig.home !== '' ? rowConfig.home : resolveDshHome()
  const logger = ctx.logger

  /** 串行化所有状态写入，避免两次点击互相覆盖。 */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()
  /**
   * 把一次写入排进队列，并把它的返回值交回给调用方。
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = (operation) => {
    const next = queue.then(operation, operation)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  // ------------------------------------------------------------------ 数据读取

  /** 会话标题：日志里最新的标题事件；没有标题的会话返回 undefined。 */
  async function readTitles(ids) {
    const query = ctx.get('sessionQuery')
    const titles = new Map()
    if (query === undefined || ids.length === 0) return titles
    try {
      const results = await query.readTitleSnapshots(ids)
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const title = result.value.title
        if (title !== undefined && typeof title.title === 'string' && title.title.trim() !== '') {
          titles.set(result.sessionId, title.title.trim())
        }
      }
    } catch (error) {
      logger?.warn?.(`dsh-session-manager: 读取会话标题失败 ${messageOf(error)}`)
    }
    return titles
  }

  /** 会话摘要：优先用会话控制器（和左侧列表同一份数据），失败时退回查询服务。 */
  async function readSummaries(signal) {
    const controller = ctx.get('sessionController')
    if (controller !== undefined) {
      try {
        const value = await controller.list({}, signal)
        if (Array.isArray(value?.items)) return value.items
      } catch (error) {
        logger?.warn?.(`dsh-session-manager: 会话列表回退到 sessionQuery（${messageOf(error)}）`)
      }
    }
    const query = ctx.get('sessionQuery')
    if (query === undefined) return []
    const records = await query.listSessions(signal)
    return records.map((record) => ({
      sessionId: record.header.id,
      updatedAt: record.header.createdAt,
      blank: false,
      running: false,
      agentAvailable: false,
      cwd: record.header.cwd,
    }))
  }

  /** 把会话、工作区、锁定、缓冲站拼成页面要的一份数据。 */
  async function readView() {
    const state = readState(home)
    const registry = ctx.get('workspaceRegistry')
    const sessionStore = ctx.get('sessions')
    const agentStore = ctx.get('agents')
    const summaries = await readSummaries()
    const titles = await readTitles(summaries.map((item) => item.sessionId))

    const workspaces = (registry?.list?.() ?? []).map((workspace) => ({
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionIds: [...workspace.sessionIds],
    }))

    const owner = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        if (!owner.has(sessionId)) owner.set(sessionId, workspace.workspaceId)
      }
    }

    const locked = new Set(state.locks)
    const buffered = new Set(state.buffer.map((entry) => entry.sessionId))
    // 进缓冲站的会话已经从左侧列表隐藏了，这里也不再列一遍：
    // 否则同一个会话会同时出现在「会话」和「删除缓冲站」两处，还带一个会报错的删除按钮。
    const visible = summaries.filter((summary) => !buffered.has(summary.sessionId))
    const sessions = visible.map((summary) => {
      const id = summary.sessionId
      const live = sessionStore?.get?.(id)
      // 运行中看的是 Agent，不是 Session：会话本身没有 status。
      const agent = agentStore?.get?.(id)
      const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
      // 没被任何工作区登记的会话会落在左侧的「未分组」里。
      // 它的 cwd 往往正好是某个工作区的目录，只是工作区的补登记只在启动时跑一次，
      // 之后新出现的会话不会再被收进去——这里算出来，让页面能提示并一键归位。
      const ownerId = owner.get(id) ?? ''
      const adoptable = ownerId === '' && cwd !== ''
        ? workspaces.find((workspace) => workspace.path === cwd)
        : undefined
      return {
        sessionId: id,
        title: titles.get(id) ?? '',
        workspaceId: ownerId,
        cwd,
        updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0,
        blank: summary.blank === true,
        subagent: summary.origin === 'subagent',
        running: summary.running === true || agent?.status === 'running',
        live: live !== undefined,
        locked: locked.has(id),
        buffered: buffered.has(id),
        adoptInto: adoptable === undefined ? '' : adoptable.workspaceId,
        adoptIntoTitle: adoptable === undefined ? '' : adoptable.title,
      }
    })

    // 工作区里登记了、但当前进程读不到日志的会话也要占一行，否则用户看不见它。
    const known = new Set(sessions.map((session) => session.sessionId))
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        if (known.has(sessionId)) continue
        if (buffered.has(sessionId)) continue
        known.add(sessionId)
        sessions.push({
          sessionId,
          title: '',
          workspaceId: workspace.workspaceId,
          cwd: workspace.path,
          updatedAt: 0,
          blank: false,
          running: false,
          live: false,
          locked: locked.has(sessionId),
          buffered: false,
          missing: true,
        })
      }
    }

    return {
      ok: true,
      settings: state.settings,
      defaults: DEFAULTS,
      limits: LIMITS,
      statePath: stateFile(home),
      workspaces,
      sessions,
      buffer: state.buffer,
      now: Date.now(),
    }
  }

  /**
   * `readView` 的容错版：写操作已经落盘之后，重新读列表失败不该把成功覆盖成失败。
   * 读不出来就退回一个空视图，页面照常显示操作结果，用户点刷新还能再看。
   */
  async function readViewSafely() {
    try {
      return await readView()
    } catch (error) {
      logger?.warn?.(`dsh-session-manager: 操作成功但重新读取列表失败 ${messageOf(error)}`)
      return { ok: false, code: 'readFailed' }
    }
  }

  /**
   * 什么情况下不能动这个会话的日志文件。
   *
   * 只有「正在跑回合」是硬拦：那时 DSH 会持续往日志里追加事件，把文件搬走会
   * 让写入者落到一个已经不在原位的路径上，重启后就是一堆丢失的对话。
   *
   * 「会话开着但空闲」不是拦的理由，但也不能直接搬：DSH 的会话列表是
   * 「磁盘文件 ∪ 内存实例」的并集，文件搬走了内存里那个实例还在，左侧照样
   * 显示。所以那种会话先归档（客户端主视图会放掉它、宿主随即释放 Agent），
   * 等它真的不在内存里了再搬文件。
   */
  function liveBlockers(sessionId) {
    const blockers = []
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent !== undefined && agent.status === 'running') blockers.push('running')
    return blockers
  }

  /** 会话是否还活在本进程里（列表会把它算进去）。 */
  function isLive(sessionId) {
    return ctx.get('sessions')?.get?.(sessionId) !== undefined
  }

  /** 让这个会话缓冲中的事件落盘；没有存储层或没有活会话时什么也不做。 */
  async function flushSession(sessionId) {
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (session === undefined) return
    try {
      await ctx.get('sessions')?.flush?.(session)
    } catch (error) {
      logger?.warn?.(`dsh-session-manager: flush 会话失败 ${messageOf(error)}`)
    }
  }

  /** 读一个会话的 header（含 cwd）。活着就直接拿，冷会话走存储层。 */
  async function readSessionHeader(sessionId) {
    const live = ctx.get('sessions')?.get?.(sessionId)
    if (live !== undefined) return live.header
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    try {
      const snapshot = await persistence.stat(sessionId)
      return snapshot?.header
    } catch {
      return undefined
    }
  }

  /**
   * 等这个会话从内存里退出（归档后客户端会放掉引用，宿主随即释放 Agent）。
   * @returns 是否在超时前退出了内存。
   */
  async function waitUntilDetached(sessionId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!isLive(sessionId)) return true
      if (Date.now() >= deadline) return false
      await delay(150)
    }
  }

  // ------------------------------------------------------------------ 删除与回档

  /**
   * 找到会话日志在磁盘上的位置。存储层知道；没有存储层时返回 undefined。
   */
  async function locateSessionLog(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return { file: undefined, code: 'noPersistence' }
    try {
      const snapshot = await persistence.stat(sessionId)
      if (snapshot === undefined) return { file: undefined, code: 'missingLog' }
      const file = snapshot.location?.path
      if (typeof file !== 'string' || file === '') return { file: undefined, code: 'noLocation' }
      return { file }
    } catch (error) {
      return { file: undefined, code: 'statFailed', detail: messageOf(error) }
    }
  }

  /**
   * 把一个会话藏起来。两步都要做，各自解决一半问题：
   *
   *   1. 归档：写进工作区归档集合，会让工作区流推一帧，左侧列表立刻重新拉数据；
   *      同时也挡住这个会话后续的唤醒。
   *   2. 把日志文件搬进回收站：只有这一步能让会话在「显示归档会话」开关打开时
   *      也彻底不在列表里——列表来自存储层的会话清单，文件不在了就没有这一行。
   *
   * 顺序不能反：归档要先做（它要检查会话存在），搬完文件后存储层就找不到它了。
   */
  async function hideSession(sessionId) {
    // 跑着回合的会话不能动：日志还在被持续追加。先叫停，让用户稍后再删。
    const blockers = liveBlockers(sessionId)
    if (blockers.length > 0) return { hidden: false, code: 'liveBlocked', detail: blockers.join(',') }

    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return { hidden: false, code: 'archiveFailed', detail: 'no workspace registry' }

    // 1. 先把内存里还没落盘的事件刷进日志。必须排在归档之前：归档之后会话会被
    //    释放，那时 flushSession 取不到会话就直接返回了，等于什么也没刷。
    await flushSession(sessionId)

    // 2. 归档：写进归档集合，推一帧让客户端放掉主视图引用。
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      return { hidden: false, code: 'archiveFailed', detail: messageOf(error) }
    }
    const unarchive = async () => {
      try {
        await registry.unarchiveSession(sessionId)
      } catch {
        // 退回失败也只是多一个归档条目，不影响正确性
      }
    }

    // 3. 等它从内存退出：列表是「磁盘 ∪ 内存」，内存里还在就照样看得见。
    const detached = await waitUntilDetached(sessionId, DETACH_TIMEOUT_MS)
    if (!detached) {
      // 有人正看着它（比如当前会话本身）。归档留着，等它关掉后由巡检接着搬。
      return { hidden: true, originalDir: '', files: [], deferred: true }
    }

    // 4. 搬文件：这一步之后存储层列不出它，开关也救不回来。
    const located = await locateSessionLog(sessionId)
    if (located.file === undefined) {
      // 找不到日志文件：归档已经让它从列表里消失了，收进缓冲站到期再清一次。
      return { hidden: true, originalDir: '', files: [] }
    }
    const moved = await moveIntoTrash(home, sessionId, located.file)
    if (moved.moved) {
      return { hidden: true, originalDir: moved.originalDir, files: moved.files }
    }
    if (moved.code === 'missingLog') return { hidden: true, originalDir: '', files: [] }

    // 搬不动就把归档也退回去，别留一个「显示已删但还在列表」的半截状态。
    await unarchive()
    return { hidden: false, code: moved.code ?? 'moveFailed', detail: moved.detail ?? '' }
  }

  /**
   * 回档：先把日志搬回它原来的会话目录，再解除归档。
   *
   * 顺序和隐藏相反：文件先回来，存储层重新列得出它，归档集合再去掉它，
   * 工作区流推一帧，列表里就回到原来的位置（工作区登记自始至终没动过）。
   *
   * 旧版插件（0.1.0 早期）是纯「归档」实现的隐藏，条目里没有 originalDir：
   * 那种条目只需解除归档就能原样回来。
   */
  async function showSession(entry) {
    const registry = ctx.get('workspaceRegistry')
    const hasFiles = Array.isArray(entry.files) && entry.files.length > 0
    const hasDir = typeof entry.originalDir === 'string' && entry.originalDir !== ''

    if (hasFiles && hasDir) {
      const restored = await restoreFromTrash(home, entry)
      if (!restored.restored) {
        return { restored: false, code: restored.code ?? 'restoreFailed', detail: restored.detail ?? '' }
      }
    }

    if (registry !== undefined) {
      try {
        await registry.unarchiveSession(entry.sessionId)
      } catch (error) {
        // 文件已经搬回去了，这个会话在存储层眼里已经回来了；只是归档集合里
        // 还留着一个 id。这种情况必须当成回档成功：否则条目会留在缓冲站里，
        // 到期后巡检会把刚刚救回来的日志再删一遍。
        logger?.warn?.(`dsh-session-manager: 解除归档失败，日志已回位 ${messageOf(error)}`)
      }
    }
    return { restored: true }
  }

  /** 彻底删除：回收站里的文件真正移除，再把它从工作区登记里摘掉。 */
  async function purgeSession(entry) {
    const sessionId = entry.sessionId
    // 跑着回合就等下一轮：回收站里的文件反正已经不在会话目录了，不急。
    const blockers = liveBlockers(sessionId)
    if (blockers.length > 0) return { done: false, code: 'liveBlocked', detail: blockers.join(',') }

    // 会话还挂在内存里的话，它可能随时把日志再写出来（回档后又被打开过）。
    // 先归档让它退出内存，等真的退出了再动文件；退不掉就只删回收站里的那份，
    // 剩下的欠账留给下一次巡检。
    let detached = true
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && isLive(sessionId)) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true })
      } catch {
        // 不在工作区里也算正常
      }
      detached = await waitUntilDetached(sessionId, DETACH_TIMEOUT_MS)
    }

    // 缓冲站里的会话日志在回收站目录；先删它。
    const purged = await purgeTrash(home, sessionId)
    if (!purged.purged) return { done: false, code: purged.code ?? 'purgeFailed', detail: purged.detail ?? '' }

    // 还在内存里就别动会话目录：文件可能正被持有，删了会写出一个已 unlink 的 inode。
    if (!detached) return { done: true, note: 'deferred' }

    // 万一日志还在会话目录里（回档失败、或当初根本没找到文件），也清一遍。
    const located = await locateSessionLog(sessionId)
    if (located.file !== undefined) {
      const removal = await removeFilesAt(located.file, sessionId)
      if (!removal.done) return removal
    }

    if (registry !== undefined) {
      // 先摘掉工作区登记（会话记录还读得到，这一步会检查它存在），
      // 再撤销归档：顺序反了的话登记录取不到会话就会被跳过，留下一条孤儿。
      let detachedFromAll = true
      for (const workspace of registry.list?.() ?? []) {
        if (!workspace.sessionIds.includes(sessionId)) continue
        try {
          await workspace.detachSession(sessionId)
        } catch (error) {
          // 摘不掉就会留下一条指向已删日志的「日志缺失」行，必须让条目留在
          // 缓冲站里继续重试，不能报告成功。
          detachedFromAll = false
          logger?.warn?.(`dsh-session-manager: 解除工作区归属失败 ${messageOf(error)}`)
        }
      }
      if (!detachedFromAll) return { done: false, code: 'detachFailed' }
      try {
        await registry.unarchiveSession(sessionId)
      } catch {
        // 不在归档集合里就什么都不用做
      }
    }
    return { done: true }
  }

  /**
   * 删掉某条日志所在目录里的会话文件：只在彻底删除时用。
   *
   * 只删**确认属于这个会话**的文件。会话目录的约定是
   * `<sessions>/<编码后的 cwd>/<sessionId>/`，所以目录名必须逐字等于会话 id。
   * 目录名对不上（存储层改了布局、或者路径是拼出来的）就只删 `location.path`
   * 指的那一个文件，绝不按前缀批量删——那样会连带删掉别人的日志。
   */
  async function removeFilesAt(file, sessionId) {
    const directory = path.dirname(file)
    const ownsDirectory = path.basename(directory) === sessionId
    if (!ownsDirectory) {
      try {
        await unlink(file)
      } catch (error) {
        if (isMissing(error)) return { done: true }
        return { done: false, code: 'unlinkFailed', detail: messageOf(error) }
      }
      return { done: true }
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return { done: true }
      return { done: false, code: 'readdirFailed', detail: messageOf(error) }
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('session.')) continue
      try {
        await unlink(path.join(directory, entry.name))
      } catch (error) {
        if (isMissing(error)) continue
        return { done: false, code: 'unlinkFailed', detail: `${entry.name}：${messageOf(error)}` }
      }
    }
    try {
      await rmdir(directory)
    } catch {
      // ENOTEMPTY / ENOENT 都无所谓
    }
    return { done: true }
  }

  /**
   * 把「进了缓冲站但文件还没搬走」的条目补搬一次。
   *
   * 两种情况会留下这种条目：
   *   - 删除时那个会话还开着（当前正在看的那个），先只归档、文件等它退出内存再搬；
   *   - 早期版本用纯归档实现隐藏，条目里根本没有 originalDir。
   * 已经搬好的条目直接返回，stat 不到文件的也直接返回。
   */
  async function adoptLegacyEntry(entry) {
    const hasFiles = Array.isArray(entry.files) && entry.files.length > 0
    const hasDir = typeof entry.originalDir === 'string' && entry.originalDir !== ''
    if (hasFiles && hasDir) return entry

    // 还活着就等下次：日志可能还要被追加。
    if (isLive(entry.sessionId)) return entry

    const located = await locateSessionLog(entry.sessionId)
    if (located.file === undefined) return entry
    const moved = await moveIntoTrash(home, entry.sessionId, located.file)
    if (!moved.moved) return entry
    return { ...entry, originalDir: moved.originalDir, files: moved.files, pending: false, note: '', noteDetail: '' }
  }

  /**
   * 清掉已经不存在的会话的锁。
   *
   * 锁是按会话 id 记的，会话删掉之后 id 就再也不会出现，锁会一直占着
   * state.json。这不是正确性问题，但状态文件会越攒越脏，用户也没法自己清。
   * 只在「确实读到了会话清单」的时候清：清单读失败或者为空（存储层还没起来）
   * 的时候什么都不动，免得把有效的锁误删。
   */
  async function pruneLocks(state) {
    if (state.locks.length === 0) return state
    let known
    try {
      known = new Set((await readSummaries()).map((summary) => summary.sessionId))
    } catch {
      return state
    }
    if (known.size === 0) return state
    // 工作区里登记着但读不到日志的会话也算存在（页面上它们还有一行）。
    const registry = ctx.get('workspaceRegistry')
    for (const workspace of registry?.list?.() ?? []) {
      for (const sessionId of workspace.sessionIds) known.add(sessionId)
    }
    for (const entry of state.buffer) known.add(entry.sessionId)
    const locks = state.locks.filter((sessionId) => known.has(sessionId))
    if (locks.length === state.locks.length) return state
    return { ...state, locks }
  }

  /** 巡检缓冲站：到期的条目彻底删除，删不掉的标记成 pending 下次再试。 */
  function sweep() {
    return serialize(async () => {
      const stored = readState(home)
      const state = await pruneLocks(stored)
      // 锁被清过也算状态变了，必须落盘，否则下次读回来还是一堆死锁。
      const locksChanged = state.locks.length !== stored.locks.length
      if (state.buffer.length === 0) {
        return locksChanged ? writeState(home, state) : state
      }
      const now = Date.now()
      // 每条都先补搬一次：推迟搬运的条目一旦退出内存就能搬了。
      let buffer = []
      let adopted = false
      for (const entry of state.buffer) {
        let current = entry
        try {
          current = await adoptLegacyEntry(entry)
        } catch (error) {
          logger?.warn?.(`dsh-session-manager: 补搬缓冲站条目失败 ${messageOf(error)}`)
        }
        if (current !== entry) adopted = true
        buffer.push(current)
      }

      const due = buffer.filter((entry) => entry.expiresAt <= now)
      if (due.length === 0) {
        if (!adopted && !locksChanged) return state
        return writeState(home, { ...state, buffer })
      }
      let changed = adopted
      for (const entry of due) {
        // 上面已经补搬过了，直接走删除流程。
        const current = buffer.find((item) => item.sessionId === entry.sessionId) ?? entry
        let result
        try {
          result = await purgeSession(current)
        } catch (error) {
          result = { done: false, code: 'purgeFailed', detail: messageOf(error) }
        }
        changed = true
        const index = buffer.findIndex((item) => item.sessionId === entry.sessionId)
        if (index === -1) continue
        if (result.done) {
          buffer.splice(index, 1)
          logger?.info?.(`dsh-session-manager: 已彻底删除会话 ${entry.sessionId}`)
        } else {
          const code = result.code ?? 'purgeFailed'
          const detail = result.detail ?? ''
          buffer[index] = { ...current, pending: true, note: code, noteDetail: detail }
          // 每分钟都会重试；只有原因变了才再记一条，免得刷屏。
          if (entry.note !== code || entry.pending !== true) {
            logger?.warn?.(`dsh-session-manager: 会话 ${entry.sessionId} 暂时删不掉（${code} ${detail}）`)
          }
        }
      }
      if (!changed && !locksChanged) return state
      return writeState(home, { ...state, buffer })
    })
  }

  // 路由统一用错误码回话，界面按当前语言翻译；只有真正意外的异常才带原始消息。
  const routes = [
    {
      path: `${ROUTE_PREFIX}/state`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        try {
          // 每次打开页面都巡检一次：补搬推迟的条目、清掉到期的条目。
          await sweep()
          writeJson(response, 200, await readView())
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'readFailed', error: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/settings`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        if (body.reset === true || body.bufferHours !== undefined) {
          // 只收真正的数字。`Number(null)`、`Number('')`、`Number([])` 都是 0，
          // 而 0 意味着「确认后立即彻底删除」——绝不能因为一个畸形请求就静默打开它。
          let hours
          if (body.reset === true) {
            hours = DEFAULTS.bufferHours
          } else {
            const raw = body.bufferHours
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
              return writeJson(response, 400, { ok: false, code: 'badNumber' })
            }
            const limit = LIMITS.bufferHours
            const rounded = Math.round(raw)
            if (rounded < limit.min || rounded > limit.max) {
              return writeJson(response, 400, { ok: false, code: 'outOfRange' })
            }
            hours = rounded
          }
          try {
            const saved = await serialize(async () => {
              const state = readState(home)
              const written = writeState(home, { ...state, settings: { ...state.settings, bufferHours: hours } })
              return written.settings
            })
            logger?.info?.(`dsh-session-manager: 缓冲时长 = ${saved.bufferHours} 小时`)
          } catch (error) {
            return writeJson(response, 500, { ok: false, code: 'saveFailed', error: messageOf(error) })
          }
        }
        try {
          writeJson(response, 200, await readView())
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'readFailed', error: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/lock`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return writeJson(response, 400, { ok: false, code: 'badBody' })
        const locked = body.locked === true
        try {
          await serialize(async () => {
            const state = readState(home)
            const others = state.locks.filter((id) => id !== sessionId)
            writeState(home, { ...state, locks: locked ? [sessionId, ...others] : others })
          })
        } catch (error) {
          return writeJson(response, 500, { ok: false, code: 'saveFailed', error: messageOf(error) })
        }
        try {
          writeJson(response, 200, await readView())
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'readFailed', error: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/delete`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return writeJson(response, 400, { ok: false, code: 'badBody' })

        try {
          const outcome = await serialize(async () => {
            const state = readState(home)
            if (state.locks.includes(sessionId)) return { ok: false, code: 'locked' }
            if (state.buffer.some((entry) => entry.sessionId === sessionId)) {
              return { ok: false, code: 'alreadyBuffered' }
            }
            const hours = state.settings.bufferHours
            const deletedAt = Date.now()
            // 先把日志搬进回收站：搬完这个会话就从列表里彻底消失了。
            // 搬不动（会话开着 / 目录动不了）就不写缓冲站，免得出现「显示已删但还在列表」。
            const hidden = await hideSession(sessionId)
            if (!hidden.hidden) {
              return { ok: false, code: hidden.code ?? 'moveFailed', detail: hidden.detail ?? '' }
            }
            const written = writeState(home, {
              ...state,
              buffer: [
                {
                  sessionId,
                  title: typeof body.title === 'string' ? body.title : '',
                  workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
                  workspaceTitle: typeof body.workspaceTitle === 'string' ? body.workspaceTitle : '',
                  deletedAt,
                  expiresAt: deletedAt + hours * 3_600_000,
                  originalDir: hidden.originalDir ?? '',
                  files: hidden.files ?? [],
                  pending: false,
                  note: '',
                  noteDetail: '',
                },
                ...state.buffer,
              ],
            })
            if (hours === 0) {
              // 缓冲时长为 0：确认后立刻彻底删除。
              const entry = written.buffer.find((item) => item.sessionId === sessionId)
              const purged = await purgeSession(entry)
              if (!purged.done) {
                const kept = written.buffer.map((item) =>
                  item.sessionId === sessionId
                    ? { ...item, pending: true, note: purged.code ?? 'purgeFailed', noteDetail: purged.detail ?? '' }
                    : item,
                )
                writeState(home, { ...written, buffer: kept })
                return { ok: true, purged: false, code: purged.code ?? 'purgeFailed' }
              }
              writeState(home, {
                ...written,
                buffer: written.buffer.filter((item) => item.sessionId !== sessionId),
              })
              return { ok: true, purged: true }
            }
            return { ok: true, purged: false }
          })
          if (outcome.ok === false) return writeJson(response, 200, outcome)
          writeJson(response, 200, { ...outcome, view: await readViewSafely() })
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'deleteFailed', error: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/restore`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return writeJson(response, 400, { ok: false, code: 'badBody' })
        try {
          const outcome = await serialize(async () => {
            const state = readState(home)
            const entry = state.buffer.find((item) => item.sessionId === sessionId)
            if (entry === undefined) {
              return { ok: false, code: 'notBuffered' }
            }
            const restored = await showSession(entry)
            if (!restored.restored) {
              return { ok: false, code: restored.code ?? 'restoreFailed', detail: restored.detail ?? '' }
            }
            writeState(home, { ...state, buffer: state.buffer.filter((item) => item.sessionId !== sessionId) })
            return { ok: true }
          })
          if (outcome.ok === false) return writeJson(response, 200, outcome)
          // 回档已经落库（文件搬回来了、条目也从缓冲站移走了），读视图失败
          // 不能再盖成 500：界面会报「回档失败」，而实际上会话已经回来了。
          writeJson(response, 200, { ...outcome, view: await readViewSafely() })
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'restoreFailed', error: messageOf(error) })
        }
      },
    },
    {
      // 缓冲站里「彻底删除」：前面已经二次确认过了，这里不再确认。
      path: `${ROUTE_PREFIX}/purge`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return writeJson(response, 400, { ok: false, code: 'badBody' })
        try {
          const outcome = await serialize(async () => {
            const state = readState(home)
            const entry = state.buffer.find((item) => item.sessionId === sessionId)
            if (entry === undefined) return { ok: false, code: 'notBuffered' }
            const purged = await purgeSession(entry)
            if (!purged.done) {
              const kept = state.buffer.map((item) =>
                item.sessionId === sessionId
                  ? { ...item, pending: true, note: purged.code ?? 'purgeFailed', noteDetail: purged.detail ?? '' }
                  : item,
              )
              writeState(home, { ...state, buffer: kept })
              return { ok: false, code: purged.code ?? 'purgeFailed', detail: purged.detail ?? '' }
            }
            writeState(home, { ...state, buffer: state.buffer.filter((item) => item.sessionId !== sessionId) })
            return { ok: true }
          })
          if (outcome.ok === false) return writeJson(response, 200, { ...outcome, view: await readViewSafely() })
          // 删除已经落盘成功了，重新读列表失败不能再把结果盖成 500，
          // 否则用户看到「删除失败」而实际已删，重试还会撞上 notBuffered。
          writeJson(response, 200, { ...outcome, view: await readViewSafely() })
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'purgeFailed', error: messageOf(error) })
        }
      },
    },
    {
      /**
       * 归位：「未分组」里的会话按 cwd 挂回它本来属于的工作区。
       *
       * DSH 的工作区补登记只在启动时按目录归并一次，之后新建的会话不会被收进去，
       * 于是左侧就多出「未分组」一栏。工作区的 `attachSession` 会自己校验 cwd
       * 必须解析到该工作区目录，所以这里不用重复判断，交给它拒绝。
       */
      path: `${ROUTE_PREFIX}/adopt`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, code: 'notLoopback' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, code: 'badBody' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return writeJson(response, 400, { ok: false, code: 'badBody' })
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) return writeJson(response, 500, { ok: false, code: 'noRegistry' })
        try {
          const outcome = await serialize(async () => {
            const header = await readSessionHeader(sessionId)
            if (header === undefined) return { ok: false, code: 'noHeader' }
            const cwd = typeof header.cwd === 'string' ? header.cwd : ''
            if (cwd === '') return { ok: false, code: 'noCwd' }
            const target = (registry.list?.() ?? []).find((workspace) => workspace.path === cwd)
            if (target === undefined) return { ok: false, code: 'noWorkspaceForCwd' }
            await target.attachSession(sessionId)
            return { ok: true, workspaceId: target.id }
          })
          if (outcome.ok === false) return writeJson(response, 200, outcome)
          // 归位已经落库，读视图失败不能再把它盖成 500：界面会提示失败，
          // 用户再点一次就重复登记同一个会话。读不到就只回成功和落点。
          writeJson(response, 200, { ...outcome, view: await readViewSafely() })
        } catch (error) {
          writeJson(response, 500, { ok: false, code: 'adoptFailed', error: messageOf(error) })
        }
      },
    },
  ]

  ctx.effect(() => {
    // 兜底一层：任何 handler 里漏网的异常都收成 500，绝不让它变成
    // 没人接管的 promise rejection 把宿主进程拖下水。
    const guard = (handler) => async (request, response) => {
      try {
        await handler(request, response)
      } catch (error) {
        logger?.warn?.(`dsh-session-manager: 路由异常 ${messageOf(error)}`)
        if (!response.headersSent) {
          writeJson(response, 500, { ok: false, code: 'internal', error: messageOf(error) })
        } else {
          try {
            response.end()
          } catch {
            // 连接已经没了
          }
        }
      }
    }
    const disposers = routes.map((route) =>
      ctx.webServer.register({ kind: 'exact', path: route.path, handler: guard(route.handler) }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 已经随作用域一起释放了
        }
      }
    }
  }, 'dsh-session-manager: settings routes')

  // 启动时先巡检一次（补搬推迟的条目 + 清欠账），然后每分钟一次。
  ctx.effect(() => {
    let stopped = false
    const tick = () => {
      if (stopped) return
      void sweep().catch((error) => logger?.warn?.(`dsh-session-manager: 巡检失败 ${messageOf(error)}`))
    }
    const timer = setTimeout(tick, 2_000)
    const interval = setInterval(tick, TICK_MS)
    interval.unref?.()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, 'dsh-session-manager: recycle sweeper')

  logger?.info?.(`dsh-session-manager: 设置路由挂在 ${ROUTE_PREFIX}，状态文件 ${stateFile(home)}`)
}

// -------------------------------------------------------------------- helpers

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function isMissing(error) {
  return error instanceof Error && ['ENOENT', 'ENOTDIR'].includes(/** @type {NodeJS.ErrnoException} */ (error).code)
}

/**
 * 只放行本机页面发来的请求。
 *
 * 三层检查缺一不可：socket 地址保证是回环、Host 头保证不是 DNS 重绑定的域名、
 * `sec-fetch-site` 保证不是别的站点发起的跨站请求。最后一条只排除 `cross-site`
 * 是不够的：`localhost` 其它端口上的本地 dev server 发来的是 `same-site`，
 * 而服务端并不看 `content-type`，一个 `no-cors` + `text/plain` 的请求就能
 * 把合法 JSON 打进 `/delete`。所以这里改成白名单：只认本页面自己发起的请求。
 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  const site = request.headers?.['sec-fetch-site']
  // `none` 是地址栏直接打开，`same-origin` 是同源页面；浏览器不发这个头时
  // 也放行（非浏览器客户端），真正的门槛是上面的回环 + Host 检查。
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  return true
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(payload)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
  } catch {
    // 客户端中途断开时流会抛 ERR_STREAM_PREMATURE_CLOSE；当成坏请求处理，
    // 不能让它变成没人接管的 promise rejection。
    return undefined
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return undefined
  }
}
