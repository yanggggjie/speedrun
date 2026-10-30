# ARCHITECTURE

TabBot 的目标、角色分工和运行时架构。agent 怎么用见 `SKILL.md`；仓库边界、开发验证、分发发布见 `AGENTS.md`；安装见 `install.md`。

## 1. 目标与原则

一句话：**超快的、用已登录 Chrome 的 skill；探索一步就写一步 task，绝不探索浪费。**

- **用户只做两件事**：说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。其余全靠 agent 自己探索，没有用户示范。agent 干活在单独的 `tabbot agent` 窗口里，不打扰用户的窗口和标签页。
- **只录 agent 自己的窗口**（学习会话和 run 窗口）。用户很久以前、或不是 agent 做的操作，agent 不知道请求的来源和意图；agent 自己做一次、学自己做出来的请求才准。要了解用户手上的页面，就在学习会话窗口里重新打开它的地址，从加载开始录。
- **录制的用途**：① 拿到接口信息，用接口大幅提速；② 接口无法重放时，给 DOM 操作提供依据（持久定位、该步触发了哪个请求）；③ 作为请求头的来源（`request` 继承 agent 窗口里同站点页面最近的请求头）。

原则（运行时做法见 `SKILL.md` 第 1 节）：
1. **唯一目标：更快完成眼前的任务。** 结果只来自 `tabbot run` / `compose`（毫秒级），最终回复引用回执。沉淀（task、组合、业务知识）是顺带的，由 TabBot 自动存，agent 不做单独的保存、维护。
2. **有 task 先用 task。** 不管什么任务，先找 verified 的 task。
3. **探索即写 task。** 探索的唯一产物是 task，不是答案；只学 agent 自己做出来的请求。**动作一旦引发请求，立刻转去学这个请求，不再继续翻。**（最重要）
4. **network 优先，DOM 兜底。** 一份 task 只覆盖一个请求（DOM 则是一个页面读取动作）。
5. **成本顺序：** 读 task 文件 < `debug replay` < 一次页面动作（截图加坐标）< 继续探索。没有用户示范，学不会就 `close --blocked`。
6. **命令面最小。** 能读文件的不做命令；TabBot 只做必须由它做的事。（重要）
7. **只录 agent 的窗口。** 用户的窗口和标签页不录、不碰，只读标签页列表（地址、标题）。

**整体结构**

| 窗口 | 用途 | 录不录 |
|---|---|---|
| 用户的窗口 | 用户自己浏览 | 不录；只读标签页列表 |
| run 窗口 | 执行 task | 录（失败时给 `--fix` 当线索；也是请求头来源） |
| 学习会话窗口（`debug-xxxx`） | 一个会话一个，agent 探索 | 录（这就是学习材料） |

```
任务 → 找 verified task → tabbot run（结束，引用回执）
         │ 没有
         ▼
  起点：用户给的链接；或用户说的 tab（tabbot tabs 对出 tab 号）；或站点首页
         ▼
tabbot learn <名> --url <链接|tab 号> (--find … | --endpoint …)
  会话窗口打开起点，输出加载期请求
  动作（截图加坐标）→ 引发的请求 + 可贴进 task 的一行；引发请求就锁定，先写草稿
  结束：run --window 跑通（verified，回执）或 close --blocked（blocked，回执）
  要登录：停下来请用户登录，再继续
```

## 2. 角色：一个 agent，两种窗口

只有一个 agent，没有 subagent。「调试」「执行」是产品的两个词：**调试**是在学习会话里摸清接口和定位，目的是写出 task；**执行**只有 `tabbot run`——用户拿到的结果必须来自 task 的返回值。

- **run 窗口**（key 为 `run`）：长期持有，只执行 task，**不能调试**。`tabbot run` / `compose` 在这里跑。
- **学习会话**（debug 窗口，key 为 `debug-xxxx`）：agent 学一个请求时用 `tabbot learn` 开一个，绑定一份 task 名；会话里才能 `tabbot debug open|screenshot|click|type|key|scroll|replay|close --blocked`，**包括真正发起有副作用的操作**（学习需要真的发一次才知道成败；先 `--dry` 看会发什么，问过用户再真发，只做学习必需的最少次数，批量留给 task 循环）。产出是一份 task；task `run` 成功会话就收回。

