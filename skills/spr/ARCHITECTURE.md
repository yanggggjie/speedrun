# ARCHITECTURE

speedrun 的目标、设计原则和运行时实现：每一部分是谁实现的、在哪个文件、保证什么。agent 怎么用见 `SKILL.md`；安装见 `install.md`；开发、验证、发布见 `AGENTS.md`。

## 1. 目标与原则

一句话：**超快的、用已登录 Chrome 的 skill；agent 写 compose 脚本完成任务，缺的 action 在 debug 窗口里写好，只用 run 窗口运行和交付。**

- **用户只做两件事**：说要做什么，以及要输入账号密码、扫码的登录。其余全靠 agent 自己写脚本，没有用户示范。
- **录制的用途**：① 拿到 endpoint，用请求代替页面操作大幅提速；② endpoint 没法直接发时，给 DOM 操作提供依据（持久定位、该步之后出现了哪个请求）；③ 作为请求头的来源（`request` 继承 agent 窗口里同站点页面最近的请求头）；④ run 出问题时反查。

**action** 是 speedrun 的基本单位：agent 写的、带参数、能复用的业务动作，由一个或几个 endpoint（录到的一个请求，写成 `方法 路径`）实现，或用 DOM 实现。**compose** 是任务脚本，用 action 串成的流程，只能调用 action 和别的 compose，不能碰页面；它是 action 的使用者，不是 action 的一种。任务永远走 Find、Write、Debug、Run：找已有脚本，写 compose，缺的 action 在 debug 窗口里写好，用 `spr run` 运行。

设计原则（agent 的使用原则在 `SKILL.md` 第 2 节）：
1. **唯一目标：更快完成眼前的任务。** 结果只来自 `spr run`：用请求代替页面操作，比点页面快一个量级。存下来的东西是顺带的：action 和 compose 是 agent 写的文件，一直留着复用；description 由 speedrun 自动存。这是 SKILL 里的约定，没有强制检查。
2. **只录 agent 的窗口。** 归属按标签组认：speedrun 组里的标签页是 agent 的（用户自己拖进 speedrun 组的也算，拖出去就收回），其余用户的窗口和标签页不录、不碰，只读标签页列表（地址、标题）；要看用户手上的页面，就在 debug 窗口里重新打开它，从加载开始录。用户很久以前做的操作，agent 不知道请求的来源和意图；只用 agent 自己做出来的请求才准。
3. **秘密不落盘、不进上下文。** 原始请求（含 token 真值）只在 daemon 内存里；日志、请求文件、观察输出里是别名。这不是对 agent 的隔离：action 和页面脚本与用户同权限（`evaluate` 能读页面的 cookie、localStorage，action 的 worker 有完整的 Node 权限），保证的只是真值不写盘、不出现在 agent 读到的文字里。原始请求按窗口存，窗口关掉（debug `close`、run 结束）就清掉。
4. **日志和 action 都是文件。** 能读文件的不做命令，agent 用 `rg`、`node`、Python 直接读；speedrun 的命令只做必须由它做的事（控制浏览器、持有不能落盘的原始请求）。
5. **命令面最小，显式区分优于隐式区分。** 同一条命令不因为 agent 看不到的状态做不同的事。run 窗口每次从空白开始、`spr run <名>` 只按名字找文件，都是为此。run 的行为只取决于 action 文件和这次窗口里发生的事：不读 `endpoints.json`，不用以前或别的窗口的原始请求。
6. **speedrun 给信号，run 的结果和 agent 来定。** speedrun 只做必须由它做、而且做得准的事：用内存里的真值统计、按固定规则继承复用、把失败说清楚；不提前替 agent 下「这个请求该怎么发」的结论。用哪个请求、用 `request`、`waitRequest` 还是 DOM，由 agent 看信号决定，以 run 的真实结果为准。

## 2. 两种窗口，以及 action 和 compose 的运行

### 2.1 两种窗口

| 窗口 | 用途 | 录不录 |
|---|---|---|
| 用户的窗口 | 用户自己浏览 | 不录；只读标签页列表 |
| debug 窗口（按 compose 查找，id 是 `<compose>-<时间>`） | agent 观察请求、写 action；run 之后也保留 | 录，日志在 `debug-windows/<id>/`，进 `endpoints.json` |
| run 窗口（`<名字>-<时间>`） | 执行 compose；每次 run 新开，结束就关 | 录，日志在 `run-windows/<名字>/`，只给反查，不进 `endpoints.json` |

为什么这样分：debug 需要页面状态接得上（点到某个状态，接着观察下一步），run 需要每次一样（不因上次留下的页面而不同）；试错、响应原文、截图都留在窗口目录里，不占 agent 的上下文；两种窗口的每个操作和请求都在各自的时间线里，run 出问题时对照着看。

