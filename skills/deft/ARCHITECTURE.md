# ARCHITECTURE

Deft 的目标、角色分工和运行时架构。agent 怎么用见 `SKILL.md`；仓库边界、开发验证、分发发布见 `AGENTS.md`；安装见 `install.md`。

## 1. 目标与原则

一句话：**超快的、用已登录 Chrome 的 skill；在一个持续的学习窗口里探索、学会 action，再在用完即关的 run 窗口里交付。**

- **用户只做两件事**：说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。其余全靠 agent 自己探索，没有用户示范。agent 干活在单独的 `deft agent` 窗口里，不打扰用户的窗口和标签页。
- **只录 agent 自己的窗口**（学习窗口和 run 窗口）。用户很久以前、或不是 agent 做的操作，agent 不知道请求的来源和意图；agent 自己做一次、学自己做出来的请求才准。要了解用户手上的页面，就在学习窗口里重新打开它的地址，从加载开始录。
- **录制的用途**：① 拿到接口信息，用接口大幅提速；② 接口无法重放时，给 DOM 操作提供依据（持久定位、该步之后出现了哪个请求）；③ 作为请求头的来源（`request` 继承 agent 窗口里同站点页面最近的请求头）；④ run 出问题时反查。

**action（业务动作）**是 Deft 的基本单位：学出来、起了名字、带参数、跑通过、能被复用。它不等于 **endpoint**（录到的原始请求接口）：一个 action 由一个或几个 endpoint 实现（文件头多行 `@endpoint`，按发送顺序），或由页面操作实现（DOM 兜底），或由别的 action 组合而成（文件头 `@compose`）。组合可以层层组合，用户的整件事跑通后本身就是一个 action。

原则（运行时做法见 `SKILL.md` 第 1 节）：
1. **唯一目标：更快完成眼前的任务。** 结果只来自 `deft run`（毫秒级），最终回复引用回执。沉淀（action、组合、业务知识）是顺带的，由 Deft 自动存，agent 不做单独的保存、维护。
2. **有 action 先用 action。**
3. **先拆分，通用操作只学一次。** agent 先把事情拆成 action；同一种操作作用在不同对象上，只在最容易的那个对象上学。
4. **探索即写 action。** 探索的唯一产物是 action，不是答案；只学 agent 自己做出来的请求。
5. **network 优先，DOM 兜底。**
6. **成本顺序：** 读文件 < `replay` < 一次页面操作（截图加坐标）< 继续探索。
7. **命令面最小，显式区分优于隐式区分。** 能读文件的不做命令；同一条命令不因为 agent 看不到的状态做不同的事。run 窗口每次从空白开始，就是为此。
8. **只录 agent 的窗口。** 用户的窗口和标签页不录、不碰，只读标签页列表（地址、标题）。

**整体结构**

| 窗口 | 用途 | 录不录 |
|---|---|---|
| 用户的窗口 | 用户自己浏览 | 不录；只读标签页列表 |
| 学习窗口（句柄 `<站点>-<时间>`） | agent 探索、观察请求、学 action；一直保留，agent 决定什么时候关 | 录，日志在 `learn-windows/<句柄>/`，进 `endpoints.json` |
| run 窗口（`<名字>-<时间>`） | 执行 action 和组合；每次 run 新开，跑完就关 | 录，日志在 `run-windows/<名字>/`，只给反查，不进 `endpoints.json` |

```
任务 → 找 action → deft run（结束，引用回执）
         │ 缺
         ▼
  拆：需要哪些 action、按数据依赖排序、哪些是通用操作
         ▼
deft learn --url <链接|tab 号> --description "要做的事"  → 句柄
  页面操作（截图加坐标）→ 自动附带观察：上次以来的页面状态、导航、请求（★ 写请求）、依赖
  observe：晚到的请求；replay：在当前页面重发、试参数
  写 action 文件（@status draft），一个窗口里学完所有要学的
  要登录：停下来请用户登录，再继续
         ▼
deft run --compose '代码' --name <名>：新开 run 窗口跑，跑完关；草稿真跑成功晋升 verified；引用回执
  有问题：回学习窗口排查，或对比两个窗口的 timeline.jsonl
         ▼
deft learn <句柄> close（agent 决定）
```

## 2. 角色：一个 agent，两种窗口

只有一个 agent，没有 subagent。「学习」「执行」是产品的两个词：**学习**是在学习窗口里摸清接口和定位，目的是写出 action；**执行**只有 `deft run`——用户拿到的结果必须来自 action 的返回值。