**为什么要有学习会话**（调试不能变成随手做的事）：
1. 速度：调试慢，按 task 执行只要毫秒。调试有头有尾（开会话、有操作上限、空闲回收、task 验证通过就收回），才不会一直调试、永远用不上 task。
2. 目标：agent 要把结果交给用户，容易倾向于“先把眼前的做出来”，task 就被省掉。所以用户的结果必须来自 `tabbot run`，每次 `run` / `compose` 发一个**回执**（`RC-xxxxxxxx`，写进 `sites/.receipts.jsonl`），最终回复必须引用它。
3. 上下文：试错、响应原文、截图都在会话里产生；读响应体用 `rg`、`node -e` 取字段，不整段读进来，截图只在需要时截。
4. 事后可查：会话里的每个动作都在它自己窗口的时间线里。

**强制机制（全在 TabBot 内，不依赖 harness；回执检查例外）**
1. `tabbot learn <task 名> [--site <站点>] [--url <链接|tab 号>] (--endpoint "方法 接口名" | --find "要的那一个数据或动作") [--note "…"] [--fix]` 是开学习会话的唯一入口（`--url` 是起点：链接原样用，tab 号只取那个用户标签页的地址；站点可以从地址推出来；没有就是站点首页。会话窗口打开起点，输出它加载期的请求，不锁定）（二选一：知道接口名用 `--endpoint`；只知道要什么用 `--find`，自己从材料和页面里找到那一个请求；`--fix` 时缺省取现有 task 文件头的 `@endpoint`；`--endpoint` 在 endpoints.json 里没有样本只警告）：开一个 **debug 窗口**（绑定 task 名和站点，只在 holder 内存里；同一个 task 名同时只能有一个，站点不限），把目标接口的样本和触发它的动作导出成冻结的**交接材料**（§6），输出自包含的学习指引（目标、会话号、材料和日志在哪、做法、纪律、SDK 用法、写 task 的规则）。一个会话只学一个站点的一个请求（`--find` 时最终也只写一个 `@endpoint`，发现还需要别的请求就学完再开下一个）：做法优先 network（task 里直接发请求），不行才 dom（触发这个请求的最小页面操作）；遍历、批量、聚合、业务汇总不写进 task，用 task 循环和 `compose`；task 名全局唯一，同名的草稿（`@status: draft`）要加 `--fix` 续。
2. `tabbot debug` 只能在学习会话里：没开会话、是 run 窗口、不存在、已收回、用完 80 次操作，一律拒绝并说明；只开着一个会话时可以不写 `--window`，开着几个要写。会话收回有三种：绑定的 task `run` 成功；`debug close --blocked "…"` 确认学不会；30 分钟没有操作自动回收（没有产物，不发回执）；收回时窗口和工作区（含材料）一起删，它留下的日志是历史，不删。
3. `compose` 只能 `task(名字, 参数)` 组合 task：compose 自己的会话被标为 compose-only，任何页面操作（包括 `import` SDK 后调用）都被 host 拒绝。
4. `run` 真跑成功一次，task 头里的 `@status: draft` 自动变 `verified`；`--dry` 让非 GET 的 `request` 不真发，只打印将发送的内容（学习时迭代用）。在学习会话里带 `--window` `run` 它绑定的 task 成功，会话收回、关掉。
5. task 头写 `@endpoint 方法 接口名`（和 `endpoints.json` 里的 `key` 一致）：聚合文件把已有 task 覆盖的接口标上 `task`，`task` 为 `null` 的就是还没学会的。`@status` 有 `draft`、`verified`、`blocked` 三种，`blocked` 是确认学不会的记录（原因在 `@note`）：`run` 拒绝，`learn` 不再开会话，`--fix` 才能重开。
6. **探索即写 task 的结构化落实**（`journal/explore.ts` 加 `journal/commands.ts` 的 `pointerCommand`、`lockReason`）：`debug click` / `type` / `key` / `scroll` 成功后输出持久定位、**一行可贴进 task 的代码**，以及**这一步引发的请求**（非噪声、非 idle、非静态资源、非周期性接口；含 GET；写明内容类型和有没有响应体，没有就写 `bodyOmitted` 的原因）。引发了请求就**锁定**这个会话：task 草稿在锁定之后被改过之前，`open` / `click` / `type` / `key` / `scroll` 被拒绝且不占操作次数，`screenshot` 和 `replay` 不受限。会话只有两种结束：绑定的 task `run` 成功，或 `debug close --blocked "原因和证据"`（把 task 标成 blocked，发回执）；不带 `--blocked` 的 `close` 被拒绝。动作后页面跳到别的站点时，输出写明跳去了哪，并列出那个站点里这个会话窗口在这一步之后的请求（同样参与锁定）。
8. **`--description`：意图沉淀成业务知识**（和 Claude Code 的 Bash 工具的 `description` 同名同用法）：`debug open/click/type/key/scroll/replay`、`run`、`compose` 必须带一句"用用户的话说这一步要做什么"，没带就拒绝（调试动作不占操作次数）。存在 agent 本来就读的地方：时间线 cmd 行的 `description`（它引发的请求经 `cause` 继承）；`endpoints.json` 每个接口的 `descriptions`（引发它的动作、重放它、跑覆盖它的 task 时带的，只收成功的，最近 5 句，`journal/endpoints.ts` 的 `observe` / `describe`）；compose 存下的文件的头。动作输出列请求时附上接口以前的 description。task 文件不自动改。
9. **compose 自动存留**（`run/tasks.ts` 的 `saveCompose`）：`tabbot compose --description "…" <文件 | '代码'> [--参数 值]`，参数以 `tabbot.params.名字` 读到。成功的代码存进 `~/.tabbot/compose/<代码哈希前 12 位>.js`，头由 TabBot 填（`@description` 最多 5 句、`@uses` 从 `task("名字")` 解析、`@params` 从 `tabbot.params.名字` 解析、`@ok` 次数和最近时间），代码原样；拿存下的文件再跑时去掉头再算哈希，所以还是同一份；只留最近 200 个；失败的不存（仍在运行历史）。代码没用参数时输出提示一句。
7. **回执检查**（可选，Claude Code 的 Stop hook）：`src/hooks/stop-receipt.mjs` 看本轮（最后一条用户消息之后）工具输出里出现过的回执，最终回复没引用任何一个就拦一次，让 agent 补上；本轮用过 `tabbot learn` / `debug` 却没有任何回执（既没 run 通过也没 `close --blocked`）也拦一次；都没有的轮次不管。注册方法：在 `~/.claude/settings.json` 里加 `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node ~/.tabbot/src/hooks/stop-receipt.mjs"}]}]}}`。别的 harness 靠 `SKILL.md` 的约定。