- **debug 窗口**（`debug/windows.ts`）：`spr debug <compose> navigate <网址|tab 号>` 在窗口没开时打开它，compose 文件必须已存在；第一次输出 debug 指引（`debug/guide.ts`，存在 `~/.speedrun/debug-guide.md`，内容变了才给全文）。窗口按 compose 名查找，内部 id 是 `<compose>-<时间>`（同一秒重名加 `-2`），`debug-windows/<id>/meta.json` 存 compose、当前 URL、标题、观察游标、操作次数，只给看日志用。一个窗口可以处理 compose 缺的多个 action，也可以跨站点。`spr run` 成功或失败都不关它。窗口关掉的情况：`spr debug <compose> close`、空闲 30 分钟、daemon 重启、扩展重连（daemon 忘掉所有组）、用户关了组；关掉后 `navigate` 以外的工具是用法错误（退出码 3），提示重新 navigate、在新窗口里复现，不会悄悄回到上次的 URL 接着用。操作上限 200 次（只有成功的页面操作计数，不清零）：到了多半是在原地打转，报错让 agent 先停下看卡在哪。同一个 compose 一次只跑一条命令（`DebugWindows.claim`），后到的直接 `fail`。每条成功输出的末行由 `run/link.ts` 算出目标和还缺的 action。
- **run 窗口**：每次 `spr run` 新开一个，整个 run（含 compose 调用的 action）共用，结束就关；失败时先截图（`screenshots/failure.*`）再关。关掉后日志留在 `run-windows/<名字>/`，要看页面就在 debug 窗口里复现。结果先返回，标签组在后台关（`ActionRunner.closeLater`），daemon 退出前等它们关完。不同的 run 可以同时跑，没有排队锁。
- **观察按游标**（`debug/observe.ts`，`debug/explore.ts`）：返回游标之后这个窗口的变化并推进游标（请求只列这个窗口里第一次出现的 endpoint，全部都在 `timeline.jsonl` 里）：页面状态、导航（跳到别的站点时写明站点）、请求（去掉噪声、静态资源、轮询；`describeRequest` 一行：编号、`方法 路径`、状态、内容类型、有没有响应体、请求文件名）、请求之间的依赖（`dependencies`：后一个请求里长度 ≥ 6 的值等于前一个响应里的值）。改变页面的操作执行完等页面安静、记录送达（`RunHost.quiet`，见 §7），自动附带一次观察；`computer wait` 等完也附带一次（晚到的请求用它看）。"这一步之后发生了什么"以两次观察之间为准，不靠 `cause` 猜。这一段里有同站请求被 401/403 拒，或者页面在登录页（`utils/url.ts` 的 `isLoginUrl`），观察里先给一条「像是登录失效」的下一步：先看页面，点一下能登录的自己点，要账号密码、扫码的请用户登录；run 失败时同样判断（`looksLoggedOut`）。
- **写请求不拦，也不判断**：debug 窗口里页面发什么就真的发什么，`run` 带 `@write` 的 action 也直接发。一个请求有没有副作用、多严重，由 agent 按 SKILL 的标准判断（原则 6）；`@write` 是 agent 写的提示。每次 `run` 统计这次实际发出的非 GET 请求（`request()` 发的和页面自己发的，只看方法、不是 GET / HEAD / OPTIONS 就算，`browser/host.ts` 的 `watchSent` / `takeSent`），输出里列成「已发出的非 GET 请求」，也写进 run 窗口 `meta.json` 的 `sent`；agent 拿它核对有没有意料之外的、告诉用户真发了什么。

### 2.2 action 和 compose 的运行

- **compose 只能调用 action**：`~/.speedrun/compose/` 下的文件跑起来时会话标为 compose-only，任何页面操作都被 `RunHost` 拒绝；反过来，action 里调用别的 action（`action()`）被 `ActionRunner` 拒绝。`spr run` 只接受 compose，action 不能单独运行。compose 可以调用 draft。
- **draft 变成 verified**（`commands/run.ts` 的 `finishRun`）：run 成功、执行过的 draft 都变成 verified（跑成功就是事实，action 自己检查状态码和返回值）。`blocked` 的 action 在执行前检查时就报出来。
- **参数**（`run/actions.ts` 的 `checkParams`、`coerceParams`）：对照文件头 `@param 名字[?][:类型]` 检查缺的、多的，再按类型（`number`、`boolean`、`json`，默认字符串）转换后作为函数参数交给脚本；compose 里 `action()` 传的参数也一样。
- **执行前检查**（`run/link.ts` 的 `checkCompose`）：`spr run` 和失败后的 `spr resume` 先读文件，跳过注释和字符串找 `action()` 调用，递归检查 compose。缺的 action 一次报全（`<名> is not defined`），依赖 blocked 也在这里报，名字不是字面量和循环调用是用法错误。这一步不开窗口、不需要扩展。别名导入这类写法看不到，`runAction` 运行时还会再报 `is not defined`。
- **compose 是 agent 写的文件**（`~/.speedrun/compose/<名>.js`）：和 action 一样的文件头（`@description` `@status` `@param` `@timeout` `@write`）和 `export default async ({ 参数 }) => 结果`，`import { action, ask } from "spr"`。放在这个目录里的就是 compose，不看文件头。一直保留、不淘汰；跑成功后 speedrun 只把 `@status draft` 改成 `verified`。`ActionRunner` 跑 compose 时把这一刻读到的代码写成它旁边的临时文件 `.run-*.mjs` 再跑（相对 import 照样能用），跑完删掉。
- **`ask`**（`run/runner.ts` 的 `work()`、`commands/run.ts` 的 `handleAsk`）：run 停下输出 `ask <问题>`、`数据`、`恢复`（`spr resume <编号> --answer …`）。恢复记录存下停下那一刻的 compose 代码；`spr resume` 新开 run 窗口、用这份代码从头重跑（agent 中途改了文件也不影响），最外层 compose 里记下的 `action()` 直接返回上次的结果，第 i 次 ask 返回第 i 个回答。恢复时核对每次调用的名字和参数，不同就失败。只有 `spr run` 直接跑的那个 compose 能 ask；`data` 超过 100KB 失败。恢复记录只在 daemon 内存里（`run/asks.ts`，归 `ActionRunner`），最多 20 条、30 分钟过期，用过就作废（ask 恢复失败时保留）。
- **失败后恢复**（`commands/run.ts` 的 `keepForResume`）：compose 失败且已有完成的 action 时，留一条 `failed` 恢复记录，不存代码。`spr resume <编号>` 不带 `--answer`，读当前文件，已完成的 action 从 journal 返回，失败的 action 用修好的文件重新执行；调用的名字或参数不同就失败。再次失败时换一条新记录。

## 3. 进程与分层

**所有逻辑和数据在 daemon，扩展、relay、CLI 只做 I/O。** 扩展的安装、分发不方便（首次只能手动加载；之后 `setup.js` 更新了扩展，daemon 发现它跑的不是磁盘上这一版就让它自己重新加载，见 §4），而 daemon、CLI 在 `~/.speedrun/src` 里，`setup.js` 镜像之后让旧 daemon 退出，下一个连接的 relay 或 CLI 就拉起新代码。

```
CLI（argv→RPC→打印） ──sock──▶ daemon（唯一的大脑） ◀──sock── relay（字节管） ◀──native messaging── 扩展（固定 ABI，CDP 输入） ──▶ 页面脚本：元素模型 + 录制 + 执行
```