- **学习窗口**（`run/learn-windows.ts`）：`deft learn --url … --description …` 打开，返回**句柄**（`<站点目录名>-<年月日>-<时分秒>`，同一秒重名加 `-2`）。句柄持久：信息存在 `learn-windows/<句柄>/meta.json`（起点、描述、当前 URL、标题、观察游标、操作次数），holder 重启后从这里读回。窗口不绑定 action，一个窗口里可以学多个。所有页面操作、观察、重放都作用在它**当前的页面**上。agent 显式 `close` 才关 Chrome 窗口；另外空闲 30 分钟自动关；holder 重启时浏览器窗口全部关掉。关了之后再对这个句柄操作，就重开窗口、回到上次的 URL（页面状态丢失，输出写明），日志接着写进同一个目录。操作上限 200 次。
- **run 窗口**：每次 `deft run` 新开一个（`<action 或组合名>-<年月日>-<时分秒>`），整个 run（含组合里嵌套的 action）共用它，跑完立刻关；失败时先截图留现场（`screenshots/failure.*`）再关。不同的 run 各开各的窗口，可以同时跑，没有排队锁。

**为什么要这样分**：
1. 速度：学习慢，按 action 执行只要毫秒。学习的产出必须是 action，用户的结果必须来自 `deft run`；每次 `run` 发一个**回执**（`RC-xxxxxxxx`，写进 `sites/.receipts.jsonl`），最终回复必须引用它。
2. 状态：学习需要页面状态接得上（截图点到某个状态，接着重放请求）；执行需要每次一样（不因上次留下的页面而不同）。所以学习窗口一直保留，run 窗口用完即关。
3. 上下文：试错、响应原文、截图都在窗口目录里；读响应体用 `rg`、`node -e` 取字段，不整段读进来，截图只在需要时截。
4. 事后可查：两种窗口的每个操作和请求都在各自目录的时间线里，run 出问题时对照着看。

**强制机制（全在 Deft 内，不依赖 harness；回执检查例外）**
1. **打开学习窗口**：`deft learn --url <链接|tab 号> --description "要做的事"` 是唯一入口（链接原样用，tab 号只取那个用户标签页的地址）。输出句柄、窗口目录、自包含的学习指引（拆分和通用操作、粒度、观察、写请求的判断、文件在哪、做法、SDK、纪律）和起点的观察结果。旧写法（`learn <action 名> …`）被拒绝并说明新写法。
2. **观察按游标**（`journal/commands.ts` 的 `observe`，`journal/explore.ts`）：每个学习窗口记一个游标（日志编号）。观察返回游标之后这个窗口的全部变化，然后推进游标：页面状态（当前 URL、标题、窗口里的其他标签页）、导航（跳到别的站点时写明站点）、请求（非噪声、非静态资源、非周期性接口；含 GET；`describeRequest`：★ 写请求（`digest.ts` 的 `looksReadOnly` 判断）、`方法 接口名`、状态、内容类型、有没有响应体、请求文件名、接口以前的业务含义）、请求之间的依赖（`dependencies`：后一个请求的查询参数或请求体里长度 ≥ 6 的值等于前一个响应里的值）、编号范围；折叠掉的噪声、轮询、静态资源给个数。页面操作（`open` / `click` / `type` / `key` / `scroll` / `replay`）执行完等页面稳定，自动附带一次观察；单独的 `observe` 拿晚到的请求，`--since <编号>` 重看不推进。"这一步之后发生了什么"以两次观察之间为准，不靠 `cause` 猜。
3. **写请求由 agent 判断**：学习窗口里页面发什么就真的发什么，不拦。SKILL 和学习指引写明标准：轻量可撤销的直接做；删除、支付、下单、发布或发给别人、改设置、不可撤销的先问用户。`replay` 重发非 GET 要 `--yes`。
4. **组合只能调用 action**：`run --compose` 和 `@compose` 的 action 的会话被标为 compose-only，任何页面操作（包括 `import` SDK 后调用）都被 host 拒绝。组合可以调用草稿。
5. **草稿在 run 里晋升**（`journal/commands.ts` 的 `finishRun`）：`run` 能跑草稿；这次真跑（非 `--dry`）成功、执行过且成功的学出来的草稿晋升 verified，输出列出。多行 `@endpoint` 要按顺序出现在这次 run 窗口发出的请求里（`missingInSequence`），否则那个草稿不晋升并说明。`--dry` 只打印要发的写请求，不真发、不晋升；GET、HEAD 和 `request()` 标了 `readOnly` 的照常发（`run/host.ts`）。
6. action 头写 `@endpoint 方法 接口名`（可多行，和 `endpoints.json` 里的 `key` 一致）：聚合文件把 action 覆盖的接口标上 `action`，为 `null` 的就是还没学会的。`@status` 有 `draft`、`verified`、`blocked` 三种，`blocked` 是确认学不会的记录（原因在 `@note`），`run` 拒绝。agent 自己改文件头：学不会改成 blocked；verified 的坏了改回 draft，回学习窗口修。
7. **`--description`：意图沉淀成业务知识**（和 Claude Code 的 Bash 工具的 `description` 同名同用法）：打开学习窗口、页面操作、`replay`、`run` 必须带一句"用用户的话说这一步要做什么"，没带就拒绝（不占操作次数）。存在 agent 本来就读的地方：时间线 cmd 行的 `description`（它引发的请求经 `cause` 继承）；`endpoints.json` 每个接口的 `descriptions`（引发它的操作、重放它、跑覆盖它的 action 时带的，只收成功的，最近 5 句，`journal/endpoints.ts` 的 `observe` / `describe`）；组合文件的头。观察列请求时附上接口以前的 description。学出来的 action 文件不自动改。
8. **组合自动存留**（`run/actions.ts` 的 `composeTarget`、`saveComposed`）：`deft run --compose '代码' --description "…" [--name 名字] [--参数 值]`，代码里 `action("名字", 参数)` 调用 action，参数以 `deft.params.名字` 读到。成功的代码存成组合实现的 action：有 `--name` 时，用到的 action 都在同一个站点就放那个站点的 `actions/`，否则放 `~/.deft/compose/`（同名的学出来的 action 拒绝）；没名字按代码哈希前 12 位放 `~/.deft/compose/`（只留最近 200 个，起名后删掉哈希版本）。头由 Deft 填（`// 描述`、`@description` 最多 5 句、`@compose` 从 `action("名字")` 解析、`@params` 从 `deft.params.名字` 解析、`@ok` 次数和最近时间），代码原样；按名字 `run` 成功也累加 description 和次数；失败的不存（日志在 run 窗口目录里）。
9. **组合中途交回判断**（`deft.ask`，`run/runner.ts` 的 `work()`、`journal/commands.ts` 的 `handleAsk`）：要语义判断（挑出"硬核技术"的回答）时，组合代码写 `const picked = await deft.ask("问题", 裁剪后的数据)`。run 停在这里，输出 `{ status: "ask", resume: "AS-…", question, data }`，不发回执、不存留；agent 判断后 `deft run --resume <编号> --answer '<json>'`（`--description` 沿用第一次 run 的，存留也用它；`--answer` 可重复，按 ask 的顺序；解析不了 JSON 就当字符串）。机制是重跑并记住结果：最外层组合里每次 `action()` 按调用顺序记进 journal；恢复时新开 run 窗口、从头重跑代码，记下的 `action()` 直接返回结果、不再执行，第 i 次 ask 返回第 i 个回答，之后的照常执行。恢复时核对每次调用的名字和参数，和上次不同就失败（组合里不要用时间、随机数决定调什么）。只有最外层的组合能 ask，被调用的组合和学出来的 action 里调用会报错；`data` 超过 100KB 失败。恢复记录只在 holder 内存里，最多 20 条、30 分钟过期，用过就作废（恢复失败时保留）。恢复后接着跑的 action 不继承上次的页面状态：ask 之后第一个 DOM 实现的 action 要自己 `goto`。
10. **回执检查**（可选，Claude Code 的 Stop hook）：`src/hooks/stop-receipt.mjs` 看本轮（最后一条用户消息之后）工具输出里出现过的回执，最终回复没引用任何一个就拦一次，让 agent 补上；本轮用过 `deft learn` 却没有任何回执也拦一次（结果没有来自 run）；组合停在 `deft.ask` 却没有 `--resume` 也拦一次。注册方法：在 `~/.claude/settings.json` 里加 `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node ~/.deft/src/hooks/stop-receipt.mjs"}]}]}}`。别的 harness 靠 `SKILL.md` 的约定。

