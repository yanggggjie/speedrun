# 机制收归与双 Agent 调优计划（2026-11-16）

依据：对 2026-11-12 至 2026-11-16 期间 `/Users/youshiyitian/.speedrun/session/invocations.jsonl`（275 条调用、11 段任务）、`/Users/youshiyitian/.speedrun/compose`（88 个文件）、`/Users/youshiyitian/.speedrun/action`（41 个站点、78 个文件），以及同期 Claude Code 与 Antigravity 会话 transcript 的实测分析。

## 实现状态（2026-11-16，分支 `feat/action-only-distill`）

- 已完成全部四刀减法、双 Agent 结构（`SKILL.md` + `agents/distiller.md`）、`spr/helpers/*` 软链接导出、日志与 `meta.json` 字段增强，以及 `/Users/youshiyitian/Code/x/speedrun/tools/stats.mjs` 指标统计脚本。
- 已完成本机迁移与实测：21 个有复用价值的带参领域脚本已迁入 `/Users/youshiyitian/.speedrun/action/<对应站点>/`，11 处相对 `helpers` 导入已更新为 `"spr/helpers/..."`，已清理 `/Users/youshiyitian/.speedrun/action/local` 与 `/Users/youshiyitian/.speedrun/compose`；`npm run check`、20 项 `npm test`、`spr doctor`、真实 Chrome `spr debug`（不抢前台）与 `spr run` / `spr run -e` 均已验证通过。

---

## 一、实测基线与问题根因

### 1. 调用与存量脚本实测数据

- **调用分布（275 条）**：`run` 174 次（`ok` 140，耗时 p50 2.9s、p90 13.9s；`fail` 25；`usage` 8；`cancelled` 1）、`debug` 90 次（`ok` 85、`usage` 5）、其它 11 次（`status` 4、`tabs` 3、`resume` 2、`close` 1、`--help` 1）。
- **88 个存量 `compose` 拆解**：
  - **68 个（77%）**只调了 **1 个** `action`（纯粹因禁止直跑 `action` 而包的壳文件）；
  - **6 个（7%）**调了 **0 个** `action`（纯本地计算或硬编码 JSON 总结，如 `/Users/youshiyitian/.speedrun/compose/harness-ux-analysis.js`）；
  - **9 个（10%）**是单次调研的硬编码拼接或未实现的空壳；
  - **仅 5 个（6%）**是真正有复用价值的同站两步串联（如 `devops-latest-artifacts`）；
  - **33 个（38%）**没有任何 `@param`（单日调研新建 25+ 个写死 URL 的一次性文件，污染 `rg` 检索）；
  - **`ask()` 触发 0 次**；`spr resume` 自 11-13 起使用 **0 次**。

### 2. 两个根本矛盾

1. **阻塞路径冲突导致“只 `debug` 不 `run`”（零沉淀）**：
   - 全量日志共 6 个脚本开过 `debug` 窗口，**4 个（67%）最终停在 `debug` 未回到 `spr run`**；其中 `cloudtest-device-session` 占了全部 90 次 `debug` 里的 **56 次（62%）**，`spr run` 为 **0 次**（写空壳绕过前置检查后直接在 `debug` 点击、截屏、`get_page_text` 交付用户，单次请求耗费 30 个含 `spr` 的 `turns`）。
   - **原因**：`debug` 一步已拿到全文/响应或已发出不可重入的写操作（如释放设备），再写两个文件新开窗口重跑一遍 `spr run` 对当前任务是纯负收益。
2. **概念分层过多导致摩擦与垃圾文件**：
   - 7 次 `usage` 报错是直接拿 `action` 传给 `spr run` / `spr debug`，2 次是 `compose` 调 `compose`；
   - 为了跑批量查询，要么在外层串行调 4～9 次 `spr run` 浪费 `turns`，要么落盘一堆无参一次性 `compose`。