| 层 | 只做 | 位置 |
|---|---|---|
| 扩展 | 固定的操作（见 §4）：唯一的输入路径（CDP），截图、执行 JS，加转发页面消息和标签页的地址变化、关闭 | `src/chrome-extension/` |
| relay | 在 Chrome 的 stdio 与 daemon 的 socket 之间原样转发字节；daemon 不在时拉起它（和 CLI 共用 `session/client.ts`） | `src/native-messaging-host/relay.ts` |
| CLI | 把 argv 交给 daemon，打印它返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留着（要诊断或停掉一个可能已经不在的 daemon） | `src/cli/` |
| 页面脚本 | `a11y.js` 找元素、算坐标（a11y 树、find、持久定位）；`recorder.js` 如实上报浏览器里发生的事；`executor.js` 等页面安静、取数、发请求 | `src/chrome-extension/page/` |
| daemon | agent 窗口与 action 运行时、观察、脱敏、写日志与 endpoints.json、日志淘汰、原始请求的内存表、别名对照表、debug 窗口登记 | `src/daemon.ts`、`src/commands/`、`src/debug/`、`src/run/`、`src/browser/`、`src/record/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| daemon | relay 或 CLI（socket connect 不上时 detached 拉起） | 扩展链路、agent 窗口、开着的 debug 窗口、原始请求、恢复记录、日志写入 | 不随 relay 断开、Chrome 退出而退出；只在三种情况下退出：扩展没连着并且 10 分钟没有命令、收到 SIGTERM、socket 文件不是自己的了（见下面的 8 条） |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

daemon 内部分四层，上层只依赖下层：

| 层 | 目录 | 只做 |
|---|---|---|
| 命令 | `commands/` | argv 解析（`args.ts`）、调用下层、按输出约定拼文本；不持有状态 |
| debug 与 run | `debug/`、`run/` | debug 窗口的登记和页面（`DebugWindows` 持有每个窗口当前的 `Session`）、观察和请求头的信号；action 运行时（`ActionRunner` 持有 ask 的恢复记录）、action 和 compose 文件 |
| 控制浏览器 | `browser/` | 扩展链路、agent 窗口池（`AgentWindows`）、页面操作（`RunHost`），debug 和 run 共用 |
| 录制与存储 | `record/` | 收页面消息、脱敏、写日志、`endpoints.json`、淘汰、原始请求的内存表（按窗口）、请求头的统计和来源比对 |

`daemon.ts` 只做组装（`build` 按依赖顺序一次建好）、socket 和定时任务。定时写盘出错（磁盘满、没权限）只记进运行时日志，不让 daemon 退出：退出会丢掉内存里的原始请求、ask 恢复记录和 debug 窗口的页面。

- 命令入口：`src/cli/spr.ts` 没有命令逻辑，`spr <argv>` 原样发给 daemon 的 `run` RPC，daemon 调 `commands/index.ts` 的 `runCommand`，返回 `{ stdout, code }`。
- **daemon 的启动和退出**（`src/session/server.ts`、`src/session/client.ts`），8 条规则：
  1. 只有一个 socket `~/.speedrun/session/sock`（权限 0600）。relay 和 CLI 都是客户端，连上后第一行说明角色：`{"role":"relay"}` / `{"role":"cli"}`；daemon 按 Buffer 收第一行再分流（relay 后面紧跟二进制帧），2 秒内没有合法的角色说明就断开。CLI 的 JSON-RPC 按 UTF-8 解码。
  2. 只有一个函数拉起 daemon：`connectDaemon`（CLI 和 relay 共用）先 connect，连不上就 spawn 一个 detached 的 daemon，再每 100ms 重试，最多 10 秒。
  3. listen 成功的就是唯一的 daemon；EADDRINUSE 时 connect 一下：连得上说明对方活着，自己退出；被拒绝说明是残留文件，删掉再 listen 一次。
  4. 只有 daemon 自己删 socket 文件，并且只在 connect 被拒绝时删。CLI、relay、`setup.js` 都不删：超时只说明 daemon 忙，不说明它死了。
  5. daemon 记住 socket 文件的 inode，每 2 秒检查一次；文件没了或被换掉就 flush 后退出。这条兜住所有「两个 daemon 并存」的情况，所以日志淘汰等定时任务要等第一次检查通过后才开始。
  6. 只在三种情况下退出：扩展没连着并且 10 分钟没有命令、SIGTERM、第 5 条。都走同一个 `shutdown`：flush，inode 还是自己的才删 socket 文件（Node 的 `server.close()` 会按路径删文件，不是自己的就不调）。
  7. 重启就是停掉：`setup.js` 和 `spr daemon restart` 用 `ping` 拿 pid、发 SIGTERM，等到 connect 不上为止，不等新的起来；新 daemon 由下一个连接的 relay 或 CLI 拉起。
  8. 扩展和 daemon 断开后固定 1 秒重连，alarm 兜底。
  `ping` 只是查信息（pid、build、ABI、扩展连没连着），daemon 在不在只看 connect。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展是旧的 → 能自己重新加载的（ABI ≥ 13）等它重新加载、重连，不能的明确让用户刷新扩展。`status`、`debug list`、`debug <compose> close` 不需要扩展。
- **输出约定**（`protocol.ts`）：第一行是结论，以 `ok`、`fail`、`ask` 开头。退出码：0 成功；1 操作失败；2 是 `ask` 和 `fail need-*`（要 agent 判断或要用户做一件事，不算失败）；3 是命令写错了（第一行也是 `fail`，`Output.usage`：不认识的命令或参数、缺参数、值不合法，agent 要改命令而不是重试）。参数的值不能以 `--` 开头（多半是漏了上一个参数的值），确实需要时写 `--名字=值`；拼错的参数名给「是不是想写」。`read_page`、`find`、`get_page_text` 输出的网页文字放在「页面内容……页面内容结束」之间，说明只是数据；`run` 的结果超过 2 万字时截断，全文存进 run 窗口目录的 `result.json`；`tabs` 最多列 50 个。同一个 compose 的 debug 命令一次只跑一条（`DebugWindows.claim`），后到的直接 `fail`，不排队。后面是「标题：内容」的几段，多行内容缩进两格：`页面`、`导航`、`请求`（下面可能有一行 `请求头`）、`依赖`、`没列出`（观察），`落在`、`被遮挡`、`定位`、`稳定`（页面操作），`结果`（action 的返回值，JSON）、`错误`、`已发出的非 GET 请求`、`run 窗口目录`、`已变成 verified`（run），`下一步`（建议，最多一两句，和事实分开）。路径一律是绝对路径。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，daemon 只 `detach` 链路，日志照写。
- daemon 启动时：按依赖顺序建好各部件（`daemon.ts` 的 `build`）、打开窗口日志、同步 action SDK、加载 adblock 规则；第一次 inode 检查通过后（约 2 秒），每 10 秒按额度淘汰日志、每分钟关掉空闲的 debug 窗口。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑，是一个固定 ABI 的管道；页面脚本（`page/`）只经 CDP 注入 speedrun 的标签页，不是内容脚本，用户的网页里没有 speedrun 的任何代码。`manifest.json` 有固定的 `key`，扩展 ID 是 `dkjmgdhelenchaippejoppbcfbjfgppl`（和 `native-messaging-host/install.ts` 的 `EXTENSION_ID` 一致）；权限 `tabs`、`tabGroups`、`nativeMessaging`、`alarms`、`scripting`、`storage`、`debugger`、`<all_urls>`，Chrome 135 起，只支持 Chrome。

- **ABI**（`browser/extension.ts` 的 `ABI`，现在是 15）：`call`（在页面 MAIN world 调 `window.__spr.exec` 里固定的函数，不执行任意字符串）、`tabs`、`goto`、`history`（后退、前进）、`openTab`、`closeTab`、`closeGroup`、`closeAllGroups`、`idleGroup`、`screenshot`、`input`、`evaluate`、`reload`。帧是 4 字节小端长度加 UTF-8 JSON。
- **CDP**（`cdp.js`，`chrome.debugger`）：speedrun 唯一的输入路径，debug 的 `computer` / `form_input` 和 action 的 `click` / `hover` / `key` / `scroll` / `form_input` 都走这里，发的是真实输入（`isTrusted` 为真）：鼠标 `mouseMoved → mousePressed → mouseReleased`（双击三击按 `clickCount`）、拖动分 10 步、滚轮 `mouseWheel`、按键 `dispatchKeyEvent`（键名表在 `keys.js`，扩展和自检共用；mac 上 cmd 组合键带 `commands`，如 `selectAll`）、输入文字每个 ASCII 字符 `rawKeyDown → insertText → keyUp`、中文只 `insertText`。截图是 `Page.captureScreenshot`（按 `1/devicePixelRatio` 缩，图上一个像素就是一个 CSS 像素，不用把标签页切到前台），`evaluate` 是 `Runtime.evaluate`（不受页面 CSP 限制）。只附着 speedrun 的标签页：标签页一开出来就附着（`call`、`goto` 之前也确保附着），附着后开 `Emulation.setFocusEmulationEnabled`。附着同时是放进页面脚本的时机（见下面的「页面脚本怎么进 speedrun 的标签页」）和后台标签页的「渲染开关」：没附着的后台标签页不渲染（rAF、IntersectionObserver 都停），在折叠的组里约 3 秒后还会被 Chrome 冻结（冻结的页面里 `chrome.scripting` 一直挂着）；附着后页面以为自己可见、有焦点，照常渲染，冻结的立刻解冻。组闲置 20 秒（`GROUP_IDLE_MS`）就解除附着（`idleGroup`），不吃 CPU，没有附着时「正在调试此浏览器」的横幅也消失（横幅是浏览器级别的，附着期间所有窗口都显示）；同时附着同一个标签页的调用共用一次附着；每条命令 20 秒超时；附着断了（用户点掉「正在调试此浏览器」提示条）下一次自动重新附着；speedrun 的标签页开着 DevTools 时附着失败，报清楚的错。
- **握手和自动重新加载**：`hello` 带 `abi` 和 `build`（`setup.js` 写进 `chrome-extension/build.js` 的版本）。和 daemon 的 ABI 不一致时不工作；扩展支持 `reload`（ABI ≥ 13）并且跑的不是磁盘上这一版（ABI 不同，或 `build` 和 `~/.speedrun/src/.version` 不同）时，daemon 让它 `chrome.runtime.reload()` 从磁盘重新加载、重连，`ensureExtension` 等它回来。新代码跑在还没有 `debugger` 权限的旧 manifest 上时 `cdp.js` 也会自己重新加载。只有第一次加载要用户在 `chrome://extensions` 里操作。
- **页面脚本怎么进 speedrun 的标签页**（`cdp.js`）：附着后注册 `Page.addScriptToEvaluateOnNewDocument`（之后每个新文档都在页面自己的脚本之前执行页面脚本，同站 iframe 一起带上）、`Runtime.addBinding`（页面脚本调用 `window.__sprSend` 上报）、`Target.setAutoAttach`（跨站 iframe 作为子会话附着上来，注册后再放行），并给当前文档补注入一次（脚本自己防重复）。要先 `Page.enable`、`Runtime.enable`，否则注册的脚本不执行、binding 收不到。解除附着后注册跟着没了：组闲置 20 秒解除附着期间，页面自己跳到的新文档没有脚本，下次操作重新附着时补上。service worker 重启后调试器和注册都还在，`attach` 会报「已经有调试器」：能发 CDP 命令就是 speedrun 自己之前的附着，解除再重新附着（清掉旧注册）；发不通才是开着 DevTools。经 `chrome.debugger` 单条消息 16MB 能完整送到。
- 页面消息：页面脚本调用 binding → 扩展在 `chrome.debugger.onEvent` 收到 `Runtime.bindingCalled` → 补上 tab、group、frame（0 是标签页本身，跨站 iframe 的子会话从 1 起）转给 daemon。每条带这次页面加载的编号 `d` 和递增序号 `n`（`page/common.js`），daemon 据此判断记录有没有送达。页面自己的脚本也能调用 binding、改写 `window.__spr`（都在 MAIN world），所以日志只是观察记录，不能当权限依据；最坏是让 speedrun 在这个页面上录不到、拿到假结果，拿不到别的站点的数据。
- 连接：Chrome 拉起的 relay 无状态，只转发字节；断开后扩展固定 1 秒重连（alarm 兜底 service worker 被停掉的情况），点工具栏图标立即重连。daemon 不随扩展刷新退出。