## 3. 进程与分层

**所有逻辑和数据在 holder，扩展、relay、CLI 只做 I/O。** 扩展的安装、重启、分发都不方便（首次只能手动加载，改了代码要用户去 `chrome://extensions` 刷新），而 holder、CLI 在 `~/.deft/src` 里，`setup.js` 镜像之后 `deft daemon restart` 就生效。

```
CLI（argv→RPC→打印） ──socket──▶ holder（唯一的大脑） ◀──ext.sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI） ──▶ 页面脚本：录制 + 执行（互相独立）
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的操作（见 §4），加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 `ext.sock` 之间原样转发字节；daemon 不在时拉起它 | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 holder，打印它返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留着（要诊断可能已死的 holder） | `src/cli/` |
| 页面脚本 | `recorder.js` 如实上报浏览器里发生的事；`executor.js` 执行 holder 下发的动作 | `src/chrome-extension/page/` |
| holder | agent 窗口与 action 运行时、观察、重放、脱敏、写日志与接口聚合、日志淘汰、原始请求的内存表、别名对照表、学习窗口登记 | `src/holder.ts`、`src/journal/`、`src/run/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（daemon） | relay 或 CLI（socket 连不上时 detached 拉起） | 扩展链路、agent 窗口、开着的学习窗口、原始请求、`deft.ask` 的恢复记录、日志写入 | 不随 relay 断开退出；没有扩展连接、也没有命令请求超过 10 分钟才退出 |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