## 3. 进程与分层

**所有逻辑和数据在 holder，扩展、relay、CLI 只做 I/O。** 扩展的安装、重启、分发都不方便（首次只能手动加载，改了代码要用户去 `chrome://extensions` 刷新），而 holder、CLI 在 `~/.tabbot/src` 里，`setup.js` 镜像之后 `tabbot daemon restart` 就生效。

```
CLI（argv→RPC→打印） ──socket──▶ holder（唯一的大脑） ◀──ext.sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI） ──▶ 页面脚本：录制 + 执行（互相独立）
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的操作（见 §4），加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 `ext.sock` 之间原样转发字节；daemon 不在时拉起它 | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 holder，打印它返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留着（要诊断可能已死的 holder） | `src/cli/` |
| 页面脚本 | `recorder.js` 如实上报浏览器里发生的事；`executor.js` 执行 holder 下发的动作 | `src/chrome-extension/page/` |
| holder | agent 窗口与 task 运行时、重放、脱敏、写日志与接口聚合、交接材料、日志淘汰、原始请求的内存表、别名对照表、debug 窗口登记 | `src/holder.ts`、`src/journal/`、`src/run/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（daemon） | relay 或 CLI（socket 连不上时 detached 拉起） | 扩展链路、agent 窗口、debug 窗口登记、原始请求、日志写入 | 不随 relay 断开退出；没有扩展连接、也没有命令请求超过 10 分钟才退出 |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

