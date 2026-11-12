# 日志与运行机制改进计划

依据：2026-11-12 对最近 100 条 run 窗口、62 个 debug 窗口目录、约 120 次 `spr` 调用（Claude Code transcript）的分析。

源码路径都相对于 `/Users/youshiyitian/Code/x/speedrun/skills/spr/`。

## 实现状态（2026-11-12，分支 `feat/logging-run-records`）

- 已完成：机制 A、C1、机制 B（B1～B4）、C2（只写进 SKILL.md）、C3；selfcheck 已补，`SKILL.md`、`ARCHITECTURE.md` 已同步；本机已重装，并在真实 Chrome 里验证了失败、成功、用法错误、取消四种情况。
- 已清理：`~/.speedrun/debug-windows/` 下 50 个只有 `timeline.jsonl` 的孤儿目录。
- 和下文设计不同的地方：
  - 机制 A 更简单：不加「已关闭」状态，只要「写入只认登记过、没被淘汰的窗口」加上「关窗口时收尾 socket 状态」就够了；关窗口之后、目录还在时到达的事件照常写进这个窗口。
  - 错误码比 B2 的表少：只放 speedrun 确定知道的类别（`not-defined` `blocked` `param` `usage` `timeout` `cancelled` `action-throw` `internal`）。`http`、`rate-limit`、`login` 要靠规则猜，按原则 7 不做成类别，只在「说明」里给事实。用法错误（开窗口前就失败）由退出码 3 体现，调用记录里 `status` 是 `usage`。
  - 「下一步」提示没有改成按错误码生成，保留原来的写法。
- 没做：C1 的「边跑边输出」。

## 设计原则

1. **简单**：机制少、规则少、实现小，能用一条通用规则就不写多个特例。
2. **靠近 Claude Code 的机制**：已写入 `skills/spr/ARCHITECTURE.md` 第 1 节设计原则第 8 条。
   - 融入：speedrun 不重复实现 Claude Code 已经有的能力（后台运行、结束通知、取消、等待条件、读大文件），而是让 `spr` 在这些机制下表现正确。
   - 借鉴：输出格式、截断方式、错误写法尽量照 Claude Code 自己的样子，模型不用额外学习。

### Claude Code 的机制与 speedrun 的对应

| Claude Code 的机制 | 模型已经熟悉的用法 | speedrun 要做到的 |
|---|---|---|
| Bash `run_in_background` + 结束时通知 | 长命令放后台，结束后自动收到结果 | `spr run` 就是一个普通的阻塞命令，放后台就是后台任务；不另做 `--bg` |
| 停止后台任务（TaskStop）、Bash 超时 | 杀掉进程就是取消 | **CLI 进程退出 = 取消这次 run**：daemon 发现 CLI 断开就终止 worker、关窗口、记 `cancelled` |
| Monitor（用 until 循环等条件） | 等某个状态，不用固定间隔反复跑 | 轮询写在 compose 的循环里（`sleep` 已有），一个窗口跑完；长的放后台 |
| 输出过大时「Full output saved to: <路径>」加预览 | 看到路径就用 Read / rg 去读 | 所有裁剪都用同样的写法：预览加完整文件路径 |
| 工具出错时只给一句短错误 | 第一行就是原因 | 第一行是错误原文，细节放文件 |
| 退出码 | 0 成功，非 0 失败 | 保持 0 成功、1 失败、2 停在 ask |
| transcript 是 JSONL | 用 jq / rg 查 | 日志都是 JSONL，固定字段，用 jq / rg 查，先不做专门的统计命令 |

## 发现的问题

| # | 问题 | 现象 |
|---|---|---|
| 1 | 孤儿 debug 目录 | 62 个 debug 目录里 51 个是旧 run 窗口名，没有 `meta.json`，只有 socket 行，时间戳全是 11-12 13:52:03 |
| 2 | 失败原因没落盘 | run 的 `meta.json` 只有 `status`；`result.json` 只在结果过大时写（100 条里 3 条有） |
| 3 | 开窗口前失败的调用没有记录 | 把 action 当 compose 跑 ×3、参数写法错、缺参数、多余参数，只在 transcript 里能找到 |
| 4 | 用反复 run 来轮询 | `devops-build-qr` 同参数每约 23 秒跑一次，共 18 次 |
| 5 | 只发请求的 action 失败诊断无用 | 页面停在 `robots.txt`，截图和「下一步：navigate robots.txt」都没有参考价值 |
| 6 | 堆栈噪音 | 「错误：」块几乎全是 `worker.ts`、`lib/index.js`、`node:internal` 帧 |
| 7 | resume 断链 | journal 按位置严格匹配，修 action 时加了参数（`x-saved-all` 第 21 次多了 `screenName`）就整个失败 |

