# 计划：第一阶段 daemon 的启动和退出收成 8 条规则（方案 B）；第二阶段简化 CLI

> 第一阶段是 §0–§6，第二阶段是 §7。两个阶段分开提交，第二阶段在第一阶段验证完之后再做。

> 目标：**daemon 独立于 Chrome 常驻，进程之间只靠一个 socket，谁也不误删别人的 socket，任何一个进程死了都能自己恢复。**
> 上一份计划（标签组）已完成并合进 main（`1f91240`），原文在 git 历史里。
> 背景：2026-11-04 对 CLI 层和启动流程的 review；参考了 OCIC（`/Users/me/Code/x/open-claude-in-chrome/host/endpoint.js`、`native-host.js`）。
> 不选「native host 直接当 daemon」：Chrome 退出、扩展刷新都会让 daemon 死掉，内存里的状态没法收尾。

## 0. 结论先行

保留独立的 daemon，按下面 8 条收紧：

1. **只有一个 socket**：daemon 只监听 `~/.habit/session/sock`。relay 和 CLI 都是客户端，连上后第一行说明角色：`{"role":"relay"}` / `{"role":"cli"}`。去掉 `ext.sock`。
2. **只有一个函数负责拉起 daemon**：CLI 和 relay 共用同一个 `ensureDaemon()`。它先 connect；连不上就 spawn 一个 detached 的 daemon，再轮询 connect 直到连上（最多 10 秒）。
3. **daemon 能不能当上，看能不能 listen**：listen 成功就是唯一的 daemon。遇到 EADDRINUSE 就 connect 一下：连得上说明对方活着，自己退出；被拒绝说明是残留文件，删掉后再 listen 一次。
4. **只有 daemon 自己能删 socket 文件**，并且只在 connect 被拒绝时删。CLI、relay、`setup.js` 都不删。超时只说明对方忙，不说明它死了。
5. **socket 文件被换掉了，daemon 就自己退出**：daemon 记住自己 listen 后 socket 文件的 inode，每 2 秒 `stat` 一次。文件没了或者 inode 变了，就 flush 后退出。这条兜住所有「两个 daemon 并存」的情况，不需要锁文件。
6. **daemon 只在三种情况下退出**：① 扩展没连着，并且 10 分钟没有任何命令；② 收到 SIGTERM；③ 第 5 条。三种都走同一个 `shutdown`：先 flush，再删 socket 文件，并且只在 inode 还是自己的时候才删。
7. **重启就是杀掉，不等新的起来**：`setup.js` 和 `habit daemon restart` 只做两件事：发 SIGTERM，然后等到 socket connect 不上为止。新 daemon 由下一个来连接的 relay 或 CLI 按第 2 条拉起。
8. **扩展重连用固定间隔**：1 秒一次，加 alarm 兜底。

## 1. 现在的问题（这次都要解决）

| 问题 | 位置 | 由哪条解决 |
|---|---|---|
| CLI ping 超时（daemon 只是忙）就删 socket 文件。删掉后新 daemon 抢不到 `ext.sock` 会自己退出，旧 daemon 又没人能连上，而且永远不会闲置退出，habit 整个不可用 | `src/cli/session.ts` 的 `ensureDaemon` | 2、4、5 |
| relay 和 CLI 各写了一套拉起 daemon 的逻辑，等待时间也不一样（15 秒和 8 秒） | `src/native-messaging-host/relay.ts`、`src/cli/session.ts` | 2 |
| 两个 socket 要分别抢占，失败时还要处理半成功的情况 | `src/daemon.ts` 的 `runDaemon` | 1、3 |
| 扩展重连的指数退避不起作用：`connectNative` 同步返回后就把 `retryCount` 清零了，所以永远是 1 秒 | `src/chrome-extension/background.js` 的 `connect` | 8（改成明确的固定 1 秒） |
| `restartDaemon` 要等新 daemon 连上扩展，扩展没连着时又是另一套行为 | `src/cli/session.ts` | 7 |

## 2. 各种情况下会发生什么（改完以后）