- 命令入口：`src/cli/deft.ts` 没有命令逻辑，`deft <argv>` 原样发给 holder 的 `run` RPC，holder 调 `journal/commands.ts` 的 `runCommand`，返回 `{ stdout, code }`。holder 不在时 CLI 会拉起它，存活判据只有一条：socket 能不能回 `ping`。socket 权限 0600，连接按 UTF-8 解码。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展 ABI 不对 → 明确让用户刷新扩展。`status`、关着的窗口上的 `observe` 不需要扩展。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`，退出码非零；`run` 输出 `{ mode, receipt, status, result | error }` 的 JSON，后面几行写 run 窗口目录、晋升的草稿、开着的学习窗口。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，日志照写。
- holder 启动时：`upgradeLayout`（§8）、打开窗口日志、同步 action SDK、加载 adblock 规则；每 10 秒按额度淘汰日志；每分钟关掉空闲的学习窗口。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑。页面脚本是扩展包里的**静态内容脚本**（`page/`）：`common.js`、`recorder.js`、`executor.js` 在 MAIN world，`bridge.js` 在隔离世界；已打开的页面在握手后由 `injectExisting` 补注入。权限：`tabs`、`nativeMessaging`、`alarms`、`scripting`，`host_permissions: <all_urls>`，`minimum_chrome_version` 135。不依赖 `chrome.userScripts`。

- **ABI 9**（`browser/extension.ts`；4 起页面脚本只在 agent 窗口上报，`call` 只在 agent 窗口执行；5 起页面消息带 `win`（标签页所在的浏览器窗口），holder 据此把页面在 agent 窗口里自己开的标签页（target=_blank、`window.open`）也算进那个窗口；6 去掉了学习时拦截写请求的 `exec.hold`；7 起只认 agent **标签页**，8 起被打开时是 `chrome://` 地址的（Cmd+T 的新标签页）不算，见 §5；9 加了读页面存储的 `exec.authSnapshot`、`exec.authRead`，见 §7「重放」）：`call { tabId, fn, args }`（在页面 MAIN world 调 `window.__tcr.exec[fn](...args)` 并取回结果；函数集合固定，不执行任意字符串，严格 CSP 的页面也能用；任意函数 `exec.eval` 是兜底）；`tabs`（http/https 页面加 anchor 页）；`goto { tabId, url, wait }`；`openWindow { anchor }`（不抢焦点）、`openTab`、`activateTab`、`closeTab`、`closeWindow`。帧是 4 字节小端长度加 UTF-8 JSON；只支持一个扩展连接，新的合法 `hello` 替换旧连接。只有改 ABI 才加版本号，用户才需要刷新扩展，`doctor` 的 `extension-abi` 提示。
- 页面消息通道：页面脚本 `window.postMessage`，`bridge.js` 收到后 `chrome.runtime.sendMessage`，扩展补上 tab、frame 后转给 holder。页面自己的脚本也能发，所以日志只是观察记录，不能当权限依据。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒；点击工具栏图标立即重连。
- 图标源文件是 `scripts/dev/icons/icon.svg`（48、128px）和 `icon-small.svg`（16、32px，线条更粗），改动后运行 `node scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机 Chrome）。

## 5. 页面脚本

- `common.js`：命名空间 `window.__tcr`、限流的 `post`、前台判断、元素描述与页面快照（只给录制用）、DOM 变化计数、原始 `fetch`。
- `recorder.js`（录制）：**只在 agent 窗口里上报**（见下），只如实上报发生的事，不改变页面行为。只录三种请求——HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker）；用户输入（点击、输入长度、特殊键、滚动）；导航；页面快照；主文档渲染后的 DOM。响应体不设策略上限，不读事件流，读到 16MiB 就停并标 `truncated`。每个请求带 `ms`（耗时）和 `at`（请求开始时离文档开始的毫秒数，holder 据此判断请求是不是在页面刚加载的那几秒里发的）。
- `executor.js`（执行）：`window.__tcr.exec` 下的 `act`（按持久定位 click / fill / select / check / press / scroll，全是 DOM 事件，action 用）、`pointer`（按屏幕坐标 click / type / key / scroll，探索用，返回点中元素的持久定位）、`text`、`replay`、`waitFor`、`query`（声明式取数）、`eval`。`act` 的目标是持久定位 `loc`（CSS、`{role,name}`、`{text}`，可加 `nth`，元素没出现会等到超时），成功后返回元素的持久定位。点击先滚到视图中央并聚焦，再发 pointer / mouse 序列和 `click`；`fill` 用原生 `value` setter 加 `input`、`change` 事件；等页面稳定：没有在途请求且 DOM 静默 400ms，最多 4 秒。不支持：文件选择框、iframe 里的元素、`closed shadow root`。
- **只录 agent 的标签页（两层）**：① 扩展：agent 标签页是 Deft 开的（`openWindow`、`openTab`），以及被它们打开的（`chrome.tabs.onCreated` 的 `openerTabId` 是 agent 标签页：target=_blank、`window.open`；Chrome 给 Cmd+T 的新标签页也设 `openerTabId`，所以创建时是 `chrome://` 地址的不算）；集合存在 `chrome.storage.session`，service worker 重启后读回。用户在 agent 窗口里自己开的标签页（Cmd+T、别的扩展开的）不算。页面脚本在 `document_start` 照常装钩子（否则漏加载期请求），`common.js` 的 `post` 先把消息缓存（最多 500 条）；`bridge.js` 加载时问 background 这个标签页是不是 agent 标签页，答"是"才发出缓存并放行，答"不是"就清空缓存、之后一条都不发。background 也只转 agent 标签页的页面消息和地址变化，`call` 只在 agent 标签页执行，`injectExisting` 只补注入 agent 标签页。② holder：扩展的 ABI 不对时一条页面消息都不收；`Ingestor.handle` 按 `AgentWindows.winOf` 丢弃不是 agent 窗口的一切（Deft 开的标签页按池里的记录；页面在 agent 窗口里自己开的标签页按消息里的 `win` 由 `adopt` 认领），窗口没在 `WindowLog` 里登记的也丢（不写日志、不进原始请求内存表、不进接口聚合），扩展是旧版本时也成立。
- **录制与执行解耦**，没有共享状态。agent 窗口里页面脚本触发的一切记为 `agent`，写进该窗口自己的时间线；有人在 agent 窗口里真的动了一下（`isTrusted`）记为 `user`。

