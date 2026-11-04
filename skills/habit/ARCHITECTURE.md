# ARCHITECTURE

habit 的目标、设计原则和运行时实现：每一部分是谁实现的、在哪个文件、保证什么。agent 怎么用见 `SKILL.md`；安装见 `install.md`；开发、验证、发布见 `AGENTS.md`。

## 1. 目标与原则

一句话：**超快的、用已登录 Chrome 的 skill；在一个持续的 learn 窗口里学会 action，再在用完即关的 run 窗口里交付。**

- **用户只做两件事**：说要做什么，以及要输入账号密码、扫码的登录。其余全靠 agent 自己 learn，没有用户示范。
- **录制的用途**：① 拿到 endpoint，用请求代替页面操作大幅提速；② endpoint 没法直接发时，给 DOM 操作提供依据（持久定位、该步之后出现了哪个请求）；③ 作为请求头的来源（`request` 继承 agent 窗口里同站点页面最近的请求头）；④ run 出问题时反查。

**action** 是 habit 的基本单位：学出来、带参数、能复用的业务动作，由一个或几个 endpoint（录到的一个请求，写成 `方法 路径`）实现，或用 DOM 实现。**compose** 是用 action 串成的流程，只能调用 action 和别的 compose，不能碰页面；它是 action 的使用者，不是 action 的一种。

设计原则（agent 的使用原则在 `SKILL.md` 第 2 节）：
1. **唯一目标：更快完成眼前的任务。** 结果只来自 `habit run`：用请求代替页面操作，比点页面快一个量级。存下来的东西是顺带的：action 和 compose 是 agent 写的文件，一直留着复用；description 由 habit 自动存。这是 SKILL 里的约定，没有强制检查。
2. **只录 agent 的窗口。** 归属按标签组认：habit 组里的标签页是 agent 的（用户自己拖进 habit 组的也算，拖出去就收回），其余用户的窗口和标签页不录、不碰，只读标签页列表（地址、标题）；要看用户手上的页面，就在 learn 窗口里重新打开它，从加载开始录。用户很久以前做的操作，agent 不知道请求的来源和意图；只学 agent 自己做出来的请求才准。
3. **秘密不落盘、不进上下文。** 原始请求（含 token 真值）只在 daemon 内存里；日志、请求文件、观察输出里是别名。这不是对 agent 的隔离：action 和页面脚本与用户同权限（`evaluate` 能读页面的 cookie、localStorage，action 的 worker 有完整的 Node 权限），保证的只是真值不写盘、不出现在 agent 读到的文字里。原始请求按窗口存，窗口关掉（learn `close`、run 结束）就清掉。
4. **日志和 action 都是文件。** 能读文件的不做命令，agent 用 `rg`、`node`、Python 直接读；habit 的命令只做必须由它做的事（控制浏览器、持有不能落盘的原始请求）。
5. **命令面最小，显式区分优于隐式区分。** 同一条命令不因为 agent 看不到的状态做不同的事。run 窗口每次从空白开始、`habit run <名>` 只按名字找文件，都是为此。run 的行为只取决于 action 文件和这次窗口里发生的事：不读 `endpoints.json`，不用以前或别的窗口的原始请求。
6. **habit 给信号，run 的结果和 agent 来定。** habit 只做必须由它做、而且做得准的事：用内存里的真值统计、按固定规则继承复用、把失败说清楚；不提前替 agent 下「这个请求该怎么发」的结论。用哪个请求、用 `request`、`waitRequest` 还是 DOM，由 agent 看信号决定，以 run 的真实结果为准。

## 2. 两种窗口，以及 action 和 compose 的运行

### 2.1 两种窗口

| 窗口 | 用途 | 录不录 |
|---|---|---|
| 用户的窗口 | 用户自己浏览 | 不录；只读标签页列表 |
| learn 窗口（句柄 `<站点>-<时间>`） | agent 观察请求、学 action；一直保留，agent 决定什么时候关 | 录，日志在 `learn-windows/<句柄>/`，进 `endpoints.json` |
| run 窗口（`<名字>-<时间>`） | 执行 action 和 compose；每次 run 新开，跑完就关 | 录，日志在 `run-windows/<名字>/`，只给反查，不进 `endpoints.json` |

为什么这样分：learn 需要页面状态接得上（点到某个状态，接着在这个状态上跑 action），run 需要每次一样（不因上次留下的页面而不同）；试错、响应原文、截图都留在窗口目录里，不占 agent 的上下文；两种窗口的每个操作和请求都在各自的时间线里，run 出问题时对照着看。