| 情况 | 结果 |
|---|---|
| Chrome 退出 | relay 退出；daemon 只 `detach` 掉扩展链路，状态都在。10 分钟后 Chrome 还没回来才退出 |
| 扩展刷新、service worker 被停掉 | relay 退出；扩展 1 秒后重连，Chrome 拉起新的 relay，连回同一个 daemon，状态都在 |
| relay 和 CLI 同时拉起 daemon | 第 3 条保证只有一个 listen 成功，另一个退出；极端竞争下由第 5 条兜底 |
| daemon 崩溃（`kill -9`） | socket 文件留下来。下一次连接时 connect 被拒绝，于是拉起新 daemon；新 daemon 按第 3 条删掉残留文件。内存状态丢失（任何方案都避免不了），落盘的数据不受影响 |
| daemon 卡住几秒 | CLI 一直等（命令本身的 10 分钟超时不变），不删 socket 文件、不拉起新的 |
| 升级（`setup.js`） | SIGTERM → flush 后退出 → 扩展重连时 relay 拉起新代码 → 握手时发现扩展旧了就 reload |
| launcher 里的 node 不在了 | relay 起不来，扩展每秒重试一次；`doctor` 指出原因（§3.6） |

## 3. 设计

### 3.1 新模块 `src/session/server.ts`：只管 socket 的所有权

daemon 用它；它不依赖 daemon 的其它部分，可以单独做自检。

- `listenOwned(sock, onConn): Promise<Owned | null>`：实现第 3 条。listen 成功后 `chmod 0600`、记下 inode。返回 null 表示已经有活的 daemon。
- `Owned.watch(onLost)`：实现第 5 条。每 2 秒 `stat` 一次，文件不在或者 inode 不对就调 `onLost`。Windows 的 named pipe 不是文件，跳过这一步：pipe 跟着进程消失，本来就没有残留和并存的问题。
- `Owned.release()`：实现第 6 条的收尾，inode 还是自己的才删文件。
- 判断「活着」只用 connect，500ms 超时。connect 在内核层就能完成，对方事件循环卡住也连得上，所以不会误判。

### 3.2 `src/session/client.ts`：CLI 和 relay 共用

- `connectDaemon(role): Promise<net.Socket>`：实现第 2 条。connect 成功就写一行角色说明，返回这个 socket。connect 失败（ENOENT、ECONNREFUSED）时 spawn 一次 daemon（detached、`stdio: "ignore"`、`unref`），之后每 100ms 重试，最多 10 秒。**不删任何文件。**
- `rpc(method, params, ms)`：CLI 的一次 JSON-RPC。现在 `cli/rpc.ts` 的逻辑搬过来，前面多写一行角色说明。
- `ping(ms)`：只是查信息（`pid`、`build`、`abi`、扩展连没连着），不参与「活没活着」的判断。
- `stopDaemon(waitMs = 10_000)`：实现第 7 条。先 `ping` 拿到 pid（超时放宽到 5 秒），发 SIGTERM，然后每 100ms connect 一次，直到连不上。返回 `none`、`stopped` 或 `timeout`。
- `cli/session.ts` 和 `cli/rpc.ts` 删掉，`cli/habit.ts`、`doctor.ts`、`setup.js` 改用这个模块。

### 3.3 daemon（`src/daemon.ts`）

- 启动：`listenOwned(SESSION_SOCK, onConnection)`；返回 null 就 `exit(0)`。然后 `owned.watch(() => shutdown(0))`。日志淘汰、关闭空闲 learn 窗口这些定时任务，等第一次 inode 检查通过后才开始（§6）。
- `onConnection`：先按 Buffer 收第一行（不要 `setEncoding`，relay 后面跟的是二进制帧）。2 秒内没收到合法的角色说明就断开。
  - `role: cli` → 剩下的字节交给现在的 JSON-RPC 处理（这时才按 UTF-8 解码）。
  - `role: relay` → 剩下的字节交给现在的 `onRelay`（4 字节长度帧）。
