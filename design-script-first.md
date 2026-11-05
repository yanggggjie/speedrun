# 设计：写出可复用的脚本是唯一主线

> 状态：已实现，未提交。`npm run check`、`npm test`、`npm run verify:pack` 通过，已在真实 Chrome 里走通 5 类任务；§9 的新旧版本对比还没做。不留兼容（AGENTS.md §2.5），旧命令和旧文件格式一起改掉。

## 0. 结论

speedrun 对 agent 来说不再是"学网站的工具"，而是一套写脚本的开发环境。任务永远走同一个流程：

| 阶段 | 对象 | 用什么 | 做什么 | 结束条件 |
|---|---|---|---|---|
| **Find** | compose、action | `rg`、`ls` | 先找 compose，再找可复用的 action | 找到 compose 就去 Run，否则去 Write |
| **Write** | compose | 写文件 | 写任务流程，调用已有 action，也写上还不存在的 action | 写完就去 Run |
| **Debug** | action | `spr debug` | 在一个窗口里写或修 compose 缺的 action | 这些 action 写完就回 Run |
| **Run** | compose | `spr run` | 运行 compose，把返回值告诉用户 | 成功就结束，失败就去 Debug |

设计原则：

1. **能用文件和 agent 自带工具，就不加 API**：Find 和 Write 没有专用命令。
2. **概念复用 agent 已经懂的**：函数、文件、JSDoc、`is not defined`，以及项目已有的 `action`、`compose`、`draft`、`verified`、`blocked`。
3. **流程没有例外**：单步任务也写 compose，`spr run` 只接受 compose。
4. **只有 Run 的返回值能交给用户**：Debug 中看到的内容不算结果。
5. **Debug 做到最小触发就停**：请求的参数能由 action 参数决定，响应里有要的数据，就写成 action。

## 发现

这一节记录为什么要做这次设计，以及讨论中否定过的方案。

### 问题

有的 agent 在 learn 窗口里看到内容后，直接把结果交给用户，没有写成 action，也没有经过 `spr run`。这样任务虽然完成了，下次仍要从头来。

### 根因：两个目标

编码这类任务只有一个目标：把事做完。speedrun 却要求 agent 同时做两件事：完成用户的任务，并学出能加速下次的 action。agent 自然优先完成眼前的任务，学习就成了可以跳过的额外工作。

文档本身也不一致：`ARCHITECTURE.md` 第 1 节说唯一目标是完成眼前的任务，存下来的东西是顺带的；`SKILL.md` 却要求先学成 action 再交付。

现有设计还放大了这个问题（以下来自读代码的推断）：

- **答案来得太容易**：`get_page_text`、`read_page` 直接返回页面内容，agent 看到后就觉得任务完成了。
- **工具形状和规则冲突**：learn 工具和 Claude in Chrome 同名同义，而后者本来就用来直接获取答案。
- **规则没有执行机制**：`ARCHITECTURE.md` 第 1 节写明"结果只来自 `spr run`"是约定，没有强制检查。
- **提醒来得晚**：每 15 次操作提醒一次，`close` 时再提醒一次，agent 不 close 就看不到后者。
- **学习比读页面步骤多**：要读请求文件、手写文件头和请求、试跑、再 run。

### 证据和局限

- 这台机器没有 `~/.speedrun`，数据还在旧目录 `~/.lore`：7 个 learn 窗口、12 个 run 窗口、4 个 action、1 个 compose，大多是测试。
- 这些数据不足以证实 agent 的实际行为，也不能说明问题有多常见。上面的根因是推断，要靠 §9 的对比验证。
- `plan.md` 引用的 94 次 run 统计来自另一份数据，这里没有复核。

### 代码里的具体发现

- **`try_action` 有假阳性**：它沿用 learn 窗口的页面状态和请求头，所以 `finishRun` 才需要一条"try_action 成功过但 run 失败"的提示。
- **compose 失败时没有截图**：`runner.ts` 只在最外层是 action 时调用 `failureShot`。`spr run` 改成只接受 compose 后，这个条件必须去掉，否则失败输出会丢掉页面和截图。
- **恢复执行大部分已经具备**：`runAction` 在没有 `opts.code` 时读当前文件，journal 也已按调用顺序记录。失败后恢复只需要把 journal 带出来，不用新机制。
- **指引和原则不一致**：`guide.ts` 只写了 `request`、`waitRequest`、DOM，SKILL.md 还有页面函数和 `waitMessage`。