## 6. 日志（journal）

格式给 agent 看的版本在 `SKILL.md` 第 3 节（唯一描述数据格式的地方）；这里讲怎么存、怎么淘汰、怎么保证准确。

- **目录**（`journal/windowlog.ts`）：一个窗口一个目录，学习窗口 `~/.deft/learn-windows/<句柄>/`，run 窗口 `~/.deft/run-windows/<名字>/`。里面是 `meta.json`、`timeline.jsonl`（这个窗口发生的一切，跨站点，每行带 `site`，追加写，不改已写的行）、`requests/`（请求文件 `<6 位编号>-<方法>-<接口名>.json`，沿用 yodo 的请求文件格式，响应体同名加 `.response.*`）、`pages/`（`<编号>-doc-<路径>.html`、`<编号>-snap-<路径>.json`）、`screenshots/`。文件名语义化，又能从编号找到（`requests/<编号>-*`）。**站点是页面的 host（去 `www.`）**，请求属于发出请求的页面；判断不出站点的行 `site` 是 `_other`。时间线和请求文件里的文件引用相对窗口目录；`endpoints.json` 的样本相对 `~/.deft`（脱离窗口也能找到）。响应体按内容哈希在同一个窗口内去重。
- **知识按站点**：`~/.deft/sites/<站点>/` 只有 `endpoints.json` 和 `actions/`，只在学习窗口里出现了非噪声请求、或有 action 时才建，广告和嵌入页面不再各占一个目录。
- **编号**：`seq` 全局递增，上界按 1000 一块落盘到 `~/.deft/sites/.seq`，崩溃重启只会留下编号空洞，不会重复。`cmd` 在开始时预留编号（它引发的请求会指向它），行在做完时才写；读者按 `seq` 排序。
- **每次请求都写一行**，不去重（轮询间隔也是信息）。
- **因果与阶段**（`journal/ingest.ts`）：`cause` 是同一标签页里请求**开始时**之前 2 秒内最近一次 agent 命令（或 agent 窗口里的真人输入），`causeDt` 是相隔毫秒；`phase` 是 `load`（文档或单页路由开始后 4 秒内、期间没有新命令）、`cmd`（命令或真人输入引发）、`idle`。这些是启发式，离线读日志用；学习时以观察（§2 第 2 条）为准。
- **保留**（`journal/retention.ts`，额度见 `utils/constants.ts`）：run 窗口目录只留最近 100 个。学习窗口：轻量层（meta、时间线、请求文件）总计 500MB，重量层（响应体、页面、截图）总计 1.5GB。重量层超了，从最旧的关着的学习窗口开始只删没受保护的重量层文件；轻量层超了才删整个最旧的关着的学习窗口。开着的学习窗口永远不动。每个接口最近 5 次成功请求是**样本**，它们的请求文件和响应体受保护（每站点样本合计 100MB），文件不在了 `endpoints.json` 里对应样本标 `available: false`。
- **接口聚合**（`journal/endpoints.ts`）：学习窗口里写入一个请求就增量更新这个站点的 `endpoints.json`（节流 2 秒原子写，重启时读回）；run 窗口的请求不进。内容：次数、`cmdTriggered` / `onLoad` / `idle`、`lastCause`、变量、响应结构、`replayable`（原始请求还在不在内存里）、样本、`action`（读该站点 `actions/` 的 `@endpoint`，多行每行都算）、`descriptions`。不排序、不下结论，只给信号。接口名由 `digest.ts` 的 `endpointOf` 算：GraphQL 取操作名，其它路径把长数字、哈希、uuid 换成 `:id`，同一路径上请求体里的 `operationName` / `action` / `method` 之类的字符串字段拼在后面（`/graphql#FavoriteTweet`），否则 POST `/graphql`、POST `/rpc` 会把所有操作并成一个接口。
- **过滤**（`filter.ts`）：`@ghostery/adblocker` 规则加第一方埋点启发式（只对非 GET）标 `noise`，默认不看；失败的请求只留小于 4KB 的响应体；只存同站的响应体。
- **脱敏**（`sanitize.ts`）：带单词边界的正则（`token`、`secret`、`password`、`csrf`、`jwt`、`auth` 等，连写的 `x-xsrftoken`、`csrftoken`、`accesstoken` 也算）加严格的 JWT 判断，只作用于请求头名、URL 查询参数名、JSON 的 key；响应体正文原样写盘。秘密换成别名 `⟨secret_<12 位十六进制>:<形状>⟩`：盐 + 真值的 HMAC（盐在 `~/.deft/alias-salt`，0600），同一个秘密永远是同一个别名。**别名 → 真值的对照表只在 holder 内存里**。
- **录制的缺口**：用户的窗口不录；WebSocket、`sendBeacon`、Worker、事件流不记录；响应超过 16MiB 被截断；请求体超过 64KB 不存内容。
- agent 窗口里的 http/https 站点都录，没有排除列表；HTML 文档原样存，不为敏感内容做额外保护（产品还在做，先把产品做好）。
- 读日志不是命令：agent 直接读文件（`rg`、`node -e`、Python）。隔离不是安全边界——agent 能读所有窗口目录。

