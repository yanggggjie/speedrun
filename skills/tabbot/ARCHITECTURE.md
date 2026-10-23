# ARCHITECTURE

TabBot 运行时架构。仓库边界、开发验证、分发发布见同目录的 `AGENTS.md`；故障排查见 `TROUBLESHOOTING.md`。

## 1. 对外接口

| 组成 | 位置 | 职责 |
|---|---|---|
| 命令入口 | `src/cli/tabbot.ts`，由 `~/.tabbot/bin/tabbot` shim 调用 | `run`、`eval`、`record`、`daemon restart`、`doctor` |
| Task SDK | `src/sdk.ts` | 只向 task 暴露 `tabbot.run({ page })`，在 client 进程运行 task 闭包 |
| task-lib | `~/.tabbot/task/lib/`，源码在 `src/templates/task-lib/` | 页面操作 helper、`toggle`、`expectRequest`、URL 工具 |
| task | `~/.tabbot/task/<name>.js` | 一个可独立执行和复用的流程，头部 `@status` 区分 `draft` 与 `verified` |

修改 task 直接改 `~/.tabbot/task` 中的文件，不再使用 `temp` 候选目录。草稿用 `@status: draft` 标记。

命令入口的约定：

- 只有 `record` 通过 RPC 连 holder（`src/cli/session.ts` 确认 holder 在不在，`src/cli/rpc.ts` 发请求）；`run`、`eval` 在本地起子进程，task 内部才通过 SDK 连 holder。
- 握手失败返回 `need-install`、`need-chrome`、`need-extension`。`ping` 返回 `extension`（扩展链路是否接着）：holder 在 relay 断开后还会存活，所以 ping 通不代表可用；`extension` 不为 `true`（或 holder 不在）时，没装 host 或 Chrome 没运行立即返回，只有 `need-extension` 才等待扩展连接（`HOLDER_READY_MS`）。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`。退出码规则只有一条：`status` 为 `success` 时 0，其它一律非零（不另建错误码表；`protocol.ts` 的 `RPC_ERRORS` 只用于 holder 与 CLI 之间的 JSON-RPC）。
- 并发：holder 同时只允许一个 run。`run.begin` 遇到另一个 run 或录制操作（错误的 `data.reason` 为 `run` 或 `record-op`）时，SDK 每 500ms 重试，最多 `RUN_BUSY_WAIT_MS`（30 秒）；`reason` 为 `record`（录制进行中）时不等待，直接报错。
- task 参数一律具名：`tabbot run <task> --名字 值`（也接受 `--名字=值`），不接受位置参数。`tabbot run` 按文件头 `@param 名字 说明`（名字后带 `?` 为可选）校验：缺必填、传了没声明的、重复的、位置参数，都在启动子进程之前报错，不写运行历史。校验通过后，参数以 JSON 放进子进程的环境变量 `TABBOT_PARAMS`，task 里用 `tabbot.params.名字` 读取（值都是字符串；`src/sdk.ts` 的 `readParams`）。`tabbot eval` 里 `task(name, { 名字: 值 })` 走同一套校验，值先转成字符串。运行历史记录 `{ params, output }`。
- task 文件头只认文件开头第一个块注释里的 `@标签`；读不了的文件在 `tabbot run` 列表里标为 `status: "invalid"`，不影响其它 task。
- 超时只有两层：单步骤 `STEP_TIMEOUT_MS`（60 秒，`src/templates/task-lib/page.js`，用于 `evaluate`、`goto`、`waitForSelector`、`expectRequest`；单条 CDP 命令的 `CDP_COMMAND_TIMEOUT_MS` 同为 60 秒，两者要一起改）；整个 task 子进程 `TASK_TIMEOUT_MS`（115 秒，比常见 shell 工具的 120 秒默认超时少一点），task 头部可用 `@timeout <秒>` 覆盖。超时被 SIGKILL 终止并按失败返回，`eval` 对每个内层 task 单独计时。
- 页面脚本（`Runtime.evaluate`、`Runtime.callFunctionOn`）的 CDP 命令超时后，命令被放弃，但脚本还在页面里跑，死循环会让标签页一直卡着。`browser/extension.ts` 在这种超时时补发一次 `Runtime.terminateExecution`（失败忽略，原超时错误照常抛出）；页面空闲时发送也安全。不给 `evaluate` 加 `timeout` 参数：它只管同步执行，管不了等待中的 Promise。
- `goto` 默认等 DOMContentLoaded，且只认本次导航提交（主框架 `frameNavigated`）之后的事件，上一个页面还没发完的加载事件不算数；`until: "commit" | "load"` 可选；不换文档的跳转（hash、pushState）等 `navigatedWithinDocument`，提交之后出现的不算。`evaluate` 不发 `Runtime.enable`（`Runtime.evaluate` 不需要它，每次 enable 会让 Chrome 重发全部执行上下文事件）。`cdp.once` 不指定 `timeout` 时用单条命令的上限，不会一直挂着。
- 连接的读写按 UTF-8 解码（`socket.setEncoding("utf8")`，两端都是）：一个汉字的三个字节可能被拆在两个数据块里，按块 `toString()` 拼接会把它变成替换字符。
- `RpcPeer.failure`：连接意外断开、或监听函数抛错时 reject；`tabbot.run` 把它和 task 函数赛跑，task 不会因此一直挂着，监听函数里的错误成为这次 run 的失败，而不是进程的未捕获异常。daemon 写队列超限（单条 16 MB、排队 64 MB）时，先写一行没有 id 的错误说明原因再断开连接，client 把它作为失败原因。
- run 结束（`runEnd`）：关掉本次 run 的 tab，以及 run 期间在 run 窗口里新开的 tab（点 `target=_blank` 链接等，扩展按 opener 纳入），锚点保留。清理做完才释放模式，下一个 `run.begin` 不会和清理同时操作 run 窗口。`window.open` 带窗口特征弹出的独立窗口不在这里处理。
- 定位（`templates/task-lib/locate.js`）：目标是 CSS 字符串或 `{ role, name }`。role/name 用 `Accessibility.queryAXTree`（根是 `document` 对象）查找，`DOM.resolveNode` 转成元素，必须唯一；CSS 保持取第一个匹配的旧行为。动作（click、fill、press、check、select、toggle）先等元素存在、可见且未禁用，默认 `ACTION_TIMEOUT_MS`（10 秒），超时报出在等什么。
- 不抢前台：task-lib 的 `evaluate`、元素动作、轮询都不带 `userGesture`，页面自己（或脚本）调用 `window.open`、点 `target=_blank` 会被浏览器的弹窗拦截拦住。原因：页面自己开的新标签会让 Chrome 激活窗口和应用（实测会抢前台），`focused: false` 管不住这一条；而带了 `userGesture` 之后，连轮询都会让页面一直处于被用户激活的状态，页面自发的弹窗也被放行。 dev 驱动是例外：它模拟用户演示，操作脚本带 `userGesture: true`，演示时点 `target=_blank` 能像真人一样开新标签，录制器会记下这个新标签。task 不需要第二个页面（见 SKILL.md 的 task 粒度），所以 task-lib 不提供开新页面的接口。
- `waitForSelector` 在 Node 侧轮询，不在页面里跑长循环；它没有 `timeout` 参数，固定使用单步骤上限。
- `RpcPeer`（`src/cli/rpc.ts`）是唯一的 socket 客户端：`sessionRpc` 是一次一连接的用法，SDK 用它保持长连接并接收页面事件。

## 2. relay 与 holder

三段进程，各自的生命周期不同：

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay（`src/native-messaging-host/relay.ts`） | Chrome（native messaging host） | 无，只在 stdio 与 `ext.sock` 之间原样转发字节 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（`src/holder.ts`，daemon） | relay（`ext.sock` 连不上时 detached 拉起） | 持有扩展链路、run、录制、窗口 | 不随 relay 断开退出；无 relay、无 run、无录制超过 10 分钟才退出 |
| 扩展（`src/chrome-extension/`） | Chrome | 所有权登记、debugger 附加状态 | service worker 可随时重启，靠对账恢复 |

relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，不退出，所以窗口与录制不丢。扩展每次 `hello` 之后，holder 做一次对账，见 4。

holder 通过 socket 提供：

```text
run.begin / run.end
cdp.send        { pageId, method, params, timeoutMs? }
cdp.event       （推送）{ sessionId, method, params }
record.start / record.stop / record.abort
ping
```

- 同一时间只允许一个 run，与发起它的 socket 绑定。连接断开时执行 `run.end` 清理。
- 页面事件由 holder 按 `sessionId`（即 pageId）推送给当前 run 的 client，client 按 method 过滤。不再有 `cdp.subscribe` 与 scope。
- 不暴露 browser 级 CDP 命令。`cdp.send` 只接受存在的 page。

## 3. 扩展

`src/chrome-extension/` 是薄层 CDP 代理，约 220 行。协议见 `src/browser/extension.ts`。

- run / 录制只操作由 holder 创建的窗口和 tab，以及两类新 tab（常驻录制的只读操作是例外，见第 7 节）：opener 属于 TabBot 的 tab；开在录制窗口里的 tab（用户在录制窗口自己按 Cmd+T 开的 tab 没有 opener）。`openWindow` 的 `kind: "record"` 标记录制窗口，run 窗口不放宽。
- 工具栏图标：manifest 声明了 `icons` 与 `action`；点击图标会唤醒 service worker 并立即尝试连接（`need-extension` 的提示让用户点一下它）。图标整个面就是一个 `t`（手法同 yodo，配色不同，避免混淆）：白色的曲线（竖笔是 S 形，弯脚向右扫出边缘；横笔是一道波浪，没有一条直线）组成 `t`，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块，色块边界沿着笔画。源文件是 `scripts/dev/icons/icon.svg`，所有尺寸共用，改动后运行 `node scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机的 Chrome）。
- 操作：`openWindow`、`openTab`、`closeTab`、`closeWindow`、`listOwned`、`windowOf`、`attach`、`detach`、`send`。
- 事件：`debuggerEvent`、`debuggerDetach`、`tab.created`、`tab.updated`、`tab.removed`。