## 5. 页面脚本

- `a11y.js` 是唯一的元素模型（做法来自 open-claude-in-chrome 的 content.js）：`role` / `name` 算法（`aria-label` > `aria-labelledby` > `placeholder` > `title` > `alt` > `<label>` > 按内容命名的元素的文字），a11y 树（`readPage`）、`findElements`、持久定位的生成（`locOf`）和解析（`find`、`resolveLoc`），以及把目标（ref、持久定位、坐标）变成视口坐标的 `point`：元素在视口外先滚到中央，报告这一点上真正收到点击的元素（被别的元素盖住时写出是谁）和落点提醒（落在页面背景、没有控件的 `<label>` 上，不自动纠正）。debug 里看到的 `role "name"` 和回放时解析 `{ role, name }` 用同一套算法。ref（`ref_N`，`common.js` 的 `refOf` / `byRef`，WeakRef 表）只在当前页面里有效，只给 debug 用；写进 action 的永远是持久定位。
- **只看主文档**：`find`、`read_page`、`get_page_text` 和元素定位（ref、持久定位、坐标）都只在标签页的主文档里，iframe 里的内容看不到、点不到（iframe 里的请求照样录）。要操作 iframe 里的东西，`navigate` 打开 iframe 自己的地址。
- **敏感输入框**（`common.js` 的 `T.sensitiveField`：密码框、隐藏框，`autocomplete` 含 `cc-`、`password`、`one-time` 的卡号、安全码、一次性验证码）：`read_page` 不显示值，`form_input` 填完不回值；`form_input` 和 `computer type`（看当前焦点）往这种框里输入时，时间线只记字数、不记内容。
- `recorder.js` 只如实上报发生的事，不改变页面行为：HTML 文档、XHR、fetch（WebSocket、事件流、Worker 里的请求由扩展的 Network 事件录，见 `cdp.js`；不录 `sendBeacon`，`blob:` 地址的 Worker 附着不上）、导航、页面快照、渲染后的 DOM；不记输入事件（agent 的每一步操作由 daemon 记成 `cmd` 行）。`executor.js` 等页面安静、等元素、读 auth 来源、`query`、替 `request()` 发请求。页面脚本不发输入：输入都由扩展用 CDP 发。细节见各文件的注释。
- **页面新开标签页由 speedrun 接管**（`newtab.js`，只在 speedrun 的标签页里生效）：页面在用户手势下自己新开标签页（点 `target=_blank`、cmd/ctrl/shift/中键点击、`window.open`），Chrome 会选中它、显示窗口、把 Chrome 拉到前台。所以页面脚本拦下这些（链接默认行为、`HTMLAnchorElement.prototype.click`、`window.open` 返回假窗口对象并接住后设的地址、`target=_blank` 的表单改在当前标签页提交），把地址发给扩展，扩展在同一个组里开（`openForPage`），时间线记一行 `tab` / `opened`。不拦：带窗口参数的 `window.open`（弹出窗口，如 OAuth 登录）、download 链接、非 http(s) 地址、指向页面里 iframe 的 target。代价：新标签页没有 `window.opener`、`Referer`、`sessionStorage`。漏掉的兜底：opener 是 speedrun 的新标签页收进组、被选中就还给用户，记 `tab` / `leaked`。判断逻辑的自检在 `browser/newtab.selfcheck.mjs`。
- **只录 speedrun 的标签页（两层，安全相关）**：① 扩展：在 speedrun 的标签组里的标签页才是 speedrun 的（扩展只记哪些组是 speedrun 的，存在 `chrome.storage.session`；组属于哪个窗口由 daemon 记）。只附着 speedrun 的标签页，页面脚本只经附着放进去，所以用户的网页里没有页面脚本，什么都不会上报。用户把标签页拖进组就是交给 speedrun：附着、注册、给当前页面补注入，之后的请求开始录（拖进来之前的不录）；拖出去就收回：先让页面脚本停止上报（`T.stop`），再解除附着，之后的文档里没有脚本。`call`、`input`、`evaluate` 也只对 speedrun 的标签页；扩展转发页面消息前还按组再判断一次。标签页关了只告诉 daemon 出现过的 speedrun 标签页。② daemon：`Ingestor.handle` 按 `AgentWindows.winOf` 丢弃不属于 speedrun 窗口的一切（页面消息带组号，按组号归到窗口），窗口没在 `WindowLog` 登记的也丢；扩展 ABI 不对时一条页面消息都不收。
- **清理旧组按标题认**：daemon 重启后第一次用时关掉所有旧的 speedrun 组（`closeAllGroups`），浏览器重启后恢复出来的不在扩展的记录里，按标题 `speedrun` 认；用户自己起这个名字的组也会被关掉，拖进 speedrun 组的用户标签页跟着组一起关。
- speedrun 组里发生的一切都记为 `src: agent`，不区分是 agent 还是有人在那个组里动了一下。

