# 设计：写出可复用的脚本是唯一主线

> 状态：方案，未实现。不留兼容（AGENTS.md §2.5），旧命令和旧文件格式一起改掉。

## 0. 结论

speedrun 对 agent 来说不再是"学网站的工具"，而是一套**写脚本的开发环境**：

| 编程里 | speedrun 里 |
|---|---|
| 程序 | action（站点能力）、compose（用户的事） |
| 编译并运行 | `spr run` |
| undefined reference | `fail missing-action` |
| 调试器 | `spr debug` |
| 崩溃现场 | 失败后保留的窗口 |

六个决定：

1. **目标写进每条命令**：`spr debug <名> …` 的 `<名>` 就是要交付的脚本，取消句柄。
2. **只有一种运行方式**：删除 `try_action`，所有运行都是 `spr run`。
3. **run 先检查再执行**：缺的 action 一次报全，什么都不发。
4. **失败现场留给 debug**：`spr run x` 失败后，`spr debug x read_page` 直接看失败的页面。
5. **修完接着跑**：compose 失败后可以 `spr resume`，已完成的 action 不重发。
6. **通过就结束**：`spr run <名>` 成功后，同名 debug 窗口自动关闭，不用 close。

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

- **文档和代码不一致**：`guide.ts:96` 和 AGENTS.md 说 run 会检查 `@endpoint` 的发送顺序，run 相关代码里没有找到这个检查。
- **verified 太宽松**：`finishRun` 在 run 成功后就把 draft 改成 verified，写死参数也能通过。本机 `ithome-search.js` 里有默认值"华为"。
- **`try_action` 有假阳性**：它沿用 learn 窗口的页面状态和请求头，所以 `finishRun` 才需要一条"try_action 成功过但 run 失败"的提示。
- **重跑 compose 可能重发写操作**：journal 目前只在 `spr.ask` 时保留。
- **失败现场会丢失**：run 失败后窗口关闭，只留截图，要到 learn 窗口重新复现。
- **`request` 不能覆盖全部**：`ithome-search` 是服务端渲染页面，用的是 `query`，所以自动生成只能覆盖一部分 action。

### 讨论过的方案

| 方案 | 结论 |
|---|---|
| Stop hook 拦截没有经过 run 的回合 | 暂缓。事后拦截，而且只对 Claude Code 有效 |
| 把目标告诉 agent：第二次要最快 | 否定。这又多了一个目标。"第二次最快"是衡量系统的指标，不写给 agent |
| learn 只给结构，真实数据只在 run 里出现 | 暂缓。改动大，截图仍会露出内容，排查也更难 |
| 开局用 todo 工具写明目标 | 不作为解法。只有部分宿主有，agent 仍可能跳过，而且写不好交替的 learn 和 run |
| 主 agent 和学习的子 agent 分离 | 暂缓。隔离干净，但依赖宿主 |
| **把任务变成写脚本，`spr run` 通过就是完成** | **采用**。只留一个目标，学习变成调试手段，交替也变成同一个循环 |

## 1. 主循环

SKILL 开头只留这一段：

> 你的任务：写一个脚本完成用户的事，用 `spr run` 运行，把返回值告诉用户。脚本留着，下次换参数直接用。

```text
找：rg 已有脚本 ──命中──▶ spr run ──▶ 把返回值告诉用户
      │没有
      ▼
写：compose（要串几步时），或直接选一个 action 名
      ▼
spr run <名> ──ok──▶ 把返回值告诉用户
      │fail missing-action / 运行失败
      ▼
spr debug <名> …  看页面、触发请求、写 action
      └──▶ 回到 spr run
```

没有"先学后交付"两个阶段，只有一个循环。不再需要 todo：缺什么由 `spr run` 报，目标由每条命令的 `<名>` 和输出末行复述。

示例：

```bash
# 写好 compose：zhihu-vote-hardcore 调用 zhihu-search、zhihu-vote
~/.speedrun/bin/spr run zhihu-vote-hardcore --q agent
# fail missing-action zhihu-search、zhihu-vote（没有执行任何操作）
~/.speedrun/bin/spr debug zhihu-vote-hardcore navigate https://www.zhihu.com/search?q=agent
# 观察：#1203 GET /api/v4/search_v3 带着「agent」……
~/.speedrun/bin/spr debug zhihu-vote-hardcore gen 1203 --name zhihu-search --param q=agent
~/.speedrun/bin/spr run zhihu-vote-hardcore --q agent
```

## 2. 命令面