## 4. 窗口

- 录制窗：`openWindow({focused: false})`，不抢用户焦点，tab 标题 `tabbot record`；agent 要告诉用户切换到这个窗口。stop、abort 或 holder 退出时关闭整扇窗口。
- run 窗：holder 记录 `runWindowId`，窗口与一个锚点 tab（`about:blank`，标题 `tabbot run`）同时存在。锚点 tab 保留，保证窗口存活。
- 每次 run 新开一个 tab，结束时 detach 并关闭它。不复用 tab。
- run 窗被用户关闭后，下次 run 静默重建。holder 退出时关闭 run 窗。
- 对账：扩展每次 `hello` 之后，holder 调用 `listOwned`，先丢弃 debugger 附加状态未知的页面记录，再按标题（`tabbot run`、`tabbot record`）识别 TabBot 的窗口：当前 `runWindowId` 的窗口保留，只关掉其中除锚点外的残留 tab；其它 `tabbot run` 窗口是孤儿，整扇关闭；录制进行中不关 `tabbot record` 窗口。只关被标题确认的窗口，从不按 id 关闭用户的窗口。录制 stop / abort 结束后也对账一次。
- 所有权登记同时写入 `chrome.storage.session`（service worker 重启后可信，扩展刷新会清空）和 `chrome.storage.local`（扩展刷新后仍在，但 tab id 在浏览器重启后会被复用）。恢复 `local` 里的登记时，只接受仍然存在、且窗口里有标题为 `tabbot run` 或 `tabbot record` 的 tab 的窗口，其余丢弃。`listOwned` 返回每个 tab 的 `title`，holder 对账靠它识别 TabBot 的窗口。