- `dialogs.js`：拦下页面的系统弹窗（它们会抢前台并阻塞操作）：`alert` 放过，`confirm`、`prompt` 选取消，离开确认不弹，页面自己的 `beforeunload` 处理照常跑；都上报，`spr run` 输出和观察里列出。漏掉的由 `cdp.js` 的 `Page.javascriptDialogOpening` 关掉。

## 6. 日志（`record/`）

`SKILL.md` 第 5 节是给 agent 的精简版，完整格式在本节末尾。常量（截断大小、额度、时间窗）都在 `utils/constants.ts` 和各文件开头。

- **目录**（`record/windowlog.ts`）：一个窗口一个目录（`debug-windows/<id>/`、`run-windows/<名字>/`），时间线只追加；文件名以全局递增的编号开头，后面是语义。**站点是发出请求的页面的 host（去 `www.`）**，判断不出是 `_other`。`~/.speedrun/action/<站点>/` 放 `endpoints.json`、`page-api.json` 和 action 文件，只在 debug 窗口里出现了非噪声请求或有 action 时才建。
- **编号**：`seq` 全局递增，崩溃重启只会留下空洞，不会重复。每次请求都写一行，不去重（轮询间隔也是信息）。
- **因果与阶段**（`record/ingest.ts`）：`cause`、`phase` 是启发式，离线读日志用；debug 时以观察（§2.1）为准。
- **保留**（`record/retention.ts`）：run 窗口目录只留最近的若干个；debug 窗口分两类额度（时间线和请求文件；响应体、页面和截图），超了先删最旧的关着的窗口里的大文件，再删整个窗口。开着的 debug 窗口、每个 endpoint 最近几次成功请求（样本）不动。
- **endpoints.json**（`record/endpoints.ts`）：只由 debug 窗口的请求增量更新，run 窗口的不进。不排序、不下结论，只给信号。endpoint 名由 `digest.ts` 的 `endpointOf` 算：长数字、哈希、uuid 换成 `:id`，GraphQL 取操作名，同一路径上请求体里的操作名拼在后面（`/graphql#FavoriteTweet`）。
- **过滤**（`filter.ts`）：adblock 规则加第一方埋点启发式标 `noise`；只存同站的响应体。adblock 规则缓存在 `~/.speedrun/adblock-engine.bin`，7 天内用缓存，过期才联网下载；下载失败就用过期的缓存，都没有时只用启发式。
- **脱敏**（`sanitize.ts`）：请求头名、查询参数名、JSON key（请求体和 JSON 响应体都算）里像秘密的，和 JWT，换成稳定的别名 `⟨secret_…⟩`（盐 + 真值的 HMAC，盐在 `~/.speedrun/alias-salt`）；HTML（页面快照、HTML 响应体）里密码框、隐藏框、卡号 / 安全码 / 一次性验证码框、名字像秘密的输入框的 `value`，和名字像秘密的 `<meta>`（`csrf-token` 这类）的 `content`，也换成别名。正文里的自由文本、内联脚本不扫描，原样写盘。同一个值的别名总是同一个，所以观察里的「依赖」照样能把请求里的值和前面响应里的对上。**别名 → 真值的对照表只在 daemon 内存里。**
- 读日志不是命令：agent 直接读文件。隔离不是安全边界——agent 能读所有窗口目录。