- 新的合法 `hello` 照旧替换旧的扩展链路（现在的行为）。多个 Chrome profile 都装了扩展的情况先不处理（§3.7）。
- `shutdown`：flush → `owned.release()` → `exit`。
- 去掉：`SESSION_EXT_SOCK`、`extServer`、两次 `listenUnique`。

### 3.4 relay（`src/native-messaging-host/relay.ts`）

只剩这几步：`connectDaemon("relay")` 得到 socket，然后 stdin 接到 socket、socket 接到 stdout，任意一端断开就退出。10 秒内连不上就 `exit(1)`。自己不再写拉起逻辑。

### 3.5 扩展（`src/chrome-extension/background.js`）

- `onDisconnect` 后固定 1 秒重连，去掉 `retryCount` 和指数退避。
- daemon 和扩展之间的消息不变，ABI 不用升。扩展代码变了，`build` 不同，握手时 daemon 会让它自己重新加载，不需要用户操作。

### 3.6 `doctor`（`src/cli/doctor.ts`）

- 新增 `launcher-node` 检查：读 `nm-host.sh` 里写死的 node 路径，确认文件存在、可执行。失败时的修复命令是「运行 setup.js」。
- `daemon` 一项改成用 connect 判断在不在；`ping` 只用来补充显示 pid、扩展连没连着。
- 统计日志前先确认 `~/.habit` 存在，不再调用会 `mkdir` 的 `WindowLog.open()`（review 里发现的「doctor 不是只读」）。

### 3.7 不在本计划里

- CLI 被 Ctrl-C 或超时后，daemon 里的命令不会被取消（review 里的第 2 条，另议）。
- 用 launchd 做 socket activation（以后在 macOS 上可以考虑）。
- 多个 Chrome profile 都装了扩展时会互相踢掉对方的链路：先不处理，只用一个 profile。
- node 路径写死成 nvm 带版本号的路径：本计划只让 `doctor` 能指出来，不改写法。

## 4. 实施步骤

0. 先提交 `feat/rename-habit` 上改名的改动（目前还没提交；里面还有两处已经修好的小问题：`Output.fail` 不再丢掉出错前已经输出的内容，`habit learn list` 带多余参数时报错说清楚），再从它开一个新分支 `feat/daemon-lifecycle`。
1. 新增 `src/session/server.ts` 和自检 `server.selfcheck.ts`（见 §5.1）。
2. 新增 `src/session/client.ts`；删掉 `cli/session.ts`、`cli/rpc.ts`；改 `cli/habit.ts`、`setup.js`。
3. 改 `daemon.ts`：只有一个 socket，按第一行分流，第二个扩展的处理，`shutdown` 只删自己的文件。
4. 改 `relay.ts`。
5. 改 `background.js` 的重连。
6. 改 `doctor.ts`。
7. 删掉 `SESSION_EXT_SOCK` 常量，以及所有还提到 `ext.sock` 的地方。
8. 改文档：`ARCHITECTURE.md` §3（进程表、生命周期、这 8 条）、§4（连接）、§9（排障）；`AGENTS.md` §2.3 加上 §5.2 的故障清单；`CHANGELOG.md`。
9. 跑 `npm run check`、`npm test`，再用 `node skills/habit/setup.js` 重装，在真实 Chrome 里按 §5.2 逐条验证。

## 5. 测试

### 5.1 自检（不依赖 Chrome）

`src/session/server.selfcheck.ts`，用临时目录里的 socket 路径，只测守住正确性的几点：

- 残留文件（自己 listen 过的 socket 文件，进程退出后留下来）：`listenOwned` 删掉它，并且 listen 成功。
- 已经有活的 owner：第二个 `listenOwned` 返回 null，第一个的 socket 文件还在、inode 没变。
- 删掉文件，或者换成另一个 socket：`watch` 在 3 秒内调用 `onLost`。
- `release()`：inode 是自己的才删；文件已经被换掉时，不碰新的那个。
- `connectDaemon` 在对方卡住（模拟成 listen 了但从不回复）时不删文件。

### 5.2 真实 Chrome 里的故障清单（加进 AGENTS.md §2.3）

每一条都要能自己恢复，不需要手动操作：