## 7. agent 窗口与 action

- **agent 窗口**（`run/window.ts`）：key 就是窗口名（学习窗口的句柄、run 窗口的名字），一个 key 一个浏览器窗口，各自的页面在自己窗口的前台（浏览器不渲染后台标签页）。窗口的第一个标签页是扩展的 anchor 页（标题 `deft agent`）。其余标签页按 origin（协议加主机加端口，只在执行层用：保证请求和页面同源）在**单个窗口内**池化：`acquire(origin, key)` 复用这个窗口里同站点空闲的标签页，没有就开 `origin/robots.txt`（很轻，页面脚本就位）；空闲 30 分钟关闭。`dispose(key)` 关掉整个窗口（run 跑完、学习窗口 close 或空闲）。key 到窗口的映射只在内存里：holder 重启（或扩展链路重连）一切归零，留下的窗口都是孤儿，第一次用窗口时全部关掉；学习窗口之后按需从 `meta.json` 里的 URL 重开。
- **学习窗口的页面**：`ctx.sessions` 按句柄存当前的 `Session`（绑定的标签页），页面操作、`screenshot`、`replay` 都用它；`ensureOpen` 发现 Chrome 窗口没开就新建 `Session` 并 `goto` 上次的 URL。
- **RunHost**（`run/host.ts`）：goto、request、act、pointer、screenshot、waitFor、text、query、eval，每个都写一行 `cmd` 记录（`request` 的 `detail.endpoint` 是它发的接口，晋升时据此检查多行 `@endpoint`）。`request` 默认继承 holder 内存里同站点最近一个带身份头（authorization、csrf、x-*）的原始请求的请求头；内存里没有（holder 重启过、页面还没发过请求）时，自动打开该站点首页让页面自己发请求，每个站点只试一次，仍没有再按需报错。`inheritFrom: "/接口路径"`（`:id` 匹配一段）只从这个接口最近一次的原始请求继承：签名和接口绑定的站点（知乎 `x-zse-96`）继承别的接口的签名会被拒；没有就报错，让 action 先 `goto` 会发它的页面。
- **ActionRunner**（`run/runner.ts`）：学出来的 action 脚本在 worker 线程里运行（`action-lib/index.js` 同步到 `~/.deft/lib`），SDK 的每个函数是向 holder 发一个操作；组合实现（`run --compose` 的代码和 `@compose` 的文件）包成一个注入了 `action()` 的模块再跑（临时文件在 `~/.deft/session/`），会话标为 compose-only。最外层的 `runAction` / `runCompose` 经 `RunWindows`（holder 里接到 `AgentWindows` 和 `WindowLog`）开一个 run 窗口，结束时关掉；嵌套调用共用这次的窗口和页面状态。整体超时 115 秒（`@timeout` 可改）。真跑成功的草稿收集在 `Session.draftsOk`，交给命令层晋升。`run` 失败（非嵌套、非组合）时，如果 run 窗口里有页面，输出带 `page`（URL、标题、截图 `run-windows/<名字>/screenshots/failure.*`）；页面像登录页或错误是 401/403 时带 `hint`（请用户登录后重跑，不要重新学习）。截图失败不影响原来的错误。
- 学出来的 action 是 `~/.deft/sites/<站点>/actions/<名字>.js`，从 `../../../lib/index.js` 引用 SDK；组合实现在站点的 `actions/` 或 `~/.deft/compose/`（`run/actions.ts`）。名字全局唯一，`deft run <名字>` 先找各站点的 `actions/`，再找 `~/.deft/compose/`。学出来的文件头 `@summary`、`@status draft|verified|blocked`、`@endpoint 方法 接口名`（可多行）、`@param 名字? 说明`、`@timeout`、`@note`（经验：签名、风控、踩过的坑，一行一条）。参数一律具名 `--名字 值`，学出来的 action 缺必填或传了没声明的参数直接报错，`answer`、`resume` 不能当参数名；组合实现不检查。

### 重放（learn <句柄> replay）