## 5. 录制

- `record start` 在 `~/.tabbot/session/recording/<name>/` 下生成录制；`record stop` 移入 `~/.tabbot/record/<name>/`。
- 录制输出：`timeline.jsonl`（request 行与 action 行）、请求文件与响应文件。没有 `DOMTimeline.jsonl`，没有 `final-state`，没有 `eventId`。
- action 类型：`click`、`value`、`checked`、`scroll`、`navigation`。`submit` 与 `keydown` 不记录。
- 页面脚本（`record/inject.js`）在页面里直接产出 timeline 需要的字段：`selector`（候选依次为稳定的 `id`、`data-testid` 等、`name`、`aria-label`、`placeholder`、稳定的 class，要求在文档里唯一；都不唯一时用 `:nth-of-type` 拼路径）、`role`、`name`（`aria-labelledby` → `aria-label` → `<label>` → `placeholder` → 自己的文字，最长 80 字符；没有可交互元素的点击只取元素自己的文字）、输入值、滚动量。点到按钮里的图标算点了按钮，点 `<label>` 算点了它控制的输入框。宿主不再采集元素的祖先、子节点等整份描述；判断是不是同一控件只比较 `selector`。
- 脚本的注入：`Page.addScriptToEvaluateOnNewDocument` 只对之后新建的文档生效，所以 attach 时还要对已存在的 frame（含 iframe）用 `Page.createIsolatedWorld` + `Runtime.evaluate` 立刻补注入，否则晚 attach 的页面（尤其单页应用）整页录不到动作。脚本加载后发 `ready`；stop 时有网络请求却没收到 `ready` 的页面，进入 `record stop` 的 `warnings`。
- 单页应用的路由变化（`Page.navigatedWithinDocument`）记为 `navigation`；iframe 里的导航不记录。
- 验证：`record/fixtures/dom-events.json` 是在真实 Chrome 里通过页面操作抓到的页面事件，其中的 `ax` 是同一页面上 Chrome 无障碍树给出的 role 和 name，`collect.selfcheck.ts` 逐个对照。
- 脱敏保留；adblock 过滤保留。
- 网络采集分两层：`record/collect.ts` 的采集端只做 attach 和所有 I/O（开启域、取响应体、读页面 HTML），事件交给 `record/requests.ts` 的 `RequestAssembler` 拼成请求记录。拼装器不做任何 I/O，只有一个入口 `feed(事件)`；需要取响应体或补抓主文档时返回一个动作，采集端执行后再把结果作为 `tabbot.body`、`tabbot.snapshot` 事件喂回去。设置 `TABBOT_RECORD_LOG=<路径>` 时，stop 时把喂给拼装器的全部事件写成 JSON（含未脱敏的数据，默认不记录），可直接作为测试夹具，放进 `record/fixtures/` 即可回放。
- 补抓的主文档（`late: true`）：页面在开始采集之前就已经加载完时，读取当前页面的 HTML 补一条主文档。`dropIncompleteRequests` 不会删除它。
- 录制期间不处理 JS 对话框（`alert`、`confirm`、`prompt`、`beforeunload`），由用户在页面里自己选，不自动点「确定」；只有无人值守的 run 页面才自动点「确定」（`CdpPage` 的 `autoDialog`）。
- 录制窗口里用户自己新开的 tab 会被纳入：扩展纳入后宿主按窗口规则 attach。新标签页是 `chrome://` 页面，无法 attach；用户在里面首次导航后才 attach，第一次文档请求可能记成补抓的主文档（`late: true`）。
- `record stop` 输出 `status`、`name`、`recordDir`、`timeline`；有页面的动作没录到时多一个 `warnings` 数组。

