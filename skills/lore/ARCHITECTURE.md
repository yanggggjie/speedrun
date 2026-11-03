# ARCHITECTURE

lore 的目标、设计原则和运行时实现：每一部分是谁实现的、在哪个文件、保证什么。agent 怎么用见 `SKILL.md`；安装见 `install.md`；开发、验证、发布见 `AGENTS.md`。

## 1. 目标与原则

一句话：**超快的、用已登录 Chrome 的 skill；在一个持续的 learn 窗口里学会 action，再在用完即关的 run 窗口里交付。**

- **用户只做两件事**：说要做什么，以及要输入账号密码、扫码的登录。其余全靠 agent 自己 learn，没有用户示范。
- **录制的用途**：① 拿到 endpoint，用请求代替页面操作大幅提速；② endpoint 没法直接发时，给 DOM 操作提供依据（持久定位、该步之后出现了哪个请求）；③ 作为请求头的来源（`request` 继承 agent 窗口里同站点页面最近的请求头）；④ run 出问题时反查。

**action** 是 lore 的基本单位：学出来、带参数、能复用的业务动作，由一个或几个 endpoint（录到的一个请求，写成 `方法 路径`）实现，或用 DOM 实现。**compose** 是用 action 串成的流程，只能调用 action 和别的 compose，不能碰页面；它是 action 的使用者，不是 action 的一种。

设计原则（agent 的使用原则在 `SKILL.md` 第 2 节）：
1. **唯一目标：更快完成眼前的任务。** 结果只来自 `lore run`（毫秒级）。存下来的东西（action、compose、description）是顺带的，由 lore 自动存，agent 不做单独的保存、维护。这是 SKILL 里的约定，没有强制检查。
2. **只录 agent 的窗口。** 用户的窗口和标签页不录、不碰，只读标签页列表（地址、标题）；要看用户手上的页面，就在 learn 窗口里重新打开它，从加载开始录。用户很久以前做的操作，agent 不知道请求的来源和意图；只学 agent 自己做出来的请求才准。
3. **秘密不落盘。** 原始请求（含 token 真值）只在 daemon 内存里；日志里是别名，agent 拿不到真值。
4. **日志和 action 都是文件。** 能读文件的不做命令，agent 用 `rg`、`node`、Python 直接读；lore 的命令只做必须由它做的事（控制浏览器、持有不能落盘的原始请求）。
5. **命令面最小，显式区分优于隐式区分。** 同一条命令不因为 agent 看不到的状态做不同的事。run 窗口每次从空白开始、`run` 的 `--action` / `--compose` / `--compose-code` 三选一，都是为此。

## 2. 两种窗口与它们的保证

| 窗口 | 用途 | 录不录 |
|---|---|---|
| 用户的窗口 | 用户自己浏览 | 不录；只读标签页列表 |
| learn 窗口（句柄 `<站点>-<时间>`） | agent 观察请求、学 action；一直保留，agent 决定什么时候关 | 录，日志在 `learn-windows/<句柄>/`，进 `endpoints.json` |
| run 窗口（`<名字>-<时间>`） | 执行 action 和 compose；每次 run 新开，跑完就关 | 录，日志在 `run-windows/<名字>/`，只给反查，不进 `endpoints.json` |

为什么这样分：learn 需要页面状态接得上（截图点到某个状态，接着在这个状态上跑 action），run 需要每次一样（不因上次留下的页面而不同）；试错、响应原文、截图都留在窗口目录里，不占 agent 的上下文；两种窗口的每个操作和请求都在各自的时间线里，run 出问题时对照着看。