### 3. 工程踩坑点与日志瑕疵

1. **`helpers` 相对路径层级不一**：`action` 需写 `../../helpers/...`，原 `compose` 需写 `../helpers/...`，照抄即报模块找不到。
2. **`debug` 参数小坑**：3 次 `--ref` 漏传值，1 次 `form_input` 参数顺序写错，1 次误敲 `spr close`。
3. **`invocations.jsonl` 缺口**：`spr debug list` 被记成 `name: "list"`；90 条 `debug` 记录全无子工具名、窗口目录和操作计数；缺少调用方会话上下文，无法直接按会话聚合计算 `turns`。
4. **文档漂移**：`/Users/youshiyitian/Code/x/speedrun/skills/spr/ARCHITECTURE.md` 第 4 节仍写 `ABI` 是 15，而 `/Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/extension.ts` 已是 `16`。

---

## 二、核心机制设计：四刀减法 + 前后台双 Agent 拆分

原则：**概念最少（只留 `action` + `spr run`），一个 agent 只背一个目标。**

### 1. 四刀减法：收归脚本与命令面

1. **砍掉 `compose` 概念与目录，持久化脚本只留 `action`**：
   - 所有可复用脚本统一存放在 `/Users/youshiyitian/.speedrun/action/<site>/<name>.js`。
   - 允许 `action` 内部调用 `action("...", params)`（最大调用深度限制为 2 防套娃，嵌套调用共用同一个 `run` 窗口与已打开的同源标签页），原同站两步工作流直接作为普通 `action` 存放。
   - 删除 `/Users/youshiyitian/.speedrun/compose` 目录概念及代码中的 `COMPOSE_DIR`、`isCompose`、`composeDirOf`。
2. **不单设 `eval` 子命令，收归为 `spr run -e '<js>'`**：
   - **单步直跑**：`spr run <action> [--<param> <value>]`（跑通后 `draft` 自动升为 `verified`；结果超 2 万字照常截断并存 `result.json`）。
   - **多步 / 批量 / 循环 / 裁剪（免落盘，共用 1 个 `run` 窗口）**：
     ```bash
     ~/.speedrun/bin/spr run -e 'return Promise.all(["101","102"].map(id => action("zhihu-answer", { id })))'
     ```
     worker 自动将 `-e` 代码包在顶层 `async` 函数中并注入 `action`、`sleep`（无需写 `import` 和 `export default`，若需纯函数仍支持动态 `await import("spr/helpers/...")`；`--timeout <秒>` 可调超时），内联模式只允许调 `action()` 与 `sleep()`，页面与请求细节始终封装在 `action` 里。
3. **砍掉 `ask()` 与 `spr resume`**：
   - 内容筛选与向用户确认直接走宿主 agent 自身的多轮对话（第 1 步 `spr run` 读列表，第 2 步 `spr run -e` 批量执行，仅 2 `turns`）。
   - 删除 `spr resume` 命令、`ask()` SDK 导出、`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/asks.ts` 及 `/Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.ts` 中的 `journal` / `AskState` 重放逻辑。
   - 退出码收敛为：`0` 成功；`1` 操作失败；`2` `need-*` 需用户配合（登录、加载扩展等）；`3` 命令或参数用法错误。
4. **删掉静态词法扫描器 `/Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/link.ts`**：
   - 取消“先盲写不存在的 `action` 名再去预检报缺”的仪式；删除 `link.ts` 与 `link.selfcheck.ts`，运行时名字不存在由 `runAction` 直接报 `not-defined`。

### 2. 前后台双 Agent 单一目标拆分（跨所有 harness 通用）

采用官方 `skill-creator` 与社区 `obra/superpowers` 验证过的标准结构，自包含在 `/Users/youshiyitian/Code/x/speedrun/skills/spr` 内（由 `/Users/youshiyitian/Code/x/speedrun/skills/spr/setup.js` 自动镜像到 `/Users/youshiyitian/.speedrun`）：