### 5.1 模式（run / 录制互斥）

`src/mode.ts` 的 `Mode` 是 daemon 里"忙不忙"的唯一来源：`idle`、`run`、`record-op`（start / stop / abort 正在执行）、`record`（录制进行中，由 `liveRecordName()` 提供，不重复保存）。`RUN_BUSY` 的判断、`reason`（`run`、`record-op`、`record`）和提示文字只在这里定义；SDK 靠 `reason` 决定要不要等（`run`、`record-op` 等，`record` 不等）。`ping` 返回 `mode`，`tabbot daemon restart` 靠它判断忙闲。

## 6. 存储与安装

- 用户数据目录只有 `~/.tabbot/task`、`~/.tabbot/record`，运行时状态在 `~/.tabbot/session`，运行时代码在 `~/.tabbot/src`。
- 运行历史写入 `~/.tabbot/run/<task>/<时间戳>.json`（`eval` 为 `run/compose/`），保存输入参数与输出，每个 task 保留最近 20 份。
- 没有 `state.json`，不做失败统计，不做重试限制。
- `setup.js` 是安装引导脚本，依赖 skill 包本身，负责把 skill 目录镜像到 `~/.tabbot`、安装依赖、写版本文件、注册 native host、生成 shim、让过期的 daemon 换成新代码、运行 `doctor`。
- 分发是源码镜像：`~/.tabbot` 是 skill 目录（`skills/tabbot/`）的逐字节拷贝，只排除 `node_modules` 和 `.DS_Store`（`store/deploy.ts` 的 `mirrorPayload`）。顶层的 `src`、`scripts` 先清空再拷；`task`、`record`、`run`、`session`、`bin` 是本机数据，镜像不碰。自检、fixtures、`scripts/dev`、文档都在，本机 agent 改完源码可以在 `~/.tabbot/src` 里 `npm install && npm test` 验证。版本哈希只算运行时文件（`isRuntimePath`：排除自检、fixtures、`node_modules`），改自检或文档不会触发换 daemon。`dev/rpc.ts` 被 `holder.ts` 静态 import；它默认关闭，由 `~/.tabbot/session/dev` 控制。
- 版本：`setup.js` 在 `~/.tabbot/src/.version` 写 `{ build, extension }`（`store/version.ts`）。`build` 是运行时代码内容的哈希；`extension` 是 `chrome-extension/background.js` 与 `manifest.json` 字节依次拼接后 SHA-256 的前 16 位十六进制，扩展启动时对自己的两个文件算同一个值，随 `hello` 的 `buildId` 发给 daemon。开发时直接从仓库运行没有 `.version`，不做版本比较。
- daemon 的版本：启动时记下自己的 `build`，`ping` 返回 `build`、`mode`、`extensionBuild`，纯上报，没有副作用。换代码只在两处发生，都不在 `ensureAttached`（CLI 与 SDK 每条命令都会走到）里——那样会让一条不相关的命令隐式触发进程重启和几秒等待：`setup.js` 发现运行中 daemon 的 `build` 与刚写入的不同时，和用户显式运行的 `tabbot daemon restart`。两者都调 `restartDaemon`（`src/cli/session.ts`）：按 `ping` 里的 `pid` 发 `SIGTERM`（holder 收到后走 `shutdown`：收尾录制、关 run 窗、再退出），daemon 退出后 relay 随之退出，扩展按指数退避重连，Chrome 重新拉起 relay，relay 拉起新 daemon。不请求 daemon 自己退出（没有 `daemon.exit` 这个 RPC），所以新旧 daemon 走同一条路，不依赖对方实现了哪个方法。忙（`mode` 为 `run`、`record`、`record-op`）时拒绝，不杀，`setup.js` 会醒目地提示"没换成新代码，等空闲后运行 `tabbot daemon restart`"；旧 daemon（`ping` 里没有 `mode`，无从判断忙闲）直接杀。扩展没连着时只让它退出，不等新的。
- 扩展代码的更新不能自动完成：`doctor` 的 `extension-build` 在已加载的扩展与已安装的不同时提示"在 chrome://extensions 里刷新 TabBot"。
- `tabbot doctor` 只读。