- **learn 窗口**（`run/learn-windows.ts`）：`lore learn new --url … --description …` 是唯一入口，返回句柄（同一秒重名加 `-2`）和 learn 指引（`run/learn-guide.ts`，存在 `~/.lore/learn-guide.md`，内容变了才在输出里给全文）。句柄持久：`learn-windows/<句柄>/meta.json` 存起点、描述、当前 URL、标题、观察游标、操作次数，daemon 重启后读回。所有页面操作、观察、`run` 都作用在它当前的页面上。关窗口：agent `close`、空闲 30 分钟、daemon 重启；关了再操作就重开、回到上次的 URL（页面状态丢失，输出写明），日志接着写。操作上限 200 次。
- **run 窗口**：每次 `lore run` 新开一个，整个 run（含 compose 调用的 action）共用，跑完立刻关；失败时先截图（`screenshots/failure.*`）再关。不同的 run 可以同时跑，没有排队锁。
- **观察按游标**（`journal/commands.ts` 的 `observe`，`journal/explore.ts`）：返回游标之后这个窗口的变化并推进游标（请求默认只列这个窗口里第一次出现的 endpoint 和所有写请求，`--all` 列全部）：页面状态、导航（跳到别的站点时写明站点）、请求（去掉噪声、静态资源、轮询；`describeRequest` 一行：写请求标 `write`（`digest.ts` 的 `looksReadOnly`）、`方法 路径`、状态、内容类型、有没有响应体、请求文件名、以前的 description）、请求之间的依赖（`dependencies`：后一个请求里长度 ≥ 6 的值等于前一个响应里的值）。页面操作执行完等页面稳定，自动附带一次观察；`--since` 重看不推进。"这一步之后发生了什么"以两次观察之间为准，不靠 `cause` 猜。
- **写请求不拦**：learn 窗口里页面发什么就真的发什么，`run` 带 `@write` 的 action 也直接发，由 agent 按 SKILL 的标准判断。`@write` 只是提示。每次 `run`（run 窗口，或 learn 窗口里的 `run`）统计这次真发出的 write 请求（`request()` 发的和页面自己发的，按 `looksReadOnly` 排除查询用的 POST，`run/host.ts` 的 `watchWrites` / `takeWrites`），输出里列成「已发出的 write 请求」，也写进 run 窗口的 `meta.json`。
- **compose 只能调用 action**：`run --compose-code` 和 `@compose` 文件的会话标为 compose-only，任何页面操作都被 `RunHost` 拒绝；反过来，学出来的 action 里调用别的 action（`lore.action`）被 `ActionRunner` 拒绝。compose 可以调用 draft。
- **draft 变成 verified**（`journal/commands.ts` 的 `finishRun`）：run 成功、执行过的 draft 变成 verified。多行 `@endpoint` 要按顺序出现在这次 run 窗口发出的请求里（`missingInSequence`），否则不变并说明。`blocked` 的 action `run` 拒绝。
- **参数**（`run/actions.ts` 的 `checkParams`、`coerceParams`）：对照文件头 `@param 名字[?][:类型]` 检查缺的、多的，再按类型（`number`、`boolean`、`json`，默认字符串）转换后交给 action；compose 里 `action()` 传的参数也一样。
- **`@start`**（`run/runner.ts` 的 `startThenWork`）：run 时先打开这个页面再执行，打不开就失败。
- **`--description`**：打开 learn 窗口、页面操作、`run` 必须带，没带就拒绝（不占操作次数）。存进时间线 cmd 行（它引发的请求经 `cause` 指向它）、`endpoints.json` 每个 endpoint 的 `descriptions`（只收成功的，最近 5 句，`journal/endpoints.ts`）、compose 文件头。学出来的 action 文件不自动改。
- **compose 存下来**（`run/actions.ts` 的 `composeTarget`、`saveComposed`、`pruneUnnamed`）：`--compose-code` 跑通后按代码哈希前 12 位存进 `~/.lore/compose/`（`--compose` 认唯一前缀，`resolveCompose`），头由 lore 填（`// 描述`、`@description` 最多 5 句、`@compose`、`@params`、`@ok` 次数和最近时间）；按名字 `run` 成功也累加 description 和次数，代码以文件当前内容为准（哈希名只在第一次存时算）。淘汰：`@ok` ≥2 次的永远保留且不占名额；只跑过一次的超过 30 天删，最多留 300 个。失败的不存。
- **`lore.ask`**（`run/runner.ts` 的 `work()`、`journal/commands.ts` 的 `handleAsk`）：run 停下输出 `ask <问题>`、`数据`、`恢复`（`lore run --resume <编号> --answer …`），不存 compose；`--resume` 恢复时新开 run 窗口、从头重跑代码，最外层 compose 里记下的 `action()` 直接返回上次的结果，第 i 次 ask 返回第 i 个回答。恢复时核对每次调用的名字和参数，不同就失败。只有最外层的 compose 能 ask；`data` 超过 100KB 失败。恢复记录只在 daemon 内存里，最多 20 条、30 分钟过期，用过就作废（恢复失败时保留）。

## 3. 进程与分层

**所有逻辑和数据在 daemon，扩展、relay、CLI 只做 I/O。** 扩展的安装、重启、分发都不方便（首次只能手动加载，改了代码要用户去 `chrome://extensions` 刷新），而 daemon、CLI 在 `~/.lore/src` 里，`setup.js` 镜像之后 `lore daemon restart` 就生效。