### 讨论过的方案

| 方案 | 结论 |
|---|---|
| Stop hook 拦截没有经过 run 的回合 | 暂缓。事后拦截，而且只对 Claude Code 有效 |
| 把目标告诉 agent：第二次要最快 | 否定。这又多了一个目标。"第二次最快"是衡量系统的指标，不写给 agent |
| learn 只给结构，真实数据只在 run 里出现 | 暂缓。改动大，截图仍会露出内容，排查也更难 |
| 开局用 todo 工具写明目标 | 不作为解法。只有部分宿主有，agent 仍可能跳过，而且写不好交替的 learn 和 run |
| 主 agent 和学习的子 agent 分离 | 暂缓。隔离干净，但依赖宿主 |
| 新增 `spr find`、`spr declare`、`gen` | 否定。`rg` 和写文件已经够用，新 API 只会增加学习成本 |
| 用占位文件和 `@status undefined` 声明 action | 否定。compose 里的调用本身就是声明 |
| 合并 action 和 compose | 否定。"调用其他脚本时不能碰页面"这条规则仍在，只是变得看不见 |
| run 失败后保留窗口 | 否定。Run 窗口用完就消失，失败原因看日志文件，页面到 Debug 窗口里复现 |
| **把任务变成写脚本，`spr run` 通过就是完成** | **采用**。只留一个目标，学习变成调试手段，交替也变成同一个循环 |

## 1. 主循环

SKILL 开头只留这一段：

> 你的任务：用 compose 完成用户的事。
> Find：用 `rg` 找已有的 compose 和 action。
> Write：没有 compose 就写一个，缺的 action 也先写上调用。
> Debug：`spr run` 报缺或失败时，在一个窗口里处理这些 action。
> Run：用 `spr run` 运行 compose，把返回值告诉用户。

```text
Find ──有 compose──────────▶ Run ──成功──▶ 告诉用户
  │没有                      ▲ │
  ▼                          │ │is not defined / 运行失败
Write ───────────────────────┘ ▼
                     Debug（处理缺的 action）──▶ 回到 Run
```

完整示例：

```bash
rg -i "知乎" ~/.speedrun/compose ~/.speedrun/action
# 没有 compose，写 ~/.speedrun/compose/zhihu-vote-hardcore.js
~/.speedrun/bin/spr run zhihu-vote-hardcore --q agent
# fail zhihu-vote-hardcore：zhihu-search、zhihu-vote is not defined（没有执行任何操作）
~/.speedrun/bin/spr debug zhihu-vote-hardcore navigate "https://www.zhihu.com/search?q=agent"
# 观察：#1203 GET /api/v4/search_v3 带着「agent」……
# 目标：spr run zhihu-vote-hardcore（还缺 zhihu-search、zhihu-vote）
# 读请求文件，写 ~/.speedrun/action/zhihu.com/zhihu-search.js
~/.speedrun/bin/spr debug zhihu-vote-hardcore find "赞同"
~/.speedrun/bin/spr debug zhihu-vote-hardcore computer left_click --ref ref_31
# 读请求文件，写 ~/.speedrun/action/zhihu.com/zhihu-vote.js
~/.speedrun/bin/spr run zhihu-vote-hardcore --q agent
```

## 2. 命令和窗口

### 2.1 命令

| 命令 | 作用 |
|---|---|
| `spr run <compose> [--参数 值]` | 唯一的运行方式 |
| `spr resume <编号> [--answer '<json>']` | 接着跑：停在 `ask` 的要带 `--answer`，失败后修好的不带 |
| `spr debug <compose> navigate <网址\|tab 号\|back\|forward>` | 没有窗口时用网址或 tab 号打开一个，第一次输出 debug 指引 |
| `spr debug <compose> read_page \| find \| get_page_text \| computer … \| form_input … \| inspect \| trace` | 和现在的 learn 工具相同 |
| `spr debug <compose> close` | 主动关窗口，可以不调 |
| `spr debug list` | 列出开着的 Debug 窗口 |
| `spr tabs`、`status`、`doctor`、`daemon restart` | 不变 |