- **learn 窗口**（`learn/windows.ts`）：`habit learn new --url … --description …` 是唯一入口，返回句柄（同一秒重名加 `-2`）和 learn 指引（`learn/guide.ts`，存在 `~/.habit/learn-guide.md`，内容变了才在输出里给全文）。句柄只在窗口开着时能用：`learn-windows/<句柄>/meta.json` 存起点、描述、当前 URL、标题、观察游标、操作次数，只给看日志用。所有工具、观察、`try_action` 都作用在它当前的页面上。窗口关掉的情况：`habit learn close <句柄>`、空闲 30 分钟、daemon 重启、扩展重连（daemon 忘掉所有组）、用户关了组；关掉后句柄只能看日志，再操作是用法错误（退出码 3），提示用 `learn new` 开新窗口、在新窗口里复现，不会悄悄回到上次的 URL 接着用。操作上限 200 次（只有成功的页面操作计数，不清零）：到了多半是在原地打转，报错让 agent 先停下看卡在哪，确实还要学就开新窗口。同一个句柄一次只跑一条命令（`LearnWindows.claim`），后到的直接 `fail`。
- **run 窗口**：每次 `habit run` 新开一个，整个 run（含 compose 调用的 action）共用，跑完立刻关；失败时先截图（`screenshots/failure.*`）再关。不同的 run 可以同时跑，没有排队锁。
- **观察按游标**（`learn/observe.ts`，`learn/explore.ts`）：返回游标之后这个窗口的变化并推进游标（请求只列这个窗口里第一次出现的 endpoint，全部都在 `timeline.jsonl` 里）：页面状态、导航（跳到别的站点时写明站点）、请求（去掉噪声、静态资源、轮询；`describeRequest` 一行：编号、`方法 路径`、状态、内容类型、有没有响应体、请求文件名、以前的 description）、请求之间的依赖（`dependencies`：后一个请求里长度 ≥ 6 的值等于前一个响应里的值）。改变页面的操作执行完等页面安静、记录送达（`RunHost.quiet`，见 §7），自动附带一次观察；`computer wait` 等完也附带一次（晚到的请求用它看）。"这一步之后发生了什么"以两次观察之间为准，不靠 `cause` 猜。这一段里有同站请求被 401/403 拒，或者页面在登录页（`utils/url.ts` 的 `isLoginUrl`），观察里先给一条「像是登录失效」的下一步：先看页面，点一下能登录的自己点，要账号密码、扫码的请用户登录；run 失败时同样判断（`looksLoggedOut`）。
- **写请求不拦，也不判断**：learn 窗口里页面发什么就真的发什么，`try_action` 和 `run` 带 `@write` 的 action 也直接发。一个请求有没有副作用、多严重，由 agent 按 SKILL 的标准判断（原则 6）；`@write` 是 agent 写的提示。每次 `run`（run 窗口，或 learn 窗口里的 `try_action`）统计这次实际发出的非 GET 请求（`request()` 发的和页面自己发的，只看方法、不是 GET / HEAD / OPTIONS 就算，`browser/host.ts` 的 `watchSent` / `takeSent`），输出里列成「已发出的非 GET 请求」，也写进 run 窗口 `meta.json` 的 `sent`；agent 拿它核对有没有意料之外的、告诉用户真发了什么。

### 2.2 action 和 compose 的运行

- **compose 只能调用 action**：`~/.habit/compose/` 下的文件跑起来时会话标为 compose-only，任何页面操作都被 `RunHost` 拒绝；反过来，学出来的 action 里调用别的 action（`action()`）被 `ActionRunner` 拒绝。compose 可以调用 draft。
- **draft 变成 verified**（`commands/run.ts` 的 `finishRun`）：run 成功、执行过的 draft 都变成 verified（跑成功就是事实，action 自己检查状态码和返回值）。`blocked` 的 action `run` 拒绝。
- **参数**（`run/actions.ts` 的 `checkParams`、`coerceParams`）：对照文件头 `@param 名字[?][:类型]` 检查缺的、多的，再按类型（`number`、`boolean`、`json`，默认字符串）转换后交给 action；compose 里 `action()` 传的参数也一样。
- **`--description`**：打开 learn 窗口、页面操作、`run` 必须带，没带就拒绝（不占操作次数）。存进时间线 cmd 行（它引发的请求经 `cause` 指向它）、`endpoints.json` 每个 endpoint 的 `descriptions`（只收成功的，最近 5 句，`record/endpoints.ts`）、run 窗口的 meta。`resume` 的 `--description` 说明为什么这样回答，记进 run 窗口的 meta（`answerWhy`）。action 和 compose 文件除了 `@status` 都不自动改。
- **compose 是 agent 写的文件**（`~/.habit/compose/<名>.js`）：和 action 一样的文件头（`@description` `@status` `@param` `@timeout` `@write`）和 `export default async () => 结果`，从 `../lib/index.js` 引 `habit`、`action`。放在这个目录里的就是 compose，不看文件头。一直保留、不淘汰；跑成功后 habit 只把 `@status draft` 改成 `verified`。`ActionRunner` 跑 compose 时把这一刻读到的代码写成它旁边的临时文件 `.run-*.mjs` 再跑（相对 import 照样能用），跑完删掉。
- **`habit.ask`**（`run/runner.ts` 的 `work()`、`commands/run.ts` 的 `handleAsk`）：run 停下输出 `ask <问题>`、`数据`、`恢复`（`habit resume <编号> --answer …`）。恢复记录存下停下那一刻的 compose 代码；`habit resume` 新开 run 窗口、用这份代码从头重跑（agent 中途改了文件也不影响），最外层 compose 里记下的 `action()` 直接返回上次的结果，第 i 次 ask 返回第 i 个回答。恢复时核对每次调用的名字和参数，不同就失败。只有 `habit run` 直接跑的那个 compose 能 ask；`data` 超过 100KB 失败。恢复记录只在 daemon 内存里（`run/asks.ts`，归 `ActionRunner`），最多 20 条、30 分钟过期，用过就作废（恢复失败时保留）。

## 3. 进程与分层

**所有逻辑和数据在 daemon，扩展、relay、CLI 只做 I/O。** 扩展的安装、分发不方便（首次只能手动加载；之后 `setup.js` 更新了扩展，daemon 发现它跑的不是磁盘上这一版就让它自己重新加载，见 §4），而 daemon、CLI 在 `~/.habit/src` 里，`setup.js` 镜像之后让旧 daemon 退出，下一个连接的 relay 或 CLI 就拉起新代码。