### 数据格式

- **文件名**：以 6 位**日志编号**开头，后面是语义（请求是方法和 endpoint 名，页面是路径）。编号全局唯一、递增；只知道编号时 `ls ~/.speedrun/*-windows/*/requests/001203-*` 只会命中一个。观察输出里的文件名是相对窗口目录的。
- **文件头**：`@description` `@status draft|verified|blocked` `@endpoint`（action，可多行）`@param` `@returns` `@write` `@timeout` `@note`。名字全局唯一（action 和 compose 共用），先在 `~/.speedrun/action/` 的各站点里找，再找 `~/.speedrun/compose/`。
- **站点**是页面的 host，去掉前导 `www.`（非默认端口带上，目录名里 `:` 变 `_`）：`app.example.com`、`docs.google.com`、`x.com`。请求属于**发出请求的页面**的站点，不是请求地址的站点：`x.com` 页面调 `api.x.com` 记在 `x.com` 里。

**timeline 一行**（JSON）：

| 字段 | 含义 |
|---|---|
| `seq` `t` `win` `site` `tab` | 编号、毫秒时间戳、窗口（debug 窗口 id 或 run 名字）、站点、标签页 |
| `src` | `agent`（speedrun 的操作，以及 agent 窗口里页面脚本触发的请求和导航） |
| `type` | `request` `nav` `cmd` `doc` `snap`（`kind: a11y` 是 `read_page` 存下的 a11y 树）`tab` |
| cmd | `kind`（navigate、request、left_click、hover、type、key、scroll、scroll_to、form_input、left_click_drag、screenshot、zoom、eval……）、`target`（如 `ref_12`、`{"role":"button","name":"赞同"}`、`(410,421)`）、`ok` `error` `detail`（`request` 命令的 `detail.endpoint` 是它发的 endpoint；输入命令的 `detail.loc` 是落点元素的持久定位） |
| request | `requestType`（fetch / xhr）、`method` `url`（不含参数）`status` `size`、`endpoint`（`方法 路径`，就是 `@endpoint` 的写法）、`file`（请求文件，相对窗口目录）、`noise: 1`（埋点广告，默认别看） |
| 因果 | `cause`：引发这个请求的命令的 `seq`（同一标签页 2 秒内最近一次 agent 命令）；`causeDt`：相隔毫秒；`phase`：`load`（页面或单页路由刚开始的几秒）、`cmd`（命令引发）、`idle`（轮询等） |

**请求文件**：`method`，`url{bareUrl, query}`（查询参数已解析），`frameUrl`，`headers`，`requestBody`（JSON 和表单已解析成对象），`status`，`responseHeaders`，`responseBodyPath`（相对窗口目录），`startedAt` `endedAt`；speedrun 另加 `seq` `win` `endpoint` `requestType` `tab` `rid` `cause` `causeDt` `phase`，失败的有 `error`，被截断的有 `truncated`，没存响应体的有 `bodyOmitted`（原因：`noise` `cross-site` `large-error` `no-body` `error`）。**token、Cookie、密码是别名 `⟨secret_…⟩`**，真值只在 daemon 内存里，agent 拿不到。