| 操作 | 期望 |
|---|---|
| `kill -STOP <daemon>`，5 秒后再 `kill -CONT` | 这段时间里发的 `habit status` 会一直等，恢复后正常返回；`session/sock` 的 inode 没变；没有出现第二个 daemon |
| `kill -9 <daemon>` 后马上 `habit tabs` | 拉起新 daemon，命令成功 |
| 没有 daemon 时，同时跑 5 个 `habit status` | 都成功；最后只有一个 daemon 进程（`pgrep -f daemon.ts`） |
| `kill <relay>` | 扩展 1 秒内重连，daemon 的 pid 不变 |
| 在 `chrome://extensions` 刷新 habit | 同上；learn 句柄还在，下次操作不用从上次的 URL 重开 |
| 退出 Chrome，2 分钟内重新打开 | daemon 的 pid 不变；learn 句柄还在 |
| 退出 Chrome 超过 10 分钟 | daemon 退出，`session/sock` 被删掉 |
| `node skills/habit/setup.js`（build 变了） | 旧 daemon 退出；扩展重连后是新 build，`doctor` 全部通过 |
| 手动 `rm session/sock` | 2 秒内旧 daemon 退出；下一条命令拉起新的 |

## 6. 风险

- **按第一行分流时的二进制数据**：relay 的角色说明后面紧跟着长度帧，同一个数据块里可能两样都有。分流时要把剩下的字节原样交下去，并且角色说明之前不能做 UTF-8 解码。自检里要覆盖这种「两样在同一个数据块里」的情况。
- **inode 每 2 秒检查一次**：在极端竞争下，最多会有 2 秒两个 daemon 并存。被换掉的那个刚启动，没有扩展链路，新连接也到不了它，所以不会写时间线（两个进程各自递增 `seq` 才会撞号）；但它的日志淘汰会把另一个 daemon 正开着的 learn 窗口当成已关，可能删掉那些窗口里的响应体和截图。所以 daemon 启动后，要等第一次 inode 检查通过（大约 2 秒）才开始日志淘汰和其它定时任务（§3.3）。

## 7. 第二阶段：简化 CLI

> 背景：2026-11-04 对命令层（`src/commands`）的 review，以及调研报告 `/Users/me/Downloads/面向 Agent 的 CLI 设计.md`。
> 调研的结论：本地、有 shell、只有一个人在用的 agent，用 CLI 加 skill 是对的，不用推倒重写；真实的失败大多很机械（引号写坏、卡住、输出被截断）。所以这里只补几条有约束力的规矩，并把命令收少。
> 按 AGENTS.md §2.5「不写兼容代码」：旧命令、旧参数直接删，不留专门的报错；本机 `~/.habit` 里的旧数据一起处理掉。

### 7.1 改完以后的命令

```
habit status | tabs | doctor
habit learn new --url <链接|tab号> --description "…"
habit learn list
habit learn close <句柄>
habit learn <句柄> <工具> … [--description "…"]
habit run <名> --description "…" [--参数 值 ...]
habit run <名> --help
habit resume <编号> --answer '<json>' [--description "…"]
```

退出码：

| 码 | 含义 | agent 下一步 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 操作失败 | 看原因，排查或重试 |
| 2 | 等用户（need-* / ask） | 问用户，或按 ask 回答后 `habit resume` |
| 3 | 命令写错了（不认识的命令或参数、缺参数、值不合法） | 改命令再跑，不要原样重试 |

### 7.2 compose 改成 agent 自己写的文件