```
CLI（argv→RPC→打印） ──sock──▶ daemon（唯一的大脑） ◀──sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI，CDP 输入） ──▶ 页面脚本：元素模型 + 录制 + 执行
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的操作（见 §4）：唯一的输入路径（CDP），截图、执行 JS，加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 daemon 的 socket 之间原样转发字节；daemon 不在时拉起它（和 CLI 共用 `session/client.ts`） | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 daemon，打印它返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留着（要诊断或停掉一个可能已经不在的 daemon） | `src/cli/` |
| 页面脚本 | `a11y.js` 找元素、算坐标（a11y 树、find、持久定位）；`recorder.js` 如实上报浏览器里发生的事；`executor.js` 等页面安静、取数、发请求 | `src/chrome-extension/page/` |
| daemon | agent 窗口与 action 运行时、观察、脱敏、写日志与 endpoints.json、日志淘汰、原始请求的内存表、别名对照表、learn 窗口登记 | `src/daemon.ts`、`src/commands/`、`src/learn/`、`src/run/`、`src/browser/`、`src/record/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| daemon | relay 或 CLI（socket connect 不上时 detached 拉起） | 扩展链路、agent 窗口、开着的 learn 窗口、原始请求、`habit.ask` 的恢复记录、日志写入 | 不随 relay 断开、Chrome 退出而退出；只在三种情况下退出：扩展没连着并且 10 分钟没有命令、收到 SIGTERM、socket 文件不是自己的了（见下面的 8 条） |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

daemon 内部分四层，上层只依赖下层：

| 层 | 目录 | 只做 |
|---|---|---|
| 命令 | `commands/` | argv 解析（`args.ts`）、调用下层、按输出约定拼文本；不持有状态 |
| learn 与 run | `learn/`、`run/` | learn 窗口的登记和页面（`LearnWindows` 持有每个窗口当前的 `Session`）、观察和请求头的信号；action 运行时（`ActionRunner` 持有 `habit.ask` 的恢复记录）、action 和 compose 文件 |
| 控制浏览器 | `browser/` | 扩展链路、agent 窗口池（`AgentWindows`）、页面操作（`RunHost`），learn 和 run 共用 |
| 录制与存储 | `record/` | 收页面消息、脱敏、写日志、`endpoints.json`、淘汰、原始请求的内存表（按窗口）、请求头的统计和来源比对 |

`daemon.ts` 只做组装（`build` 按依赖顺序一次建好）、socket 和定时任务。定时写盘出错（磁盘满、没权限）只记进运行时日志，不让 daemon 退出：退出会丢掉内存里的原始请求、ask 恢复记录和 learn 窗口的页面。

- 命令入口：`src/cli/habit.ts` 没有命令逻辑，`habit <argv>` 原样发给 daemon 的 `run` RPC，daemon 调 `commands/index.ts` 的 `runCommand`，返回 `{ stdout, code }`。
- **daemon 的启动和退出**（`src/session/server.ts`、`src/session/client.ts`），8 条规则：
  1. 只有一个 socket `~/.habit/session/sock`（权限 0600）。relay 和 CLI 都是客户端，连上后第一行说明角色：`{"role":"relay"}` / `{"role":"cli"}`；daemon 按 Buffer 收第一行再分流（relay 后面紧跟二进制帧），2 秒内没有合法的角色说明就断开。CLI 的 JSON-RPC 按 UTF-8 解码。
  2. 只有一个函数拉起 daemon：`connectDaemon`（CLI 和 relay 共用）先 connect，连不上就 spawn 一个 detached 的 daemon，再每 100ms 重试，最多 10 秒。
  3. listen 成功的就是唯一的 daemon；EADDRINUSE 时 connect 一下：连得上说明对方活着，自己退出；被拒绝说明是残留文件，删掉再 listen 一次。
  4. 只有 daemon 自己删 socket 文件，并且只在 connect 被拒绝时删。CLI、relay、`setup.js` 都不删：超时只说明 daemon 忙，不说明它死了。
  5. daemon 记住 socket 文件的 inode，每 2 秒检查一次；文件没了或被换掉就 flush 后退出。这条兜住所有「两个 daemon 并存」的情况，所以日志淘汰等定时任务要等第一次检查通过后才开始。
  6. 只在三种情况下退出：扩展没连着并且 10 分钟没有命令、SIGTERM、第 5 条。都走同一个 `shutdown`：flush，inode 还是自己的才删 socket 文件（Node 的 `server.close()` 会按路径删文件，不是自己的就不调）。
  7. 重启就是停掉：`setup.js` 和 `habit daemon restart` 用 `ping` 拿 pid、发 SIGTERM，等到 connect 不上为止，不等新的起来；新 daemon 由下一个连接的 relay 或 CLI 拉起。
  8. 扩展和 daemon 断开后固定 1 秒重连，alarm 兜底。
  `ping` 只是查信息（pid、build、ABI、扩展连没连着），daemon 在不在只看 connect。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展是旧的 → 能自己重新加载的（ABI ≥ 13）等它重新加载、重连，不能的明确让用户刷新扩展。`status`、`learn list`、`learn close` 不需要扩展。