```
CLI（argv→RPC→打印） ──socket──▶ daemon（唯一的大脑） ◀──ext.sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI） ──▶ 页面脚本：录制 + 执行（互相独立）
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的操作（见 §4），加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 `ext.sock` 之间原样转发字节；daemon 不在时拉起它 | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 daemon，打印它返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留着（要诊断可能已死的 daemon） | `src/cli/` |
| 页面脚本 | `recorder.js` 如实上报浏览器里发生的事；`executor.js` 执行 daemon 下发的动作 | `src/chrome-extension/page/` |
| daemon | agent 窗口与 action 运行时、观察、脱敏、写日志与 endpoints.json、日志淘汰、原始请求的内存表、别名对照表、learn 窗口登记 | `src/daemon.ts`、`src/journal/`、`src/run/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| daemon | relay 或 CLI（socket 连不上时 detached 拉起） | 扩展链路、agent 窗口、开着的 learn 窗口、原始请求、`lore.ask` 的恢复记录、日志写入 | 不随 relay 断开退出；没有扩展连接、也没有命令请求超过 10 分钟才退出 |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

- 命令入口：`src/cli/lore.ts` 没有命令逻辑，`lore <argv>` 原样发给 daemon 的 `run` RPC，daemon 调 `journal/commands.ts` 的 `runCommand`，返回 `{ stdout, code }`。daemon 不在时 CLI 会拉起它，存活判据只有一条：socket 能不能回 `ping`。socket 权限 0600，连接按 UTF-8 解码。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展 ABI 不对 → 明确让用户刷新扩展。`status`、关着的窗口上的 `observe` 不需要扩展。
- **输出约定**（`protocol.ts`）：第一行是结论，以 `ok`、`fail`、`ask` 开头，退出码 0、1、2（`ask` 和 `fail need-*` 是 2：要 agent 判断或要用户做一件事，不算失败）；后面是「标题：内容」的几段，多行内容缩进两格：`页面`、`导航`、`请求`、`依赖`、`没列出`（观察），`定位`、`草稿`（页面操作），`结果`（action 的返回值，JSON）、`错误`、`没真发的 write 请求`、`run 窗口目录`、`已变成 verified`（run），`下一步`（建议，最多一两句，和事实分开）。路径一律是绝对路径。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，daemon 只 `detach` 链路，日志照写。
- daemon 启动时：`upgradeLayout`（§8）、打开窗口日志、同步 action SDK、加载 adblock 规则；每 10 秒按额度淘汰日志；每分钟关掉空闲的 learn 窗口。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑，是一个固定 ABI 的管道；页面脚本是扩展包里的静态内容脚本（`page/`）。`manifest.json` 有固定的 `key`，扩展 ID 是 `dkjmgdhelenchaippejoppbcfbjfgppl`（和 `native-messaging-host/install.ts` 的 `EXTENSION_ID` 一致）；权限 `tabs`、`nativeMessaging`、`alarms`、`scripting`、`storage`、`<all_urls>`，Chrome 135 起。

- **ABI**（`browser/extension.ts` 的 `ABI`，现在是 10）：`call`（在页面 MAIN world 调 `window.__lore.exec` 里固定的函数，不执行任意字符串）、`tabs`、`goto`、`openWindow`、`openTab`、`activateTab`、`closeTab`、`closeWindow`、`screenshot`。帧是 4 字节小端长度加 UTF-8 JSON；`hello` 带 `abi`，和 daemon 不一致时不工作，提示用户刷新扩展。只有改 ABI 或权限才需要用户刷新扩展。
- 页面消息：页面脚本 `postMessage` → `bridge.js` → `chrome.runtime.sendMessage` → 扩展补上 tab、frame 转给 daemon。页面自己的脚本也能发，所以日志只是观察记录，不能当权限依据。
- 连接：Chrome 拉起的 relay 无状态，只转发字节；断开后扩展指数退避重连（上限 30 秒），点工具栏图标立即重连。daemon 不随扩展刷新退出。

## 5. 页面脚本

