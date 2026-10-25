# ARCHITECTURE

TabBot 的目标、角色分工和运行时架构。agent 怎么用见 `SKILL.md`；仓库边界、开发验证、分发发布见 `AGENTS.md`；安装见 `install.md`。

## 1. 目标

- **只有两种方向**：人做一半交接给 agent 继续；或 agent 自己单独做。没有 agent→人，没有人抢占，没有租约。
- **录制的用途，按优先级**：① 拿到接口信息，用接口大幅提速；② 给任务提供上下文（用户最近做了什么）；③ 接口无法重放时，给 DOM 操作提供依据（持久定位、该步触发了哪个请求）。
- **绝对原则：以接口请求为粒度，每个接口都沉淀成 task，不重复探索。** 有请求就用请求；没有请求才用 DOM，也写成 task。一份 task 只覆盖一个请求。批量的事（点 10 个赞、取 30 条回答）用 task 循环，本来就是这一次最快的做法。
- agent 干活在单独的 `tabbot agent` 窗口里，不打扰用户的窗口和标签页。

## 2. 角色：主 agent 和 subagent

「调试」「执行」是产品的两个词：**调试**是 subagent 在自己的 agent 窗口里摸清接口和定位；**执行**只有 `tabbot run`——用户拿到的结果必须来自 task 的返回值。

- **主 agent**：唯一目标是完成用户任务。**没有调试权限**。能用：`task`（列出）、`run`、`compose`（只组合 task）、`delegate`、`api`、`context`、`log`、`sql`、`req`（读日志）、`status`、`tabs`、`doctor`。缺哪个能力，就为它派一个 subagent；独立的并行派。subagent 回报后，主 agent 综合回报和 task 的执行结果，向用户汇报，汇报前对照 `tabbot log --src agent` 核对 subagent 说的和做的。
- **subagent**：每个只有一个目标——「调试，然后写出 `<task 名>`」。有完整权力：`tabbot debug --ticket <票据> open|snapshot|text|act|close|replay`，**包括真正发起有副作用的操作**（学习需要真的发一次才知道成败；只做学习必需的最少次数，批量留给主 agent）。产出是一份 task 加一份回报：task 名、参数、`@endpoint`、验证结果、**副作用清单**（做过什么、对象 id、日志编号）、遗留问题。

**为什么这样区分**（写在 `tabbot delegate` 生成的 brief 和 `SKILL.md` 里，让 agent 明白原因，才不会想绕）：
1. 速度：调试慢，按 task 执行只要毫秒。混在一起，agent 会一直调试，永远用不上 task。
2. 目标不同：主 agent 要把结果交给用户，subagent 要把 task 写对。同一个 agent 背两个目标，会倾向于“先把眼前的做出来”，task 就被省掉。
3. 上下文干净：试错、失败的尝试、响应原文只留在 subagent 那里。
4. 可并行：独立的 task 同时让几个 subagent 调试。
5. 边界在工具里：主 agent 没有调试权限，不是约定而是做不到；想学新东西只能派 subagent，所以探索必然产出 task。
6. 事后可核对：subagent 的每个动作都在日志里。