归结为三个机制：A 窗口生命周期，B 记录与输出，C run 的执行方式。

---

## 机制 A：窗口只有开和关，关了就不能再写

解决：1。

### 问题 1 的根因

1. `src/record/ingest.ts` 的 `socket()` 为每条 websocket 在内存 `sockets` Map 里留一个 `SocketState`，记着所属窗口名。
2. 正常靠 `close` 事件写最后一行并删除；但 run 结束时直接关标签页组（`src/browser/window.ts` 的 `dispose`），`close` 不会到，状态一直留在 Map 里。
3. 任意一次 debug 观察会调用 `flushSockets()`（`src/debug/observe.ts:44`），把 Map 里所有残留连接都写一遍，包括早已被淘汰的 run 窗口。
4. `socketRow()` 写入时不检查窗口；`src/record/windowlog.ts` 的 `winDir()` 对认不出的窗口默认归到 debug，于是凭空建目录。

### 设计

两条规则：

1. **关窗口时同步收尾**：`closeWindow(win)` 先写出这个窗口剩下的 socket 摘要、写 meta 的 `endedAt`、删掉它的内存状态，再标记为关闭；关浏览器标签页组照旧放在后台异步做。
2. **只有 `openWindow` 能建目录**：所有写入（`append`、`appendFile`、`putFile`）遇到未知或已关闭的窗口，直接忽略。

只要两个状态，不需要中间状态：收尾是同步的，标记关闭之后到达的事件按第 2 条忽略即可。迟到事件不计数，它们没有分析价值。

这条规则是通用的：以后任何迟到事件（socket、请求、截图）都被同一处挡住，不用在每个写入点加检查。

一次性清理：删掉 `debug-windows/` 下没有 `meta.json` 的目录。

### 涉及文件

- `src/record/windowlog.ts`：未知或已关闭的窗口不写
- `src/record/ingest.ts`：提供 `closeWindow(win)`，收尾这个窗口的 socket 状态
- `src/run/runner.ts`、`src/debug/windows.ts`：关窗口时先调用收尾

---

## 机制 B：记录完整，输出精简，两者来自同一份结果

解决：2、3、5、6。

原则：给 agent 的输出是记录的精简视图；凡是裁剪掉的内容，都照 Claude Code 的写法给出完整文件路径。

### B1. 调用记录

`~/.speedrun/session/invocations.jsonl`：daemon 在每条 CLI 命令结束时写一行，包括开窗口前就失败的、被取消的。

- 只在结束时写一行，CLI 进程被杀时 daemon 也能写（见 C1）。
- 不跟 run 窗口的 100 条上限绑定，单独按大小淘汰，和 `session/log.jsonl` 用同一套逻辑。
- 输出的最后一行带上调用 id，人和 agent 都能据此在 JSONL 里找到这条记录。

字段：

| 字段 | 说明 |
|---|---|
| `id`、`ts`、`ms` | 调用 id、开始时间、耗时 |
| `cmd`、`name` | 子命令（run / resume / debug ……）和 compose 或 action 名 |
| `params` | 脱敏后的参数，复用现有 sanitizer |
| `cwd` | 调用方所在目录，区分是哪个项目在用 |
| `window` | 对应的窗口名，没开窗口就为空 |
| `status` | `success` / `failure` / `ask` / `cancelled` |
| `error` | 失败时：`code`、`message`（第一行原文）、`action`、`at`（用户文件的 file:line） |
| `result` | 成功时：`bytes`、`count`（数组长度）、`empty` |
| `calls` | compose 调用过的 action：名字、耗时、状态、是否来自 resume 缓存 |
| `sent` | 实际发出的非 GET 请求 |
| `resumedFrom` | 从哪个恢复编号接着跑 |

窗口目录里补全细节：

- `result.json`：成功结果一律写，不再只在过大时写。
- `error.txt`：失败时的完整报错和完整 stack。
- `meta.json`：补上 `error.code` 和 `error.message`。

### B2. 错误码只有一张表

CLI 的「下一步」提示按错误码查这张表生成，调用记录里存的也是同一个 code。改一处提示，统计口径跟着一致。

| code | 含义 |
|---|---|
| `not-defined` | 名字找不到 |
| `run-action-directly` | 用 `spr run` 跑了 action |
| `param` | 缺参数、多余参数、类型不对、值格式不对 |
| `timeout` | 超过 `@timeout` |
| `http` | 请求返回 4xx / 5xx（429 和登录单列） |
| `rate-limit` | 429 |
| `login` | 命中登录页规则或 401 |
| `no-body` | 没录到响应体 |
| `action-throw` | action 自己抛的错 |
| `cancelled` | CLI 被杀或被中断 |
| `internal` | speedrun 自身的错 |