- `recorder.js` 只如实上报发生的事，不改变页面行为：HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker、事件流）、用户输入、导航、页面快照、渲染后的 DOM。`executor.js` 执行 daemon 下发的动作（按持久定位、按屏幕坐标、取文字、`query`、`eval`）。录制和执行互相独立，没有共享状态。细节见两个文件的注释。
- **只录 agent 的标签页（两层，安全相关）**：① 扩展：agent 标签页是 lore 开的，以及被它们打开的（`openerTabId`；创建时是 `chrome://` 地址的 Cmd+T 新标签页不算），集合存在 `chrome.storage.session`。页面脚本在 `document_start` 装钩子、先缓存消息，`bridge.js` 问到「是 agent 标签页」才放行，否则清空缓存、之后一条都不发；`call`、补注入也只对 agent 标签页。② daemon：`Ingestor.handle` 按 `AgentWindows.winOf` 丢弃不属于 agent 窗口的一切，窗口没在 `WindowLog` 登记的也丢；扩展 ABI 不对时一条页面消息都不收。
- agent 窗口里页面脚本触发的一切记为 `src: agent`；有人在 agent 窗口里真的动了一下（`isTrusted`）记为 `user`。

## 6. 日志（journal）

`SKILL.md` 第 5 节是给 agent 的精简版，完整格式在本节末尾。常量（截断大小、额度、时间窗）都在 `utils/constants.ts` 和各文件开头。

- **目录**（`journal/windowlog.ts`）：一个窗口一个目录（`learn-windows/<句柄>/`、`run-windows/<名字>/`），时间线只追加；文件名以全局递增的编号开头，后面是语义。**站点是发出请求的页面的 host（去 `www.`）**，判断不出是 `_other`。`~/.lore/sites/<站点>/` 只有 `endpoints.json` 和 `actions/`，只在 learn 窗口里出现了非噪声请求或有 action 时才建。
- **编号**：`seq` 全局递增，崩溃重启只会留下空洞，不会重复。每次请求都写一行，不去重（轮询间隔也是信息）。
- **因果与阶段**（`journal/ingest.ts`）：`cause`、`phase` 是启发式，离线读日志用；learn 时以观察（§2）为准。
- **保留**（`journal/retention.ts`）：run 窗口目录只留最近的若干个；learn 窗口分两类额度（时间线和请求文件；响应体、页面和截图），超了先删最旧的关着的窗口里的大文件，再删整个窗口。开着的 learn 窗口、每个 endpoint 最近几次成功请求（样本）不动。
- **endpoints.json**（`journal/endpoints.ts`）：只由 learn 窗口的请求增量更新，run 窗口的不进。不排序、不下结论，只给信号。endpoint 名由 `digest.ts` 的 `endpointOf` 算：长数字、哈希、uuid 换成 `:id`，GraphQL 取操作名，同一路径上请求体里的操作名拼在后面（`/graphql#FavoriteTweet`）。
- **过滤**（`filter.ts`）：adblock 规则加第一方埋点启发式标 `noise`；只存同站的响应体。
- **脱敏**（`sanitize.ts`）：请求头名、查询参数名、JSON key 里像秘密的，和 JWT，换成稳定的别名 `⟨secret_…⟩`（盐 + 真值的 HMAC，盐在 `~/.lore/alias-salt`）；响应体和页面正文原样写盘。**别名 → 真值的对照表只在 daemon 内存里。**
- 读日志不是命令：agent 直接读文件。隔离不是安全边界——agent 能读所有窗口目录。

### 数据格式

- **文件名**：以 6 位**日志编号**开头，后面是语义（请求是方法和 endpoint 名，页面是路径）。编号全局唯一、递增；只知道编号时 `ls ~/.lore/*-windows/*/requests/001203-*` 只会命中一个。观察输出里的文件名是相对窗口目录的。
- **action 文件头**：学出来的是 `@summary` `@status draft|verified|blocked` `@endpoint`（可多行）`@param` `@write` `@start` `@timeout` `@note`；compose 是 `// 描述` 加 `@description`（最多 5 句）`@compose` `@params` `@ok`（成功次数和最近时间），下面是代码原文。名字全局唯一（action 和 compose 共用），`lore run --action <名>` / `--compose <名>` 在所有站点的 `actions/` 和 `~/.lore/compose/` 里找。
- **站点**是页面的 host，去掉前导 `www.`（非默认端口带上，目录名里 `:` 变 `_`）：`app.example.com`、`docs.google.com`、`x.com`。请求属于**发出请求的页面**的站点，不是请求地址的站点：`x.com` 页面调 `api.x.com` 记在 `x.com` 里。

**timeline 一行**（JSON）：

