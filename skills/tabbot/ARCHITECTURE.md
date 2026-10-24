# ARCHITECTURE

TabBot 运行时架构。产品场景见仓库的 `docs/DESIGN.md`；仓库边界、开发验证、分发发布见同目录的 `AGENTS.md`；故障排查见 `TROUBLESHOOTING.md`。

人和 agent 共用同一个 Chrome：页面脚本常驻录制，holder 写日志，agent 读日志、并经 holder 在用户正在用的原页面上操作。不使用 `chrome.debugger`，不开专用窗口，不创建标签页。

**设计原则：所有逻辑和数据在 holder，扩展、relay、CLI 只做 I/O。** 原因是扩展的安装、重启、分发都不方便（首次只能手动加载，改了代码要用户去 `chrome://extensions` 刷新），而 holder、CLI 在 `~/.tabbot/src` 里，`setup.js` 镜像之后 `tabbot daemon restart` 就生效。

```
CLI（argv→RPC→打印） ──socket──▶ holder（唯一的大脑） ◀──ext.sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI） ──▶ 页面脚本：录制 + 执行（互相独立）
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的 4 个操作：`register`、`exec`、`tabs`、`goto`，加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 `ext.sock` 之间原样转发字节；daemon 不在时拉起它 | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 holder，打印它返回的文本，用它返回的退出码；`doctor` 和 `daemon restart` 留着（要诊断可能已死的 holder） | `src/cli/` |
| 页面脚本 | `recorder.js` 如实上报浏览器里发生的事；`executor.js` 执行 holder 下发的动作。由 holder 在扩展连接时下发，不放在扩展里 | `src/page/` |
| holder | 租约、动作、重放、查询与渲染、`wait`、脱敏、写日志、原始请求的内存表、别名对照表 | `src/holder.ts`、`src/journal/` |

## 1. 命令入口

`src/cli/tabbot.ts` 没有命令逻辑：`tabbot <argv>` 原样发给 holder 的 `run` RPC，holder 调 `journal/commands.ts` 的 `runCommand`，返回 `{ stdout, code }`。命令：`context`、`api`、`tabs`、`log`、`sql`、`snapshot`、`text`、`wait`、`status`、`takeover`、`release`、`act`、`req`、`replay`；`daemon restart`、`doctor` 留在 CLI。

- holder 不在时 CLI 会拉起它（读历史日志不应该依赖 Chrome 开着）：`session.ts` 的 `ensureHolder`，存活判据只有一条——socket 能不能回 `ping`。
- 要经扩展的命令（`tabs`、`snapshot`、`text`、`takeover`、`act`、`replay`）先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；Chrome 在运行 → 等扩展连上（`HOLDER_READY_MS`），等不到 `need-extension`；扩展 ABI 不对、用户脚本开关没打开、页面脚本没装上，都用明确的错误说怎么办。读日志的命令（`log`、`sql`、`wait`、`status`、`req`）不需要扩展。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`，退出码非零；成功时输出文本，退出码 0（`takeover` 被拒、`act` 被拒、重放得到 4xx/5xx 等也是非零）。
- 连接的读写按 UTF-8 解码（`socket.setEncoding("utf8")`，两端都是）：一个汉字的三个字节可能被拆在两个数据块里，按块 `toString()` 拼接会把它变成替换字符。

## 2. relay 与 holder

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（daemon） | relay 或 CLI（socket 连不上时 detached 拉起） | 扩展链路、租约、原始请求、日志写入 | 不随 relay 断开退出；没有扩展连接、也没有命令请求超过 10 分钟才退出 |
| 扩展 | Chrome | 无（不保存任何东西） | service worker 可随时重启 |

relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，日志照写。holder 通过 socket 提供 `ping` 和 `run`，见 `src/protocol.ts`，socket 权限 0600。

holder 与扩展之间的帧是 4 字节小端长度加 UTF-8 JSON（`src/browser/extension.ts`）：holder 发 `{ id, name, args }`，扩展回 `{ id, result | error }`；扩展主动推送 `{ type: "hello", abi, userScripts, ... }`（握手）和 `{ type: "page", tab, frame, top, page, msg }`（页面脚本的消息，或标签页的地址变化、关闭）。只支持一个扩展连接，新的合法 `hello` 替换旧连接。

## 3. 扩展

`src/chrome-extension/background.js` 约 130 行，没有业务逻辑，也不放任何页面脚本。权限：`tabs`、`nativeMessaging`、`alarms`、`userScripts`，以及 `host_permissions: <all_urls>`，`minimum_chrome_version` 135。