- 命令入口：`src/cli/tabbot.ts` 没有命令逻辑，`tabbot <argv>` 原样发给 holder 的 `run` RPC，holder 调 `journal/commands.ts` 的 `runCommand`，返回 `{ stdout, code }`。holder 不在时 CLI 会拉起它，存活判据只有一条：socket 能不能回 `ping`。socket 权限 0600，连接按 UTF-8 解码。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展 ABI 不对 → 明确让用户刷新扩展。`status`、`tabs` 之外不碰浏览器的命令不需要扩展。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`，退出码非零；`run`/`compose` 输出 `{ mode, status, result | error }` 的 JSON。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，日志照写。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑。页面脚本是扩展包里的**静态内容脚本**（`page/`）：`common.js`、`recorder.js`、`executor.js` 在 MAIN world，`bridge.js` 在隔离世界；已打开的页面在握手后由 `injectExisting` 补注入。权限：`tabs`、`nativeMessaging`、`alarms`、`scripting`，`host_permissions: <all_urls>`，`minimum_chrome_version` 135。不依赖 `chrome.userScripts`。

- **ABI 5**（`browser/extension.ts`；4 起页面脚本只在 agent 窗口上报，`call` 只在 agent 窗口执行；5 起页面消息带 `win`（标签页所在的浏览器窗口），holder 据此把页面在 agent 窗口里自己开的标签页（target=_blank、`window.open`）也算进那个窗口）：`call { tabId, fn, args }`（在页面 MAIN world 调 `window.__tcr.exec[fn](...args)` 并取回结果；函数集合固定，不执行任意字符串，严格 CSP 的页面也能用；任意函数 `exec.eval` 是兜底）；`tabs`（http/https 页面加 anchor 页）；`goto { tabId, url, wait }`；`openWindow { anchor }`（不抢焦点）、`openTab`、`activateTab`、`closeTab`、`closeWindow`。帧是 4 字节小端长度加 UTF-8 JSON；只支持一个扩展连接，新的合法 `hello` 替换旧连接。只有改 ABI 才加版本号，用户才需要刷新扩展，`doctor` 的 `extension-abi` 提示。
- 页面消息通道：页面脚本 `window.postMessage`，`bridge.js` 收到后 `chrome.runtime.sendMessage`，扩展补上 tab、frame 后转给 holder。页面自己的脚本也能发，所以日志只是观察记录，不能当权限依据。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒；点击工具栏图标立即重连。
- 图标源文件是 `scripts/dev/icons/icon.svg`，改动后运行 `node scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机 Chrome）。

## 5. 页面脚本

- `common.js`：命名空间 `window.__tcr`、限流的 `post`、前台判断、元素描述与页面快照（只给录制用）、DOM 变化计数、原始 `fetch`。
- `recorder.js`（录制）：**只在 agent 窗口里上报**（见下）。只录三种请求——HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker）；用户输入（点击、输入长度、特殊键、滚动）；导航；页面快照；主文档渲染后的 DOM。响应体不设策略上限，不读事件流，读到 16MiB 就停并标 `truncated`。每个请求带 `ms`（耗时）和 `at`（请求开始时离文档开始的毫秒数，holder 据此判断请求是不是在页面刚加载的那几秒里发的）。
- `executor.js`（执行）：`window.__tcr.exec` 下的 `act`（按持久定位 click / fill / select / check / press / scroll，全是 DOM 事件，task 用）、`pointer`（按屏幕坐标 click / type / key / scroll，探索用，返回点中元素的持久定位）、`text`、`replay`、`waitFor`、`query`（声明式取数）、`eval`。`act` 的目标是持久定位 `loc`（CSS、`{role,name}`、`{text}`，可加 `nth`，元素没出现会等到超时），成功后返回元素的持久定位。点击先滚到视图中央并聚焦，再发 pointer / mouse 序列和 `click`；`fill` 用原生 `value` setter 加 `input`、`change` 事件；等页面稳定：没有在途请求且 DOM 静默 400ms，最多 4 秒。不支持：文件选择框、iframe 里的元素、`closed shadow root`。
- **只录 agent 的窗口（两层）**：① 扩展：页面脚本在 `document_start` 照常装钩子（否则漏加载期请求），`common.js` 的 `post` 先把消息缓存（最多 500 条）；`bridge.js` 加载时问 background 这个标签页所在的窗口有没有 anchor 页（有就是 agent 窗口），答"是"才发出缓存并放行，答"不是"就清空缓存、之后一条都不发。background 也只转 agent 窗口的页面消息和地址变化，`call` 只在 agent 窗口执行，`injectExisting` 只补注入 agent 窗口。② holder：`Ingestor.handle` 按 `AgentWindows.winOf` 丢弃不是 agent 窗口的一切（TabBot 开的标签页按池里的记录；页面在 agent 窗口里自己开的标签页按消息里的 `win` 由 `adopt` 认领）（不写日志、不进原始请求内存表、不进接口聚合），扩展是旧版本时也成立。
- **录制与执行解耦**：录制如实反映 agent 窗口里的浏览器状态；执行只管执行，两者之间没有共享状态。agent 窗口里页面脚本触发的一切记为 `agent`，写进该窗口自己的时间线文件；有人在 agent 窗口里真的动了一下（`isTrusted`）记为 `user`。