- **输出约定**（`protocol.ts`）：第一行是结论，以 `ok`、`fail`、`ask` 开头。退出码：0 成功；1 操作失败；2 是 `ask` 和 `fail need-*`（要 agent 判断或要用户做一件事，不算失败）；3 是命令写错了（第一行也是 `fail`，`Output.usage`：不认识的命令或参数、缺参数、值不合法，agent 要改命令而不是重试）。参数的值不能以 `--` 开头（多半是漏了上一个参数的值），确实需要时写 `--名字=值`；拼错的参数名给「是不是想写」。`read_page`、`find`、`get_page_text` 输出的网页文字放在「页面内容……页面内容结束」之间，说明只是数据；`run` 的结果超过 2 万字时截断，全文存进 run 窗口目录的 `result.json`；`tabs` 最多列 50 个。同一个 learn 句柄一次只跑一条命令（`LearnWindows.claim`），后到的直接 `fail`，不排队。后面是「标题：内容」的几段，多行内容缩进两格：`页面`、`导航`、`请求`（下面可能有一行 `请求头`）、`依赖`、`没列出`（观察），`落在`、`被遮挡`、`定位`、`稳定`（页面操作），`结果`（action 的返回值，JSON）、`错误`、`已发出的非 GET 请求`、`run 窗口目录`、`已变成 verified`（run），`下一步`（建议，最多一两句，和事实分开）。路径一律是绝对路径。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，daemon 只 `detach` 链路，日志照写。
- daemon 启动时：按依赖顺序建好各部件（`daemon.ts` 的 `build`）、打开窗口日志、同步 action SDK、加载 adblock 规则；第一次 inode 检查通过后（约 2 秒），每 10 秒按额度淘汰日志、每分钟关掉空闲的 learn 窗口。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑，是一个固定 ABI 的管道；页面脚本（`page/`）只经 CDP 注入 habit 的标签页，不是内容脚本，用户的网页里没有 habit 的任何代码。`manifest.json` 有固定的 `key`，扩展 ID 是 `dkjmgdhelenchaippejoppbcfbjfgppl`（和 `native-messaging-host/install.ts` 的 `EXTENSION_ID` 一致）；权限 `tabs`、`tabGroups`、`nativeMessaging`、`alarms`、`scripting`、`storage`、`debugger`、`<all_urls>`，Chrome 135 起，只支持 Chrome。

- **ABI**（`browser/extension.ts` 的 `ABI`，现在是 15）：`call`（在页面 MAIN world 调 `window.__habit.exec` 里固定的函数，不执行任意字符串）、`tabs`、`goto`、`history`（后退、前进）、`openTab`、`closeTab`、`closeGroup`、`closeAllGroups`、`idleGroup`、`screenshot`、`input`、`evaluate`、`reload`。帧是 4 字节小端长度加 UTF-8 JSON。
- **CDP**（`cdp.js`，`chrome.debugger`）：habit 唯一的输入路径，learn 的 `computer` / `form_input` 和 action 的 `click` / `hover` / `key` / `scroll` / `form_input` 都走这里，发的是真实输入（`isTrusted` 为真）：鼠标 `mouseMoved → mousePressed → mouseReleased`（双击三击按 `clickCount`）、拖动分 10 步、滚轮 `mouseWheel`、按键 `dispatchKeyEvent`（键名表在 `keys.js`，扩展和自检共用；mac 上 cmd 组合键带 `commands`，如 `selectAll`）、输入文字每个 ASCII 字符 `rawKeyDown → insertText → keyUp`、中文只 `insertText`。截图是 `Page.captureScreenshot`（按 `1/devicePixelRatio` 缩，图上一个像素就是一个 CSS 像素，不用把标签页切到前台），`evaluate` 是 `Runtime.evaluate`（不受页面 CSP 限制）。只附着 habit 的标签页：标签页一开出来就附着（`call`、`goto` 之前也确保附着），附着后开 `Emulation.setFocusEmulationEnabled`。附着同时是放进页面脚本的时机（见下面的「页面脚本怎么进 habit 的标签页」）和后台标签页的「渲染开关」：没附着的后台标签页不渲染（rAF、IntersectionObserver 都停），在折叠的组里约 3 秒后还会被 Chrome 冻结（冻结的页面里 `chrome.scripting` 一直挂着）；附着后页面以为自己可见、有焦点，照常渲染，冻结的立刻解冻。组闲置 20 秒（`GROUP_IDLE_MS`）就解除附着（`idleGroup`），不吃 CPU，没有附着时「正在调试此浏览器」的横幅也消失（横幅是浏览器级别的，附着期间所有窗口都显示）；同时附着同一个标签页的调用共用一次附着；每条命令 20 秒超时；附着断了（用户点掉「正在调试此浏览器」提示条）下一次自动重新附着；habit 的标签页开着 DevTools 时附着失败，报清楚的错。
- **握手和自动重新加载**：`hello` 带 `abi` 和 `build`（`setup.js` 写进 `chrome-extension/build.js` 的版本）。和 daemon 的 ABI 不一致时不工作；扩展支持 `reload`（ABI ≥ 13）并且跑的不是磁盘上这一版（ABI 不同，或 `build` 和 `~/.habit/src/.version` 不同）时，daemon 让它 `chrome.runtime.reload()` 从磁盘重新加载、重连，`ensureExtension` 等它回来。新代码跑在还没有 `debugger` 权限的旧 manifest 上时 `cdp.js` 也会自己重新加载。只有第一次加载要用户在 `chrome://extensions` 里操作。
- **页面脚本怎么进 habit 的标签页**（`cdp.js`）：附着后注册 `Page.addScriptToEvaluateOnNewDocument`（之后每个新文档都在页面自己的脚本之前执行页面脚本，同站 iframe 一起带上）、`Runtime.addBinding`（页面脚本调用 `window.__habitSend` 上报）、`Target.setAutoAttach`（跨站 iframe 作为子会话附着上来，注册后再放行），并给当前文档补注入一次（脚本自己防重复）。要先 `Page.enable`、`Runtime.enable`，否则注册的脚本不执行、binding 收不到。解除附着后注册跟着没了：组闲置 20 秒解除附着期间，页面自己跳到的新文档没有脚本，下次操作重新附着时补上。service worker 重启后调试器和注册都还在，`attach` 会报「已经有调试器」：能发 CDP 命令就是 habit 自己之前的附着，解除再重新附着（清掉旧注册）；发不通才是开着 DevTools。经 `chrome.debugger` 单条消息 16MB 能完整送到。
- 页面消息：页面脚本调用 binding → 扩展在 `chrome.debugger.onEvent` 收到 `Runtime.bindingCalled` → 补上 tab、group、frame（0 是标签页本身，跨站 iframe 的子会话从 1 起）转给 daemon。每条带这次页面加载的编号 `d` 和递增序号 `n`（`page/common.js`），daemon 据此判断记录有没有送达。页面自己的脚本也能调用 binding、改写 `window.__habit`（都在 MAIN world），所以日志只是观察记录，不能当权限依据；最坏是让 habit 在这个页面上录不到、拿到假结果，拿不到别的站点的数据。
- 连接：Chrome 拉起的 relay 无状态，只转发字节；断开后扩展固定 1 秒重连（alarm 兜底 service worker 被停掉的情况），点工具栏图标立即重连。daemon 不随扩展刷新退出。