**endpoints.json**：`{ site, updatedAt, endpoints: [{ key, method, host, name, count, firstSeq, lastSeq, lastStatus, cmdTriggered, onLoad, idle, lastCause, variables, shape, headers, samples, action }] }`。只由 debug 窗口的记录累积。`key` 是 `方法 路径`；`cmdTriggered` / `onLoad` / `idle` 按 `phase` 统计；`variables` 是能改的参数，`shape` 是响应结构；`samples` 是最近 5 次成功请求（`file`、`body` 相对 `~/.speedrun`，`available` 为假表示文件已被淘汰）；`action` 是覆盖它的 action 名（多行 `@endpoint` 每一行都算）；`headers` 是请求头的信号（debug 窗口观察时算的最近一次）：头名 → `{ kind, source? }`，`kind` 是值在这个窗口的同站请求里怎么变（`page` 页面级不变、`endpoint` 按 endpoint 不变、`varies` 每次都变、`few` 样本太少），`source` 是它在页面里的位置（`cookie:_xsrf`、`local:…`，给 `request` 的 `auth` 用）；只有名字和类别，没有值，只给 agent 读，run 不读；不排序，由你筛。文件可能比日志晚两秒，要最新就读时间线。


**页面函数**（`debug/page-api.ts`）：debug 窗口打开、跳转、第一次操作后快照页面自己的全局对象，写 `page-api/`，累积进 `action/<站点>/page-api.json`（只由 debug 窗口写，run 不读）。只记名字、类型和结构，不记值，不调用 getter；每个顶层对象单独限额，广度优先。`inspect --path` 补更深的对象，路径上的 getter 会读（agent 明确要看的）。`trace` 临时包住指定函数，详情脱敏后写 `calls/`，站点文件只存结构。

**WebSocket、事件流**：一条连接一个 `sockets/<编号>-<地址>.jsonl`（脱敏，单条 64KB、每条连接 5MB 上限），时间线只有 `socket` 摘要行（累计消息数，最快 2 秒一行，观察前补齐）。原文只在内存里交给 `waitMessage`。不提供重放 WebSocket 写入。

**观察的取舍**：默认只给结论和线索，列出的请求最多 6 个，放不下时按相关性排（`explore.ts` 的 `relevance`：这一步引发的、内容对得上的靠前，配置和上报靠后），其余折叠成数量，不丢。比较内容用真值，只输出结果。

## 7. 执行

- **speedrun 窗口**（`browser/window.ts`）：不是单独的 Chrome 窗口，而是用户窗口里 speedrun 的一个**标签组**（一个 debug 窗口或一次 run 一个组，始终折叠；标题都是 `speedrun`，debug 组蓝色、run 组灰色）。组建在用户最近用的普通窗口里，没有普通窗口时才开一个不抢焦点的窗口。speedrun 从不选中自己的标签页：新标签页先开成 `chrome://newtab/`（Tab Activate 这类把新标签页切到前台的扩展会跳过它），进组、附着调试器后再导航；刚开的标签页万一被别的扩展选中，扩展把选中还给用户之前的标签页。组内标签页按 origin 池化，保证请求和页面同源。窗口名到组号的映射只在内存里：daemon 重启后留下的组都是孤儿，第一次用时全部关掉（`closeAllGroups`，也按标题 `speedrun` 认出浏览器重启后恢复的组）。
- **RunHost**（`browser/host.ts`）：action 的每个操作都在这里执行并写一行 `cmd`。三种实现方式按顺序选：`request` > `waitRequest` > DOM。
  - `request` 的请求头按顺序凑齐，尽量继承复用：① 浏览器自己带的（cookie）；② 从这次窗口里页面发过的同站请求抄（`copyHeaders`）：页面发过同一个 endpoint 就整组抄它最近一次的，否则按 `record/headers.ts` 的 `headerKinds` 只抄页面级不变的头，每次都变、按 endpoint 变的不跨 endpoint 抄，和它们同一族的（名字去掉最后一段相同，如 `x-zse-93` 和 `x-zse-96`）也不抄：只带签名族的一半会被拒；这次窗口里还没有同站请求就等 1.5 秒；③ `auth` 声明的页面固定位置（cookie、localStorage、sessionStorage、meta），发送时在页面里现读；④ 前序请求的值由 action 代码写进 `headers`；`headers` 显式写的最后覆盖。cmd 行的 `detail` 记下抄自哪些 endpoint、抄了和没抄的头名。被 401/403 拒时，run 的 `hint` 写清楚抄了什么、没抄什么、下一步（`takeRejected`）。和当前页面同 origin、或者当前页面在这次窗口里自己往那个 origin 发过请求的，在当前页面上发；否则在请求自己的 origin 上开页面发（只看注册域名不够：a.example.com 和 b.example.com 同是 example.com，互不放行跨域）。
  - `waitRequest` 等页面自己发出的第一个匹配请求，签名由页面算。
  - **等待**只有四种，都有明确的结束条件和上限（`utils/constants.ts`）：① 页面可用：`navigate` 等到 `readyState` 是 interactive（`GOTO_WAIT_MS`，不等被墙的子资源）；② 页面安静 + 记录送达（`quiet`，`QUIET_MAX_MS` 2 秒）：页面没有在途请求、DOM 400ms 没变（`executor.js` 的 `quiet`），并且页面报告的最后一个消息序号已经到了 daemon（`ingest.ts` 的 `waitDelivered`）；debug 每步之后、第一次 `navigate`、`request` 抄头前（刚 `navigate` 过、这次窗口还没有同站请求时）默认等，SDK 的 `navigate` / 操作带 `{ settle: true }` 时等；③ 等某个请求：`waitRequest`（`WAIT_REQUEST_MS`）；④ 等某个元素：操作先找元素、`waitFor`（10 秒）。单步 `STEP_TIMEOUT_MS`、整个 action `ACTION_TIMEOUT_MS` 是兜底。没有固定时长的等待。