## 6. 日志（journal）

格式给 agent 看的版本在 `SKILL.md` 第 3 节（唯一描述数据格式的地方）；这里讲怎么存、怎么淘汰、怎么保证准确。

- **目录**（`journal/sitelog.ts`）：`~/.tabbot/sites/<站点>/log/<段>/`，每个窗口一个 `timeline.<窗口>.jsonl`（追加写，不改已写的行），每次请求一个请求文件（`<编号>_<方法>_<地址>.json`，沿用 yodo 的请求文件格式），响应体 `.response.*`、HTML 文档 `.doc.html`、页面快照 `.snap.json`。**站点是页面的 host（去 `www.`）**，请求属于发出请求的页面；判断不出站点的行放在 `_other`。文件引用写成相对 `log/` 的 `<段>/<文件名>`，所以后出现的相同响应体可以直接指向较早的段里已有的文件（按内容哈希，同一站点内去重）。
- **编号**：`seq` 全局递增，上界按 1000 一块落盘到 `~/.tabbot/sites/.seq`，崩溃重启只会留下编号空洞，不会重复。`cmd` 在开始时预留编号（它引发的请求会指向它），行在做完时才写；读者按 `seq` 排序。
- **每次请求都写一行**，不去重（轮询间隔也是信息）；省空间靠响应体按内容哈希只存一份。
- **因果与阶段**（`journal/ingest.ts`）：`cause` 是同一标签页里请求**开始时**之前 2 秒内最近一次 agent 命令（或 agent 窗口里的真人输入），`causeDt` 是相隔毫秒；`phase` 是 `load`（文档或单页路由开始后 4 秒内、期间没有新动作）、`action`、`idle`。这些是启发式，原始 `nav` 行和时间都在，读者可以自己重算。
- **两层保留**（`journal/retention.ts`，额度见 `utils/constants.ts` 的 `LOG_LIMITS`，总计 2GB）：轻量层（时间线、请求文件）总计 500MB、每站点 150MB；重量层（响应体、文档、快照）总计 1.5GB、每站点 600MB。重量层超了，从最旧的段开始只删没受保护的重量层文件，时间线和请求文件保留；轻量层超了才删整段。单个站点超了只动它自己，总量超了先动占用最多的站点，当前段永远不动。段在重量层写满 64MB 或开满一天时换。每个接口最近 5 次成功请求是**样本**，它们的请求文件和响应体受保护（每站点样本合计 100MB），整段被删时 `endpoints.json` 里对应样本标 `available: false`。按本机实测（约 260MB/天）完整响应体能留约 6 天，时间线能留一个多月。
- **接口聚合**（`journal/endpoints.ts`）：写入一个请求就增量更新这个站点的 `endpoints.json`（节流 2 秒原子写，重启时读回）：只由 agent 窗口的记录累积：次数、`actionTriggered` / `onLoad` / `idle`（旧文件的 `userTriggered` 丢掉、`agentTriggered` 并进 `actionTriggered`）、`lastCause`、变量、响应结构、`replayable`（原始请求还在不在内存里）、样本、`task`（读该站点 `tasks/` 的 `@endpoint`）。不排序、不下结论，只给信号。接口名由 `digest.ts` 的 `endpointOf` 算：GraphQL 取操作名，其它路径把长数字、哈希、uuid 换成 `:id`，同一路径上请求体里的 `operationName` / `action` / `method` 之类的字符串字段拼在后面（`/graphql#FavoriteTweet`），否则 POST `/graphql`、POST `/rpc` 会把所有操作并成一个接口。
- **交接材料**（`journal/material.ts`）：`learn` 时导出到 `debug/<窗口号>/material/`，只含一个站点，行和文件逐字复制（硬链接，不行就复制），按窗口分文件；仍开着的其他学习会话整个排除（它们正在试错）；只有 agent 窗口的记录；以目标接口的样本为锚点（样本、触发它们的动作、同一标签页前 60 秒的行），没指定接口时锚点是最近 30 分钟里动作引发的非 GET 请求；`--fix` 时另带 run 窗口里这个接口最近 3 次失败的请求；`doc`、`snap` 行不导出，响应体只给锚点请求的；`manifest.json` 写明包含和排除了哪些窗口、数量和缺口，不假装完整。
- **过滤**（`filter.ts`）：`@ghostery/adblocker` 规则加第一方埋点启发式（只对非 GET）标 `noise`，默认不看；失败的请求只留小于 4KB 的响应体；只存同站的响应体。
- **脱敏**（`sanitize.ts`）：带单词边界的正则（`token`、`secret`、`password`、`csrf`、`jwt`、`auth` 等）加严格的 JWT 判断，只作用于请求头名、URL 查询参数名、JSON 的 key；响应体正文原样写盘。秘密换成别名 `⟨secret_<12 位十六进制>:<形状>⟩`：盐 + 真值的 HMAC（盐在 `~/.tabbot/alias-salt`，0600），同一个秘密永远是同一个别名。**别名 → 真值的对照表只在 holder 内存里**。
- **录制的缺口**（会在材料的 `manifest.json` 里提示）：用户的窗口不录；WebSocket、`sendBeacon`、Worker、事件流不记录；响应超过 16MiB 被截断；请求体超过 64KB 不存内容。
- agent 窗口里的 http/https 站点都录，没有排除列表；HTML 文档原样存，不为敏感内容做额外保护（产品还在做，先把产品做好）。
- 读日志不是命令：agent 直接读文件（`rg`、`node -e`、Python）。隔离不是安全边界——agent 能读所有站点目录；debug 窗口“只看该看的”靠物理分文件和冻结的材料。