**强制机制（全在 TabBot 内，不依赖 harness）**
1. `tabbot delegate <task 名> --goal "…" [--site 站点] [--fix]` 是派 subagent 的唯一入口：发一张**票据**（ticket，绑定 task 名和一个 agent 窗口，只在 holder 内存里），输出自包含的 brief（目标、票据、SDK 用法、写 task 的规则、副作用边界、回报格式）。
2. `tabbot debug` 必须带 `--ticket`：没有、不存在、已交付、用完 80 次操作，一律拒绝并说明。同一站点最多 2 张未交付的票据。
3. `compose` 只能 `task(名字, 参数)` 组合 task：compose 自己的会话被标为 compose-only，任何页面操作（包括 `import` SDK 后调用）都被 host 拒绝。
4. `run` 真跑成功一次，task 头里的 `@status: draft` 自动变 `verified`；`--dry` 让非 GET 的 `request` 不真发，只打印将发送的内容（subagent 迭代用）。subagent 带票据 `run` 自己那份 task 成功，票据结束，窗口关掉。
5. task 头写 `@endpoint 方法 接口名`（和 `tabbot api` 输出的一致）：`api <站点>` 把已有 task 覆盖的接口标 `task:<名字>` 并排后面，**没有 task 的排前面**——主 agent 靠它决定派哪些 subagent。`req show` 输出可粘贴的 `request(...)` 代码和 `@endpoint` 行。`debug act` 成功后输出持久定位和它引发的非 GET 请求，提示“有请求就改用请求”。

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
| holder | agent 窗口与 task 运行时、重放、查询与渲染、脱敏、写日志、原始请求的内存表、别名对照表、票据 | `src/holder.ts`、`src/journal/`、`src/run/` |

| 进程 | 谁拉起 | 状态 | 生命周期 |
|---|---|---|---|
| relay | Chrome（native messaging host） | 无 | 任一端断开即退出，Chrome 下次连接时重新拉起 |
| holder（daemon） | relay 或 CLI（socket 连不上时 detached 拉起） | 扩展链路、agent 窗口、票据、原始请求、日志写入 | 不随 relay 断开退出；没有扩展连接、也没有命令请求超过 10 分钟才退出 |
| 扩展 | Chrome | 无 | service worker 可随时重启 |

- 命令入口：`src/cli/tabbot.ts` 没有命令逻辑，`tabbot <argv>` 原样发给 holder 的 `run` RPC，holder 调 `journal/commands.ts` 的 `runCommand`，返回 `{ stdout, code }`。holder 不在时 CLI 会拉起它（读历史日志不应该依赖 Chrome 开着），存活判据只有一条：socket 能不能回 `ping`。socket 权限 0600，连接按 UTF-8 解码。
- 要经扩展的命令先 `ensureExtension`：没装 host → `need-install`；Chrome 没运行 → `need-chrome`；等不到扩展 → `need-extension`；扩展 ABI 不对 → 明确让用户刷新扩展。读日志的命令不需要扩展。
- 所有命令失败时 stdout 都带 `status`：`{ status: "failure", error }`，握手类为 `{ status, guide }`，退出码非零；`run`/`compose` 输出 `{ mode, status, result | error }` 的 JSON。
- relay 断开（刷新扩展、service worker 重启、Chrome 重启）是日常事件，holder 只 `detach` 链路，日志照写。

## 4. 扩展

`src/chrome-extension/background.js` 没有业务逻辑。页面脚本是扩展包里的**静态内容脚本**（`page/`）：`common.js`、`recorder.js`、`executor.js` 在 MAIN world，`bridge.js` 在隔离世界；已打开的页面在握手后由 `injectExisting` 补注入。权限：`tabs`、`nativeMessaging`、`alarms`、`scripting`，`host_permissions: <all_urls>`，`minimum_chrome_version` 135。不依赖 `chrome.userScripts`。