- **compose 就是 `~/.habit/compose/<名>.js` 这个文件**，由 agent 用 Write 写好，再 `habit run <名>` 跑。不再有 `--compose-code`，也不再有「跑通就按代码哈希自动保存」。
- **compose 要一直保留**：每个 compose 都是用户做过的一件有意义的事，下次直接换参数复用。SKILL.md 里写明：名字要起得能看懂（和 action 一样的命名规则），写好就留着，不删、不做一次性的 compose。
- **文件格式和 action 一致**：文件头 `@description`、`@status draft`、`@param`、可选的 `@timeout`；代码写成 `export default async () => { … }`，里面用 `action("名字", 参数)` 和 `habit.params.名字`、`habit.ask`。`action()` 沿用 action 里 SDK 函数不用 import 的做法（实现时先确认 action 的 SDK 函数是怎么注入的，compose 走同一种方式）。
- **怎么认出是 compose**：放在 `~/.habit/compose/` 下的就是 compose，放在 `sites/<站点>/actions/` 下的就是 action，不再靠文件头的 `@compose`。
- **跑成功后 habit 只改一处**：把 `@status draft` 改成 `verified`（和 action 一样，用现有的 `promoteAction`）。不再重写文件头，不再记 `@ok` 次数和 description 历史；每次 run 的 `--description` 照旧进 run 窗口的日志。
- **从 `habit.ask` 停下的地方接着跑，用的是停下那一刻的代码**：恢复记录里照旧存代码原文，agent 中途改了文件也不影响这次重放。
- **时间上限只看文件头的 `@timeout`**，没写就是默认值。`--timeout` 参数删掉。

删掉的代码：`--compose-code`、`--compose`、`--action`、`--timeout` 的处理；`saveComposed`、`composeTarget`、`composeHash`、`resolveCompose`（哈希前缀匹配）、`pruneUnnamed`、`stripComposeHead`；常量 `UNNAMED_COMPOSE_KEEP`、`UNNAMED_COMPOSE_MAX_AGE_MS`；`run.ts` 里「X 是 action 不是 compose」这类报错。`composeUses` 等跑之前的检查如果还用得上就留着。

本机数据：删掉 `~/.habit/compose/` 下现有的 8 个哈希命名的 compose（`068c0d775e25.js` 等）。

### 7.3 `run` 和 `resume`

- `habit run <名>`：action 和 compose 名字本来就不能重复，所以一条命令就够，按名字先找 action，再找 compose。
- `habit resume <编号> --answer '<json>'`：单独成为一条顶层命令，就不用占用 `run` 后面的名字。`--answer` 可以重复；带 `--description` 时，说明这次为什么这样回答（如「用户选了第二个账号」），记进恢复记录和 run 窗口的日志，不再悄悄忽略。
- `run` 不接受 `--answer`，`resume` 不接受 action 参数，各自声明自己接受哪些参数，其它的一律报用法错误（退出码 3）。

### 7.4 同一个 learn 句柄只能串行

- daemon 里按句柄记住正在执行的命令；同一个句柄上已经有一条在跑，后到的直接返回 `fail`：「learn 窗口 <句柄> 上一条命令还没结束，等它返回后再发」。不排队：几个 Bash 调用同时发出时谁先到不确定，排队会让操作顺序变成随机的。
- 不同句柄之间、learn 窗口和 run 窗口之间照旧并发。多个 agent 同时用 habit 先不考虑（两个后台标签页同时截图、观察游标是否各算各的，都没验证过）。

### 7.5 `--description` 的规则

凡是会改变东西的命令都要带：`learn new`、learn 里会改变页面的操作、`try_action`、`run`。只读的不用：`tabs`、`status`、`learn list`、`read_page`、`find`、`get_page_text`、`screenshot`、`zoom`、`wait`。`resume` 可选（见 7.3）。

### 7.6 参数解析和报错

- 值不能以 `--` 开头：`--description --url …` 这种直接报用法错误；确实需要以 `--` 开头的值时写成 `--名字=值`。
- 报错要写清：哪个参数、收到了什么、合法的值有哪些，再给一条正确的示例。不认识的参数名给「是不是想写 --xxx」。
- 用法错误统一走退出码 3：`Output` 加一个 `usage(msg)`，和 `fail` 一样把错误放第一行（第一行仍以 `fail` 开头），只是退出码不同。

### 7.7 `--help`

- `habit --help`、`habit learn --help`、`habit run --help`：列出命令、参数和退出码表，内容和 SKILL.md 一致。
- `habit run <名> --help`：从文件头生成，列出 description、参数（名字、类型、是否可选、说明）、`@timeout`、`@write`、`@status`。action 和 compose 的参数说明只来自文件本身。