## 7. agent 窗口与 task

- **agent 窗口**（`run/window.ts`）分两种：**run 窗口**（key 为 `run`）长期持有，只执行 task，不能调试；**debug 窗口**（key 为 `debug-xxxx`，登记在 `run/debug-windows.ts`）一个学习会话一个，开会话时开、收回时关。一个 key 一个窗口，所以 run 窗口和学习会话的页面各在自己窗口的前台（浏览器不渲染后台标签页）。窗口的第一个标签页是扩展的 anchor 页（标题 `tabbot agent`）。其余标签页按 origin（协议加主机加端口，只在执行层用：保证请求和页面同源）池化：`acquire(origin, key)` 复用同站点空闲标签页，没有就开 `origin/robots.txt`（很轻，页面脚本就位）；用完还回去，空闲 30 分钟关闭（只录 agent 窗口，请求头只能从这些页面继承，留久一点少重开）；debug 窗口收回时整个窗口关掉。key 到窗口的映射只在内存里：holder 重启（或扩展链路重连）一切归零，留下的窗口都是孤儿，第一次用窗口时全部关掉。用户关了窗口会自动重开（run 和 debug 一样）。run 窗口不并发：`run` 和 `compose` 同一个 key 一次只跑一个。
- **RunHost**（`run/host.ts`）：goto、request、act、pointer、screenshot、waitFor、text、query、eval，每个都写一行 `cmd` 记录。`request` 默认继承 holder 内存里同站点最近一个带身份头（authorization、csrf、x-*）的原始请求的请求头；内存里没有（holder 重启过、页面还没发过请求）时，自动打开该站点首页让页面自己发请求，每个站点只试一次，仍没有再按需报错。
- **TaskRunner**（`run/runner.ts`）：task 脚本在 worker 线程里运行（`task-lib/index.js` 同步到 `~/.tabbot/lib`），SDK 的每个函数是向 holder 发一个操作；同一个 key 一次只跑一个，不同 key 可以同时跑；整体超时 115 秒（`@timeout` 可改）；`tabbot.task()` 嵌套调用共用页面状态；运行历史在 `~/.tabbot/run/<task>/`；成功的 compose 另存一份代码到 `~/.tabbot/compose/`（见第 2 节）。`run` 失败（非嵌套）时，如果 run 窗口里有页面，输出带 `page`（URL、标题、截图文件 `~/.tabbot/run/failures/fail-*`，只留最近 10 张）；页面像登录页或错误是 401/403 时带 `hint`（请用户登录后重跑，不要重新学习）。截图失败不影响原来的错误。
- task 是 `~/.tabbot/sites/<站点>/tasks/<名字>.js`，从 `../../../lib/index.js` 引用 SDK；task 名全局唯一，`tabbot run <名字>` 在所有站点的 `tasks/` 里找。文件头 `@summary`、`@status: draft|verified`、`@endpoint 方法 接口名`、`@param 名字? 说明`、`@timeout`、`@note`（经验：签名、风控、踩过的坑，一行一条）。参数一律具名 `--名字 值`，缺必填或传了没声明的参数直接报错。