## 5. 页面脚本

- `a11y.js` 是唯一的元素模型（做法来自 open-claude-in-chrome 的 content.js）：`role` / `name` 算法（`aria-label` > `aria-labelledby` > `placeholder` > `title` > `alt` > `<label>` > 按内容命名的元素的文字），a11y 树（`readPage`）、`findElements`、持久定位的生成（`locOf`）和解析（`find`、`resolveLoc`），以及把目标（ref、持久定位、坐标）变成视口坐标的 `point`：元素在视口外先滚到中央，报告这一点上真正收到点击的元素（被别的元素盖住时写出是谁）和落点提醒（落在页面背景、没有控件的 `<label>` 上，不自动纠正）。learn 里看到的 `role "name"` 和回放时解析 `{ role, name }` 用同一套算法。ref（`ref_N`，`common.js` 的 `refOf` / `byRef`，WeakRef 表）只在当前页面里有效，只给 learn 用；写进 action 的永远是持久定位。
- **只看主文档**：`find`、`read_page`、`get_page_text` 和元素定位（ref、持久定位、坐标）都只在标签页的主文档里，iframe 里的内容看不到、点不到（iframe 里的请求照样录）。要操作 iframe 里的东西，`navigate` 打开 iframe 自己的地址。
- **敏感输入框**（`common.js` 的 `T.sensitiveField`：密码框、隐藏框，`autocomplete` 含 `cc-`、`password`、`one-time` 的卡号、安全码、一次性验证码）：`read_page` 不显示值，`form_input` 填完不回值；`form_input` 和 `computer type`（看当前焦点）往这种框里输入时，时间线只记字数、不记内容。
- `recorder.js` 只如实上报发生的事，不改变页面行为：HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker、事件流）、导航、页面快照、渲染后的 DOM；不记输入事件（agent 的每一步操作由 daemon 记成 `cmd` 行）。`executor.js` 等页面安静、等元素、读 auth 来源、`query`、替 `request()` 发请求。页面脚本不发输入：输入都由扩展用 CDP 发。细节见各文件的注释。
- **页面新开标签页由 habit 接管**（`newtab.js`，只在 habit 的标签页里生效）：页面在用户手势下自己新开标签页（点 `target=_blank`、cmd/ctrl/shift/中键点击、`window.open`），Chrome 会选中它、显示窗口、把 Chrome 拉到前台。所以页面脚本拦下这些（链接默认行为、`HTMLAnchorElement.prototype.click`、`window.open` 返回假窗口对象并接住后设的地址、`target=_blank` 的表单改在当前标签页提交），把地址发给扩展，扩展在同一个组里开（`openForPage`），时间线记一行 `tab` / `opened`。不拦：带窗口参数的 `window.open`（弹出窗口，如 OAuth 登录）、download 链接、非 http(s) 地址、指向页面里 iframe 的 target。代价：新标签页没有 `window.opener`、`Referer`、`sessionStorage`。漏掉的兜底：opener 是 habit 的新标签页收进组、被选中就还给用户，记 `tab` / `leaked`。判断逻辑的自检在 `browser/newtab.selfcheck.mjs`。
- **只录 habit 的标签页（两层，安全相关）**：① 扩展：在 habit 的标签组里的标签页才是 habit 的（扩展只记哪些组是 habit 的，存在 `chrome.storage.session`；组属于哪个窗口由 daemon 记）。只附着 habit 的标签页，页面脚本只经附着放进去，所以用户的网页里没有页面脚本，什么都不会上报。用户把标签页拖进组就是交给 habit：附着、注册、给当前页面补注入，之后的请求开始录（拖进来之前的不录）；拖出去就收回：先让页面脚本停止上报（`T.stop`），再解除附着，之后的文档里没有脚本。`call`、`input`、`evaluate` 也只对 habit 的标签页；扩展转发页面消息前还按组再判断一次。标签页关了只告诉 daemon 出现过的 habit 标签页。② daemon：`Ingestor.handle` 按 `AgentWindows.winOf` 丢弃不属于 habit 窗口的一切（页面消息带组号，按组号归到窗口），窗口没在 `WindowLog` 登记的也丢；扩展 ABI 不对时一条页面消息都不收。
- **清理旧组按标题认**：daemon 重启后第一次用时关掉所有旧的 habit 组（`closeAllGroups`），浏览器重启后恢复出来的不在扩展的记录里，按标题 `habit·` / `habit▶` 认；用户自己起这种名字的组也会被关掉，拖进 habit 组的用户标签页跟着组一起关。
- habit 组里发生的一切都记为 `src: agent`，不区分是 agent 还是有人在那个组里动了一下。

## 6. 日志（`record/`）

`SKILL.md` 第 5 节是给 agent 的精简版，完整格式在本节末尾。常量（截断大小、额度、时间窗）都在 `utils/constants.ts` 和各文件开头。