删除：`learn new`、`learn close <句柄>`、`try_action`、句柄、`closedNote`、全部 `--description`、`spr run <名> --help`。说明和参数都在文件头，Find 时直接读文件。

规则：

- `spr run` 收到 action 名时报用法错误，提示写一个调用它的 compose。
- `spr debug` 的第一个参数必须是已存在的 compose。文件不存在时报用法错误，提示先写 compose。这条规则保证 Write 在 Debug 之前。
- `list` 是保留名，不能作为 compose 名。
- 窗口没开时，`navigate` 以外的工具都报错，提示 `spr debug <compose> navigate <网址>`。`back`、`forward` 也需要窗口已开。

### 2.2 窗口

| 窗口 | 生命周期 |
|---|---|
| **Debug** | Run 成功或失败都不关。`close`、空闲 30 分钟、daemon 重启、扩展重连、标签组被关时才关 |
| **Run** | 一次 run 结束就关闭，成功、失败和停在 `ask` 都一样 |

- 一个 compose 同时只有一个 Debug 窗口。窗口可以处理它缺的多个 action，也可以跨站点。
- 日志目录名继续是 `<compose>-<年月日>-<时分秒>`，放在 `debug-windows/`。窗口重开时新建目录。
- 200 次操作上限、同一窗口串行、标签组颜色都保留。到上限后 `close`，再 `navigate` 开新窗口。
- Run 窗口关闭后，日志还在 `run-windows/<名字>/`。排查时用 `rg` 读日志，需要页面时在 Debug 窗口里复现。

## 3. Run

### 3.1 执行前检查

新增 `run/link.ts`，导出 `checkCompose(name, paths)`。只读文件，不开窗口，不需要扩展：

```typescript
type LinkResult = { missing: string[]; blocked: Array<{ name: string; note: string }>; errors: string[] };
```

- 用一个小扫描器读 compose 源码，跳过注释和字符串，找 `action(` 调用。
- 名字是普通字符串时记入依赖。名字是变量或带 `${}` 的模板字符串时，记为用法错误。
- 依赖是 compose 时递归检查，用调用栈发现循环。
- 依赖文件不存在记入 `missing`。依赖是 `@status blocked` 记入 `blocked`，`actionSummary` 增加 `note` 字段。

`runCommand` 在 `ensureExtension` 之前调用它：

```text
fail zhihu-vote-hardcore：zhihu-search、zhihu-vote is not defined（没有执行任何操作）
下一步：spr debug zhihu-vote-hardcore navigate <网址>，写好后再 spr run zhihu-vote-hardcore
```

静态检查覆盖不到别名导入这类写法，所以 `runAction` 运行时继续检查，错误文字同样改成 `<名> is not defined`。

### 3.2 失败输出

- `runner.ts` 去掉 `failureShot` 的 `!composed` 条件，最外层 compose 失败时也截图。
- 登录失效提示里的 `spr learn new` 改成 `spr debug <compose> navigate <这个页面>`。
- 删除 `finishRun` 里两条提醒 learn 窗口的文字。
- 有 `failedAction` 时给出下一步：

```text
fail zhihu-vote-hardcore：[zhihu-vote] 403
出错的 action：zhihu-vote
页面：https://www.zhihu.com/… "…"
截图：~/.speedrun/run-windows/zhihu-vote-hardcore-20261106-101500/screenshots/failure.png
run 窗口目录：~/.speedrun/run-windows/zhihu-vote-hardcore-20261106-101500（窗口已关，日志留着）
下一步：spr debug zhihu-vote-hardcore navigate <页面>，修好 zhihu-vote 后 spr resume AS-1a2b3c4d
```

### 3.3 失败后继续

目标是修好失败的 action 后，不必重跑已完成的 action。实现复用现有的 ask 恢复：