- **ABI**（`browser/extension.ts` 的 `ABI`，`hello` 里带上）：`register { scripts }` 用 `chrome.userScripts` 注册常驻脚本（所有 http/https 页面，`document_start`，所有 frame）并给已打开的页面补注入；`exec { tabId, code }` 在页面（MAIN world）里执行任意代码字符串；`tabs` 列 http/https 标签页；`goto { tabId, url }`。只有改 ABI 才加版本号，用户才需要刷新扩展；`hello` 的 ABI 不符时 holder 提示刷新。
- **为什么用 `chrome.userScripts`**：`chrome.scripting.executeScript` 的 `func` 只能传函数对象，不能传字符串；往页面里塞 `<script>` 或用 `eval` 会被严格 CSP 的站点拦下。`userScripts` 不受页面 CSP 约束，所以页面端的所有逻辑可以放在 holder 里，改页面脚本不用刷新扩展。代价：用户要在扩展详情页打开一次"允许用户脚本"（Chrome 138 起是每个扩展的开关）；没打开时录制和 `exec` 都不工作，`hello` 里 `userScripts` 为假，`doctor` 报出。
- **exec 的结果不靠扩展返回**：被执行的代码自己把结果 `postMessage` 回来（`k: "res"`），经 bridge 到扩展再到 holder，`journal/pages.ts` 的 `PageHost.call` 按 uid 配对。页面跳转时脚本被打断、结果发不回来：动作类的算成功（`navigated`），其它的算失败。
- 页面消息通道：MAIN world 的页面脚本 `window.postMessage`，USER_SCRIPT world 的 `bridge.js`（`userScripts.configureWorld({ messaging: true })`）收到后 `chrome.runtime.sendMessage`，扩展用 `onUserScriptMessage` 接收，补上 tab、frame 后转给 holder。页面自己的脚本也能往 window 发消息，所以日志只是观察记录，不能当权限依据。
- 工具栏图标：点击会唤醒 service worker 并立即尝试连接。图标整个面就是一个 `t`：白色的曲线（竖笔是 S 形，弯脚向右扫出边缘；横笔是一道波浪，没有一条直线）组成 `t`，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块。源文件是 `scripts/dev/icons/icon.svg`，改动后运行 `node scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机的 Chrome）。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒。

## 4. 页面脚本

holder 在扩展 `hello` 之后下发（`PageHost.install`）：`common.js`、`recorder.js`、`executor.js` 拼成一份 MAIN world 脚本（保证顺序），`bridge.js` 跑在 USER_SCRIPT world。每次扩展连接都重新注册一遍，所以不依赖注册能否跨浏览器重启保留。

- `common.js`：命名空间 `window.__tcr`、限流的 `post`、前台判断（页面可见，或离开前台不到 8 秒）、元素描述与快照、稳定的元素引用 `@e12`、DOM 变化计数、原始 `fetch`。
- `recorder.js`（录制）：只录三种请求——HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker）；用户输入（点击、输入长度、特殊键、滚动）；导航；页面快照；主文档渲染后的 DOM（`load` 稳定后一次，原样上报）。响应体不设策略上限，技术底线：不读事件流，读到 16MiB 就停并标 `truncated`（消息要经 native messaging，单条上限 64MiB）。后台页面只计数。
- `executor.js`（执行）：`window.__tcr.exec` 下的 `act`（click / fill / select / check / press / scroll，全是 DOM 事件）、`snapshot`、`text`、`replay`。自己数在途的 fetch / XHR 来判断页面稳定；自己监听真人的设备事件，动作等待稳定期间真人动手就立刻停并返回 `revokedDuring`。
- **录制与执行解耦**：录制如实反映浏览器状态，无论是谁造成的；执行只管执行。两者之间没有任何共享状态。来源只看 `isTrusted`：真是 `human`，假是 `page`（页面自己的脚本，或 agent 的 DOM 事件——观察端分不出也不去分）。agent 做了什么由 holder 另写的命令记录说明。

## 5. 日志（journal）

```
页面脚本 ──postMessage→ bridge ──→ 扩展 ──native messaging→ relay → holder: Ingestor → JournalStore（SQLite + 文件）
CLI → holder: runCommand（读日志、问扩展、执行动作）
```

- **分段队列**（`journal/store.ts`）：`~/.tabbot/journal/seg-<序号>/{events.db, bodies/, snapshots/}`。只往最新一段写；写满 50MB 就新开一段，新开时检查总量，超过 500MB 就整段删除最旧的分段（先进先出，和时间无关）。`seq` 全局递增，holder 启动时从最新分段接着编。同一个响应体按内容哈希去重（分段内）。行里的 `body` 是 `<分段序号>/<文件名>`。保留多久取决于流量。只有 holder 读写日志目录；`node:sqlite` 在 Node 24 里还是实验性的，`journal/sqlite.ts` 动态加载并过滤这一条警告。
- **事件**（`journal/ingest.ts`）：`input`（人和页面脚本的输入事件）、`cmd`（agent 的命令记录：动作类型、目标、结果，被租约拒绝也记）、`net`、`doc`（主文档的 HTML）、`nav`、`snap`、`tab`、`bg`、`lease`。请求的 `cause` 指向 2 秒内最近一次人的事件或 agent 命令。`tabbot log` 不隐藏任何一类。
- **过滤**（`filter.ts`）：`@ghostery/adblocker` 规则加第一方埋点启发式（只对非 GET：host 含 analytics / apm / datahub 等、路径含 collect / events / logs 等、204）标 `noise`，默认隐藏；adblock 规则要联网下载，加载好之前只用启发式；非噪声的第三方请求只留索引；失败的请求只留小于 4KB 的响应体。同一个请求（方法 + 地址 + 响应内容哈希）5 分钟内重复出现只给上一行 `dup` 加一。
- **脱敏**（`sanitize.ts`）：一条带单词边界的正则（`token`、`secret`、`password`、`csrf`、`jwt`、`auth`、`api key` 等）加严格的 JWT 判断，只作用于请求头名、URL 查询参数名、JSON 的 key；正文里的自由文本不扫描，响应体正文原样写盘。秘密换成别名 `⟨secret_<12 位十六进制>:<形状>⟩`：盐 + 真值的 HMAC，盐在 `~/.tabbot/journal/alias-salt`（0600），所以同一个秘密永远是同一个别名（重启也不变），不能还原。**别名 → 真值的对照表只在 holder 内存里**，`--set` 里写别名由它换回真值；holder 重启后失效。
- **租约**（`journal/lease.ts`）：agent 能不能在某个标签页上动手（只管写，读不受影响）。状态在 holder 里；页面把来源为 `human` 的事件立即上报，`humanInput` 立即撤销租约（滚轮、滚动只记"人在场"）；`acquire` 要求人静默超过 1.5 秒；租约 10 分钟没有动作失效。租约变化写进日志（kind `lease`）。
- **整理成 agent 能直接用的材料**（`journal/digest.ts`，纯函数）：`context` 把时间窗口内的行按站点（注册域名）分组，给出访问的页面、用户自己的操作、**操作引发的请求**（用 `cause` 把用户操作和请求配对，如 `human click button[Like] → POST graphql FavoriteTweet`）、agent 的命令；`api <站点>` 按“方法 + 接口名”分组（GraphQL 取操作名，queryId 会变；其它路径把长数字、哈希、uuid 换成 `:id`），每组给次数、最近一次的编号、请求变量（请求体的 `variables`，或查询参数里 JSON 的 `variables.*`）、触发它的用户操作、响应结构（沿着单键对象往下走）、原始请求现在还在不在 holder 内存里（能不能直接重放）。写操作、有用户操作触发的排前面。目的是让 agent 接到任务的第一步就能知道上下文，并发现“这件事有现成接口”，不用探索页面。
- **wait**：轮询日志：有人的事件且静默 `--idle` 秒就返回，超时则返回"无变化"或"人还在操作"。

### 5.1 在原页面上操作（takeover / release / act）

`runAct`（`journal/commands.ts`）：检查并续租约 → 写命令记录 → `PageHost.call(tab, "window.__tcr.exec.act(...)")`（`goto` 走扩展）→ 动作引起跳转就等加载完拿新地址 → 动作做完看租约还在不在（不在就是 `revokedDuring`）→ 补全命令记录。

- 点击先滚到视图中央并聚焦，再发 pointer / mouse 序列和 `click`；`fill` 用原生 `value` setter 加 `input`、`change` 事件（React 等框架才认），可编辑区域用 `execCommand("insertText")`；`press` 的 Enter 点按钮或提交表单，可打印字符插入到输入框。
- 等页面稳定：没有在途请求且 DOM 静默 400ms，最多 4 秒。
- 不支持：文件选择框、部分风控站点、iframe 里的元素、`closed shadow root`。`act` 冻结为兜底，优先走请求优先。

### 5.2 请求优先：重放（req / replay）

- **原始请求只在 holder 内存里**（`journal/raw.ts`）：页面里发的每个同站请求（`rid = docId:序号`）的方法、地址、请求头、请求体，键是 `tab:rid`，上限 50MB、单条 64KB，先丢最旧的；**绝不落盘**。日志里是脱敏后的版本。
- `replay <编号> [--set ...] [--tab N] [--yes]`：按 `rid` 取原始内容 → 把 `--set` 里的别名换回真值 → `applySets`（`journal/replay-core.ts`）→ 挑标签页 → `window.__tcr.exec.replay(请求)` 在页面里用原始 `fetch` 发出（带登录态）→ 响应脱敏后记一行 `agent replay`，响应体存成文件。
- **`--set`**：`名字=值` 改查询参数；`名字.路径=值` 当该查询参数的值是 JSON 时改里面的字段（GraphQL 的 GET 请求 `variables.cursor=xxx`，翻页用）；`header.名字=值` 改请求头（值为空就删）；`body.路径=值` 改 JSON 或表单请求体（按已有值的类型转换）；`body=内容` 整个换掉。
- **安全**：标签页必须与该请求同站，且标签页的 origin 等于请求原来发出时的页面 origin（效果和页面原来发的完全一致，包括 CORS）；GET、HEAD 不要租约，其它方法要租约和 `--yes`；浏览器自己管的请求头（`cookie`、`origin`、`referer`、`sec-*` 等）去掉；`exec.replay` 用保存下来的原始 `fetch`，所以重放不会被录制端当成页面自己发的请求记下来。
- `req find`：在保留的响应体和 HTML 文档里找文字，返回是哪个请求（或哪个文档）里有；`req show` 用 `templateFromRow` 把日志里的一行还原成请求的样子，并给出风险提示（签名类参数、非 GET）。

## 6. 存储与安装

- 用户数据只有 `~/.tabbot/journal`；运行时状态在 `~/.tabbot/session`；运行时代码在 `~/.tabbot/src`。
- `setup.js` 把 skill 目录镜像到 `~/.tabbot`、安装依赖、写版本文件、注册 native host、生成 shim、让过期的 daemon 换成新代码、运行 `doctor`。
- 分发是源码镜像：`~/.tabbot` 是 skill 目录（`skills/tabbot/`）的逐字节拷贝，只排除 `node_modules` 和 `.DS_Store`（`store/deploy.ts` 的 `mirrorPayload`）。顶层的 `src`、`scripts` 先清空再拷；`journal`、`session`、`bin` 是本机数据，镜像不碰。版本哈希只算运行时文件（`isRuntimePath`：排除自检、fixtures、`node_modules`），页面脚本在其中，改自检或文档不会触发换 daemon。
- 版本：`setup.js` 在 `~/.tabbot/src/.version` 写 `{ build }`（`store/version.ts`）；daemon 启动时记下自己的 `build`，`ping` 返回它。换代码只在两处发生：`setup.js` 发现运行中 daemon 的 `build` 与刚写入的不同时，和用户显式运行的 `tabbot daemon restart`（`restartDaemon`：按 `ping` 里的 `pid` 发 `SIGTERM`，holder 走 `shutdown` 清掉 socket 再退出；扩展按指数退避重连，Chrome 重新拉起 relay，relay 拉起新 daemon）。没有任何命令会自动重启 daemon。
- 扩展代码的更新不能自动完成；但扩展只在 ABI 变化或权限变化时才需要用户刷新，`doctor` 的 `extension-abi` 提示。页面脚本的更新不需要刷新扩展。
- `tabbot doctor` 只读。

## 7. 测试

`npm test` 逐个运行 `*.selfcheck.*`，都不依赖 Chrome：脱敏、别名、租约、原始请求表、分段存储、`--set`、日志摄入、命令层（假的 holder 能力）、扩展链路分帧与握手、`background.js`（桩 `chrome.*`）、holder 的端到端（真实 relay + holder + 假扩展，含"整个 `~/.tabbot` 里没有 token 真值"的扫描）。页面脚本在真实页面里的行为，用 `scripts/dev/hook-e2e.mjs`（需要本机 Chrome，无头）验证，不在 `npm test` 里。