| 命令 | 作用 |
|---|---|
| `spr run <名> [--参数 值]` | 运行 action 或 compose，唯一的运行方式 |
| `spr resume <编号> [--answer '<json>']` | 接着跑：停在 `spr.ask` 的，或失败后修好的 |
| `spr debug <名> navigate <网址\|tab 号\|back\|forward>` | 没有窗口就开一个，第一次输出 debug 指引 |
| `spr debug <名> find \| read_page \| get_page_text \| computer … \| form_input … \| inspect \| trace` | 和现在的 learn 工具相同 |
| `spr debug <名> gen <请求编号> [--name <action 名>] [--param 名=值 …]` | 从录到的请求生成 action 文件 |
| `spr debug <名> close` | 放弃时关窗口；跑通后不用调 |
| `spr debug list`、`tabs`、`status`、`doctor`、`daemon restart` | 不变 |

删除：`learn new`、`learn close <句柄>`、`try_action`、句柄、`closedNote`、操作上的强制 `--description`。

规则：

- `<名>` 可以是还不存在的脚本，这样单个 action 也能直接开始。`list` 成为保留名。
- 一个名字同时只有一个窗口。窗口关掉后（空闲 30 分钟、daemon 重启、扩展重连），`find` 这类命令报错，提示重新 `navigate`。
- 一个窗口可以写多个 action，所以窗口绑定到顶层 compose，而不是每个 action 一个窗口。
- 200 次操作上限、同一窗口串行、空闲关闭都保留。

## 3. run 的语义

### 3.1 执行前检查

只读文件，不开窗口，递归检查 compose 调用的 compose：

- 脚本不存在：`fail missing-action a、b（没有执行任何操作）`，并给出 `下一步`。
- 依赖是 `@status blocked`：直接失败，列出 `@note`。这样不会执行到一半才发现。
- `action()` 的名字不是字面量：用法错误。否则检查不完整。
- 循环调用：用法错误。

这一步也解决了重跑风险：缺 action 时前面的写操作不会先发出去。

### 3.2 失败保留现场

最外层 run 失败时不关窗口，保留 10 分钟，每个名字保留最新一个。输出写明：

```text
fail zhihu-vote：403
现场：窗口保留 10 分钟：spr debug zhihu-vote read_page
```

这是输出里看得见的事，不违反 ARCHITECTURE 原则 5。实现要点：

- `host.end` 现在立即清原始请求（`browser/host.ts:184`），要推迟到现场关闭。
- 现场窗口的 kind 是 `run`，请求不进 `endpoints.json`（`record/ingest.ts:359`）。debug 接管后要改成进入，这样现场里录到的请求可用于 `gen`。

### 3.3 失败后继续

`runner.ts` 的 journal 目前只在 ask 时保留。改成 compose 失败时也保留：

- 输出 `恢复：spr resume <编号>`（journal 非空时才有）。
- 恢复时读**当前文件**，因为 agent 刚修过。ask 恢复仍用停下时的代码。
- 现有的"调用名字和参数不同就失败"继续作为保护。
- 局限：只记录已完成的 action。失败的 action 自身发出一半的写操作，要靠「已发出的非 GET 请求」核对。

### 3.4 verified 要证明"第二次"

现在跑成功一次就变 verified，写死参数的脚本也能通过。本机 `ithome-search.js` 就有 `params.q ?? "华为"`。新规则：

| 脚本 | 变成 verified 的条件 |
|---|---|
| 没有参数 | 成功一次，结果非空 |
| 有参数，只读 | 两组不同参数都成功，结果非空 |
| `@write` | 用户真要做时成功一次，不为验证多发 |

- 空结果是 `null`、`[]`、`{}`。
- 两组参数结果完全相同时警告："参数可能没生效"，不升级。
- 第一次成功后输出 `下一步：换一组参数再跑一次`，但这不挡交付：用户的结果已经拿到了。
- 记录放 daemon 内存，重启后重跑一次即可。verified 不拦任何操作，丢了代价很小。

### 3.5 run 成功

同名 debug 窗口自动关闭。输出不再提醒 close。

## 4. debug 的输出

**每条输出末行复述目标**，由 3.1 的检查算出：

```text
目标：spr run zhihu-vote-hardcore（还缺 zhihu-vote）
```

它替代现在的三处提醒：`observe.ts` 的 uncovered、`learn.ts` 的每 15 次 nudge、`closeLearn` 的未交付提醒。

**观察里给可执行的下一步**：请求里出现 agent 输入的值时（`observe.ts` 已有 `sentIt`）：

```text
下一步：#1203 GET /api/v4/search_v3 带着你输入的「agent」：
  spr debug zhihu-vote-hardcore gen 1203 --name zhihu-search --param q=agent
```

**`gen` 的范围**：