- **目录**（`record/windowlog.ts`）：一个窗口一个目录（`learn-windows/<句柄>/`、`run-windows/<名字>/`），时间线只追加；文件名以全局递增的编号开头，后面是语义。**站点是发出请求的页面的 host（去 `www.`）**，判断不出是 `_other`。`~/.habit/sites/<站点>/` 只有 `endpoints.json` 和 `actions/`，只在 learn 窗口里出现了非噪声请求或有 action 时才建。
- **编号**：`seq` 全局递增，崩溃重启只会留下空洞，不会重复。每次请求都写一行，不去重（轮询间隔也是信息）。
- **因果与阶段**（`record/ingest.ts`）：`cause`、`phase` 是启发式，离线读日志用；learn 时以观察（§2.1）为准。
- **保留**（`record/retention.ts`）：run 窗口目录只留最近的若干个；learn 窗口分两类额度（时间线和请求文件；响应体、页面和截图），超了先删最旧的关着的窗口里的大文件，再删整个窗口。开着的 learn 窗口、每个 endpoint 最近几次成功请求（样本）不动。
- **endpoints.json**（`record/endpoints.ts`）：只由 learn 窗口的请求增量更新，run 窗口的不进。不排序、不下结论，只给信号。endpoint 名由 `digest.ts` 的 `endpointOf` 算：长数字、哈希、uuid 换成 `:id`，GraphQL 取操作名，同一路径上请求体里的操作名拼在后面（`/graphql#FavoriteTweet`）。
- **过滤**（`filter.ts`）：adblock 规则加第一方埋点启发式标 `noise`；只存同站的响应体。
- **脱敏**（`sanitize.ts`）：请求头名、查询参数名、JSON key 里像秘密的，和 JWT，换成稳定的别名 `⟨secret_…⟩`（盐 + 真值的 HMAC，盐在 `~/.habit/alias-salt`）；响应体和页面正文原样写盘。**别名 → 真值的对照表只在 daemon 内存里。**
- 读日志不是命令：agent 直接读文件。隔离不是安全边界——agent 能读所有窗口目录。

### 数据格式

- **文件名**：以 6 位**日志编号**开头，后面是语义（请求是方法和 endpoint 名，页面是路径）。编号全局唯一、递增；只知道编号时 `ls ~/.habit/*-windows/*/requests/001203-*` 只会命中一个。观察输出里的文件名是相对窗口目录的。
- **action 文件头**：学出来的是 `@summary` `@status draft|verified|blocked` `@endpoint`（可多行）`@param` `@write` `@timeout` `@note`；compose 的文件头写法一样（用 `@description` 不用 `@summary`，没有 `@endpoint`）。名字全局唯一（action 和 compose 共用），`habit run <名>` 先在所有站点的 `actions/` 里找，再找 `~/.habit/compose/`。
- **站点**是页面的 host，去掉前导 `www.`（非默认端口带上，目录名里 `:` 变 `_`）：`app.example.com`、`docs.google.com`、`x.com`。请求属于**发出请求的页面**的站点，不是请求地址的站点：`x.com` 页面调 `api.x.com` 记在 `x.com` 里。

**timeline 一行**（JSON）：

| 字段 | 含义 |
|---|---|
| `seq` `t` `win` `site` `tab` | 编号、毫秒时间戳、窗口（句柄或 run 名字）、站点、标签页 |
| `description` | cmd 行：这一步带的 `--description`（用户的话，description）；它引发的请求经 `cause` 指向这一行 |
| `src` | `agent`（habit 的操作，以及 agent 窗口里页面脚本触发的请求和导航） |
| `type` | `request` `nav` `cmd` `doc` `snap`（`kind: a11y` 是 `read_page` 存下的 a11y 树）`tab` |
| cmd | `kind`（navigate、request、left_click、hover、type、key、scroll、scroll_to、form_input、left_click_drag、screenshot、zoom、eval……）、`target`（如 `ref_12`、`{"role":"button","name":"赞同"}`、`(410,421)`）、`ok` `error` `detail`（`request` 命令的 `detail.endpoint` 是它发的 endpoint；输入命令的 `detail.loc` 是落点元素的持久定位） |
| request | `requestType`（fetch / xhr）、`method` `url`（不含参数）`status` `size`、`endpoint`（`方法 路径`，就是 `@endpoint` 的写法）、`file`（请求文件，相对窗口目录）、`noise: 1`（埋点广告，默认别看） |
| 因果 | `cause`：引发这个请求的命令的 `seq`（同一标签页 2 秒内最近一次 agent 命令）；`causeDt`：相隔毫秒；`phase`：`load`（页面或单页路由刚开始的几秒）、`cmd`（命令引发）、`idle`（轮询等） |

**请求文件**：`method`，`url{bareUrl, query}`（查询参数已解析），`frameUrl`，`headers`，`requestBody`（JSON 和表单已解析成对象），`status`，`responseHeaders`，`responseBodyPath`（相对窗口目录），`startedAt` `endedAt`；habit 另加 `seq` `win` `endpoint` `requestType` `tab` `rid` `cause` `causeDt` `phase`，失败的有 `error`，被截断的有 `truncated`，没存响应体的有 `bodyOmitted`（原因：`noise` `cross-site` `large-error` `no-body` `error`）。**token、Cookie、密码是别名 `⟨secret_…⟩`**，真值只在 daemon 内存里，agent 拿不到。

