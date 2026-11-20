// dsh-session-manager（会话删除管理）的浏览器半侧：设置 → 「会话删除管理」一页。
//
// 三件事：
//   1. 按工作区分组列出所有会话，每行带「锁定」和「删除」；
//   2. 删除要二次确认，确认后不是立刻销毁，而是进下面的「删除缓冲站」；
//   3. 缓冲站里的会话可以回档，到期才由宿主彻底删除。
//
// 宿主调用走普通 HTTP 路由（lib/index.js 里的 `ctx.webServer.register`）。
// 样式全部用 `--dsw-alias-*` 主题变量，深浅色自动跟随；不 import 任何 Harness UI 包
// —— 那些包会随版本变动，自己写控件最稳。
//
// ⚠️ 这里的 id 必须逐字等于 package.json 的 name。
// client-modules 用**包名**当 entry id（dsh-client-modules/lib/index.js 的
// `graphRow(packageName, ...)`），浏览器端拿这个 id 去核对 bundle 是否注册过；
// 对不上就整个浏览器半侧作废，设置页里那一项根本不出现 —— 而且不报错、不崩溃，
// 只是静悄悄地没了。2026-11-18 因为包改名成 @psyduck25/dsh-session-manager
// 而这里还留着旧名，正是这么丢的。
window.__ModuleLoader__.load({
  id: '@psyduck25/dsh-session-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SECTION_ID = 'session-manager'
    const ROUTE_PREFIX = '/api/dsh-session-manager'
    const LOCALE_NS = 'session-manager'
    /** 宿主最长要等 3 秒让会话退出内存，留足余量。 */
    const HOST_TIMEOUT_MS = 30_000

    // ---------------------------------------------------------------- 文案

    const DICT = {
      en: {
        'common.retry': 'Retry',
        'section.label': 'Session manager',
        'page.title': 'Session manager',
        'page.desc': 'List every session by workspace, lock the ones you want to keep, and delete the rest through a recycle bin.',
        'settings.title': 'Recycle bin window',
        'settings.hint': 'Deleted sessions stay recoverable for this long, then their logs are deleted for real. 0 means deleting for good on confirmation.',
        'settings.unit': 'hours',
        'settings.save': 'Save',
        'settings.reset': 'Restore default',
        'settings.saved': 'Saved.',
        'settings.needNumber': 'Enter a whole number of hours first.',
        'settings.range': 'Allowed range: {min}–{max} hours',
        'reload.label': 'Reload interface',
        'reload.hint': 'Reloads this page and re-reads the session list, which clears rows left behind by the browser-side snapshot.',
        'reload.busy': 'Reloading…',
        'notice.reloadFailed': 'this page cannot reload itself; press F12 and then Ctrl+R instead',
        'sessions.title': 'Sessions',
        'sessions.empty': 'No sessions.',
        'sessions.refresh': 'Refresh',
        'sessions.unnamed': 'Untitled',
        'sessions.expand': 'Show the remaining {count}',
        'sessions.collapse': 'Collapse',
        'sessions.orphan': 'No workspace',
        'sessions.subagent': 'subagent',
        'sessions.locked': 'Locked',
        'sessions.live': 'open',
        'sessions.running': 'running',
        'sessions.missing': 'log missing',
        'action.lock': 'Lock',
        'action.unlock': 'Unlock',
        'action.delete': 'Delete',
        'action.adopt': 'File it',
        'adopt.hint': 'Its folder belongs to {workspace}',
        'notice.adopted': '“{title}” is filed under {workspace}.',
        'migrate.label': 'Move to workspace',
        'migrate.choose': 'Move to…',
        'migrate.current': 'current',
        'migrate.confirm': 'Move “{title}” from {from} to {to}?',
        'migrate.confirmHint': 'Its log folder on disk moves with it. This takes effect after DSH restarts.',
        'migrate.yes': 'Move',
        'migrate.no': 'Cancel',
        'notice.migrated': '“{title}” now belongs to {workspace}. Restart DSH to see it in the sidebar.',
        'notice.migratedNoRestart': '“{title}” now belongs to {workspace}.',
        'notice.registrationOnly': 'Only the registration changed. The log still sits under the old folder, so DSH will put “{title}” back under No workspace on the next restart.',
        'notice.migrateNeedRestart': 'Moved on disk. Restart DSH to finish the move in the sidebar.',
        'perm.title': 'Permission needed to move files',
        'perm.body': 'Moving “{title}” rewrites its session header and moves its log folder. The system refused one of those operations, so nothing was changed.',
        'perm.paths': 'From: {from}',
        'perm.pathsTo': 'To: {to}',
        'perm.cannotElevate': 'DSH cannot raise its own privileges. If the folders are read-only or owned by another account, fix that first — then try again.',
        'perm.allow': 'I understand, try again',
        'perm.registerOnly': 'Change registration only',
        'perm.cancel': 'Cancel',
        'notice.noWorkspaceForCwd': 'no workspace owns that folder',
        'notice.noCwd': 'the session records no folder',
        'notice.noHeader': 'the session log cannot be read',
        'notice.noRegistry': 'this profile has no workspace registry',
        'notice.adoptFailed': 'filing it failed',
        'confirm.delete': 'Delete “{title}”? It moves to the recycle bin and can be recovered for {hours} hours.',
        'confirm.now': 'Delete “{title}” for good? This cannot be undone.',
        'confirm.purge': 'Delete “{title}” for good? This cannot be undone.',
        'confirm.yes': 'Delete',
        'confirm.no': 'Cancel',
        'notice.locked': 'This session is locked. Unlock it first.',
        'notice.alreadyBuffered': 'This session is already in the recycle bin.',
        'notice.deleted': '“{title}” moved to the recycle bin.',
        'notice.purged': '“{title}” was deleted for good.',
        'notice.restored': '“{title}” is back where it was.',
        'notice.purgeFailed': '“{title}” could not be deleted yet: {reason}',
        'notice.notBuffered': 'This session is no longer in the recycle bin.',
        'buffer.title': 'Recycle bin',
        'buffer.desc': 'These sessions are gone from the workspace list. Restore one to bring it back exactly as it was, or delete it for good now.',
        'buffer.empty': 'Empty. Deleted sessions wait here.',
        'buffer.restore': 'Restore',
        'buffer.purge': 'Delete now',
        'buffer.remaining': '{time} left',
        'buffer.pending': 'Expired, waiting: {note}',
        'buffer.purgeSoon': 'about to be deleted',
        'reason.running': 'it is in the middle of a turn; stop it and try again',
        'reason.archiveFailed': 'the workspace could not record the removal',
        'reason.moveFailed': 'the session log file could not be moved',
        'reason.noPersistence': 'this profile has no session storage',
        'reason.noLocation': 'the log file cannot be located',
        'reason.statFailed': 'could not locate the log file',
        'reason.readdirFailed': 'could not read the session folder',
        'reason.unlinkFailed': 'could not remove the log file',
        'reason.purgeFailed': 'deletion failed',
        'reason.liveBlocked': 'it is in the middle of a turn; stop it and try again',
        'reason.noMeta': 'the recycle bin is missing its restore information',
        'reason.missingLog': 'the session log file could not be found',
        'reason.deleteFailed': 'deletion failed',
        'reason.restoreFailed': 'restore failed',
        'reason.saveFailed': 'saving failed',
        'reason.readFailed': 'reading sessions failed',
        'reason.notLoopback': 'this page must be opened on the local address',
        'reason.badBody': 'the request was rejected',
        'reason.network': 'the Host could not be reached',
        'reason.timeout': 'the Host did not answer in time; try again',
        'reason.detachFailed': 'the workspace still lists it; try again',
        'reason.noRegistry': 'this profile has no workspace registry',
        'reason.noWorkspace': 'that workspace no longer exists',
        'reason.alreadyThere': 'it already belongs to that workspace',
        'reason.buffered': 'it is in the recycle bin; restore it first',
        'reason.noHeader': 'its stored header could not be read',
        'reason.noCwd': 'its header records no working directory, so it cannot be moved',
        'reason.migrateFailed': 'the move did not finish',
        'reason.needPermission': 'the system refused the file operation',
        'reason.noDirectory': 'the session folder on disk is missing',
        'time.minutes': '{n}m',
        'time.hours': '{n}h',
        'time.days': '{n}d',
        'time.justNow': 'just now',
        'time.ago': '{time} ago',
        'error.prefix': 'Request failed: ',
        'loading': 'Reading sessions…',
        'loading.failed': 'Could not read sessions.',
      },
      zh: {
        'common.retry': '重试',
        'section.label': '会话删除管理',
        'page.title': '会话删除管理',
        'page.desc': '按工作区列出所有会话，锁定的会话不能删除；删除先进缓冲站，到期才真正删掉。',
        'settings.title': '缓冲时长',
        'settings.hint': '进入缓冲站的会话在这段时间内都能回档，超时才真正删除日志。填 0 表示二次确认后立即彻底删除。',
        'settings.unit': '小时',
        'settings.save': '保存',
        'settings.reset': '恢复默认',
        'settings.saved': '已保存。',
        'settings.needNumber': '先填一个整数的时长。',
        'settings.range': '可填范围 {min}–{max} 小时',
        'reload.label': '刷新界面',
        'reload.hint': '重新加载这个页面并重新读取会话列表；删除后仍然显示的那一行就是靠它清掉的。',
        'reload.busy': '正在刷新…',
        'notice.reloadFailed': '这个页面不能自己刷新，请按 F12 打开开发者工具后按 Ctrl+R',
        'sessions.title': '会话',
        'sessions.empty': '没有会话。',
        'sessions.refresh': '刷新',
        'sessions.unnamed': '未命名',
        'sessions.expand': '展开其余 {count} 个会话',
        'sessions.collapse': '收起',
        'sessions.orphan': '未归属工作区',
        'sessions.subagent': '子代理',
        'sessions.locked': '已锁定',
        'sessions.live': '打开中',
        'sessions.running': '运行中',
        'sessions.missing': '日志缺失',
        'action.lock': '锁定',
        'action.unlock': '解锁',
        'action.delete': '删除',
        'action.adopt': '归位',
        'adopt.hint': '它的目录属于 {workspace}',
        'notice.adopted': '「{title}」已归位到 {workspace}。',
        'migrate.label': '迁移到工作区',
        'migrate.choose': '迁到…',
        'migrate.current': '当前',
        'migrate.confirm': '把「{title}」从 {from} 迁到 {to}？',
        'migrate.confirmHint': '磁盘上的日志目录会一起搬过去。需要重启 DSH 才会生效。',
        'migrate.yes': '迁移',
        'migrate.no': '取消',
        'notice.migrated': '「{title}」现在属于 {workspace}。重启 DSH 后左侧列表会跟着变。',
        'notice.migratedNoRestart': '「{title}」现在属于 {workspace}。',
        'notice.registrationOnly': '只改了归属。日志还在旧目录里，所以 DSH 下次重启后会把它放回「未分组」。',
        'notice.migrateNeedRestart': '磁盘已搬完，重启 DSH 后左侧列表才会更新。',
        'perm.title': '需要权限才能搬文件',
        'perm.body': '迁移「{title}」要改写会话头、并把日志目录搬到新位置。系统拒绝了其中一步，所以什么都没改。',
        'perm.paths': '从：{from}',
        'perm.pathsTo': '到：{to}',
        'perm.cannotElevate': 'DSH 没法给自己提权。如果那两个目录是只读的、或者属于别的账户，请先解决，再试一次。',
        'perm.allow': '我知道了，再试一次',
        'perm.registerOnly': '只改变归属',
        'perm.cancel': '取消',
        'notice.noWorkspaceForCwd': '没有工作区认领它的目录',
        'notice.noCwd': '这个会话没有记录目录',
        'notice.noHeader': '读不到这个会话的日志',
        'notice.noRegistry': '这个配置没有工作区注册表',
        'notice.adoptFailed': '归位失败',
        'confirm.delete': '确认删除「{title}」？会先进入删除缓冲站，{hours} 小时内可以回档。',
        'confirm.now': '确认彻底删除「{title}」？此操作无法撤销。',
        'confirm.purge': '彻底删除「{title}」？此操作无法撤销。',
        'confirm.yes': '确认删除',
        'confirm.no': '取消',
        'notice.locked': '这个会话已锁定，先解锁再删除。',
        'notice.alreadyBuffered': '这个会话已经在删除缓冲站里了。',
        'notice.deleted': '「{title}」已进入删除缓冲站。',
        'notice.purged': '「{title}」已彻底删除。',
        'notice.restored': '「{title}」已回档到原来的位置。',
        'notice.purgeFailed': '「{title}」暂时删不掉：{reason}',
        'notice.notBuffered': '这个会话已经不在删除缓冲站里了。',
        'buffer.title': '删除缓冲站',
        'buffer.desc': '这些会话已经从工作区列表消失。回档会原样恢复；「彻底删除」则立即销毁日志，不再等待到期。',
        'buffer.empty': '空。删除的会话会先在这里等一会儿。',
        'buffer.restore': '回档',
        'buffer.purge': '彻底删除',
        'buffer.remaining': '还剩 {time}',
        'buffer.pending': '已到期，等待清理：{note}',
        'buffer.purgeSoon': '即将删除',
        'reason.running': '它正在跑一个回合，停下来再删',
        'reason.archiveFailed': '工作区没能记录这次移除',
        'reason.moveFailed': '会话日志文件搬不动',
        'reason.noPersistence': '这个配置没有挂会话存储',
        'reason.noLocation': '定位不到日志文件',
        'reason.statFailed': '定位不到日志文件',
        'reason.readdirFailed': '读不了会话目录',
        'reason.unlinkFailed': '删不掉日志文件',
        'reason.purgeFailed': '删除失败',
        'reason.liveBlocked': '它正在跑一个回合，停下来再删',
        'reason.noMeta': '回收站里缺少还原信息',
        'reason.missingLog': '找不到会话日志文件',
        'reason.deleteFailed': '删除失败',
        'reason.restoreFailed': '回档失败',
        'reason.saveFailed': '保存失败',
        'reason.readFailed': '读取会话列表失败',
        'reason.notLoopback': '这个页面必须从本机地址打开',
        'reason.badBody': '请求被拒绝',
        'reason.network': '连不上宿主',
        'reason.timeout': '宿主迟迟没有响应，请重试',
        'reason.detachFailed': '工作区里还挂着它，请重试',
        'reason.noRegistry': '这个配置没有挂工作区登记表',
        'reason.noWorkspace': '那个工作区已经不在了',
        'reason.alreadyThere': '它已经属于那个工作区了',
        'reason.buffered': '它在删除缓冲站里，先回档再迁移',
        'reason.noHeader': '读不到它的会话头',
        'reason.noCwd': '会话头里没有工作目录，没法迁移',
        'reason.migrateFailed': '迁移没有完成',
        'reason.needPermission': '系统拒绝了文件操作',
        'reason.noDirectory': '磁盘上的会话目录不见了',
        'error.prefix': '请求失败：',
        'time.minutes': '{n}分',
        'time.hours': '{n}小时',
        'time.days': '{n}天',
        'time.justNow': '刚刚',
        'time.ago': '{time}前',
        'loading': '正在读取会话…',
        'loading.failed': '读取会话失败。',
      },
    }

    function format(dict, key, vars) {
      const template = dict[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
    }

    /** 语言包优先用 Harness 的 locale 服务，取不到就退回包内字典。 */
    function makeTranslate(locale, active) {
      const fallback = DICT[String(active || 'zh').slice(0, 2)] ?? DICT.zh
      const bound = locale === undefined ? undefined : locale.bind(LOCALE_NS)
      const translator = (key, vars) => {
        let value
        if (bound !== undefined) {
          try {
            value = bound(key, vars)
          } catch {
            value = undefined
          }
        }
        if (typeof value === 'string' && value !== key) return value
        return format(fallback, key, vars)
      }
      translator.dict = fallback
      return translator
    }

    /**
     * 把宿主返回的错误翻译成当前语言。
     * 宿主只给错误码（code）和原始消息，句子由界面拼，英文界面里不会冒出中文。
     */
    function describeError(t, result) {
      const code = result && typeof result.code === 'string' ? result.code : ''
      if (code !== '') {
        // 归位相关的错误码用 notice.* 文案，其余用 reason.*。
        const asNotice = t(`notice.${code}`)
        if (asNotice !== `notice.${code}`) return asNotice
        const known = t(`reason.${code}`)
        if (known !== `reason.${code}`) return known
      }
      const detail = result && typeof result.error === 'string' ? result.error : ''
      return detail !== '' ? t('error.prefix') + detail : t('error.prefix') + 'HTTP'
    }

    // ---------------------------------------------------------------- 宿主调用

    /**
     * 统一成 {ok, ...}；页面只处理一种形状。
     *
     * 一定要有超时：宿主那边的删除要等会话退出内存（最长 3 秒，见 DETACH_TIMEOUT_MS），
     * 万一它卡住不回，fetch 会一直挂着，`busy` 就永远不为 null——页面上所有按钮
     * 从此点不动，只能刷新。这里 30 秒兜底，超时按 network 错误报出去。
     */
    async function callHost(action, payload) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HOST_TIMEOUT_MS)
      try {
        const response = await fetch(`${ROUTE_PREFIX}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal: controller.signal,
        })
        let parsed = null
        try {
          parsed = await response.json()
        } catch {
          parsed = null
        }
        if (parsed === null || typeof parsed !== 'object') {
          return { ok: false, status: response.status }
        }
        if (!response.ok && parsed.ok !== false) {
          return { ...parsed, ok: false, status: response.status }
        }
        return parsed
      } catch (error) {
        if (error && error.name === 'AbortError') return { ok: false, code: 'timeout' }
        return { ok: false, code: 'network', error: error && error.message ? error.message : String(error) }
      } finally {
        clearTimeout(timer)
      }
    }

    // ---------------------------------------------------------------- 小图标

    function TrashGlyph({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 7h16', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M6.6 7l.8 11.2c.05.98.88 1.8 1.86 1.8h5.48c.98 0 1.81-.82 1.86-1.8L17.4 7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M10.4 11.2v5.4M13.6 11.2v5.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function LockGlyph({ locked, size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', {
          x: 5, y: 10.5, width: 14, height: 9.5, rx: 2.2,
          stroke: 'currentColor', strokeWidth: 1.7,
          fill: locked ? 'currentColor' : 'none',
          fillOpacity: locked ? 0.14 : 0,
        }),
        h('path', {
          d: locked ? 'M8.4 10.5V8.2a3.6 3.6 0 0 1 7.2 0v2.3' : 'M8.4 10.5V8.2a3.6 3.6 0 0 1 6.6-2',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        }),
      )
    }

    function FolderGlyph({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.6 7.2c0-1 .8-1.8 1.8-1.8h3.4l1.6 1.9h8.2c1 0 1.8.8 1.8 1.8v7.7c0 1-.8 1.8-1.8 1.8H5.4c-1 0-1.8-.8-1.8-1.8V7.2Z',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round',
        }),
      )
    }

    function RestoreGlyph({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4.6 12a7.4 7.4 0 1 0 2.3-5.35', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M4.2 4.6v4.1h4.1', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** 双向循环箭头：刷新整页。 */
    function ReloadGlyph({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M20 11.2a8 8 0 0 0-13.6-5.1L4 8.5',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', { d: 'M4 4.2v4.3h4.3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', {
          d: 'M4 12.8a8 8 0 0 0 13.6 5.1L20 15.5',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', { d: 'M20 19.8v-4.3h-4.3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    // ---------------------------------------------------------------- 样式

    let styleCache = null
    function pageStyles() {
      if (styleCache !== null) return styleCache
      const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      styleCache = {
        page: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
          maxWidth: 720,
          color: 'var(--dsw-alias-label-primary)',
          font: '13px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        },
        head: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 10, rowGap: 2, alignItems: 'center' },
        glyph: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, gridRow: 'span 2', color: 'var(--dsw-alias-label-primary)' },
        title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
        desc: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
        card: {
          padding: '14px 16px 16px',
          borderRadius: 'var(--dsw-radius-xl)',
          // 设置页的卡片用 settings-card-* 这一对：浅色主题下 bg-layer-1/2 是同一个
          // 白色，只有它能让卡片和页面分开。
          border: '1px solid var(--dsw-alias-settings-card-stroke)',
          background: 'var(--dsw-alias-settings-card-fill)',
        },
        cardHead: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px' },
        cardTitle: { margin: 0, fontSize: 12.5, fontWeight: 600 },
        cardHint: { margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
        row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
        input: {
          width: 88,
          height: 32,
          padding: '0 8px',
          boxSizing: 'border-box',
          textAlign: 'right',
          fontSize: 13,
          fontFamily: mono,
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-md)',
        },
        unit: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        buttonPrimary: {
          height: 32,
          padding: '0 16px',
          fontSize: 12.5,
          fontWeight: 600,
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary-foreground)',
          background: 'var(--dsw-alias-button-primary-fill)',
          border: '1px solid transparent',
        },
        buttonGhost: {
          height: 30,
          padding: '0 12px',
          fontSize: 12.5,
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        buttonDanger: {
          height: 30,
          padding: '0 12px',
          fontSize: 12.5,
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
          color: 'var(--dsw-alias-state-error-primary)',
          background: 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        buttonDangerSolid: {
          height: 30,
          padding: '0 12px',
          fontSize: 12.5,
          fontWeight: 600,
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary-foreground)',
          background: 'var(--dsw-alias-state-error-primary)',
          border: '1px solid transparent',
        },
        buttonIcon: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
        },
        buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
        // 迁移下拉：和 ghost 按钮同高，跟着主题走，不自绘箭头。
        pick: {
          height: 32,
          padding: '0 8px',
          fontSize: 13,
          boxSizing: 'border-box',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
        },
        // 「展开其余 N 个」：看起来像一行灰字，不像按钮挤在一起，但整行都可点。
        collapse: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          width: '100%',
          marginTop: 2,
          padding: '6px 10px',
          fontSize: 12,
          textAlign: 'left',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'transparent',
          border: '1px dashed var(--dsw-alias-border-l1)',
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
        },
        collapseNote: { fontSize: 11, opacity: 0.8 },
        select: {
          height: 30,
          maxWidth: 150,
          padding: '0 8px',
          fontSize: 12.5,
          boxSizing: 'border-box',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-md)',
          cursor: 'pointer',
        },
        dialog: {
          padding: '14px 16px 16px',
          borderRadius: 'var(--dsw-radius-xl)',
          border: '1px solid var(--dsw-alias-state-warn-primary)',
          background: 'var(--dsw-alias-settings-card-fill)',
        },
        dialogTitle: { margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-warn-primary)' },
        dialogBody: { margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.6 },
        dialogHint: { margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
        pathBox: {
          margin: '0 0 10px',
          padding: '8px 10px',
          fontSize: 11.5,
          fontFamily: mono,
          lineHeight: 1.6,
          overflowX: 'auto',
          whiteSpace: 'pre',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 'var(--dsw-radius-md)',
        },
        group: { marginTop: 12 },
        groupHead: {
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '4px 2px 6px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-secondary)',
        },
        groupPath: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        list: { display: 'flex', flexDirection: 'column', gap: 4 },
        sessionRow: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 10,
          alignItems: 'center',
          padding: '7px 10px',
          borderRadius: 'var(--dsw-radius-md)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
        },
        sessionRowConfirm: { outline: '1px solid var(--dsw-alias-state-error-primary)' },
        sessionMain: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
        sessionTitle: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        sessionMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8, flexWrap: 'wrap' },
        sessionActions: { display: 'flex', alignItems: 'center', gap: 6 },
        badge: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '0 6px',
          height: 18,
          borderRadius: 'var(--dsw-radius-sm)',
          fontSize: 10.5,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        badgeLocked: { color: 'var(--dsw-alias-label-primary)' },
        badgeWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
        confirmBar: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '8px 10px',
          borderRadius: 'var(--dsw-radius-md)',
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        confirmText: { flex: '1 1 220px', minWidth: 0 },
        notice: {
          marginTop: 8,
          padding: '7px 9px',
          borderRadius: 'var(--dsw-radius-md)',
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-line',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        noticeError: { color: 'var(--dsw-alias-state-error-primary)' },
        noticeOk: { color: 'var(--dsw-alias-label-primary)' },
        empty: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' },
      }
      return styleCache
    }

    // ---------------------------------------------------------------- 时间

    /** 相对时间；单位走语言包，英文界面不会冒出「小时前」。 */
    function relativeTime(timestamp, now, t) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
      const diff = Math.max(0, now - timestamp)
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return t('time.justNow')
      let time
      if (diff < hour) time = t('time.minutes', { n: Math.floor(diff / minute) })
      else if (diff < day) time = t('time.hours', { n: Math.floor(diff / hour) })
      else if (diff < 30 * day) time = t('time.days', { n: Math.floor(diff / day) })
      else return new Date(timestamp).toLocaleDateString()
      return t('time.ago', { time })
    }

    function remainingTime(expiresAt, now, t) {
      const left = expiresAt - now
      if (left <= 0) return t('buffer.purgeSoon')
      const totalMinutes = Math.ceil(left / 60_000)
      const days = Math.floor(totalMinutes / (60 * 24))
      const hours = Math.floor((totalMinutes - days * 60 * 24) / 60)
      const minutes = totalMinutes % 60
      // 只显示两级：天+小时 / 小时+分 / 分，单位跟语言走。
      // 两级之间用 ' ' 隔开：直接拼会是「1天3小时」「1d3h」，读起来糊成一团。
      if (days > 0) return `${t('time.days', { n: days })} ${t('time.hours', { n: hours })}`
      if (hours > 0) return `${t('time.hours', { n: hours })} ${t('time.minutes', { n: minutes })}`
      return t('time.minutes', { n: minutes })
    }

    // ---------------------------------------------------------------- 设置页

    function SessionManagerSection() {
      const { useCallback, useEffect, useMemo, useRef, useState } = React
      const style = useMemo(pageStyles, [])
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [confirming, setConfirming] = useState(null)
      // 迁移确认：{ sessionId, workspaceId, title }，选定目标工作区后出现。
      const [migrateConfirm, setMigrateConfirm] = useState(null)
      // 权限申请：{ sessionId, workspaceId, title, plan }，宿主报 needPermission 时出现。
      const [migrateAsk, setMigrateAsk] = useState(null)
      const [reloading, setReloading] = useState(false)
      // 哪些工作区被手动展开了（默认只显示 showCount 个）。
      const [expandedGroups, setExpandedGroups] = useState(() => new Set())
      const [now, setNow] = useState(() => Date.now())
      const aliveRef = useRef(true)

      const translate = useTranslate()
      const t = translate

      const applyView = useCallback((next) => {
        if (!aliveRef.current) return
        if (next && next.ok === true) {
          setView(next)
          setDraft((current) => (current === null ? String(next.settings.bufferHours) : current))
          setNow(Date.now())
        }
      }, [])

      const refresh = useCallback(async () => {
        const next = await callHost('state', {})
        if (!next.ok) {
          if (aliveRef.current) setNotice({ tone: 'error', text: describeError(t, next) })
          return next
        }
        applyView(next)
        return next
      }, [applyView, t])

      useEffect(() => {
        aliveRef.current = true
        void refresh()
        return () => {
          aliveRef.current = false
        }
      }, [refresh])

      // 只负责刷新「还剩多久」的本地时钟，不重复拉数据。
      useEffect(() => {
        const timer = setInterval(() => {
          if (aliveRef.current) setNow(Date.now())
        }, 15_000)
        return () => clearInterval(timer)
      }, [])

      // 有条目到点时拉一次，让宿主把真正删掉的会话移出缓冲站。
      const dueSignature = view === null
        ? ''
        : view.buffer.filter((entry) => entry.expiresAt <= now).map((entry) => entry.sessionId).join(',')
      useEffect(() => {
        if (dueSignature === '') return
        const timer = setTimeout(() => void refresh(), 3_000)
        return () => clearTimeout(timer)
      }, [dueSignature, refresh])

      const run = useCallback(
        async (key, action, payload, onDone, onFail) => {
          if (busy !== null) return
          setBusy(key)
          setNotice(null)
          const result = await callHost(action, payload)
          if (!aliveRef.current) return
          setBusy(null)
          if (result.ok !== true) {
            // 有些失败不是错误，而是需要用户先做一个决定（比如「要不要为此申请权限」）。
            // onFail 返回 true 表示它已经接管了这条结果。
            if (onFail !== undefined && onFail(result) === true) return
            setNotice({ tone: 'error', text: describeError(t, result) })
            return
          }
          if (result.view !== undefined) applyView(result.view)
          else applyView(result)
          if (onDone !== undefined) onDone(result)
        },
        [busy, applyView, t],
      )

      const noticeNode = notice === null
        ? null
        : h('div', {
            role: notice.tone === 'error' ? 'alert' : 'status',
            style: Object.assign(
              {},
              style.notice,
              { marginTop: 0 },
              notice.tone === 'error' ? style.noticeError : style.noticeOk,
            ),
          }, notice.text)

      // 权限申请框：只有真去搬文件、而系统拒绝了那一步时才出现。
      // 这里说的「申请权限」不是提权（DSH 提不了权），而是把要做的每一步
      // 和真实路径摆清楚，让用户明白自己在同意什么，然后再试一次。
      const permissionNode = migrateAsk === null
        ? null
        : h('div', { style: style.dialog },
            h('h3', { style: style.dialogTitle }, t('perm.title')),
            h('p', { style: style.dialogBody }, t('perm.body', { title: migrateAsk.title })),
            h('div', { style: style.pathBox },
              t('perm.paths', { from: migrateAsk.plan?.fromDir ?? migrateAsk.plan?.fromCwd ?? '?' }),
              '\n',
              t('perm.pathsTo', { to: migrateAsk.plan?.toDir ?? migrateAsk.plan?.toCwd ?? '?' }),
            ),
            h('p', { style: style.dialogHint }, t('perm.cannotElevate')),
            h('div', { style: style.row },
              h('button', {
                type: 'button',
                style: Object.assign({}, style.buttonPrimary, busy !== null ? style.buttonDisabled : null),
                disabled: busy !== null,
                onClick: () => {
                  const ask = migrateAsk
                  setMigrateAsk(null)
                  void run(`migrate:${ask.sessionId}`, 'migrate', {
                    sessionId: ask.sessionId,
                    workspaceId: ask.workspaceId,
                    mode: 'full',
                  }, (result) => {
                    const to = (view.workspaces.find((item) => item.workspaceId === ask.workspaceId) ?? {}).title ?? ''
                    if (result.mode === 'full') setNotice({ tone: 'ok', text: t('notice.migrated', { title: ask.title, workspace: to }) })
                    else setNotice({ tone: 'ok', text: t('notice.registrationOnly', { title: ask.title }) })
                  }, (failure) => {
                    if (failure.code !== 'needPermission') return false
                    setMigrateAsk({ ...ask, plan: failure.plan ?? ask.plan, detail: failure.detail ?? '' })
                    return true
                  })
                },
              }, t('perm.allow')),
              h('button', {
                type: 'button',
                style: Object.assign({}, style.buttonGhost, busy !== null ? style.buttonDisabled : null),
                disabled: busy !== null,
                onClick: () => {
                  const ask = migrateAsk
                  setMigrateAsk(null)
                  void run(`migrate:${ask.sessionId}`, 'migrate', {
                    sessionId: ask.sessionId,
                    workspaceId: ask.workspaceId,
                    mode: 'registrationOnly',
                  }, () => setNotice({ tone: 'ok', text: t('notice.registrationOnly', { title: ask.title }) }))
                },
              }, t('perm.registerOnly')),
              h('button', { type: 'button', style: style.buttonGhost, onClick: () => setMigrateAsk(null) }, t('perm.cancel')),
            ),
          )

      if (view === null) {
        // 首次读取失败必须能看见也能重试，否则只会永远停在「正在读取会话…」。
        return h('div', { style: style.page },
          h('div', { style: style.card },
            notice !== null ? t('loading.failed') : t('loading'),
            noticeNode,
            notice === null
              ? null
              : h('div', { style: style.row },
                  h('button', {
                    type: 'button',
                    style: style.buttonPrimary,
                    onClick: () => {
                      setNotice(null)
                      void refresh()
                    },
                  }, t('common.retry')),
                ),
          ),
        )
      }

      const settings = view.settings
      const limits = view.limits?.bufferHours ?? { min: 0, max: 720, step: 1 }
      const bufferHours = settings.bufferHours
      // 老版本宿主没有这两个字段，缺了也不能让整页崩：退回插件的默认值。
      const showCount = Number.isFinite(settings.showCount) ? settings.showCount : 5
      const groups = buildGroups(view, t)
      const showSecondConfirm = bufferHours > 0

      const confirmText = (session) => {
        const title = session.title.trim() === '' ? t('sessions.unnamed') : session.title
        return showSecondConfirm
          ? t('confirm.delete', { title, hours: bufferHours })
          : t('confirm.now', { title })
      }

      return h('div', { style: style.page },
        h('div', { style: style.head },
          h('span', { style: style.glyph }, h(TrashGlyph, { size: 24 })),
          h('h2', { style: style.title }, t('page.title')),
          h('p', { style: style.desc }, t('page.desc')),
        ),

        // 刷新整页：DSH 的会话清单在浏览器里是一份内存快照，删掉的会话要等它重新
        // 拉一次才会从左侧消失。DSH 自己在升级提示里就是用 location.reload() 做的，
        // 桌面版正式发行的菜单里没有「刷新页面」，所以这里给一个入口。
        h('div', { style: style.card },
          h('div', { style: style.cardHead }, h('h3', { style: style.cardTitle }, t('reload.label'))),
          h('p', { style: style.cardHint }, t('reload.hint')),
          h('div', { style: style.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonGhost, style.buttonIcon, reloading ? style.buttonDisabled : null),
              disabled: reloading,
              onClick: () => {
                if (reloading) return
                setReloading(true)
                const reload = globalThis.location && globalThis.location.reload
                if (typeof reload === 'function') {
                  try {
                    reload.call(globalThis.location)
                  } catch {
                    setReloading(false)
                    setNotice({ tone: 'error', text: t('notice.reloadFailed') })
                  }
                } else {
                  setReloading(false)
                  setNotice({ tone: 'error', text: t('notice.reloadFailed') })
                }
              },
            }, h(ReloadGlyph, { size: 13 }), reloading ? t('reload.busy') : t('reload.label')),
          ),
        ),

        // 提示放在页头下面：动作可能来自列表中间，提示得在看得见的地方。
        noticeNode,
        permissionNode,

        // 缓冲时长
        h('div', { style: style.card },
          h('div', { style: style.cardHead }, h('h3', { style: style.cardTitle }, t('settings.title'))),
          h('p', { style: style.cardHint }, t('settings.hint')),
          h('div', { style: style.row },
            // 用 text + inputMode 而不是 number：数字框会把滚轮当成改值，
            // 设置页一滚就悄悄改掉缓冲时长。
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              pattern: '[0-9]*',
              style: style.input,
              value: draft ?? String(bufferHours),
              maxLength: String(limits.max).length,
              'aria-label': t('settings.title'),
              title: t('settings.range', { min: limits.min, max: limits.max }),
              onChange: (event) => {
                const next = event.target.value.replace(/[^\d]/g, '')
                setDraft(next)
              },
            }),
            h('span', { style: style.unit }, t('settings.unit')),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonPrimary, busy === 'settings' ? style.buttonDisabled : null),
              disabled: busy !== null,
              onClick: () => {
                // 空输入不能当成 0：那等于把每次删除都变成不可撤销。
                const raw = draft ?? String(bufferHours)
                if (raw === '') {
                  setNotice({ tone: 'error', text: t('settings.needNumber') })
                  return
                }
                void run('settings', 'settings', { bufferHours: Number(raw) }, () => {
                  setDraft(null)
                  setNotice({ tone: 'ok', text: t('settings.saved') })
                })
              },
            }, t('settings.save')),
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonGhost, busy !== null ? style.buttonDisabled : null),
              disabled: busy !== null,
              onClick: () =>
                void run('settings', 'settings', { reset: true }, (result) => {
                  setDraft(String(result?.settings?.bufferHours ?? 24))
                  setNotice({ tone: 'ok', text: t('settings.saved') })
                }),
            }, t('settings.reset')),
          ),
        ),

        // 会话列表
        h('div', { style: style.card },
          h('div', { style: style.cardHead },
            h('h3', { style: style.cardTitle }, t('sessions.title')),
            h('span', { style: style.badge }, String(view.sessions.length)),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonGhost, busy !== null ? style.buttonDisabled : null),
              disabled: busy !== null,
              onClick: () => void run('refresh', 'state', {}, () => setConfirming(null)),
            }, t('sessions.refresh')),
          ),
          groups.length === 0
            ? h('div', { style: style.empty }, t('sessions.empty'))
            : groups.map((group) => {
                // 每个工作区只展开 showCount 个，其余折在后面。
                // 这个数字和 DSH 自己侧栏的折叠保持一致（都写死成 5），
                // 两边看起来才是一个东西。
                const isExpanded = expandedGroups.has(group.key)
                const visible = isExpanded ? group.sessions : group.sessions.slice(0, showCount)
                const stillHidden = group.sessions.length - visible.length
                return h('div', { key: group.key, style: style.group },
                  h('div', { style: style.groupHead },
                    h(FolderGlyph, { size: 13 }),
                    h('span', { style: { whiteSpace: 'nowrap' } }, group.title),
                    group.path === '' ? null : h('span', { style: style.groupPath }, group.path),
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: style.badge }, `${visible.length}/${group.sessions.length}`),
                  ),
                  h('div', { style: style.list },
                    visible.map((session) => {
                      const title = session.title.trim() === '' ? t('sessions.unnamed') : session.title
                      const locked = session.locked
                      const isConfirming = confirming === session.sessionId
                      const isMigrating = migrateConfirm !== null && migrateConfirm.sessionId === session.sessionId
                      const rowStyle = isConfirming || isMigrating
                        ? Object.assign({}, style.sessionRow, style.sessionRowConfirm)
                        : style.sessionRow
                      return h('div', { key: session.sessionId, style: rowStyle },
                        h('div', { style: style.sessionMain },
                          h('span', { style: style.sessionTitle, title }, title),
                          h('span', { style: style.sessionMeta },
                            session.updatedAt > 0 ? h('span', null, relativeTime(session.updatedAt, now, t)) : null,
                            // 两个状态分开显示：「正在运行」是硬拦（这时候动日志会丢对话），
                            // 「打开中」只是还挂在内存里，删除会走「先归档、退出内存后补搬」。
                            session.running === true
                              ? h('span', { style: Object.assign({}, style.badge, style.badgeWarn) }, t('sessions.running'))
                              : null,
                            session.running !== true && session.live === true
                              ? h('span', { style: style.badge }, t('sessions.live'))
                              : null,
                            locked ? h('span', { style: Object.assign({}, style.badge, style.badgeLocked) }, h(LockGlyph, { locked: true, size: 11 }), t('sessions.locked')) : null,
                            session.subagent === true ? h('span', { style: style.badge }, t('sessions.subagent')) : null,
                            session.missing === true ? h('span', { style: style.badge }, t('sessions.missing')) : null,
                            // 未分组、但目录属于某个工作区：告诉用户它本来该在哪。
                            session.adoptIntoTitle ? h('span', { style: style.badge }, t('adopt.hint', { workspace: session.adoptIntoTitle })) : null,
                          ),
                        ),
                        h('div', { style: style.sessionActions },
                          // 迁移目标下拉：列出当前 DSH 的所有工作区，选中一个就弹确认条。
                          // 锁定的会话不允许迁移，这里直接禁用并说明原因。
                          h('select', {
                            style: Object.assign({}, style.select, locked || busy !== null ? style.buttonDisabled : null),
                            value: '',
                            disabled: locked || busy !== null,
                            title: locked ? t('sessions.locked') : t('migrate.label'),
                            'aria-label': t('migrate.label'),
                            onChange: (event) => {
                              const workspaceId = event.target.value
                              if (workspaceId === '') return
                              setConfirming(null)
                              setMigrateConfirm({ sessionId: session.sessionId, workspaceId, title })
                              // 让下拉回到占位项，否则选过一次就再也选不动同一个工作区。
                              event.target.value = ''
                            },
                          },
                            h('option', { value: '' }, t('migrate.choose')),
                            view.workspaces.map((workspace) =>
                              h('option', {
                                key: workspace.workspaceId,
                                value: workspace.workspaceId,
                                disabled: workspace.workspaceId === session.workspaceId,
                              },
                                `${workspace.title}${workspace.workspaceId === session.workspaceId ? ` (${t('migrate.current')})` : ''}`,
                              ),
                            ),
                          ),
                          session.adoptIntoTitle
                            ? h('button', {
                                type: 'button',
                                style: Object.assign({}, style.buttonGhost, style.buttonIcon, busy !== null ? style.buttonDisabled : null),
                                disabled: busy !== null,
                                title: t('adopt.hint', { workspace: session.adoptIntoTitle }),
                                onClick: () =>
                                  void run(`adopt:${session.sessionId}`, 'adopt', { sessionId: session.sessionId }, () => {
                                    setNotice({ tone: 'ok', text: t('notice.adopted', { title, workspace: session.adoptIntoTitle }) })
                                  }),
                              }, h(FolderGlyph, { size: 13 }), t('action.adopt'))
                            : null,
                          h('button', {
                            type: 'button',
                            style: Object.assign({}, style.buttonGhost, style.buttonIcon, busy !== null ? style.buttonDisabled : null),
                            disabled: busy !== null,
                            title: locked ? t('action.unlock') : t('action.lock'),
                            onClick: () =>
                              void run(`lock:${session.sessionId}`, 'lock', { sessionId: session.sessionId, locked: !locked }, () => setConfirming(null)),
                          }, h(LockGlyph, { locked, size: 13 }), locked ? t('action.unlock') : t('action.lock')),
                          h('button', {
                            type: 'button',
                            style: Object.assign(
                              {},
                              locked ? style.buttonGhost : style.buttonDanger,
                              style.buttonIcon,
                              locked || busy !== null ? style.buttonDisabled : null,
                            ),
                            disabled: locked || busy !== null,
                            title: locked ? t('sessions.locked') : t('action.delete'),
                            onClick: () => setConfirming(isConfirming ? null : session.sessionId),
                          }, h(TrashGlyph, { size: 13 }), t('action.delete')),
                        ),
                        isConfirming
                          ? h('div', { style: Object.assign({}, style.confirmBar, { gridColumn: '1 / -1' }) },
                              h('span', { style: style.confirmText }, confirmText(session)),
                              h('button', {
                                type: 'button',
                                style: Object.assign({}, style.buttonDangerSolid, busy !== null ? style.buttonDisabled : null),
                                disabled: busy !== null,
                                onClick: () =>
                                  void run(`delete:${session.sessionId}`, 'delete', {
                                    sessionId: session.sessionId,
                                    title: session.title,
                                    workspaceId: session.workspaceId ?? '',
                                    workspaceTitle: group.title,
                                  }, (result) => {
                                    setConfirming(null)
                                    if (result.purged === true) {
                                      setNotice({ tone: 'ok', text: t('notice.purged', { title }) })
                                    } else if (typeof result.code === 'string' && result.code !== '') {
                                      setNotice({
                                        tone: 'error',
                                        text: t('notice.purgeFailed', { title, reason: describeError(t, result) }),
                                      })
                                    } else {
                                      setNotice({ tone: 'ok', text: t('notice.deleted', { title }) })
                                    }
                                  }),
                              }, t('confirm.yes')),
                              h('button', {
                                type: 'button',
                                style: style.buttonGhost,
                                disabled: busy !== null,
                                onClick: () => setConfirming(null),
                              }, t('confirm.no')),
                            )
                          : null,
                        isMigrating
                          ? h('div', { style: Object.assign({}, style.confirmBar, { gridColumn: '1 / -1' }) },
                              h('span', { style: style.confirmText },
                                t('migrate.confirm', {
                                  title,
                                  from: group.title,
                                  to: (view.workspaces.find((item) => item.workspaceId === migrateConfirm.workspaceId) ?? {}).title ?? '?',
                                }),
                                ' ',
                                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('migrate.confirmHint')),
                              ),
                              h('button', {
                                type: 'button',
                                style: Object.assign({}, style.buttonPrimary, busy !== null ? style.buttonDisabled : null),
                                disabled: busy !== null,
                                onClick: () => {
                                  const target = migrateConfirm
                                  setMigrateConfirm(null)
                                  void run(`migrate:${session.sessionId}`, 'migrate', {
                                    sessionId: session.sessionId,
                                    workspaceId: target.workspaceId,
                                    mode: 'full',
                                  }, (result) => {
                                    const to = (view.workspaces.find((item) => item.workspaceId === target.workspaceId) ?? {}).title ?? ''
                                    if (result.mode === 'full') {
                                      setNotice({ tone: 'ok', text: t('notice.migrated', { title, workspace: to }) })
                                    } else {
                                      setNotice({ tone: 'ok', text: t('notice.registrationOnly', { title }) })
                                    }
                                  }, (failure) => {
                                    // 权限不够：不是报错，而是先问用户。把将要做的每一步
                                    // 和真实的两个路径摆在对话框里，让他知道自己在同意什么。
                                    if (failure.code !== 'needPermission') return false
                                    setMigrateAsk({ ...target, plan: failure.plan ?? {}, detail: failure.detail ?? '' })
                                    return true
                                  })
                                },
                              }, t('migrate.yes')),
                              h('button', {
                                type: 'button',
                                style: style.buttonGhost,
                                disabled: busy !== null,
                                onClick: () => setMigrateConfirm(null),
                              }, t('migrate.no')),
                            )
                          : null,
                      )
                    }),
                    // 折叠行：只在还有东西看不见时出现。
                    // 点一下在工作区内就地展开，不重建整页——用户刚点的位置不变。
                    stillHidden > 0
                      ? h('button', {
                          type: 'button',
                          style: style.collapse,
                          onClick: () => {
                            setExpandedGroups((current) => {
                              const next = new Set(current)
                              if (isExpanded) next.delete(group.key)
                              else next.add(group.key)
                              return next
                            })
                          },
                        },
                          isExpanded
                            ? t('sessions.collapse')
                            : t('sessions.expand', { count: stillHidden }),
                        )
                      : null,
                  ),
                )
              }),
        ),

        // 删除缓冲站
        h('div', { style: style.card },
          h('div', { style: style.cardHead },
            h('h3', { style: style.cardTitle }, t('buffer.title')),
            h('span', { style: style.badge }, String(view.buffer.length)),
          ),
          h('p', { style: style.cardHint }, t('buffer.desc')),
          view.buffer.length === 0
            ? h('div', { style: style.empty }, t('buffer.empty'))
            : h('div', { style: style.list },
                view.buffer.map((entry) => {
                  const title = entry.title.trim() === '' ? t('sessions.unnamed') : entry.title
                  const isPurging = confirming === `purge:${entry.sessionId}`
                  // 确认条必须占**整行**（gridColumn: '1 / -1'），不能塞进右侧的
                  // sessionActions 里。右列是 auto 宽的，而确认条里的文字要 220px，
                  // 两下一夹就把左列（minmax(0,1fr)）压到几乎 0 宽，
                  // 中文会变成一个字一行。会话列表一直是这么写的，这里原来漏了。
                  return h('div', {
                    key: entry.sessionId,
                    style: isPurging
                      ? Object.assign({}, style.sessionRow, style.sessionRowConfirm)
                      : style.sessionRow,
                  },
                    h('div', { style: style.sessionMain },
                      h('span', { style: style.sessionTitle, title }, title),
                      h('span', { style: style.sessionMeta },
                        entry.workspaceTitle === '' ? null : h('span', null, entry.workspaceTitle),
                        entry.pending === true
                          ? h('span', null, t('buffer.pending', { note: describeError(t, { code: entry.note, error: entry.noteDetail }) }))
                          : h('span', null, t('buffer.remaining', { time: remainingTime(entry.expiresAt, now, t) })),
                      ),
                    ),
                    h('div', { style: style.sessionActions },
                      h('button', {
                        type: 'button',
                        style: Object.assign({}, style.buttonGhost, style.buttonIcon, busy !== null ? style.buttonDisabled : null),
                        disabled: busy !== null,
                        title: t('buffer.restore'),
                        onClick: () =>
                          void run(`restore:${entry.sessionId}`, 'restore', { sessionId: entry.sessionId }, () => {
                            setNotice({ tone: 'ok', text: t('notice.restored', { title }) })
                          }),
                      }, h(RestoreGlyph, { size: 13 }), t('buffer.restore')),
                      // 彻底删除不可撤销，而且紧挨着「回档」，误点代价是日志没了。
                      // 所以这里也要一次行内确认：第一次点变成「确认删除？是 / 否」，
                      // 和上面列表里的删除按钮同一套交互。
                      isPurging
                        ? null
                        : h('button', {
                            type: 'button',
                            style: Object.assign({}, style.buttonDanger, style.buttonIcon, busy !== null ? style.buttonDisabled : null),
                            disabled: busy !== null,
                            title: t('buffer.purge'),
                            onClick: () => setConfirming(`purge:${entry.sessionId}`),
                          }, h(TrashGlyph, { size: 13 }), t('buffer.purge')),
                    ),
                    isPurging
                      ? h('div', { style: Object.assign({}, style.confirmBar, { gridColumn: '1 / -1' }) },
                          h('span', { style: style.confirmText }, t('confirm.purge', { title })),
                          h('button', {
                            type: 'button',
                            style: Object.assign({}, style.buttonDanger, style.buttonIcon, busy !== null ? style.buttonDisabled : null),
                            disabled: busy !== null,
                            onClick: () => {
                              setConfirming(null)
                              void run(
                                `purge:${entry.sessionId}`,
                                'purge',
                                { sessionId: entry.sessionId },
                                () => setNotice({ tone: 'ok', text: t('notice.purged', { title }) }),
                              )
                            },
                          }, t('confirm.yes')),
                          h('button', {
                            type: 'button',
                            style: style.buttonGhost,
                            disabled: busy !== null,
                            onClick: () => setConfirming(null),
                          }, t('confirm.no')),
                        )
                      : null,
                  )
                }),
              ),
        ),
      )
    }

    /** 按工作区分组；不在任何工作区里的会话落到最后一组。 */
    function buildGroups(view, t) {
      const byWorkspace = new Map()
      for (const workspace of view.workspaces) byWorkspace.set(workspace.workspaceId, [])
      const orphans = []
      const order = view.workspaces.map((workspace) => workspace.workspaceId)
      for (const session of view.sessions) {
        const bucket = byWorkspace.get(session.workspaceId)
        if (bucket === undefined) orphans.push(session)
        else bucket.push(session)
      }
      const groups = []
      for (const workspaceId of order) {
        const sessions = byWorkspace.get(workspaceId) ?? []
        if (sessions.length === 0) continue
        const workspace = view.workspaces.find((item) => item.workspaceId === workspaceId)
        groups.push({
          key: workspaceId,
          title: workspace?.title ?? '',
          path: workspace?.path ?? '',
          sessions: [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
        })
      }
      if (orphans.length > 0) {
        groups.push({
          key: '__orphan__',
          title: t('sessions.orphan'),
          path: '',
          sessions: [...orphans].sort((left, right) => right.updatedAt - left.updatedAt),
        })
      }
      return groups
    }

    /** 当前语言：优先 Harness 的 locale 服务，切换语言时重新渲染。 */
    const localeState = { service: undefined, active: 'zh' }

    function useTranslate() {
      const { useEffect, useMemo, useState } = React
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        const service = localeState.service
        if (service === undefined || typeof service.subscribe !== 'function') return undefined
        return service.subscribe(() => setRevision((value) => value + 1))
      }, [])
      // 必须 memo：translate 的身份变化会让所有 useCallback/useEffect 依赖它，
      // 每次渲染都重建会退化成不停重拉数据。
      return useMemo(() => makeTranslate(localeState.service, localeState.active), [revision])
    }

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 语言包：en / zh 各一份，其余语言沿 fallback 链回落到 en。
        const dicts = DICT
        for (const [localeId, dict] of Object.entries(dicts)) {
          ctx.effect(() => ctx.locale.register(LOCALE_NS, localeId, dict), `dsh-session-manager: locale ${localeId}`)
        }
        localeState.service = ctx.locale
        localeState.active = ctx.locale.getLocale?.().active ?? 'zh'

        ctx.effect(() => {
          const dispose = ctx.locale.subscribe?.(() => {
            localeState.active = ctx.locale.getLocale?.().active ?? localeState.active
          })
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, 'dsh-session-manager: locale tracking')

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 50,
              label: () => makeTranslate(ctx.locale, ctx.locale.getLocale?.().active ?? 'zh')('section.label'),
            },
            SessionManagerSection,
          ),
        )

        // 导航图标按 id 派发，两处 id 必须逐字相同
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, (props) =>
            h(TrashGlyph, { size: props && props.size ? props.size : 16 }),
          ),
        )
      },
    }
  },
})