- **ABI 2**（`browser/extension.ts`）：`call { tabId, fn, args }`（在页面 MAIN world 调 `window.__tcr.exec[fn](...args)` 并取回结果；函数集合固定，不执行任意字符串，严格 CSP 的页面也能用；任意函数 `exec.eval` 是兜底）；`tabs`（http/https 页面加 anchor 页）；`goto { tabId, url, wait }`；`openWindow { anchor }`（不抢焦点）、`openTab`、`activateTab`、`closeTab`、`closeWindow`。帧是 4 字节小端长度加 UTF-8 JSON；只支持一个扩展连接，新的合法 `hello` 替换旧连接。只有改 ABI 才加版本号，用户才需要刷新扩展，`doctor` 的 `extension-abi` 提示。
- 页面消息通道：页面脚本 `window.postMessage`，`bridge.js` 收到后 `chrome.runtime.sendMessage`，扩展补上 tab、frame 后转给 holder。页面自己的脚本也能发，所以日志只是观察记录，不能当权限依据。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒；点击工具栏图标立即重连。
- 图标源文件是 `scripts/dev/icons/icon.svg`，改动后运行 `node scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机 Chrome）。

## 5. 页面脚本

- `common.js`：命名空间 `window.__tcr`、限流的 `post`、前台判断、元素描述与快照、稳定的元素引用 `@e12`、DOM 变化计数、原始 `fetch`。
- `recorder.js`（录制）：只录三种请求——HTML 文档、XHR、fetch（不录 WebSocket、`sendBeacon`、Worker）；用户输入（点击、输入长度、特殊键、滚动）；导航；页面快照；主文档渲染后的 DOM。响应体不设策略上限，不读事件流，读到 16MiB 就停并标 `truncated`。后台页面只计数。
- `executor.js`（执行）：`window.__tcr.exec` 下的 `act`（click / fill / select / check / press / scroll，全是 DOM 事件）、`snapshot`、`text`、`replay`、`waitFor`、`query`（声明式取数）、`eval`。`act` 的目标可以是 `@e12` 引用或持久定位 `loc`（CSS、`{role,name}`、`{text}`，可加 `nth`，元素没出现会等到超时），成功后返回元素的持久定位。点击先滚到视图中央并聚焦，再发 pointer / mouse 序列和 `click`；`fill` 用原生 `value` setter 加 `input`、`change` 事件；等页面稳定：没有在途请求且 DOM 静默 400ms，最多 4 秒。不支持：文件选择框、iframe 里的元素、`closed shadow root`。
- **录制与执行解耦**：录制如实反映浏览器状态，无论是谁造成的；执行只管执行，两者之间没有共享状态。来源只看 `isTrusted`：真是 `human`，假是 `page`；agent 窗口里发生的一切由 holder 记为 `agent`（`Ingestor.isAgentTab`），不混进“用户做了什么”。`human` 是交接的上下文：`context` 里分开列。

## 6. 日志（journal）

- **分段队列**（`journal/store.ts`）：`~/.tabbot/journal/seg-<序号>/{events.db, bodies/, snapshots/}`。只往最新一段写；写满 50MB 就新开一段，新开时检查总量，超过 500MB 就整段删除最旧的分段（先进先出，和时间无关）。`seq` 全局递增。同一个响应体按内容哈希去重（分段内）。`node:sqlite` 在 Node 24 里是实验性的，`journal/sqlite.ts` 动态加载并过滤这条警告。只有 holder 读写日志目录。
- **事件**（`journal/ingest.ts`）：`input`、`cmd`（agent 的命令记录：动作类型、目标、持久定位、结果）、`net`、`doc`（主文档渲染后的 HTML）、`nav`、`snap`、`tab`、`bg`。请求的 `cause` 指向 2 秒内最近一次人的事件或 agent 命令。`tabbot log` 不隐藏任何一类。
- **过滤**（`filter.ts`）：`@ghostery/adblocker` 规则加第一方埋点启发式（只对非 GET）标 `noise`，默认隐藏；同一个请求（方法 + 地址 + 响应内容哈希）5 分钟内重复只给上一行 `dup` 加一；失败的请求只留小于 4KB 的响应体。
- **脱敏**（`sanitize.ts`）：带单词边界的正则（`token`、`secret`、`password`、`csrf`、`jwt`、`auth` 等）加严格的 JWT 判断，只作用于请求头名、URL 查询参数名、JSON 的 key；响应体正文原样写盘。秘密换成别名 `⟨secret_<12 位十六进制>:<形状>⟩`：盐 + 真值的 HMAC（盐在 `~/.tabbot/journal/alias-salt`，0600），同一个秘密永远是同一个别名。**别名 → 真值的对照表只在 holder 内存里**。
- **整理成可用的材料**（`journal/digest.ts`，纯函数）：`context` 按站点分组，给出访问的页面、用户自己的操作、**操作引发的请求**（用 `cause` 配对，如 `human click button[Like] → POST graphql FavoriteTweet`）、agent 的命令；`api <站点>` 按“方法 + 接口名”分组（GraphQL 取操作名，其它路径把长数字、哈希、uuid 换成 `:id`），每组给次数、最近一次的编号、请求变量、触发它的用户操作、响应结构、原始请求还在不在内存里（能不能直接重放）、task 覆盖情况。
- 默认录所有 http/https 站点，没有排除列表；HTML 文档原样存，不为敏感内容做额外保护（产品还在做，先把产品做好）。

## 7. agent 窗口与 task

- **agent 窗口**（`run/window.ts`）：一个 key（subagent 的票据号，或 主 agent 自己的 `main`）一个窗口，所以几个 subagent 并行时各自的页面都在自己窗口的前台（浏览器不渲染后台标签页）。窗口的第一个标签页是扩展的 anchor 页（标题 `tabbot agent`）。其余标签页按站点（origin）池化：`acquire(origin, key)` 复用同站点空闲标签页，没有就开 `origin/robots.txt`（很轻，页面脚本就位）；用完还回去，空闲 5 分钟关闭；票据结束时整个窗口关掉。key 到窗口的映射只在内存里：holder 重启后留下的窗口是孤儿，第一个当 `main` 接管，其余关掉。用户关了窗口会自动重开。
- **RunHost**（`run/host.ts`）：goto、request、act、waitFor、text、snapshot、query、eval，每个都写一行 `cmd` 记录。`request` 默认继承 holder 内存里同站点最近一个带身份头（authorization、csrf、x-*）的原始请求的请求头。
- **TaskRunner**（`run/runner.ts`）：task 脚本在 worker 线程里运行（`task-lib/index.js` 同步到 `~/.tabbot/task/lib`），SDK 的每个函数是向 holder 发一个操作；同一个 key 一次只跑一个，不同 key 可以同时跑；整体超时 115 秒（`@timeout` 可改）；`tabbot.task()` 嵌套调用共用页面状态；运行历史在 `~/.tabbot/run/<task>/`。
- task 是 `~/.tabbot/task/<名字>.js`：文件头 `@summary`、`@status: draft|verified`、`@endpoint`、`@param 名字? 说明`、`@timeout`。参数一律具名 `--名字 值`，缺必填或传了没声明的参数直接报错。

### 重放（req / replay）

- **原始请求只在 holder 内存里**（`journal/raw.ts`）：页面里发的每个同站请求的方法、地址、请求头、请求体，上限 50MB、单条 64KB，先丢最旧的；**绝不落盘**。
- `tabbot debug replay <编号> [--set ...] [--yes]`：取原始内容 → 把 `--set` 里的别名换回真值 → `applySets`（`journal/replay-core.ts`）→ 在 subagent 的 agent 窗口里和原请求同 origin 的标签页用原始 `fetch` 发出（带登录态，不会被录制端当成页面自己发的）→ 响应脱敏后记一行 `agent replay`。
- **`--set`**：`名字=值` 改查询参数；`名字.路径=值` 改查询参数里 JSON 的字段（GraphQL 的 GET 请求 `variables.cursor=xxx`，翻页用）；`header.名字=值` 改请求头；`body.路径=值` 改 JSON 或表单请求体；`body=内容` 整个换掉。非 GET 要 `--yes`；浏览器自己管的请求头去掉。
- `req find` 在保留的响应体和 HTML 里找页面上看到的值；`req show` 把日志里的一行还原成请求，给出风险提示（签名类参数、非 GET）和可粘贴的 task 代码。

## 8. 存储与安装

- 用户数据：`~/.tabbot/journal`（日志）、`~/.tabbot/task`（task 和 SDK）、`~/.tabbot/run`（运行历史）；运行时状态 `~/.tabbot/session`；运行时代码 `~/.tabbot/src`。
- `setup.js` 把 skill 目录镜像到 `~/.tabbot`、安装依赖、写版本文件、注册 native host、生成 shim、让过期的 daemon 换成新代码、运行 `doctor`。分发是源码镜像：`~/.tabbot` 是 `skills/tabbot/` 的逐字节拷贝，只排除 `node_modules` 和 `.DS_Store`（`store/deploy.ts`）；顶层的 `src`、`scripts` 先清空再拷，`journal`、`task`、`run`、`session`、`bin` 是本机数据，镜像不碰。
- 版本：`~/.tabbot/src/.version` 写 `{ build }`（只算运行时文件，排除自检）；daemon 启动时记下 `build`，`ping` 返回它。换代码只在 `setup.js` 发现 `build` 不同和用户显式 `tabbot daemon restart` 时发生，没有命令会自动重启 daemon。
- `tabbot doctor` 只读。

## 9. 测试

`npm test`（几秒，纯逻辑，不依赖 Chrome）：脱敏与别名、`--set`、日志摄入与过滤、分段队列、扩展链路分帧与握手、命令层（假的 holder 能力：票据与 `debug` 强制、`compose` 只能组合、`--dry`、自动晋升、覆盖标记）。**不模拟扩展**：扩展、页面脚本、agent 窗口、task 运行时的行为用真实 Chrome 加 Claude in Chrome 验证（见 `AGENTS.md` 2.3）。`npm run verify:pack` 只在发布前跑。

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
| `run` 报“没有可继承的请求头” | 这个站点的页面还没自己发过请求：让 subagent 先 `debug open` 站点页面，或让用户在 Chrome 里浏览一下 |
| `run` 在 agent 窗口里一直不动 | 窗口被用户关了会自动重开；同一 key 里另一个 task 在跑会等 30 秒再失败 |
| `debug` 报“主 agent 没有调试权限” | 这是设计：用 `tabbot delegate` 派 subagent；票据失效（holder 重启）也由 主 agent 重新派 |
| `debug snapshot`、`act` 报“页面里没有 TabBot 的脚本” | 页面是 `chrome://` 之类的，或是在扩展加载之前打开的：刷新这个页面 |
| `replay` 报“原始内容已经不在 holder 的内存里”或“别名已失效” | holder 重启过或太旧被清掉；在页面上再触发一次这个操作，然后重试 |
| 日志里没有某个站点的事件 | 后台标签页只记导航和请求数；先看 `tabbot doctor` 里 `extension` 项 |