**endpoints.json**：`{ site, updatedAt, endpoints: [{ key, method, host, name, count, firstSeq, lastSeq, lastStatus, cmdTriggered, onLoad, idle, lastCause, descriptions, variables, shape, headers, samples, action }] }`。只由 learn 窗口的记录累积。`key` 是 `方法 路径`；`cmdTriggered` / `onLoad` / `idle` 按 `phase` 统计；`variables` 是能改的参数，`shape` 是响应结构；`samples` 是最近 5 次成功请求（`file`、`body` 相对 `~/.habit`，`available` 为假表示文件已被淘汰）；`action` 是覆盖它的 action 名（多行 `@endpoint` 每一行都算）；`headers` 是请求头的信号（learn 窗口观察时算的最近一次）：头名 → `{ kind, source? }`，`kind` 是值在这个窗口的同站请求里怎么变（`page` 页面级不变、`endpoint` 按 endpoint 不变、`varies` 每次都变、`few` 样本太少），`source` 是它在页面里的位置（`cookie:_xsrf`、`local:…`，给 `request` 的 `auth` 用）；只有名字和类别，没有值，只给 agent 读，run 不读；`descriptions` 是这个 endpoint 的**description**：引发它的操作、跑覆盖它的 action 时带的 `--description`（`{ text, from, t }`，只收成功的，最近 5 句，新的在前）。不排序，由你筛。文件可能比日志晚两秒，要最新就读时间线。


## 7. 执行

- **habit 窗口**（`browser/window.ts`）：不是单独的 Chrome 窗口，而是用户窗口里 habit 的一个**标签组**（一个 learn 句柄或一次 run 一个组，始终折叠；learn 组标题 `habit·站点`，run 组 `habit▶名字`）。组建在用户最近用的普通窗口里，没有普通窗口时才开一个不抢焦点的窗口。habit 从不选中自己的标签页：新标签页先开成 `chrome://newtab/`（Tab Activate 这类把新标签页切到前台的扩展会跳过它），进组、附着调试器后再导航；刚开的标签页万一被别的扩展选中，扩展把选中还给用户之前的标签页。组内标签页按 origin 池化，保证请求和页面同源。窗口名到组号的映射只在内存里：daemon 重启后留下的组都是孤儿，第一次用时全部关掉（`closeAllGroups`，也按标题认出浏览器重启后恢复的 habit 组）。
- **RunHost**（`browser/host.ts`）：action 的每个操作都在这里执行并写一行 `cmd`。三种实现方式按顺序选：`request` > `waitRequest` > DOM。
  - `request` 的请求头按顺序凑齐，尽量继承复用：① 浏览器自己带的（cookie）；② 从这次窗口里页面发过的同站请求抄（`copyHeaders`）：页面发过同一个 endpoint 就整组抄它最近一次的，否则按 `record/headers.ts` 的 `headerKinds` 只抄页面级不变的头，每次都变、按 endpoint 变的不跨 endpoint 抄，和它们同一族的（名字去掉最后一段相同，如 `x-zse-93` 和 `x-zse-96`）也不抄：只带签名族的一半会被拒；这次窗口里还没有同站请求就等 1.5 秒；③ `auth` 声明的页面固定位置（cookie、localStorage、sessionStorage、meta），发送时在页面里现读；④ 前序请求的值由 action 代码写进 `headers`；`headers` 显式写的最后覆盖。cmd 行的 `detail` 记下抄自哪些 endpoint、抄了和没抄的头名。被 401/403 拒时，run 的 `hint` 写清楚抄了什么、没抄什么、下一步（`takeRejected`）。和当前页面同一注册域名的请求在当前页面上发，否则在请求自己的 origin 上开页面发。
  - `waitRequest` 等页面自己发出的第一个匹配请求，签名由页面算。
  - **等待**只有四种，都有明确的结束条件和上限（`utils/constants.ts`）：① 页面可用：`navigate` 等到 `readyState` 是 interactive（`GOTO_WAIT_MS`，不等被墙的子资源）；② 页面安静 + 记录送达（`quiet`，`QUIET_MAX_MS` 2 秒）：页面没有在途请求、DOM 400ms 没变（`executor.js` 的 `quiet`），并且页面报告的最后一个消息序号已经到了 daemon（`ingest.ts` 的 `waitDelivered`）；learn 每步之后、`learn new`、`request` 抄头前（刚 `navigate` 过、这次窗口还没有同站请求时）默认等，SDK 的 `navigate` / 操作带 `{ settle: true }` 时等；③ 等某个请求：`waitRequest`（`WAIT_REQUEST_MS`）；④ 等某个元素：操作先找元素、`waitFor`（10 秒）。单步 `STEP_TIMEOUT_MS`、整个 action `ACTION_TIMEOUT_MS` 是兜底。没有固定时长的等待。