1. `runAction` 给最外层 compose 建 `state`，失败时把 `state.journal`、`state.answers` 放进 `Outcome`。
2. `runNamed` 在失败且 journal 非空时，调用 `asks.add`，记录 `failed: true`，不存 `code`。
3. `resumeCommand` 对 `failed` 记录不要求 `--answer`，先跑 §3.1 的检查。
4. `runAction` 没收到 `code`，自然读当前文件。ask 恢复继续用停下时的代码。
5. 前面的 action 从 journal 返回，失败的 action 没有记录，所以用修好的文件重新执行。
6. 恢复再次失败时，用新的记录替换旧的 `failed` 记录。ask 记录仍按现状保留。

现有的"调用名字和参数不同就失败"继续作为保护。恢复记录仍只在 daemon 内存里，30 分钟有效，最多 20 条。

### 3.4 draft 和 verified

这部分不改：run 成功后，这次执行过的 draft 都变成 verified。action 不能单独运行，所以它通过 compose 的成功运行变成 verified。

## 4. Debug

### 4.1 打开窗口

`startLearn` 合并进 `navigate`：

1. 查 compose 是否存在，不存在就报用法错误。
2. 窗口没开时，用现有的 `resolveStartUrl` 解析网址或 tab 号。
3. 创建窗口、打开页面、等页面安静、做页面函数快照、输出观察。
4. 第一次或内容变化时写 `debug-guide.md`，并在输出末尾给全文。
5. 窗口已开时，走现有的 `navigate` 操作。

`LearnWindows` 改名 `DebugWindows`。内部继续按窗口 id 登记，再加一张 compose 名到 id 的映射。这样 `AgentWindows`、`Session`、`WindowLog`、日志淘汰都继续用 id。

### 4.2 处理缺的 action

agent 看观察结果，用 `rg` 读请求日志，自己写 action 文件。一个窗口里可以连续处理 compose 缺的多个 action。

实现方式沿用 SKILL.md 现有的顺序，能用上面的就不用下面的。站点有官方 API 时先用官方 API，否则按下面四层选：

| 顺序 | 策略 | SDK | 什么时候用 | 停止条件 |
|---|---|---|---|---|
| 1 | HTTP 请求 | `request`、`waitRequest` | 页面发了可用请求。签名或请求体复现不了时，用 `waitRequest` 让页面自己发 | 参数能由 action 参数决定，响应里有要的数据 |
| 2 | 页面函数 | `evaluate` | 没有可用请求，但页面有自己的接口 | 调用函数能完成动作或取到数据 |
| 3 | WebSocket、事件流 | `waitMessage` | 数据从长连接或事件流来 | 收到的消息里有要的数据 |
| 4 | DOM 或真实输入 | `query`、`get_page_text`、页面操作 | 上面都不行 | 操作完成，或页面里读到目标数据 |

- 达到当前层的停止条件，就写 action，不继续往下试。
- 同一种页面操作连续失败两次，换下一层。
- 四层都不行时，写 `@status blocked` 和 `@note`，向用户说明。
- 想先验证一个 action 时，写一个只调用它的小 compose，用 `spr run` 运行。

### 4.3 输出末行

`windowCommand` 成功返回后，用 `checkCompose` 算出末行：

```text
目标：spr run zhihu-vote-hardcore（还缺 zhihu-vote）
```

不缺 action 时是 `目标：spr run zhihu-vote-hardcore`。这行替代三处提醒：`observe.ts` 的 uncovered、`learn.ts` 的 `NUDGE_EVERY`、`closeLearn` 的未交付提醒。

观察里的请求排序不变，`sentIt` 已经把带着 agent 输入值的请求排在前面。

### 4.4 删除的内容

- `try_action`：`TOOLS`、`SPECS`、`target` 分支和 `runInLearn`。
- `--description`：`SPECS`、`DESCRIPTION_HINT`、`descriptionOf`、`RESERVED_PARAMS` 里的 `description`、`EndpointIndex.describe`、`Description` 类型、`descriptions` 字段，以及观察里"以前的 description"。
- `closedNote`、`HANDLE`、`actionsNewerThan`、`WindowLog.runsSince`。

写请求继续沿用现有规则：speedrun 不拦，由 agent 判断副作用。

## 5. 文件格式和 SDK

action 和 compose 共用一种写法：