- **原始请求只在 holder 内存里**（`journal/raw.ts`）：页面里发的每个同站请求的方法、地址、请求头、请求体，上限 50MB、单条 64KB，先丢最旧的；**绝不落盘**。
- `deft learn <句柄> replay <编号> [--set ...] [--inherit-from <接口路径>] [--yes] [--raw]`：**和 action 走同一条路径**——按编号找请求文件（先这个窗口，再全部窗口）→ 方法、地址、请求体取自内存里的原始内容（没有就用请求文件，别名换回真值）→ `applySets`（`journal/replay-core.ts`）→ 调用和 action 一样的 `host.request`（同一套请求头继承；`--inherit-from` 对应 `inheritFrom`；`header.名字=` 对应显式 `headers`），在学习窗口**当前的标签页**里发出（当前页面和原请求不同源时，在同一个窗口里另开一个同源标签页）→ 响应脱敏后写成新的请求文件（`requestType: replay`，带 `replayOf`、`inheritedFrom`）和一行时间线。输出写明请求头继承自哪里、身份头来源（`journal/auth.ts`）、签名不匹配（`RunHost.sourceOf`：继承来的签名类头配上了和它原来不一样的路径、查询参数或请求体）、可贴进 action 的一行 `request(...)`（带 `auth`）。所以 replay 成功等于这行代码在当前页面状态下能成功；页面状态的差异由 run 草稿收口。`--raw`：原样用那一次请求的请求头，只用来排查。
- **身份头来源**（`journal/auth.ts`，观察里的 ★ 写请求和 replay 时判断）：holder 用原始请求头的真值和页面此刻的 cookie、localStorage、sessionStorage、meta（页面脚本 `authSnapshot`，只回给 holder）比对，再看同一接口各次请求里这个头变不变，分成 cookie / local / session / meta / 签名 / 不变 / 不明；前序响应这一类由 `dependencies` 判断（身份头也纳入比对）。结果只写来源，记进 `endpoints.json` 的 `auth`、`signed`。action 里 `request` 的 `auth` 声明在发送时由页面脚本 `authRead` 现读，`from:` 从原始请求内存按接口取，取不到就报错。
- **`--set`**：`名字=值` 改查询参数；`名字.路径=值` 改查询参数里 JSON 的字段（GraphQL 的 GET 请求 `variables.cursor=xxx`，翻页用）；`header.名字=值` 改请求头；`body.路径=值` 改 JSON 或表单请求体；`body=内容` 整个换掉。非 GET 要 `--yes`；浏览器自己管的请求头去掉。
- 在响应体里找页面上看到的值是 `rg`，还原请求就是读请求文件；`journal/replay.ts` 的 `templateFromRequestFile` 给出风险提示（签名类参数、非 GET）。

## 8. 存储与安装

- 用户数据：`~/.deft/learn-windows`、`~/.deft/run-windows`（日志）、`~/.deft/sites`（每个站点：`endpoints.json`、`actions/`；还有 `.seq`、`.receipts.jsonl`、`.layout`）、`~/.deft/compose`（跨站点和没起名字的组合）、`~/.deft/lib`（action SDK）、`~/.deft/alias-salt`；运行时状态 `~/.deft/session`；运行时代码 `~/.deft/src`。
- `setup.js` 把 skill 目录镜像到 `~/.deft`、安装依赖、写版本文件、注册 native host、生成 shim、让过期的 daemon 换成新代码、运行 `doctor`。分发是源码镜像：`~/.deft` 是 `skills/deft/` 的逐字节拷贝，只排除 `node_modules` 和 `.DS_Store`（`store/deploy.ts`）；顶层的 `src`、`scripts` 先清空再拷，本机数据目录镜像不碰。
- **布局升级**（`run/actions.ts` 的 `upgradeLayout`，holder 启动时执行，看 `sites/.layout` 只做一次）：旧日志不兼容，直接删掉——`sites/<站点>/log/`、`sites/<站点>/debug/`、`~/.deft/run/`、更早版本的 `journal`、`task`（和改名后的 `.old`）；`endpoints.json` 保留接口统计和 `descriptions`，清空指向旧日志的 `samples`；删完后既没有接口、也没有 action 的站点目录整个删掉；`~/.deft/actions/*.js` 挪进 `~/.deft/compose/`。
- 版本：`~/.deft/src/.version` 写 `{ build }`（只算运行时文件，排除自检）；daemon 启动时记下 `build`，`ping` 返回它。换代码只在 `setup.js` 发现 `build` 不同和用户显式 `deft daemon restart` 时发生，没有命令会自动重启 daemon。
- `deft doctor` 只读。

## 9. 测试

`npm test`（几秒，纯逻辑，不依赖 Chrome）：脱敏与别名、`--set`、日志摄入（只录 agent 窗口、一个窗口一个目录、语义化文件名、站点按页面 host、因果与阶段、run 窗口的请求不进接口聚合）、按窗口淘汰（开着的和样本不动、run 窗口只留最近的）、接口聚合与接口名、观察里列什么（折叠噪声轮询静态资源、★ 写请求、依赖）、布局升级（旧日志删掉、业务知识和 action 不丢、只做一次）、扩展链路分帧与握手、命令层（观察按游标不漏不重、句柄持久、旧写法被拒、草稿晋升与多行 `@endpoint` 顺序）、action 运行（每次 run 新开窗口、跑完关、不排队、组合只能调用 action、组合按名字再跑、停在 `deft.ask` 后恢复不重跑之前的 action）。**不模拟扩展**：扩展、页面脚本、agent 窗口、action 运行时的行为用真实 Chrome 加 Claude in Chrome 验证（见 `AGENTS.md` 2.3）。`npm run verify:pack` 只在发布前跑。