| 字段 | 含义 |
|---|---|
| `seq` `t` `win` `site` `tab` | 编号、毫秒时间戳、窗口（句柄或 run 名字）、站点、标签页 |
| `description` | cmd 行：这一步带的 `--description`（用户的话，description）；它引发的请求经 `cause` 指向这一行 |
| `src` | `agent`（lore 的操作，以及 agent 窗口里页面脚本触发的请求和导航）；`user` 只在有人在 agent 窗口里真的动了一下时出现 |
| `type` | `request` `input`（页面里的点击、输入、按键、滚动）`nav` `cmd` `doc` `snap` `tab` |
| input / cmd | `kind`（input 是 click、input、key、scroll、change、submit；cmd 是 goto、request、click、fill……）、`target`（如 `button[Like]`）、`role` `name` `selector` `key` `deltaY`；cmd 有 `ok` `error` `detail`（`request` 命令的 `detail.endpoint` 是它发的 endpoint） |
| request | `requestType`（fetch / xhr）、`method` `url`（不含参数）`status` `size`、`endpoint`（`方法 路径`，就是 `@endpoint` 的写法）、`file`（请求文件，相对窗口目录）、`noise: 1`（埋点广告，默认别看） |
| 因果 | `cause`：引发这个请求的命令的 `seq`（同一标签页 2 秒内最近一次 agent 命令）；`causeDt`：相隔毫秒；`phase`：`load`（页面或单页路由刚开始的几秒）、`cmd`（命令引发）、`idle`（轮询等） |

**请求文件**：`method`，`url{bareUrl, query}`（查询参数已解析），`frameUrl`，`headers`，`requestBody`（JSON 和表单已解析成对象），`status`，`responseHeaders`，`responseBodyPath`（相对窗口目录），`startedAt` `endedAt`；lore 另加 `seq` `win` `endpoint` `requestType` `tab` `rid` `cause` `causeDt` `phase`，失败的有 `error`，被截断的有 `truncated`，没存响应体的有 `bodyOmitted`（原因：`noise` `cross-site` `large-error` `no-body` `error`）。**token、Cookie、密码是别名 `⟨secret_…⟩`**，真值只在 daemon 内存里，agent 拿不到。

**endpoints.json**：`{ site, updatedAt, endpoints: [{ key, method, host, name, count, firstSeq, lastSeq, lastStatus, cmdTriggered, onLoad, idle, lastCause, descriptions, variables, shape, auth, samples, action }] }`。只由 learn 窗口的记录累积。`key` 是 `方法 路径`；`cmdTriggered` / `onLoad` / `idle` 按 `phase` 统计；`variables` 是能改的参数，`shape` 是响应结构；`samples` 是最近 5 次成功请求（`file`、`body` 相对 `~/.lore`，`available` 为假表示文件已被淘汰）；`action` 是覆盖它的 action 名（多行 `@endpoint` 每一行都算）；`auth` 是 auth 头的来源（`cookie:_xsrf`、`local:…`，或 `signed` / `static` / `unknown`），`signed` 为真表示带签名头、换参数可能被拒（以 run 的结果为准）；`descriptions` 是这个 endpoint 的**description**：引发它的操作、跑覆盖它的 action 时带的 `--description`（`{ text, from, t }`，只收成功的，最近 5 句，新的在前）。不排序，由你筛。文件可能比日志晚两秒，要最新就读时间线。


## 7. 执行