- 只生成 `request` 型 action：`navigate` 发出请求的页面，`request` 搬 url、method、body，把 `--param` 的值换成参数。
- 先带 `navigate`，保证能抄到请求头；去掉 `navigate` 的提速仍按现有指引手动试。
- 请求里有 `⟨secret_…⟩` 别名时不写进文件，标 TODO 并提示用 `auth`。
- 目标文件已存在就拒绝。
- 不生成 DOM action：`ithome-search` 这种服务端渲染页面没有可用请求，仍然手写 `query`。

## 5. 文件格式和 SDK

action 和 compose 共用一种写法：

```javascript
/**
 * @description 在知乎搜索，返回回答列表
 * @status draft
 * @param q 搜索词
 * @param n?:number 要几条
 */
import { navigate, request } from "spr";

export default async ({ q, n = 30 }) => {
  await navigate("https://www.zhihu.com/search");
  const r = await request({ url: `https://www.zhihu.com/api/v4/search_v3?q=${encodeURIComponent(q)}` });
  return r.json().data.slice(0, n);
};
```

| 改动 | 原因 |
|---|---|
| 参数走函数参数，删除 `spr.params` | 脚本就是函数，没有"默认写死华为"的惯性 |
| `import … from "spr"` | 取代 `../../../lib/index.js` 和 `../lib/index.js` 两种路径。`~/.speedrun/node_modules/spr` 链到 `lib/` |
| `spr.ask` 改成 `ask` | `spr` 对象不再需要 |
| `@summary` 并入 `@description` | 同义 |
| 删除 `@endpoint` | 手写且没有校验。覆盖关系改由成功 run 里的 `request` 命令回填 `endpoints.json` 的 `action` 字段 |

顺带修一个文档错误：`guide.ts:96` 和 AGENTS.md 说 run 会检查 `@endpoint` 顺序，代码里没有这个检查。

## 6. 保留不动

- action 和 compose 两层。它们是"库和主程序"的关系，也是 missing-action 循环成立的前提。compose 不碰页面，这是 resume 能安全重放的基础。
- `compose` 这个名字。改名没有行为收益。
- 扩展、页面脚本、录制、脱敏、请求头继承、`spr.ask` 流程。
- `get_page_text`：写 DOM action 时需要看正文。

## 7. 这次不做

- **learn 只给结构**：改动大，也影响排查。等 §9 的数字说明 agent 还在绕过 run 时再做。
- **Stop hook**：只对 Claude Code 有效，同样等数字。
- **主 agent 和子 agent 分离**：依赖宿主。

## 8. 风险

| 风险 | 处理 |
|---|---|
| 这套设计能否改变 agent 行为，没有证据 | §9 用真实任务对比，不靠感觉 |
| 删除 `try_action` 后，依赖深层页面状态的 action 每次都要从头走 | run 本来就要从头走，这是真实成本；`@write` 的多步流程最难受，实测后再判断要不要补 |
| 失败现场让原始请求多留 10 分钟内存 | 不落盘，TTL 到期清掉，写进 PRIVACY.md |
| 现场窗口留在用户 Chrome 里 | 折叠组，每个名字一个，闲置 20 秒解除附着 |
| 删除操作的 `--description`，endpoint 的 description 变少 | 找脚本靠文件头，endpoint 描述只影响还没写成脚本的接口。这是判断，不是数据 |
| 两个 agent 用同一个名字 | 同窗口串行，报错提示换名 |
| 简单任务第一次也要写脚本 | 接受，这是单一规则的代价 |

## 9. 验证

固定 5 个真实任务，覆盖请求型、服务端渲染、签名站点、写操作、canvas，新旧版本各跑：

| 指标 | 期望 |
|---|---|
| 结果来自 `spr run` 的任务比例 | 接近 100% |
| 第一次完成的命令数和耗时 | 不比旧版明显变差 |
| 换参数第二次的命令数 | 找一次、run 一次 |
| 留下的脚本换参数能否直接跑 | 都能 |

`spr status` 增加两个长期数字：开过 debug 但目标从没跑通的比例，没开 debug 直接命中脚本的 run 比例。

## 10. 实施范围

一次做完，按依赖顺序：

1. learn 改名 debug（约 40 个文件、479 处），目录 `debug-windows/`、`debug-guide.md`，句柄改成名字。
2. run 的检查、`missing-action`、目标复述、成功自动关窗口；删除 `try_action`。
3. 失败现场、失败后 resume、verified 新规则。
4. SDK 和文件头；改写现有 action、compose。
5. `gen`、观察里的下一步、`status` 数字。
6. 重写 SKILL.md、debug 指引、ARCHITECTURE.md、AGENTS.md §2.3、示范文档、PRIVACY.md、CHANGELOG.md。
