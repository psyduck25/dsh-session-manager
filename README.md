# dsh-session-manager（会话删除管理）

`@psyduck25/dsh-session-manager` · [npm](https://www.npmjs.com/package/@psyduck25/dsh-session-manager) · MIT

```bash
dsh plugin add @psyduck25/dsh-session-manager
```

> 包名带 `@psyduck25/` 作用域：无作用域的 `dsh-session-manager` 在 npm 上已被其他作者占用。
> 装好之后在设置页里看到的仍然是「会话删除管理」，包名不影响界面。

DSH 本身没有「删除单个会话」：左侧列表只能归档会话，要真正清掉一条只能连整个工作区一起删。
这个插件补的就是这一块——**按工作区列出所有会话，锁住不想删的，其余走「二次确认 → 删除缓冲站 → 到期真删」**。

设置 → **会话删除管理**。

> **English summary** — DSH can archive a session but cannot delete just one; the only way to clear a
> session for good is to delete its whole workspace. This plugin lists every session by workspace with a
> lock toggle and a delete button, asks for confirmation, then moves the log into a recycle bin so the row
> disappears from the left list. Sessions stay recoverable for a configurable window (24 h by default,
> `0` = delete immediately) and are really removed when it expires.
> Requires DSH `>=0.2.2-rc.3`. Install with `dsh plugin add @psyduck25/dsh-session-manager`.
> See [docs/DETAIL.md](docs/DETAIL.md) for the full picture.

## 能做什么

- **按工作区分组列出所有会话**，带工作区名称、路径、会话标题、最后活动时间；正在运行的会话和日志缺失的会话都有标记。
- **锁定**：点锁定后该行的删除按钮变灰，服务端也会拒绝（不是只靠界面禁用）。再次点击解锁。
- **删除要二次确认**：点删除先在行内展开确认条，写明这个会话会进缓冲站、多少小时内可回档；缓冲时长为 0 时确认文案直接说「无法撤销」。
- **删除缓冲站**：二次确认通过的会话落到页面底部，同时**从左侧工作区列表消失**。
- **回档**：缓冲期内点「回档」恢复原样——日志文件搬回原目录、解除归档，所以标题、位置、工作区归属都不变。
- **缓冲时长可自定义**：默认 24 小时，填 0 就是二次确认后立即彻底删除。范围 0–720 小时。
- **到期真删**：宿主的定时器（每分钟巡检，启动 2 秒后先清一次上一轮的欠账）把到期条目的日志文件删掉、解除工作区归属、清空归档集合。

## 两段式删除具体做了什么

进入缓冲站时做两件事，各自解决一半问题：

1. **归档**：写进工作区归档集合，推一帧让左侧列表刷新，同时挡住这个会话后续被唤醒。
2. **把日志文件搬进回收站**：从会话目录移到 `$DSH_HOME/session-manager/trash/<会话>/`。
   列表来自存储层的会话清单，文件不在了就没有这一行——**即使你开着「显示归档会话」也看不见它**。

| 阶段 | 对会话做的事 | 对左侧列表 |
|---|---|---|
| 进入缓冲站 | 归档 + 日志搬进回收站 | 会话彻底消失（不是变灰） |
| 回档 | 日志搬回原目录 + 解除归档 | 会话回到原来的位置 |
| 彻底删除 | 回收站目录整个移除 + 摘掉工作区归属 | 会话彻底不存在 |

工作区登记里的那个 id 自始至终没被删过，所以回档不用猜位置，原样恢复。

真正删除只在这个会话自己的目录里动以 `session.` 开头的文件；目录空了才一并删掉，
其余文件（比如你手工放进去的备份）一个都不碰。

如果进入缓冲站时这个会话还开着（Windows 上文件被占用搬不动），操作会直接失败并告诉你原因，
不会出现「显示已删但还在列表」的半截状态。到期时如果删不掉，条目标成
「已到期，等待清理：原因」，下一次巡检或下一次启动 DSH 再重试。

缓冲站里每行还有 **彻底删除**：点一下先展开一行确认（「彻底删除」紧挨着「回档」，
误点的代价是日志直接没了，所以照样要确认一次），确认后立即销毁日志，不等到期。

## 数据放在哪

`$DSH_HOME/session-manager/state.json`（默认 `~/.dsh/session-manager/state.json`）：

```json
{
  "version": 1,
  "settings": { "bufferHours": 24 },
  "locks": ["session-…"],
  "buffer": [
    {
      "sessionId": "session-…",
      "title": "…",
      "workspaceId": "…",
      "workspaceTitle": "DSHdev",
      "deletedAt": 0,
      "expiresAt": 0,
      "originalDir": "…\\sessions\\--…--\\session-…",
      "files": ["session.v4.jsonl.zstd"],
      "pending": false,
      "note": "",
      "noteDetail": ""
    }
  ]
}
```

回收站目录 `$DSH_HOME/session-manager/trash/<编码后的会话 id>/` 里放搬过去的日志文件，
外加一份 `meta.json` 记录原目录和文件清单——`state.json` 万一丢了也能靠它还原。

写入是「先写临时文件再替换」的原子写。文件损坏时退回默认值，不会让插件起不来。

## 接口

全部是本机 loopback 的 HTTP 路由（非本机请求一律 403）：

| 路由 | 作用 |
|---|---|
| `POST /api/dsh-session-manager/state` | 拉全量数据（顺带补搬老条目、巡检一次缓冲站） |
| `POST /api/dsh-session-manager/settings` | `{ bufferHours }` 或 `{ reset: true }` |
| `POST /api/dsh-session-manager/lock` | `{ sessionId, locked }` |
| `POST /api/dsh-session-manager/delete` | `{ sessionId, title, workspaceId, workspaceTitle }` |
| `POST /api/dsh-session-manager/restore` | `{ sessionId }` |
| `POST /api/dsh-session-manager/purge` | `{ sessionId }`，缓冲站里立即彻底删除 |
| `POST /api/dsh-session-manager/adopt` | `{ sessionId }`，把未分组会话按 cwd 挂回工作区 |

### 「未分组」里的会话可以用「归位」挂回工作区

**现象**：左侧「未分组」下面堆着一些会话，可它们的目录明明就是某个工作区的目录。

**原因**：DSH 的工作区登记只在启动时按目录把会话归并一次，之后新建的会话不会被收进去。
工作区里那个 id 没被登记，左侧就只能把它算作「未分组」。

**处理**：插件会算出每个未分组会话的 `cwd` 属于哪个工作区，在行上显示
「它的目录属于 XXX」并给一个「归位」按钮。点一下就走
`Workspace.attachSession()` 把它登记进去（该方法自己校验 cwd 必须解析到该工作区目录，
所以不会挂错），左侧随下一帧就能看到它回到正确的分组里。

只对「目录恰好等于某个已登记工作区」的会话提供归位；目录没有对应工作区的
会话不会出现这个按钮。

## 已知限制

- 会话标题来自日志里的标题事件；从未生成过标题的会话显示「未命名」。
- 正在运行的会话删不掉：插件会先拒绝（`running`），等那一轮结束再删。
- 打开着但没在跑的会话是「推迟搬运」的：先归档让它从列表消失，等它退出内存后
  由巡检补搬日志文件；`stopActivity: true` 只是停掉它的活动，并不会替你保存正在跑的回合。
- 卸载插件不会动已经写下的 `state.json` 和回收站里的文件，也不会自动搬到别处；
  想彻底清干净就删掉 `$DSH_HOME/session-manager/`。
- 回收站里的日志是完整文件，不是压缩包：清空回收站之前它会一直占着磁盘。
- 打开着的会话是「推迟搬运」的：归档先让它从列表消失，等它退出内存后由巡检补搬日志文件。

### 左侧列表可能残留一行（这是 DSH 客户端缓存，不是插件没删干净）

**现象**：彻底删除之后，左侧列表里仍然能看到那一行，通常挂在「未分组」下面；
点进去还会报 `历史加载失败: session "…" not found (session/not-found)`。

**原因**：DSH 的客户端把会话清单和投影缓存在内存里，只在收到事件时增量更新。
插件删除会话时，宿主侧是真的删干净了：

- 日志目录已不存在
- `~/.dsh/storages/workspace.json` 里已经摘掉这个 id
- `~/.dsh/session-manager/trash/` 里也没有它
- 宿主的会话列表里查不到它

但已经渲染出来的那一行要等客户端重新拉一次清单才会消失，
而 DSH 没有为「会话被外部删除」发事件，所以它就一直挂在那儿。

**处理**：用页面顶部「刷新界面」卡片里的 **刷新界面** 按钮。它调用
`globalThis.location.reload()`，让客户端重新拉一次会话列表——DSH 自己在升级提示里、
`ui-settings-general` 的 `reloadPage` 就是这么做的。

桌面版正式安装包的「应用」菜单里没有「刷新页面」这一项（源码里它包在
`...development ? [...] : []` 里，只有开发模式才出现），所以这个按钮是插件补上的入口。
按钮不可用时（页面不能自我刷新）会提示改用 F12 打开开发者工具后按 Ctrl+R。

**同理**，如果你开着「显示归档会话」开关，被归档但还没补搬文件的会话会**变灰**
留在原位置——灰色是 DSH 对归档会话的正常表现，不是插件的问题。
等它退出内存、巡检把日志搬进回收站之后，这一行才会真正消失。