```text
skills/spr/
├── SKILL.md                  # 主 agent：唯一目标是“最少 turns 完成用户任务”
└── agents/
    └── distiller.md          # 沉淀 subagent：唯一目标是“读窗口日志 → 写带参 action → 验证只读接口”
```

1. **主 agent（读 `/Users/youshiyitian/.speedrun/SKILL.md`）——只管最快完成任务**：
   - `rg` 搜 `/Users/youshiyitian/.speedrun/action` → 有现成 `action` 就 `spr run <action>` 或 `spr run -e '<js>'`（1～2 `turns` 完成）。
   - 没现成 `action`：
     - **单次任务**：直接 `spr debug <名> navigate <网址|tab 号>`（`<名>` 仅作窗口标识，**无前置文件锁**）操作并拿到结果后**当场交付用户**（不重跑第二次，有状态写操作不会冲突）。
     - **批量/翻页任务**：在窗口里做第 1 条看清接口后，当场写 `action` 配合 `spr run -e` 跑完（此时写脚本本身最快）。
   - **派发沉淀 subagent**：`SKILL.md` 不写死特定宿主工具名，只用自然语言规定：收到命令输出末尾的「未沉淀窗口」提示时，在回复用户的同一轮启动一个后台 subagent（宿主不支持后台则普通 subagent；无 subagent 环境再内联处理），让它读取 `/Users/youshiyitian/.speedrun/agents/distiller.md` 并传入该窗口目录。各 harness 自动映射到自身的 `Agent` / `invoke_subagent` / `task` 工具。
2. **`daemon` 输出提醒与触发（防漏搜、防漏调）**：
   - `spr debug <名> navigate <网址|tab 号>` 打开窗口时，若目标站点下已有现成 `action`，在输出中顺手列出同站已有 `action` 名（防主 agent 漏搜导致重复探索）。
   - `daemon` 检查该 `debug` 窗口是否录到了尚未被现有 `action`（`@endpoint`）覆盖的有效请求或关键页面操作：若有，在取数/操作及 `close` 输出末尾附上提示（含窗口目录绝对路径和 `/Users/youshiyitian/.speedrun/agents/distiller.md` 绝对路径）。
3. **沉淀 subagent（读 `/Users/youshiyitian/.speedrun/agents/distiller.md`）——只管提炼与验证**：
   - 只读传入窗口目录的 `timeline.jsonl`、`requests/`、站点 `endpoints.json`；
   - 按五层优先级写成带 `@param` 的 `/Users/youshiyitian/.speedrun/action/<site>/<name>.js`，文件头标注 `@from <debug窗口名>`（同站已有相近 `action` 时扩充可选参数，不在第 1 层写明 `@note`）；
   - **只读 `action`**：运行 `SPR_ROLE=distiller SPR_FROM=<debug窗口名> ~/.speedrun/bin/spr run <action> ...` 真实验证，通过即自动标为 `verified`；
   - **写操作 `action`**：标 `@write`、保留 `@status draft`，绝不重复触发真实副作用，留待下次真实任务调用跑通后自动转 `verified`。

### 3. 统一 `spr/helpers/*` 导入路径

Node ESM 的 `package.json` `exports` 不允许 `../` 越界（实测抛 `ERR_INVALID_PACKAGE_TARGET`）。在 `/Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/actions.ts` 的 `syncActionLib` 同步 `/Users/youshiyitian/.speedrun/lib` 时，建立 `lib/helpers -> ../helpers` 软链接，并在 `/Users/youshiyitian/Code/x/speedrun/skills/spr/src/action-lib/package.json` 导出 `"."` → `"./index.js"` 与 `"./helpers/*"` → `"./helpers/*"`，统一写 `import { ... } from "spr/helpers/<name>.js"`。

---

## 三、指标体系（以 `turns` 为牵引）与日志补全