```javascript
/**
 * @description 在知乎搜索，返回回答列表
 * @status draft
 * @endpoint GET /api/v4/search_v3
 * @param q 搜索词
 * @param n?:number 要几条
 * @returns 回答数组，每项有 id、title
 */
import { navigate, request } from "spr";

export default async ({ q, n = 30 }) => {
  await navigate("https://www.zhihu.com/search");
  const r = await request({ url: `https://www.zhihu.com/api/v4/search_v3?q=${encodeURIComponent(q)}` });
  return r.json().data.slice(0, n);
};
```

compose 调用 action，这段调用本身就声明了名字、参数和返回值的用法：

```javascript
/**
 * @description 给知乎搜索结果里的硬核回答点赞
 * @status draft
 * @param q 搜索词
 */
import { action, ask } from "spr";

export default async ({ q }) => {
  const list = await action("zhihu-search", { q });
  const picked = await ask("哪些是硬核技术的回答？回答 id 数组", list.map((x) => ({ id: x.id, title: x.title })));
  for (const id of picked) await action("zhihu-vote", { id });
  return { voted: picked.length };
};
```

| 改动 | 实现 |
|---|---|
| 参数走函数参数 | `worker.ts` 调用 `mod.default(params)`，`index.js` 删除 `spr.params` |
| `spr.ask` 改成 `ask` | `index.js` 导出 `ask`，删除 `spr` 对象 |
| `import … from "spr"` | `action-lib` 加 `package.json`（`name: spr`、`type: module`、`exports: ./index.js`）。`syncActionLib` 建 `~/.speedrun/node_modules/spr` 符号链接，指向 `lib/` |
| `@summary` 并入 `@description` | `actionSummary` 只读 `@description`，`summary` 字段改名 `description` |
| 可选的 `@returns` | 只给 Find 时阅读，不加代码 |

`~/.speedrun/compose/` 和 `~/.speedrun/action/<站点>/` 都能向上找到 `~/.speedrun/node_modules`。compose 的临时 `.run-*.mjs` 文件和 compose 同目录，也能解析。

## 6. 代码改动清单

| 位置 | 改动 |
|---|---|
| `src/learn/` | 目录改名 `src/debug/`，`windows.ts`、`guide.ts`、`observe.ts` 按 §4 改 |
| `commands/learn.ts` | 改名 `commands/debug.ts`，按 §2、§4 改 |
| `commands/run.ts` | 只接受 compose，接入检查、失败恢复和新输出，删除 `--description` 和 `runHelp` |
| `commands/index.ts`、`protocol.ts` | 改命令分发、`HELP`、`USAGE` |
| `commands/context.ts`、`args.ts` | `Ctx.learn` 改 `debug`，删除 description 相关代码 |
| `run/link.ts` | 新增 §3.1 的检查 |
| `run/runner.ts` | 失败截图、journal 带出、错误文字，删除 `runInLearn` |
| `run/asks.ts` | 增加 `failed` |
| `run/actions.ts` | `note`、`description` 字段，`syncActionLib` 建链接 |
| `run/worker.ts`、`action-lib/` | 按 §5 改 |
| `record/windowlog.ts`、`retention.ts`、`ingest.ts` | `WinKind` 改 `debug`，目录改 `debug-windows/`，保留规则不变 |
| `record/endpoints.ts` | 删除 `describe` 和 `descriptions`，其余保留 |
| `browser/host.ts`、`window.ts` | 改错误文字和注释，`host.end` 不改 |
| `daemon.ts`、`cli/doctor.ts`、`store/deploy.ts`、`utils/constants.ts` | 跟随改名 |
| 文档 | 重写 SKILL.md、`ARCHITECTURE.md`、AGENTS.md §2.3、`topics/*`、README、PRIVACY.md，加 CHANGELOG |

`git grep -i learn` 现在有 45 个文件、407 行，不含 `plan.md`、CHANGELOG 和本文。

同时删掉 `guide.ts` 第 96 行"run 时会检查实际发出的顺序"的说法，让文档和代码一致。`@endpoint` 本身保留，继续表示 action 用到的 endpoint。

**不做迁移**：没有兼容代码。旧的 `learn-windows/`、`learn-guide.md` 留在本机不再使用。`endpoints.json` 里指向 `learn-windows/` 的样本路径会失效，实施时要确认缺文件不会报错。这台机器没有 `~/.speedrun`，不用改写脚本。其他机器上的 action 和 compose 要手动改成 §5 的写法，这写进 CHANGELOG。

## 7. 保留不动

- **action 和 compose 两层**：action 碰页面，compose 调用 action。compose 不碰页面，这是恢复时安全重放的基础。
- **目录**：`compose/`、`action/<站点>/`、`run-windows/`、`lib/`、`helpers/`。
- **`endpoints.json` 和 `@endpoint`**：继续是可 `rg` 的文件。
- **`@status`**：继续用 `draft`、`verified`、`blocked`，升级规则不变。
- **扩展、页面脚本、录制、脱敏、请求头继承、`ask` 流程**。
- **`get_page_text`**：写 DOM action 时需要看正文。
- **这次不做**：learn 只给结构、Stop hook、主 agent 和子 agent 分离。等 §9 的数字说明 agent 还在绕过 run 时再做。

## 8. 风险

| 风险 | 处理 |
|---|---|
| 这套设计能否改变 agent 行为，没有证据 | §9 用真实任务对比，不靠感觉 |
| compose 还缺 action 时，已写好的 action 跑不了 | 写一个只调用它的小 compose，或把缺的都写完再 Run |
| 删除 `try_action` 后，改 action 要从 compose 开头跑 | 失败后用 `spr resume` 跳过已完成的 action |
| Run 窗口关闭后，失败的页面状态要重新复现 | 接受。日志文件保留，Debug 窗口可以一直开着 |
| Debug 窗口留在用户 Chrome 里 | 折叠组，空闲 30 分钟关闭 |
| 单步任务也要写 compose | 接受，这是流程没有例外的代价，也留下了可复用入口 |
| 删除 `--description` 后，`endpoints.json` 没有描述可搜 | 接受。Find 主要靠 compose 和 action 的文件头 |
| 静态检查漏掉别名导入 | `runAction` 运行时继续报 `is not defined` |
| 两个 agent 同时 Debug 同一个 compose | 同窗口串行，后到的命令报错 |

## 9. 验证

**自检**（`npm run check`、`npm test`），只守住会静默出错的点：

- `checkCompose`：缺失、blocked、循环、非字面量、注释和字符串里的 `action(` 不算调用。
- `spr run` 拒绝 action，`spr debug` 拒绝不存在的 compose 和 action 名。
- 失败后 `resume` 读当前文件，已完成的 action 不重跑，失败的 action 重跑。
- run 结束时只关 Run 窗口，Debug 窗口保持登记。
- SDK：`import "spr"` 能解析，参数传进函数，`ask` 能停下和恢复。

**真实 Chrome**：按新命令重写 AGENTS.md §2.3，重点验证：

- 一个 Debug 窗口写两个 action，`spr run` 通过后窗口还在。
- Run 成功和失败后，灰色标签组都消失，日志和失败截图都在。
- 窗口关掉后再操作，错误提示能引导重新 `navigate`。
- 不抢前台的要求不变。

**行为对比**：固定 5 个真实任务，覆盖请求型、服务端渲染、签名站点、写操作、canvas，新旧版本各跑：

| 指标 | 期望 |
|---|---|
| 结果来自 `spr run` 的任务比例 | 接近 100% |
| 第一次完成的命令数和耗时 | 不比旧版明显变差 |
| 换参数第二次的命令数 | 找一次、run 一次 |
| 留下的 compose 换参数能否直接跑 | 都能 |

## 10. 实施顺序

一次做完，按依赖顺序：

1. learn 改名 debug，窗口改按 compose 名查找，`navigate` 合并打开窗口。
2. 新增 `run/link.ts`，`spr run` 只接受 compose，加上 Debug 末行。
3. 删除 `try_action`、`--description`、旧提醒和 `closedNote`。
4. 失败截图、失败输出和失败后 `resume`。
5. SDK、worker、`import "spr"` 和文件头。
6. 重写指引和文档，删除 `@endpoint` 顺序检查的说法，加 CHANGELOG。
7. 跑自检，本地安装，做真实 Chrome 验证和 5 个任务的对比。