- **agent 窗口**（`run/window.ts`）：一个窗口名一个 Chrome 窗口，第一个标签页是 anchor 页（标题 `lore agent`）；其余标签页在窗口内按 origin 池化，保证请求和页面同源。窗口名到 Chrome 窗口的映射只在内存里：daemon 重启后留下的都是孤儿，第一次用时全部关掉。
- **RunHost**（`run/host.ts`）：action 的每个操作都在这里执行并写一行 `cmd`。`request` 默认继承同站点最近一个带 auth 头的原始请求的请求头（内存里没有就先打开站点首页让页面发一次）；`inheritFrom` 只从指定 endpoint 继承（签名和 endpoint 绑定的站点用）；`auth` 声明的头发送时在页面里现读；`waitRequest` 等页面自己发出的第一个匹配请求。
- **ActionRunner**（`run/runner.ts`）：action 在 worker 线程里跑，SDK（`action-lib/index.js`，daemon 每次启动整个覆盖到 `~/.lore/lib`，保证和 daemon 同一个版本）的每个函数是向 daemon 发一个操作，不用传 page；action 文件是 `export default async () => 结果`（`run/worker.ts` 调用它）；agent 自己的纯函数在 `~/.lore/helpers/`，只在不存在时建目录，从不覆盖；compose 包成注入了 `action()` 的模块再跑。整体超时 115 秒（`@timeout` 可改）。失败时输出带 `page`（URL、标题、截图），像登录失效时带 `hint`。
- **在 learn 窗口里 run**（`journal/commands.ts` 的 `windowCommand`）：`lore learn <句柄> run --action <名>` 把 learn 窗口当前的 `Session` 交给 `ActionRunner.runAction`，和 compose 调用 action 一样共用页面状态；日志进 learn 窗口，不变成 verified。原始请求（含真值）只在 daemon 内存里（`journal/raw.ts`），**绝不落盘**，daemon 重启就没了。
- **草稿**（`journal/commands.ts` 的 `observe`、`requestLine`）：观察里最多 3 个请求（写请求优先，再是这一步引发的，再是最新的）带 auth 来源和一行可以贴进 action 的 `request(...)`；地址和请求体里的秘密写成别名。
- **auth 来源**（`journal/auth.ts`）：拿原始请求头的真值和页面此刻的 cookie、localStorage、sessionStorage、meta 比对，再看同一 endpoint 各次请求里这个头变不变，分出来源；只记来源（`endpoints.json` 的 `auth`），不记值。

## 8. 存储与安装

- 用户数据：`~/.lore/learn-windows`、`~/.lore/run-windows`（日志）、`~/.lore/sites`（`endpoints.json`、`actions/`、`.seq`）、`~/.lore/compose`、`~/.lore/helpers`、`~/.lore/alias-salt`；lore 维护的 `~/.lore/lib`；运行时状态 `~/.lore/session`；运行时代码 `~/.lore/src`。
- `setup.js` 把 skill 目录镜像到 `~/.lore`（只排除 `node_modules`、`.DS_Store`；本机数据目录不碰）、装依赖、注册 native host、生成命令、让过期的 daemon 换成新代码、运行 `doctor`；从旧名字（TabBot、Deft、Silt）迁移由 `store/deploy.ts` 的 `migrateHome` 做。
- 版本：`~/.lore/src/.version` 的 `build`；只有 `setup.js` 发现 `build` 不同、或用户 `lore daemon restart` 时才换代码。`lore doctor` 只读。

## 9. 排障

先运行 `~/.lore/bin/lore doctor`（`--json` 得到机器可读结果），失败项带修复命令。安装类的问题（Node、依赖、native host、加载扩展）见 `install.md`。下面是运行时的问题，都可以读源码定位并直接修复；直接改 `~/.lore/src` 是临时修复，下次升级会覆盖。

| 现象 | 处理 |
|---|---|
| `extension-abi` 不对，或"扩展是旧版本" | 在 `chrome://extensions` 里刷新 lore |
| `need-extension` | 请用户确认 Chrome 里的 lore 扩展开着，点一下工具栏图标；从没加载过的属于安装问题 |
| `need-install` | lore 没装好或 native host 丢了：告诉用户需要重新安装 lore |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，Chrome 会重新拉起；等几秒，仍不行就重启 Chrome |
| 升级后旧 daemon 还在跑 | `lore daemon restart` |
| `run` 报"没有可继承的请求头" | 已经自动打开过该站点首页仍没有带 auth 头的请求：这个站点的 endpoint 可能不需要（去掉 `inherit`），或 action 要先 `goto` 到会发这个请求的页面 |
| learn 窗口的操作说"重新打开" | Chrome 窗口之前关了（close、空闲 30 分钟、daemon 重启），页面状态没了；回到了上次的 URL，需要的话重新点到那个状态 |
| `learn <句柄> click`、`type`、`key`、`scroll` 报"页面里没有 lore 的脚本" | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| run 成功了 draft 却没变成 verified | 输出写了原因：多行 `@endpoint` 没按顺序发出（前置请求漏了，或顺序写错） |
| 日志里没有某个站点的事件 | 只录 agent 窗口：用户自己窗口里的浏览不会有记录，要用 `learn new --url` 在 learn 窗口里重新打开；用户在 agent 窗口里自己开的标签页（Cmd+T）也不录；看对应窗口目录里的 `timeline.jsonl`，按 `site` 字段筛 |
| 磁盘上 `~/.lore/learn-windows` 太大 | 按额度自动淘汰（`lore status` 看占用）；要手动清就删关掉的旧窗口目录，别删 `sites/*/actions/` |

- 运行时日志：`~/.lore/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <daemon pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。