### 重放（debug replay）

- **原始请求只在 holder 内存里**（`journal/raw.ts`）：页面里发的每个同站请求的方法、地址、请求头、请求体，上限 50MB、单条 64KB，先丢最旧的；**绝不落盘**。
- `tabbot debug replay <编号> [--set ...] [--yes]`（开着几个会话时加 `--window <号>`）：在学习会话绑定的站点里按编号找请求文件（文件名开头的数字）→ 用文件里的 `tab` 和 `rid` 取内存里的原始内容 → 把 `--set` 里的别名换回真值 → `applySets`（`journal/replay-core.ts`）→ 在学习会话的 agent 窗口里和原请求同 origin 的标签页用原始 `fetch` 发出（带登录态，不会被录制端当成页面自己发的）→ 响应脱敏后写成新的请求文件（`requestType: replay`，带 `replayOf`）和一行时间线，记在这个 debug 窗口自己的文件里。
- **`--set`**：`名字=值` 改查询参数；`名字.路径=值` 改查询参数里 JSON 的字段（GraphQL 的 GET 请求 `variables.cursor=xxx`，翻页用）；`header.名字=值` 改请求头；`body.路径=值` 改 JSON 或表单请求体；`body=内容` 整个换掉。非 GET 要 `--yes`；浏览器自己管的请求头去掉。
- 在响应体里找页面上看到的值是 `rg`，还原请求就是读请求文件；`journal/replay.ts` 的 `templateFromRequestFile` 给出风险提示（签名类参数、非 GET）。

## 8. 存储与安装

- 用户数据：`~/.tabbot/sites`（每个站点：日志、`endpoints.json`、task、debug 窗口工作区）、`~/.tabbot/lib`（task SDK）、`~/.tabbot/alias-salt`、`~/.tabbot/run`（运行历史）、`~/.tabbot/compose`（跑通过的 compose 代码）；运行时状态 `~/.tabbot/session`；运行时代码 `~/.tabbot/src`。
- `setup.js` 把 skill 目录镜像到 `~/.tabbot`、把旧版本的 `journal`、`task` 目录改名为 `journal.old`、`task.old`（不读取、不转换，旧盐复制到新位置）、安装依赖、写版本文件、注册 native host、生成 shim、让过期的 daemon 换成新代码、运行 `doctor`。分发是源码镜像：`~/.tabbot` 是 `skills/tabbot/` 的逐字节拷贝，只排除 `node_modules` 和 `.DS_Store`（`store/deploy.ts`）；顶层的 `src`、`scripts` 先清空再拷，`sites`、`lib`、`run`、`session`、`bin`、`alias-salt` 是本机数据，镜像不碰。
- 版本：`~/.tabbot/src/.version` 写 `{ build }`（只算运行时文件，排除自检）；daemon 启动时记下 `build`，`ping` 返回它。换代码只在 `setup.js` 发现 `build` 不同和用户显式 `tabbot daemon restart` 时发生，没有命令会自动重启 daemon。
- `tabbot doctor` 只读。

## 9. 测试

`npm test`（几秒，纯逻辑，不依赖 Chrome）：脱敏与别名、`--set`、日志摄入（站点按页面 host、窗口分文件、因果与阶段、每次请求一行）、站点日志存储（编号唯一、换段、占用量）、两层淘汰（只动自己的站点、样本和当前段不动）、接口聚合与接口名、交接材料（逐字复制、排除仍开着的窗口、缺口）、升级时旧数据改名、扩展链路分帧与握手、命令层（假的 holder 能力：debug 窗口与 `debug` 强制、`compose` 只能组合、`--dry`、自动晋升、草稿 `--fix`）。**不模拟扩展**：扩展、页面脚本、agent 窗口、task 运行时的行为用真实 Chrome 加 Claude in Chrome 验证（见 `AGENTS.md` 2.3）。`npm run verify:pack` 只在发布前跑。