- **ActionRunner**（`run/runner.ts`）：action 在 worker 线程里跑，SDK（`action-lib/index.js`，daemon 每次启动整个覆盖到 `~/.habit/lib`，保证和 daemon 同一个版本）的每个函数是向 daemon 发一个操作，不用传 page；action 文件是 `export default async () => 结果`（`run/worker.ts` 调用它）；agent 自己的纯函数在 `~/.habit/helpers/`，只在不存在时建目录，从不覆盖；compose 是和 action 一样的模块（自己从 `../lib/index.js` import `habit`、`action`），跑的时候写成旁边的临时文件 `.run-*.mjs`（见 §2.2）。整体超时 115 秒（`@timeout` 可改）。失败时输出带 `page`（URL、标题、截图），像登录失效时带 `hint`。
- **learn 的工具**（`commands/learn.ts`）：和 Claude in Chrome 同名、同参数、同语义：`read_page`、`find`、`get_page_text`（只看不动：不计次数、不要 `--description`、不附带观察；`read_page` 的全文存进 `pages/<编号>-a11y.txt`）、`computer`（`parseComputer`：坐标或 `--ref`）、`form_input`、`navigate`，加一个 habit 自有的 `try_action`。输入（`RunHost.input`）先在页面里把目标换成坐标（`a11y.js` 的 `point`），再由扩展用 CDP 发，输出 `落在：`、`被遮挡：`、`定位：`、提醒；`form_input` 的文本框是点一下 → 全选 → 删除 → `insertText`，复选框状态不对就点，下拉框在页面里直接设值（原生下拉的选项 CDP 点不到），最后核对值。action 的 SDK 走同一个 `RunHost.input`，只是目标是持久定位。工具只是探索、让 habit 录到请求：这一步引发了没有 action 覆盖的 endpoint、操作满 15 次还没写 action、`close` 前没跑过成功的 `habit run` 时，输出给一行「下一步」。
- **在 learn 窗口里试跑**（`commands/learn.ts`）：`habit learn <句柄> try_action <名>` 把 learn 窗口当前的 `Session` 交给 `ActionRunner.runAction`，和 compose 调用 action 一样共用页面状态；日志进 learn 窗口，不变成 verified。原始请求（含真值）只在 daemon 内存里（`record/raw.ts`），**绝不落盘**，daemon 重启就没了。
- **请求头的信号**（`learn/observe.ts`、`record/auth.ts`、`record/headers.ts`）：观察里每个带非浏览器头的请求有一行「请求头」：按头名统计这个窗口里同站请求的真值怎么变（只在同一次页面加载里比），再拿真值和页面此刻的 cookie、localStorage、sessionStorage、meta 比对出位置；只输出、只记类别和位置（`endpoints.json` 的 `headers`），不记值。

## 8. 存储与安装

- 用户数据：`~/.habit/learn-windows`、`~/.habit/run-windows`（日志）、`~/.habit/sites`（`endpoints.json`、`actions/`、`.seq`）、`~/.habit/compose`、`~/.habit/helpers`、`~/.habit/alias-salt`；habit 维护的 `~/.habit/lib`；运行时状态 `~/.habit/session`；运行时代码 `~/.habit/src`。
- `setup.js` 把 skill 目录镜像到 `~/.habit`（只排除 `node_modules`、`.DS_Store`；本机数据目录不碰）、装依赖、注册 native host、生成命令、`build` 不同时让旧 daemon 退出（扩展重连时拉起新代码）、运行 `doctor`。
- 版本：`~/.habit/src/.version` 的 `build`；只有 `setup.js` 发现 `build` 不同、或用户 `habit daemon restart` 时才换代码。`habit doctor` 只读。

## 9. 排障

先运行 `~/.habit/bin/habit doctor`（`--json` 得到机器可读结果），失败项带修复命令。安装类的问题（Node、依赖、native host、加载扩展）见 `install.md`。下面是运行时的问题，都可以读源码定位并直接修复；直接改 `~/.habit/src` 是临时修复，下次升级会覆盖。

| 现象 | 处理 |
|---|---|
| `extension-abi` 不对，或"扩展是旧版本" | 扩展会自己重新加载（跑一次 `habit tabs` 触发，等几秒再试）；仍不行在 `chrome://extensions` 里刷新 habit |
| 「连不上这个标签页的调试接口」 | 这个 habit 标签页开着 DevTools（或别的调试器），关掉后重试；用户点掉了「正在调试此浏览器」提示条的，下一次操作会自动重新附着 |
| 「被遮挡：…」 | 点击落在了盖在目标上面的元素（弹窗、遮罩、吸顶栏）上：先关掉它，或换一个没被盖住的目标 |
| 「ref_N 找不到了」 | 页面跳转或元素被移除，ref 失效：重新 `find` / `read_page` |
| `need-extension` | 请用户确认 Chrome 里的 habit 扩展开着，点一下工具栏图标；从没加载过的属于安装问题 |
| `need-install` | habit 没装好或 native host 丢了：告诉用户需要重新安装 habit |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，扩展 1 秒后重连、Chrome 拉起新的 relay；等几秒，仍不行看 `doctor` 的 `launcher-node`，再不行重启 Chrome |
| `launcher-node` 失败 | 启动脚本里写死的 node 不在了（nvm 换了版本），relay 起不来：重新运行 `setup.js` |
| 升级后旧 daemon 还在跑 | `habit daemon restart`（只让它退出，下一条命令拉起新的） |
| 命令一直等着不返回 | daemon 在忙（或被暂停）；不要删 `session/sock`，删了旧 daemon 会在 2 秒内退出、内存里的状态就没了。真卡死了用 `habit daemon restart` |
| `run` 的请求被 401/403 拒 | 失败的「下一步」写了抄了什么、没抄什么：登录失效就请用户登录；页面这次没发带某个头的请求，action 要先 `navigate` 会发它的页面，或照 learn 窗口观察「请求头」给的位置写 `auth`；每次都变的头被拒，改用 `waitRequest` 或 DOM |
| learn 窗口的操作说"已经关了" | 窗口之前关了（`learn close`、空闲 30 分钟、daemon 重启、扩展重连、用户关了组）：这个句柄只能看日志，用 `learn new --url <要的页面>` 开新窗口复现 |
| `learn <句柄> find` / `read_page` / `computer …` 报"页面里没有 habit 的脚本" | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| 日志里没有某个站点的事件 | 只录 habit 组里的标签页：组外的浏览不会有记录，要用 `learn new --url` 在 learn 窗口里重新打开（或把那个标签页拖进 habit 的组）；看对应窗口目录里的 `timeline.jsonl`，按 `site` 字段筛 |
| 磁盘上 `~/.habit/learn-windows` 太大 | 按额度自动淘汰（`habit status` 看占用）；要手动清就删关掉的旧窗口目录，别删 `sites/*/actions/` |

- 运行时日志：`~/.habit/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <daemon pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。