## 7. 常驻录制（journal）

和 run / 录制互不相干：不用 CDP、不开窗口、不进 `Mode`，只读观察。默认在所有 http/https 站点上常驻（内置排除敏感站点），数据落在 `~/.tabbot/journal`。

```text
页面 hook.js (MAIN) ─postMessage→ relay.js (隔离世界) ─runtime.sendMessage→ 扩展 background.js
  ─批量(300ms) native messaging {type:"journal", events}→ relay 进程 → holder: Ingestor → JournalStore(SQLite + 文件)
CLI: 直接开只读 SQLite（log / sql / wait / status）；tabs、snapshot、sites 生效经 holder 问扩展
```

- **扩展权限变了**：`host_permissions: <all_urls>` 加 `scripting`。内容脚本不写在 manifest 里，由 `setSites` 按录制范围用 `chrome.scripting.registerContentScripts` 动态注册（`persistAcrossSessions`），所以改范围不需要重新加载扩展：`mode: "all"` 注册 `http://*/*`、`https://*/*` 并用 `excludeMatches` 排除敏感站点，`mode: "only"` 只按点名站点注册；被排除的页面、无痕窗口、`chrome://` 等既不注入脚本、也不上报任何事件。`siteTabs`、`snapshot` 这两个只读操作也只对范围内的 tab 开放，**不要求 tab 由 TabBot 创建**（run / 录制仍然只操作自己的窗口）。范围配置在 `~/.tabbot/journal/sites.json`（`mode`、`only`、`exclude`、`allow`；内置排除列表在 `src/journal/sites.ts` 的 `BUILTIN_EXCLUDE`，用户的 `allow` 可以重新打开其中某个），holder 每次扩展 `hello` 后和 `tabbot sites ...` 之后把解析好的 `{ mode, sites, exclude }` 下发。旧版只存点名站点列表的 `sites.json` 按默认的 `all` 处理。
- **hook.js**（`src/chrome-extension/journal/`）：包住 fetch / XHR / sendBeacon / WebSocket；`foreground()`（页面可见，或离开前台不到 8 秒）为假时请求只计数，不读响应体；只对同站、非埋点、文本类的响应读体（上限 256KB，页面里只有粗判，最终判断在 holder）；输入只记长度；普通字符键不记，只记 Enter / Escape / Tab / Cmd 或 Ctrl 组合；滚动合并成一条；每分钟最多 3000 条。`__tcrSnap` 生成元素快照（默认视图内最多 60 个，密码和敏感字段的值不取）。页面脚本也能往 window 发消息，所以日志只是观察记录，不能当权限依据。
- **日志**（`src/journal/`）：`<日期>.db` 一天一个 SQLite（WAL），表 `events`，`seq` 跨天单调递增；响应体 `bodies/<日期>/<哈希>.json|txt`（脱敏后缩进展开，方便 `rg`），快照 `snapshots/<日期>/`。同一天内按内容去重。`node:sqlite` 在 Node 24 里还是实验性的，`journal/sqlite.ts` 动态加载并过滤这一条警告（CLI 输出必须干净）。
- **过滤**（`filter.ts`、`ingest.ts`）：`@ghostery/adblocker` 规则（沿用 `record/pipeline.ts` 的引擎）加第一方埋点启发式（只对非 GET：host 含 analytics / apm / datahub 等、路径含 collect / events / logs 等、204）标 `noise`，噪声只留索引、默认视图隐藏；非噪声的第三方请求只留索引；失败的请求只留小于 4KB 的响应体。`RecordSanitizer`（与 record 共用）负责脱敏：同一个秘密稳定别名，别名在 URL 里保持可读。同一个请求（方法 + 地址 + 响应内容哈希）5 分钟内重复出现只给上一行 `dup` 加一。人或 agent 的动作之后 2 秒内的请求，`cause` 指向这个动作。
- **来源**：`isTrusted` 为真且没有水印 → `human`；鼠标点击带 `force: 0.123` 水印（`pressure ≈ 0.123`）→ `agent`；`isTrusted` 为假（脚本触发）和所有请求、导航、快照 → `page`。目前没有 agent 动作的 ledger，也没有租约（下一阶段）。
- **淘汰**（`retention.ts`）：holder 每 5 分钟检查，目录总大小超过 1GB 的 80% 先删最旧一天的响应体和快照，仍超过 1GB 再删最旧一天的库；今天的不动。
- **wait**：直接轮询日志文件（不经过 holder）：有人的事件且静默 `--idle` 秒就返回，超时则返回"无变化"或"人还在操作"。
- **自检**：`journal/*.selfcheck.ts`、`cli/journal.selfcheck.ts`（真实起 CLI 子进程，HOME 指向临时目录）、`chrome-extension/background.selfcheck.mjs`（桩 chrome 对象）。`hook.js` 在页面里的行为没有自动测试，改它之后用真实 Chrome 手动验证（点击、输入、滚动、请求、前后台）。