### 1. 四个核心指标

后台沉淀 subagent 带 `SPR_ROLE=distiller` 单独标记，不计入前台用户任务的 `turns`：

| 指标 | 计算口径 | 当前基线 | 目标 |
|---|---|---|---|
| **前台任务 `turns`** | 单次用户请求内主会话含 `spr` 的执行轮次（同轮并行命令按时间重叠算 1 轮；离线脚本可关联宿主 transcript 算总 `turns`） | 复用 1～2；外层串行 5～9；手动点页面 14～30 | 复用 **1～2**；新任务单次 **2～4**；新任务批量 **4～5** |
| **窗口沉淀漏斗** | 依次追踪：发出沉淀提示的窗口数 → `distiller` 接单数 → 产出带 `@from` 的 `action` 数（及只读 `verified` 率） | **33%（2/6）** | **≥ 90%** |
| **脚本含参率与复用率** | ① 含 `@param` 的 `action` 占比；② 被跨任务段调用 ≥ 2 次的 `action` 占比；③ `debug` 时同站已有 `action` 却未复用的比例 | 存量 `compose` 含参率仅 62% | 新建 `action` 含参率 **≥ 90%** |
| **首跑通过率与耗时结构** | ① 前台 `spr run` 首次执行即 `ok` 比例；② `openMs` / `navMs` / `reqMs` / `domMs` 分段耗时与 `request` vs DOM 占比 | 首跑通过率 80.5%（140/174），p90 13.9s | 通过率 **≥ 90%**，定位慢速 DOM 脚本升级为 `request` |

### 2. `/Users/youshiyitian/.speedrun/session/invocations.jsonl` 与窗口 `meta.json` 补全

不新建额外日志文件，全部收敛在现有的 `invocations.jsonl` 和窗口 `meta.json` 中：

1. **`caller` 会话与沉淀溯源**（`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/session/client.ts`）：
   - `host`：识别 `claude` / `antigravity` / `opencode` / `cursor`；
   - `session`：优先取宿主会话 ID 环境变量（如 `ANTIGRAVITY_CONVERSATION_ID`、`CURSOR_TRACE_ID`、`SPR_SESSION`）短哈希，无则回退为非 shell 祖先进程 PID；
   - `role`：默认 `"main"`，`SPR_ROLE=distiller` 时为 `"distiller"`；
   - `fromWindow`：当传入 `SPR_FROM=<debug窗口名>` 时记录来源窗口，与文件头 `@from <debug窗口名>` 共同闭合沉淀漏斗（即使 `@write` 脚本不跑验证也能通过 `@from` 统计到产出）。
2. **`run` 模式、内联代码、分段耗时与真实写请求拆分**（`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/run.ts`、`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts`）：
   - `mode`：`"action"` | `"inline"`（`-e`）；`-e` 时记录脱敏并截断（≤ 500 字）的 `code` 与内部 `calls` 序列，便于挖掘高频组合升级为正式 `action`；
   - `perf` 与 `ops`：汇总本次 `run` 的分段耗时 `{ openMs, navMs, reqMs, domMs }` 与操作计数 `{ nav, req, dom, eval }`，直接暴露慢在开窗、页面加载还是 DOM 操作；
   - `sent` 去噪拆分：把“脚本通过 `request()` 主动发出的非 GET 请求”与“页面加载/交互自发触发的非 GET 请求”分开记录（解决页面初始化自带几十条背景 POST 淹没真实写请求的问题）。