## 10. 排障

先运行 `~/.deft/bin/deft doctor`（`--json` 得到机器可读结果），失败项带修复命令。下面的问题都可以读源码定位并直接修复；直接改 `~/.deft/src` 是临时修复，下次升级会覆盖。

| 现象 | 处理 |
|---|---|
| Node 低于 24；`npm install` 失败；`doctor` 的 `home`、`src`、`deps`、`session`、`native-host`、`launcher` 失败 | 升级 Node / 解决 npm 的报错后重跑 `node <skill 安装目录>/setup.js`（可重复执行，`npx skills ls -g` 找安装目录） |
| 找不到 `deft` 命令 | 用绝对路径 `~/.deft/bin/deft`，或把 `~/.deft/bin` 加入 PATH |
| `need-extension`，从没加载过扩展 | `chrome://extensions` 开「开发者模式」，「加载已解压的扩展程序」，选 `~/.deft/src/chrome-extension` |
| `need-extension`，扩展已加载 | 确认 Deft 开着，点一下工具栏图标 |
| `extension-abi` 不对，或"扩展是旧版本" | 在 `chrome://extensions` 里刷新 Deft；从旧版本（ABI 1）升级的要先移除旧扩展再重新加载，否则旧的动态内容脚本会残留、重复录制 |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，Chrome 会重新拉起；等几秒，仍不行就重启 Chrome |
| 升级后旧 daemon 还在跑 | `deft daemon restart` |
| `run` 报"没有可继承的请求头" | 已经自动打开过该站点首页仍没有带身份头的请求：这个站点的接口可能不需要（去掉 `inherit`），或 action 要先 `goto` 到会发这个请求的页面 |
| `learn <名字> …` 报"不是学习窗口的句柄" | 学习窗口不再按 action 名开：`deft learn --url … --description …` 拿句柄；`deft learn` 列出已有的句柄 |
| 学习窗口的操作说"重新打开" | Chrome 窗口之前关了（close、空闲 30 分钟、holder 重启），页面状态没了；回到了上次的 URL，需要的话重新点到那个状态 |
| `learn <句柄> click`、`type`、`key`、`scroll` 报"页面里没有 Deft 的脚本" | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| `replay` 报"原始内容已经不在 holder 的内存里"或"别名已失效" | holder 重启过或太旧被清掉；在学习窗口里重新操作触发一次，用新的编号重试 |
| run 成功了草稿却没晋升 | 输出写了原因：多行 `@endpoint` 没按顺序发出（前置请求漏了，或顺序写错）；或者用了 `--dry` |
| 日志里没有某个站点的事件 | 只录 agent 窗口：用户自己窗口里的浏览不会有记录，要用 `learn --url` 在学习窗口里重新打开；扩展要是 ABI 9（`deft doctor` 的 `extension-abi`）；用户在 agent 窗口里自己开的标签页（Cmd+T）也不录；看对应窗口目录里的 `timeline.jsonl`，按 `site` 字段筛 |
| 磁盘上 `~/.deft/learn-windows` 太大 | 按额度自动淘汰（`deft status` 看占用）；要手动清就删关掉的旧窗口目录，别删 `sites/*/actions/` |

- 运行时日志：`~/.deft/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <holder pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。

## 11. 未做的事

- 并行跑时窗口被其它窗口完全遮住：Chrome 可能停掉 `requestAnimationFrame` 和 `IntersectionObserver`（和 X 时间线不加载同类）。请求实现的 action 不受影响，只有 DOM 兜底的受影响。需要在真实有头 Chrome 里实测；实测结果决定窗口怎么摆（露出一角、并排小窗）。
- 回执检查只有 Claude Code 的 Stop hook 一种实现，且要用户自己注册；别的 harness 靠 `SKILL.md` 约定。回执只能证明引用了某次 `run`，证明不了 action 写得对。
- 签名类请求头（如知乎 `x-zse-96`）的重放：现在是原样带旧签名，多数站点不拒绝；被拒时改用 DOM。
- 学习窗口重新打开时恢复页面状态（现在只回到上次的 URL）；原始请求持久化（现在重启就没了）。
- 只做过 `--dry` 的写操作 action 没有单独的状态。
- 响应数据太大时怎么给 agent；重放响应"只取某个 JSON 字段"。
- adblock 规则缓存到磁盘（现在每次 daemon 启动都联网下载）。
- 站点兼容性：流式响应、`Request` 对象、页面检测 `fetch.toString()`、反调试。
- 产品化：域名、商标、版本号和发布。