- **ActionRunner**（`run/runner.ts`）：action 在 worker 线程里跑，SDK（`action-lib/index.js`，daemon 每次启动整个覆盖到 `~/.speedrun/lib`，保证和 daemon 同一个版本）的每个函数是向 daemon 发一个操作，不用传 page；action 和 compose 文件是 `export default async ({ 参数 }) => 结果`（`run/worker.ts` 调用它），`import … from "spr"`，`~/.speedrun/node_modules/spr` 链到 `lib/`；agent 自己的纯函数在 `~/.speedrun/helpers/`，只在不存在时建目录，从不覆盖；compose 跑的时候写成旁边的临时文件 `.run-*.mjs`（见 §2.2）。整体超时 115 秒（`@timeout` 可改）。最外层 compose 失败时输出带 `failedAction`、`page`（URL、标题、截图），像登录失效时带 `hint`。
- **debug 的工具**（`commands/debug.ts`）：和 Claude in Chrome 同名、同参数、同语义：`read_page`、`find`、`get_page_text`（只看不动：不计次数、不附带观察；`read_page` 的全文存进 `pages/<编号>-a11y.txt`）、`computer`（`parseComputer`：坐标或 `--ref`）、`form_input`、`navigate`，加 speedrun 自有的 `inspect`、`trace`。输入（`RunHost.input`）先在页面里把目标换成坐标（`a11y.js` 的 `point`），再由扩展用 CDP 发，输出 `落在：`、`被遮挡：`、`定位：`、提醒；`form_input` 的文本框是点一下 → 全选 → 删除 → `insertText`，复选框状态不对就点，下拉框在页面里直接设值（原生下拉的选项 CDP 点不到），最后核对值。action 的 SDK 走同一个 `RunHost.input`，只是目标是持久定位。工具只用来触发页面行为、让 speedrun 录到请求；每条输出末行复述目标，代替分散的提醒。
- **原始请求**（`record/raw.ts`）：含真值，只在 daemon 内存里，**绝不落盘**，daemon 重启就没了。
- **请求头的信号**（`debug/observe.ts`、`record/auth.ts`、`record/headers.ts`）：观察里每个带非浏览器头的请求有一行「请求头」：按头名统计这个窗口里同站请求的真值怎么变（只在同一次页面加载里比），再拿真值和页面此刻的 cookie、localStorage、sessionStorage、meta 比对出位置；只输出、只记类别和位置（`endpoints.json` 的 `headers`），不记值。

## 8. 存储与安装

- 用户数据：`~/.speedrun/debug-windows`、`~/.speedrun/run-windows`（日志）、`~/.speedrun/action`（`endpoints.json`、action 文件、`.seq`）、`~/.speedrun/compose`、`~/.speedrun/helpers`、`~/.speedrun/alias-salt`；speedrun 维护的 `~/.speedrun/lib`、`~/.speedrun/adblock-engine.bin`（adblock 规则的缓存）；运行时状态 `~/.speedrun/session`；运行时代码 `~/.speedrun/src`。
- `setup.js` 把 skill 目录镜像到 `~/.speedrun`（只排除 `node_modules`、`.DS_Store`；本机数据目录不碰）、装依赖、注册 native host、生成命令、`build` 不同时让旧 daemon 退出（扩展重连时拉起新代码）、运行 `doctor`。
- 版本：`~/.speedrun/src/.version` 的 `build`；只有 `setup.js` 发现 `build` 不同、或用户 `spr daemon restart` 时才换代码。`spr doctor` 只读。

## 9. 排障

先运行 `~/.speedrun/bin/spr doctor`（`--json` 得到机器可读结果），失败项带修复命令。安装类的问题（Node、依赖、native host、加载扩展）见 `install.md`。下面是运行时的问题，都可以读源码定位并直接修复；直接改 `~/.speedrun/src` 是临时修复，下次升级会覆盖。

| 现象 | 处理 |
|---|---|
| `extension-abi` 不对，或"扩展是旧版本" | 扩展会自己重新加载（跑一次 `spr tabs` 触发，等几秒再试）；仍不行在 `chrome://extensions` 里刷新 speedrun |
| 「连不上这个标签页的调试接口」 | 这个 speedrun 标签页开着 DevTools（或别的调试器），关掉后重试；用户点掉了「正在调试此浏览器」提示条的，下一次操作会自动重新附着 |
| 「被遮挡：…」 | 点击落在了盖在目标上面的元素（弹窗、遮罩、吸顶栏）上：先关掉它，或换一个没被盖住的目标 |
| 「ref_N 找不到了」 | 页面跳转或元素被移除，ref 失效：重新 `find` / `read_page` |
| `need-extension` | 请用户确认 Chrome 里的 speedrun 扩展开着，点一下工具栏图标；从没加载过的属于安装问题 |
| `need-install` | speedrun 没装好或 native host 丢了：告诉用户需要重新安装 speedrun |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，扩展 1 秒后重连、Chrome 拉起新的 relay；等几秒，仍不行看 `doctor` 的 `launcher-node`，再不行重启 Chrome |
| `launcher-node` 失败 | 启动脚本里写死的 node 不在了（nvm 换了版本），relay 起不来：重新运行 `setup.js` |
| 升级后旧 daemon 还在跑 | `spr daemon restart`（只让它退出，下一条命令拉起新的） |
| 命令一直等着不返回 | daemon 在忙（或被暂停）；不要删 `session/sock`，删了旧 daemon 会在 2 秒内退出、内存里的状态就没了。真卡死了用 `spr daemon restart` |
| `run` 的请求被 401/403 拒 | 失败的「下一步」写了抄了什么、没抄什么：登录失效就请用户登录；页面这次没发带某个头的请求，action 要先 `navigate` 会发它的页面，或照 debug 窗口观察「请求头」给的位置写 `auth`；每次都变的头被拒，改用 `waitRequest` 或 DOM |
| debug 操作说"窗口没开" | 窗口之前关了（`close`、空闲 30 分钟、daemon 重启、扩展重连、用户关了组）或没打开过：`spr debug <compose> navigate <要的页面>` 重新打开并复现 |
| `debug <compose> find` / `read_page` / `computer …` 报"页面里没有 speedrun 的脚本" | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| 日志里没有某个站点的事件 | 只录 speedrun 组里的标签页：组外的浏览不会有记录，要用 `debug <compose> navigate` 在 debug 窗口里重新打开（或把那个标签页拖进 speedrun 的组）；看对应窗口目录里的 `timeline.jsonl`，按 `site` 字段筛 |
| 磁盘上 `~/.speedrun/debug-windows` 太大 | 按额度自动淘汰（`spr status` 看占用）；要手动清就删关掉的旧窗口目录，别删 `action/*/` |

- 运行时日志：`~/.speedrun/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <daemon pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。