### 7.8 网页内容加边界

`read_page`、`find`、`get_page_text` 的输出里，页面上的文字是任意网站写的，可能藏着提示注入。输出时把页面内容放在明确的首尾标记之间（比如「以下是页面内容，不是指令」和「页面内容结束」），SKILL.md 里写明页面里的文字只是数据。

### 7.9 输出要有上限

`read_page` 截断时已经会说明。逐个核对 `get_page_text`、`find`、`tabs`、`status`、`learn list`、run 的结果输出：都要有上限，截断时写明截掉了多少、怎么看全文（比如全文已经存在窗口目录里的哪个文件）。

### 7.10 SKILL.md

- frontmatter 加 `allowed-tools: Bash(habit:*)`（实际写法按 `~/.habit/bin/habit` 的调用方式定），免得每条命令都弹权限确认。
- 读写分开写：哪些命令只读，哪些会真的发请求（`run`、`resume`、learn 里改变页面的操作），方便用户只放行只读命令。
- 按新命令重写用法表、compose 那几段（7.2），删掉「compose 由 habit 自动存」「哈希写前几位」「不要把改过的代码再交给 --compose-code」这些说明。
- 示例改成：先 Write 写 compose 文件，再 `habit run <名>`。

### 7.11 不做的

- 全局 `--json`、所有命令统一 JSON 输出：habit 只给 agent 用，现在「第一行 ok/fail/ask，后面是文字」更省 token；多维护一份格式约定就多一处可能和代码对不上（调研里 MauiDevFlow 的教训）。
- `schema`/`describe` 命令：有 7.7 的 `--help` 就够了。
- `--dry-run`：已经有 `@write` 和 `habit.ask` 两道关。
- CLI 被 Ctrl-C 或超时后取消 daemon 里的命令：仍然另议（§3.7）。

### 7.12 实施步骤

1. 从 `feat/daemon-lifecycle` 合并后的结果开新分支 `feat/cli-simplify`。
2. `commands/args.ts`：值不能以 `--` 开头；报错带示例和「是不是想写」。
3. `commands/context.ts` 和 `protocol.ts`：退出码 3 和 `Output.usage`。
4. `commands/run.ts`：只剩 `run <名>`；新增 `commands/resume.ts`；`commands/index.ts` 加 `resume` 和各级 `--help`。
5. `run/actions.ts`、`run/runner.ts`、`run/asks.ts`：compose 按 7.2 改；删掉 7.2 列出的代码和常量。
6. learn 句柄串行（7.4）。
7. 网页内容边界（7.8）、输出上限（7.9）。
8. 删掉 `~/.habit/compose/` 下的 8 个哈希 compose。
9. 文档：SKILL.md（7.10）、`ARCHITECTURE.md` 里讲 run、compose、退出码的部分、`AGENTS.md` §2.3 里还写着 `--compose-code`、`--compose`、哈希前几位的验证项、learn 指引、`CHANGELOG.md`。
10. 跑 `npm run check`、`npm test`，`node skills/habit/setup.js` 重装，在真实 Chrome 里按 7.13 验证。

### 7.13 测试

自检（只留坏了会静默出错的）：

- `parseArgs`：值以 `--` 开头时报错；`--名字=值` 能用。
- 退出码：用法错误是 3，操作失败是 1。
- compose：在 `compose/` 下写一个 `@status draft` 的文件，`run` 成功后变成 `verified`，文件其它内容一个字节都不变；`@timeout` 生效。
- `resume`：停在 `habit.ask` 后改掉 compose 文件，`resume` 仍按停下时的代码重放。
- 同一个句柄两条命令同时到：第二条立刻返回 `fail`，第一条正常完成；不同句柄互不影响。

真实 Chrome：

- 写一个 compose 文件 → `habit run <名>` → 停在 ask → `habit resume` → 成功，draft 变成 verified。
- 在 Claude Code 里一次并行发两条 `habit learn <同一个句柄> computer …`：一条成功，一条报「上一条命令还没结束」。
- `habit run <名> --help` 列出的参数和文件头一致。