### B3. 失败时给什么证据：按 action 做过什么决定

robots.txt 是暖页面：action 要以站点身份发 `fetch`（带 cookie、同源），需要该 origin 下的一个标签页，robots.txt 最轻（`src/browser/window.ts` 的 `acquire`）。只发请求的 action 从不导航，所以失败时页面就停在这里。

一条规则：

- timeline 里有导航或页面操作：给截图和页面地址，保持现状。
- 只发过请求：不截图，不建议 navigate；给出失败那条请求的记录文件和响应体路径。

### B4. 给 agent 的错误格式

照 Claude Code 工具出错时的样子：

```
fail <name>：<错误原文第一行>
位置：<用户文件>:<行>
证据：<截图路径，或失败请求的文件路径>
完整报错：<窗口目录>/error.txt
下一步：<按错误码生成>
```

- stack 只保留用户文件的帧（`action/`、`compose/`、`helpers/`）；完整 stack 在 `error.txt`。
- 结果过大时的输出也统一成「预览 + 完整结果保存在 <路径>」。

### B5. 暂不做

- `spr stats` 统计命令：先用 jq / rg 查 `invocations.jsonl`，在 `ARCHITECTURE.md` 里给几条常用查询；真的常用再做成命令。
- 记录 debug 改了哪些 action 文件：先靠 `invocations.jsonl` 里 debug 和 run 的先后顺序就能看出「失败 → debug → 修好」的轮数。

---

## 机制 C：`spr run` 是一个普通的阻塞命令

解决：4、7。

### C1. CLI 进程退出就取消 run

现状：daemon 收到 CLI 的请求后，CLI 断开不会影响正在跑的 run（`src/daemon.ts` 的 `onCli` 没有处理连接断开）。被 Bash 超时杀掉或被 TaskStop 停掉时，run 还在后台继续跑。

设计：CLI 连接断开时，daemon 终止这次 run 的 worker、关窗口、写调用记录，`status` 记为 `cancelled`。

有了这一条，Claude Code 的机制就能直接用：

- 长任务：agent 用 Bash `run_in_background` 跑 `spr run X`，结束时 Claude Code 自动通知；不需要 `--bg`、`spr wait`、`spr status`。
- 取消：TaskStop 或 Ctrl+C 杀掉进程，就是取消。
- 超时：Bash 前台默认 2 分钟、`@timeout` 默认 115 秒，两者保持一致；超过 2 分钟的 compose 在 SKILL.md 里写明要放后台跑。

可选：把 compose 里 `console.log` 的内容边跑边输出到 stdout（现在只在结束时附在报错里），放后台时能在输出文件里看到进度。

### C2. 轮询写在 compose 的循环里

不新增 API，`sleep` 已经有了：

```js
for (let i = 0; i < 45; i++) {
  const r = await action("devops-build-qr", p);
  if (r.qrUrl) return r;
  await sleep(20_000);
}
throw new Error("15 分钟内没等到二维码");
```

- 一个窗口跑完，不会占掉 100 条 run 窗口名额。
- 要等很久的就调大 `@timeout`，用 Bash `run_in_background` 跑。
- SKILL.md 写一条：要等某个状态时，在 compose 里循环，不要在外面反复 `spr run`。

### C3. resume：按内容复用，不按位置匹配

现状：`src/run/runner.ts` 要求第 i 次调用的 name 和 params 与上次完全一致，否则整个 resume 失败。

设计：一条规则。

- journal 以 `name + 规范化后的 params` 作 key（深比较，忽略 `undefined` 和 key 顺序），同一个 key 下按顺序存多次结果。
- resume 时，同一个 key 的第 k 次调用返回记下的第 k 次结果；记录用完了或没有这个 key，就照常执行。
- 只有成功的调用才进 journal。
- ask 的回答同理，以问题文本作 key。

为什么不用额外的安全检查：只有 name 和 params 完全相同才会复用，复用时不会重复发请求；参数变了就是一次新调用，本来就该执行。按顺序存多次结果，也让 C2 那种循环在 resume 时不会一直拿到同一个旧结果。

---

## 落地顺序

1. **机制 A**：改动最小，先止住孤儿目录和内存泄漏，清理现有孤儿目录。
2. **C1**：CLI 退出就取消 run。改动小，接上 Claude Code 的后台运行和取消。
3. **机制 B**：调用记录、错误码表、错误格式、按 action 做过什么给证据。
4. **C3**：resume 按内容复用。
5. **SKILL.md**：补上 C1、C2 的用法（后台跑、在 compose 里循环）。

每一步都补对应的 selfcheck，并更新 `ARCHITECTURE.md`。

## 待定

- `invocations.jsonl` 的大小上限（比如 20MB）。
- C1 的「边跑边输出」要不要做。