3. **`debug` 行明细、漏复用探针与关窗状态闭环**（`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts`、`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/windows.ts`）：
   - `debug` 行写入 `tool`、`sub`（如 `left_click`、`screenshot`）、`window`、`ops`、`promptedDistill`（本次输出是否附带了未沉淀提示）；修复 `spr debug list` 误把 `"list"` 写入 `name` 的问题；
   - `navigate` 打开窗口时额外记录 `site` 与 `siteActions`（当时该站点已有的 `action` 数量），用于离线统计“同站已有脚本却去开 `debug`”的情况；
   - 窗口在命令 `close`、空闲超时淘汰、`daemon` 重启或扩展重连关闭时，同步将 `debug-windows/<id>/meta.json` 更新为 `open: false` 并写入 `closedBy: "cmd" | "idle" | "restart"`（修复旧窗口 `meta.json` 长期停留在 `open: true` 的问题）。
4. **统计脚本 `/Users/youshiyitian/Code/x/speedrun/tools/stats.mjs`**：
   - 扫描 `/Users/youshiyitian/.speedrun/session/invocations.jsonl`、`debug-windows/*/meta.json` 与 `/Users/youshiyitian/.speedrun/action/*/*.js`（可选关联本机 transcript），一键输出上述 4 项指标、沉淀漏斗、耗时拆解、高频 `run -e` 代码与未沉淀窗口。

---

## 四、落地顺序

1. **运行时减法与底座改造**：
   - 删除 `asks.ts`、`link.ts`、`link.selfcheck.ts`、`resume` 命令、`ask()` SDK 与 `COMPOSE_DIR` 相关分支；
   - `spr run` 支持直跑 `action`（允许深度 ≤ 2 嵌套调 `action()`）与 `-e '<js>' [--timeout <秒>]`；
   - `spr debug <名>` 去掉前置文件检查，增加同站已有 `action` 提示、未覆盖请求末尾沉淀提示，以及关窗 `meta.json` 状态同步；
   - `syncActionLib` 增加 `lib/helpers -> ../helpers` 软链接与 `package.json` `exports`。
2. **日志补全与统计脚本**：
   - 补齐 `caller`（含 `role`、`fromWindow`）、`mode` + 脱敏 `code`、`perf` / `ops`、`sent` 拆分、`debug` 明细（含 `siteActions`、`promptedDistill`），修 `debug list` 的 `name`；
   - 编写 `/Users/youshiyitian/Code/x/speedrun/tools/stats.mjs`。
3. **双 Agent 文档与自检**：
   - 新增 `/Users/youshiyitian/Code/x/speedrun/skills/spr/agents/distiller.md`；
   - 重写精简 `/Users/youshiyitian/Code/x/speedrun/skills/spr/SKILL.md`、`/Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/guide.ts`、`/Users/youshiyitian/Code/x/speedrun/README.md` 与 `/Users/youshiyitian/Code/x/speedrun/skills/spr/ARCHITECTURE.md`（含 `ABI 16`）；
   - 更新全部 `*.selfcheck.*`，跑通 `npm run check && npm test`。
4. **本机存量迁移与真实 Chrome 验证**：
   - 将 `/Users/youshiyitian/.speedrun/compose` 中那 5 个有复用价值的同站多步脚本迁入 `/Users/youshiyitian/.speedrun/action/<对应站点>/`、把存量 `../helpers/` 与 `../../helpers/` 改为 `"spr/helpers/..."`，合并 `/Users/youshiyitian/.speedrun/action/local` 重复项后删除整个 `/Users/youshiyitian/.speedrun/compose` 目录；
   - 运行 `node /Users/youshiyitian/Code/x/speedrun/skills/spr/setup.js` 本地更新，`spr doctor` 验收，并在真实 Chrome 窗口实测 `spr run <action>`、`spr run -e` 和 `spr debug` 未沉淀提示全链路。

---

## 附：上一轮计划归档（2026-11-12，分支 `feat/logging-run-records`）

- 已完成：窗口关闭同步收尾与未知窗口拒写、CLI 退出即取消 `run`、`invocations.jsonl` 初版与 `result.json` / `error.txt` / 暖页面请求证据 / 用户帧裁剪。
- 留存可选项：长后台任务中 `console.log` 边跑边流式输出到 stdout。