### 7.1 在原页面上操作（takeover / release / act）

```
CLI act ─RPC journal.act→ holder.runAct ─siteOp "act"→ 扩展 runAct ─executeScript(MAIN)→ 页面 window.__tcrAct
          └ beginAct / endAct 写 agent 行（动作期间吞掉同 tab 的合成事件）
```

- **租约**在扩展里（`lease` Map，`humanAt` Map），不经过 daemon：页面脚本把真人输入（`trusted` 为真的 `ev`，以及不进日志的 `presence` 在场信号：任意按键、滚轮）交给扩展，`humanInput` 立即撤销租约（滚轮、滚动只记"人在场"）。`leaseAcquire` 要求人静默超过 `HUMAN_IDLE_MS`（1.5s）；租约 `LEASE_IDLE_MS`（10 分钟）没有动作失效；service worker 重启丢租约。租约变化以 `{ type: "lease", tab, state, ... }` 上报，holder 写进日志（kind `lease`，撤销记为 `human`，其余记为 `agent`）。
- **动作**是页面内的合成事件：`hook.js` 的 `window.__tcrAct`。`click` 先滚到视图中央并聚焦，再发 pointer / mouse 序列和 `click`（对 `<a>`、按钮有默认行为）；`fill` 用原生 `value` setter 加 `input`、`change` 事件（React 等框架才认），可编辑区域用 `execCommand("insertText")`；`select`、`check`、`press`（`Enter` 点按钮或提交表单，可打印字符插入到输入框）、`scroll`（页面或容器）。元素引用是稳定编号（`WeakMap` 元素 → `eN`，`Map` 编号 → `WeakRef`），快照和动作共用；实时快照（`why: "live"`）还会列出可滚动区域。
- **等页面稳定**：`hook.js` 统计在途的 fetch / XHR，并记录最近一次 DOM 变化；动作之后等"没有在途请求且 DOM 静默 400ms"，最多 4 秒。动作引发页面跳转（点链接、提交表单）时，页面里等待的脚本被打断，`executeScript` 报"frame 被移除"，扩展把它当成成功（`navigated: true`），等标签页加载完再返回新地址。`goto` 用 `chrome.tabs.update`。
- **登记**：`Ingestor.beginAct` 先写一行 `agent`（动作引发的请求的 `cause` 指向它），动作期间同一个 tab 上 `trusted` 为 false 的页面事件不重复记；`endAct` 补上元素描述、字数、结果（`fill` 的文字不进日志）；动作结束后 800ms 的宽限内晚到的合成事件也不重复记。被租约拒绝的动作也有一行记录。
- **测试**：`journal/act.selfcheck.ts`（登记）、`cli/act.selfcheck.ts`（命令解析）、`chrome-extension/background.selfcheck.mjs`（租约与动作，桩 chrome）、`native-messaging-host/holder.e2e.selfcheck.mjs`（经 relay、holder 到假扩展）；`scripts/dev/hook-e2e.mjs` 在真实 Chrome 里验证 `hook.js` 的每个动作（需要本机 Chrome，不在 `npm test` 里）。