## 10. 排障

先运行 `~/.tabbot/bin/tabbot doctor`（`--json` 得到机器可读结果），失败项带修复命令。下面的问题都可以读源码定位并直接修复；直接改 `~/.tabbot/src` 是临时修复，下次升级会覆盖。

| 现象 | 处理 |
|---|---|
| Node 低于 24；`npm install` 失败；`doctor` 的 `home`、`src`、`deps`、`session`、`native-host`、`launcher` 失败 | 升级 Node / 解决 npm 的报错后重跑 `node <skill 安装目录>/setup.js`（可重复执行，`npx skills ls -g` 找安装目录） |
| 找不到 `tabbot` 命令 | 用绝对路径 `~/.tabbot/bin/tabbot`，或把 `~/.tabbot/bin` 加入 PATH |
| `need-extension`，从没加载过扩展 | `chrome://extensions` 开「开发者模式」，「加载已解压的扩展程序」，选 `~/.tabbot/src/chrome-extension` |
| `need-extension`，扩展已加载 | 确认 TabBot 开着，点一下工具栏图标 |
| `extension-abi` 不对，或“扩展是旧版本” | 在 `chrome://extensions` 里刷新 TabBot；从旧版本（ABI 1）升级的要先移除旧扩展再重新加载，否则旧的动态内容脚本会残留、重复录制 |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，Chrome 会重新拉起；等几秒，仍不行就重启 Chrome |
| 升级后旧 daemon 还在跑 | `tabbot daemon restart` |
| `run` 报“没有可继承的请求头” | 已经自动打开过该站点首页仍没有带身份头的请求：这个站点的接口可能不需要（去掉 `inherit`），或 task 要先 `goto` 到会发这个请求的页面 |
| `run` 在 agent 窗口里一直不动 | 窗口被用户关了会自动重开；同一 key 里另一个 task 在跑会等 30 秒再失败 |
| `debug` 报“没有学习会话” | 这是设计：调试只能在学习会话里，先 `tabbot learn …`；会话失效（holder 重启）也重新 learn |
| `debug click`、`type`、`key`、`scroll` 报“页面里没有 TabBot 的脚本” | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| `replay` 报“原始内容已经不在 holder 的内存里”或“别名已失效” | holder 重启过或太旧被清掉；`debug open` 加 `screenshot`、`click` 在 debug 窗口里触发一次这个操作，用新的编号重试 |
| 日志里没有某个站点的事件 | 只录 agent 窗口：用户自己窗口里的浏览不会有记录，要在学习会话里 `learn --url` 重新打开；扩展要是 ABI 5（`tabbot doctor` 的 `extension-abi`）；站点目录名是页面的 host（去 `www.`），如 `app.example.com` 不在 `example.com` 下；先看 `tabbot doctor` 里 `extension` 项 |
| 磁盘上 `~/.tabbot/sites` 太大 | 按额度自动淘汰（`tabbot status` 看占用）；要手动清就删 `~/.tabbot/sites/<站点>/log`，别删 `tasks/` |

- 运行时日志：`~/.tabbot/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <holder pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。

## 11. 未做的事

- 并行调试时窗口被其它窗口完全遮住：Chrome 可能停掉 `requestAnimationFrame` 和 `IntersectionObserver`（和 X 时间线不加载同类）。请求版 task 不受影响，只有 DOM 兜底的受影响。需要在真实有头 Chrome 里实测，无头环境测不了；实测结果决定窗口怎么摆（露出一角、并排小窗）。
- 回执检查只有 Claude Code 的 Stop hook 一种实现，且要用户自己注册；别的 harness 靠 `SKILL.md` 约定。回执只能证明引用了某次 `run`，证明不了 task 写得对。
- 签名类请求头（如知乎 `x-zse-96`）的重放：现在是原样带旧签名，多数站点不拒绝；被拒时改用 DOM。
- 响应数据太大时怎么给 agent；重放响应“只取某个 JSON 字段”。
- adblock 规则缓存到磁盘（现在每次 daemon 启动都联网下载）。
- 站点兼容性：流式响应、`Request` 对象、页面检测 `fetch.toString()`、反调试。
- 产品化：域名、商标、版本号和发布。