- 运行时日志：`~/.tabbot/session/log.jsonl`。
- 进入运行中的 daemon：`kill -USR1 <holder pid>` 用 Node inspector 连入（会看到内存里的 token 真值）。

## 11. 未做的事

- 并行调试时窗口被其它窗口完全遮住：Chrome 可能停掉 `requestAnimationFrame` 和 `IntersectionObserver`（和 X 时间线不加载同类）。请求版 task 不受影响，只有 DOM 兜底的受影响。需要在真实有头 Chrome 里实测，无头环境测不了；实测结果决定窗口怎么摆（露出一角、并排小窗）。
- 用 Claude Code 的 PreToolUse hook 对非 subagent 调用的 `tabbot debug*` 硬拒绝：要先确认 hook 输入里能区分主 agent 和 subagent；目前只靠票据校验。
- 回执（`run` 返回回执编号，Stop hook 检查最终回复引用了它）。
- 签名类请求头（如知乎 `x-zse-96`）的重放：现在是原样带旧签名，多数站点不拒绝；被拒时改用 DOM。
- 响应数据太大时怎么给 agent；重放响应“只取某个 JSON 字段”。
- adblock 规则缓存到磁盘（现在每次 daemon 启动都联网下载）。
- 站点兼容性：流式响应、`Request` 对象、页面检测 `fetch.toString()`、反调试。
- 产品化：域名、商标、版本号和发布。