### 7.2 请求优先：重放（req / replay）

```
页面 hook.js ─net 消息（含请求头真值、rid）→ 扩展 rememberRaw ─存 chrome.storage.session（原始内容，不落盘）
                                              └ 转给 daemon 前 redactHeadersForDaemon 抹掉名字像秘密的请求头
CLI replay ─RPC journal.replay→ holder.runReplay（挑请求、挑同源标签页）─siteOp "replay"→ 扩展 runReplay
   取原始内容 → replay-core.applySets（--set）→ executeScript → 页面 window.__tcrReplay（用保存下来的原始 fetch 发）
   ← 响应 → holder 脱敏、存成响应体文件、记一行 agent replay → CLI
```

- **真值留在浏览器里**：页面里发的每个同站请求（`rid = docId:序号`，`docId` 是页面文档的随机编号），原始内容（方法、地址、请求头、请求体）存在扩展的 `chrome.storage.session`（`rawReqs`，上限 4MB，单条 64KB，先丢最旧的；浏览器重启就没了）。转给 daemon 的那份，名字像秘密的请求头（`authorization`、`*token*`、`*csrf*` 等）在扩展里已经抹成 `[redacted]`，daemon 原样保留，不再起别名；地址和请求体里的秘密由 daemon 脱敏（别名）后再写日志。日志里没有真值，也没有"保管处"。
- **别名**：`secret_` 加"盐 + 真值"的 HMAC 前 8 位十六进制（盐在 `~/.tabbot/journal/alias-salt`，0600，第一次运行时随机生成）：同一个秘密永远是同一个别名（重启 daemon 也不变），不能还原。录制和 task 仍用按出现顺序的编号。
- **请求体的脱敏**：JSON 请求体先解析再脱敏（继承来的文本脱敏只认 `key=value`，认不出 JSON 里的 `"access_token":"…"`）；太大（>8KB）或不是完整 JSON 的不存内容（`reqBodyTruncated`）；页面脚本放的占位文字（`[FormData]`、`[Blob 120]`）原样保留，表示没法重放。
- **`--set`**（`chrome-extension/journal/replay-core.js` 的 `applySets`，扩展和自检共用，daemon 只引用其中的常量）：查询参数、`header.名字`、`body.路径`（JSON 或表单，按已有值的类型转换）、`body=`。应用在浏览器里的原始内容上，不在日志里的别名版本上。
- **安全**：只能发给标签页自己的站点（`origin` 必须相同，否则不发）；GET、HEAD 不要租约，其它方法要租约（扩展检查）和 `--yes`（holder 检查）；原始请求头里浏览器自己管的（`cookie`、`origin`、`referer`、`sec-*`…）去掉，`cookie` 由浏览器按 `credentials: "include"` 带上；`__tcrReplay` 用保存下来的原始 `fetch`，所以重放不会被 hook 当成页面自己发的请求记下来。
- **`req find`**：在最近 7 天存下来的响应体文件里找文字，返回是哪个请求返回的；`req show` 用 `templateFromRow` 把日志里的一行还原成请求的样子，并给出风险提示（签名类参数、非 GET）。
- **测试**：`chrome-extension/journal/replay-core.selfcheck.mjs`（`--set`、请求头）、`journal/replay.selfcheck.ts`（别名稳定、还原请求的样子、选标签页、摘要、JSON 请求体不泄露）、`background.selfcheck.mjs`（原始内容、抹真值、重放操作、同源、租约）、`holder.e2e.selfcheck.mjs`（经 relay、holder 到假扩展，含日志里没有真值）；`scripts/dev/hook-e2e.mjs` 在真实 Chrome 里验证 `__tcrReplay`（带 cookie 和自定义请求头、不被记成页面请求）。

