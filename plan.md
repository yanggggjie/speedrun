# 发布前机制加固、日志修复与收口计划（2026-11-18）

依据：对 [invocations.jsonl](file:///Users/youshiyitian/.speedrun/session/invocations.jsonl)（近 7 天 311 条调用，含 11-18 ABI 17 上线后 92 条真实生产调用）、Claude Code / Antigravity transcript 及 [stats.mjs](file:///Users/youshiyitian/Code/x/speedrun/tools/stats.mjs) 的复盘。

## 一、机制层分析：哪些值得升维消除，哪些直接修 bug

1. **`spr run -e` 误调未 `import` 的 SDK 函数（7/18 次非测试 `-e` 失败）→ 用「全量受控绑定」从机制上消除**
   - 根因：`wrapInlineCode` 只自动注入了 `{ action, sleep }`，导致 agent 未写 `import` 直接写 `navigate(...)` / `request(...)` 时抛出原生 `ReferenceError`，绕过了 [host.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts) 的 `s.inlineOnly` 单一权威守卫，被误记成 `action-throw` 而非 `usage`。
   - **机制消除**：由 `wrapInlineCode` 把 `spr` SDK 的全部公开导出（未被当前脚本局部声明/导入的）统一注入绑定。如此无论调用方写没写 `import`，只要在 `-e` 里调了页面/请求函数，都会在真正操作浏览器之前统一落入 `RunHost.op` 的 `s.inlineOnly` 守卫（`code: "usage"`），彻底消灭原生 `ReferenceError` 分叉与重复正则表。

2. **`.catch()` 捕获子 `action` 失败后污染后续 `timeout` / `cancelled` 错误码（1 次实测）→ 用「错误随异常值走」消除共享可变状态**
   - 根因：[runner.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.ts) 用共享变量 `trace.code` 与闭包 `let failedAction` 暂存子 `action` 失败信息，导致已经被 `.catch()` 消化的错误残留到后续 `115s` 超时或取消时，把 `out.code` 覆盖成 `action-throw`。
   - **机制消除**：彻底删除 `RunContext.code` 与闭包 `let failedAction`；让 `sprCode` 与 `failedAction` 直接随子 `Error` 对象跨 Worker 边界传递（`reply` → [index.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/action-lib/index.js) 挂到 `Error` 实例 → [worker.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/worker.ts) 原样附在 `fail` 消息上）。被 `.catch()` 吃掉的错误自然随异常对象消亡，只有真正逃逸到顶层的失败才会带出 `sprCode` 与 `failedAction`。

3. **扩展传输超时与业务步骤超时同为 `60_000ms` 撞车（2 次实测）→ 直接修复**
   - 属简单层级超时间隔 bug：将 [constants.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/utils/constants.ts) 的 `EXTENSION_COMMAND_TIMEOUT_MS` 提至 `90_000`，并让 `ExtensionLink.request` 支持按单次调用传入更大上限（`request({ timeout })` 较大时自动放宽），确保页面内 `fetch` 先报出业务超时而非 `扩展命令超时 60000ms：call`。

4. **`stats.mjs` 把已删除测试窗口算进未沉淀漏斗 → 直接修复**
   - 属简单统计过滤 bug：统计沉淀漏斗时过滤掉 `debug-windows/<id>/meta.json` 已不存在的已清理临时目录。

5. **后台 `distiller` subagent 模型选型缺失（日志实测：`flash` 3/3 全成，`haiku` 极小档受限/过弱）**
   - 在 [SKILL.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/SKILL.md) 与 [debug.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts) 补全选型指引：**优先后台运行，模型选快速且具备完整编程/排错能力的中档模型**（如 Antigravity 用 `flash`、Claude Code 用 `sonnet`，不必用最重推理模型，也避免极简摘要小模型；中档受限则继承当前模型）。

---

## 二、改动清单

### 1. 错误随异常传递 + `-e` 全量受控绑定
**文件**：
- [index.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/action-lib/index.js)
- [worker.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/worker.ts)
- [runner.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.ts)
- [runner.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.selfcheck.ts)

- **`action-lib/index.js` + `worker.ts` 传递错误元信息**：
  - `call` 收到带 `sprCode` / `failedAction` 的 `reply` 时挂到被 reject 的 `Error` 实例上；`worker.ts` 捕获顶层未处理异常时把 `sprCode`、`failedAction` 一并附在 `{ type: "fail" }` 上回传。
- **`runner.ts` 消除 `trace.code` / `failedAction` 共享状态**：
  - 删除 `RunContext.code`、`work()` 闭包 `let failedAction` 以及 `decorateFailure` 对 `trace.code` 的回填；`m.type === "fail"` 直接读取 `m.sprCode ?? "action-throw"` 与 `m.failedAction`。
- **`wrapInlineCode` 全量受控注入**：
  - 从 `action-lib/index.js` 自动提取全部导出名（避免手写清单漂移），对未在用户顶部 `import` 或脚本局部声明（`const`/`let`/`var`/`function`/`class`）中出现的 SDK 函数名一并注入 `import { ... } from "spr"`，由 `RunHost.op` 的 `s.inlineOnly` 统一拦截为 `code: "usage"`。
- **自检**：在 [runner.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.selfcheck.ts) 新增「`-e` 未写 `import` 直接调 `navigate()`/`request()` 返回 `code: "usage"`」、「`-e` `.catch()` 捕获子 `action` 失败后再超时，外层 `code` 仍为 `"timeout"`」。

---

### 2. 错开扩展传输超时与业务步骤超时
**文件**：
- [constants.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/utils/constants.ts)
- [extension.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/extension.ts)
- [host.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts)
- [host.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.selfcheck.ts)

- `EXTENSION_COMMAND_TIMEOUT_MS` 从 `60_000` 调整为 `90_000`。
- `ExtensionLink.request(name, args, timeoutMs = EXTENSION_COMMAND_TIMEOUT_MS)` 支持自定义超时；[host.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts) 的 `request()` 调用 `callTab` 时传入 `Math.max(EXTENSION_COMMAND_TIMEOUT_MS, (a.timeout ?? STEP_TIMEOUT_MS) + 10_000)`。

---

### 3. 后台 Distiller 选型指引与统计过滤
**文件**：
- [SKILL.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/SKILL.md)
- [debug.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts)
- [stats.mjs](file:///Users/youshiyitian/Code/x/speedrun/tools/stats.mjs)

- [SKILL.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/SKILL.md) 与 [debug.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts) 沉淀提示中增加后台 subagent 模型选型原则（优先中档快速模型、不用旗舰重推理模型也避免极简小模型，受限则继承主模型）。
- [stats.mjs](file:///Users/youshiyitian/Code/x/speedrun/tools/stats.mjs) 过滤掉 `debug-windows/<id>/meta.json` 已不在磁盘上的已清理测试窗口。

---

### 4. 发布收口（等待确认版本号后执行）
**文件**：
- [CHANGELOG.md](file:///Users/youshiyitian/Code/x/speedrun/CHANGELOG.md)
- [package.json](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/package.json)（及 [package-lock.json](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/package-lock.json)，若建发布分支）

- 整理 [CHANGELOG.md](file:///Users/youshiyitian/Code/x/speedrun/CHANGELOG.md)，补全近期完整变更，清理过时描述。
- 运行 `npm run check`、`npm test`、`npm run verify:pack` 与 `node /Users/youshiyitian/Code/x/speedrun/skills/spr/setup.js` + `spr doctor` 验收；确认版本号后按 [AGENTS.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/AGENTS.md) 建 `release/vX.Y.Z` 分支收口。

---

## 三、验收标准

1. `npm run check`、全部 `npm test` 与 `npm run verify:pack` 通过。
2. `node /Users/youshiyitian/Code/x/speedrun/skills/spr/setup.js` 部署后，`spr doctor` 全部通过（`ABI 17`）。
3. `node /Users/youshiyitian/Code/x/speedrun/tools/stats.mjs` 输出不含已清理的临时测试窗口。
4. `spr run -e 'await navigate("https://example.com")'` 返回退出码 `3`（`usage`）与清晰引导。

---

## 附：历史计划归档

### 2026-11-18：单一品牌色分组与按窗口作用域重构（`main` 提交 `c802344`，已完成）

- 将标签组降级为扩展内纯 UI 收纳盒（`parkInGroup` 单飞维护全局唯一黄色折叠 `speedrun` 组 + `connect()` 自清场，ABI 16 → 17），移除 `storage.session` 与拖组/`T.foreground()` 遗留；daemon 改为 `WindowScope`（含 `AbortSignal`）+ 按 `tabId` 管理，去掉 `reaper`、`robots.txt` 占位重跳与 `nested?: Session`，并经真机 Chrome 实验验证通过。

### 2026-11-16：机制收归与双 Agent 调优（分支 `feat/action-only-distill`，已完成）

- 完成四刀减法（砍掉 `compose`、`ask()`、`spr resume`、`link.ts`，收归为单层 `action` + `spr run -e`）、前后台双 Agent 结构（`SKILL.md` + `agents/distiller.md`）、`spr/helpers/*` 导出、`invocations.jsonl` 与 `meta.json` 闭环及 `tools/stats.mjs`。

### 2026-11-12：run 记录与取消（分支 `feat/logging-run-records`，已完成）

- 完成窗口关闭同步收尾与未知窗口拒写、CLI 退出即取消 `run`、`invocations.jsonl` 初版与 `result.json` / `error.txt` / 暖页面请求证据 / 用户帧裁剪。
