# 计划：让 action 和 compose 跑得更快

> 状态：已实现，未提交（2026-11-05）。与方案的差别：单元格批量接口 `setRangeValue` 没抓到调用，写入用逐格 `setSingleValue`；Word 类文档已做读和追加（`wedoc-doc-read`、`wedoc-doc-append`，走 `pad.editor`）；§4B 只验证了有历史参数的 action。
> 实施原则：**一次彻底实现，不分阶段，不留兼容。** 本文列的内容全部做完才算完成；旧的写法和 `~/.speedrun` 里的 action、compose 一起改成新格式，不留迁移代码（AGENTS.md §2.5）。
> 上一份计划（页面脚本只进 speedrun 的标签页）已实现，原文在 git 历史里；它还没验证的项目记在 AGENTS.md §2.3 第 4 条。
> 目标：**同样的事做得更快。** 这次做六项：learn 和 action 的页面操作对齐、先返回结果再关窗口、去掉不必要的 `navigate`、学习路线加上页面函数、录制更多通道、输出遵循渐进式发现，再验证 action 内的并发请求。不做 compose 并发，原因见 §4。

## 0. 结论先行

1. **页面操作对齐**：SDK 补上 `type`、`drag`、`screenshot`、`find`、`read_page` 和坐标、ref 操作。底层已有，**不改扩展**（§2）。
2. **不做 `parallel`**：批量读取用 action 内的 `Promise.all`，这里只验证并写进文档。
3. **先返回结果，再关 run 窗口**：标签组改到后台关闭，每次省 0.14～0.5 秒。
4. **去掉不必要的 `navigate`**：逐个检查现有 action，能只发请求的就改掉。
5. **学习路线加上页面函数**：learn 自动快照页面接口并落盘累积，按需录制函数调用，action 用 `evaluate` 调用（§4C）。
6. **渐进式发现**：默认只给结论和线索，详情按需看；请求按相关性排序（§4E）。
7. **录制更多通道**：WebSocket、Worker、事件流，只有这项要改扩展（§4D），扩展升级后自动重新加载。
8. 开发顺序：先返回结果、页面操作对齐、`navigate` 清理、页面函数、录制更多通道、渐进式发现，全部完成后一起验证。

## 1. 依据

本机 94 次 run 的日志（2026-11-05 统计）：

| 环节 | 实测 |
|---|---|
| 只发请求的 action | 中位 0.1～0.6 秒 |
| 要打开页面的 action | 2.4～4.7 秒 |
| compose 某个内部 compose | 三次分别是 7 秒（209 个请求）、650 秒（33 个请求）、337 秒（416 个请求） |
| 在线表格写 24 格 | 72 条命令，因为 action 不能输入文字，只能在 learn 窗口里逐格做 |

短 run 的大部分时间花在开关标签页（中位数，2026-11-05 统计）：

| action | 总耗时 | 开页面 | 收尾 | 请求本身 |
|---|---|---|---|---|
| 读文档的 action | 0.46 秒 | 0.33 秒 | 0.14 秒 | 0.08 秒 |
| 搜索的 action | 1.34 秒 | 0.66 秒 | 0.43 秒 | 0.23 秒 |
| `git-mr-detail` | 0.87 秒 | 0.34 秒 | 0.54 秒 | 0.50 秒 |

`spr` 命令本身 0.07 秒，不用优化。

## 2. learn 和 action 的页面操作对齐

### 2.1 分工

一套页面操作，两种运行模式，再加一层编排：

- **页面操作层（共用）**：点击、输入、拖动、截图、`find`、`read_page` 等，learn 和 action 都有。
- **learn 负责看和试**：操作后的观察、`inspect`、`trace`、`try_action`、窗口控制。
- **action 负责做**：`spr.params`、返回值、`request`、`waitRequest`、`query`、`evaluate`。
- **compose 负责编排**：`action()`、`spr.ask`，不碰页面。

`request` 这类能力不进 learn：先写 action 再 `try_action`，试通的代码就能交付，也避免 agent 在 learn 里拿到结果就结束。`spr tabs` 不进 action，它读的是用户自己的标签页。

learn 的步骤不自动转成 action 草稿：现有 action 大多用 `request`，转译出的页面操作多半要重写，还要多记录输入内容；agent 自己写更好。

### 2.2 SDK 补齐

都只改 `/Users/me/Code/x/speedrun/skills/spr/src/action-lib/index.js`，daemon 已支持，**不改扩展**：

| API | 用途 | 说明 |
|---|---|---|
| `type(text, { loc? })` | 输入到当前焦点 | 给了 `loc` 先获得焦点，daemon 的 `case "type"` 照 `case "key"` 加这一步 |
| `drag(from, to)` | 滑块、排序、框选 | 对应 `left_click_drag` |
| `screenshot({ region?, scale? })` | canvas 页面确认结果 | 存进 run 窗口，返回路径，不返回 base64；`region` 就是 `zoom` |
| `find(查询)` | 运行时查元素，判断有没有、有几个 | 返回 ref 和持久定位 |
| `read_page(选项)` | 读带结构的页面 | 内容是不可信数据 |
| 坐标 `click({ x, y })` 等 | canvas 这类没有 DOM 元素的页面 | 窗口大小一变就点错，只作兜底 |
| 操作函数接收 `find` 的结果 | 现查现用 | 优先用 ref，失效时退回持久定位 |

规则：ref 不写死在 action 文件里，运行时现查出来的可以用。

`find`、`read_page` 在 `op` 里已有，但 `screenshot` 的存文件方式要确认。这些都要在 run 窗口里实测。

### 2.3 防止再出现缺口

自检加一条：learn 的页面操作都要有对应的 SDK 函数，例外写在清单里。

文档：`/Users/me/Code/x/speedrun/skills/spr/SKILL.md` 的「写代码」一段同步更新。

## 4. 并发：不做 `parallel`，只验证 `Promise.all`

### 4.1 为什么不做

- **需求证据不足**：本机只有 1 个 compose，现有 action 没有一个用 `Promise.all`，96 次 run 里只有 1 次超过 10 秒。
- **常见的并行已经有了**：agent 同时发多条 `spr run` 本来就能跑，96 次里 36 次有重叠，最大一批 8 个，1.6 秒跑完。
- **用的是用户真实账号**：登录态站点大多有频率或风控限制，并发高了可能被限流、影响账号，不是免费的提速。
- **成本高**：compose 里的 action 共用页面，并发要做多标签页，还要改 `waits` 和 journal。

learn 也不做并行：同一个窗口的后一步依赖前一步的页面状态；多个窗口本来就能并行，但慢在 agent 思考。

### 4.2 批量读取的写法

- 同一站点的多个请求：写成一个 action，里面用 `Promise.all` 加小并发，只用一个标签页。
- 每个条目都要打开页面：agent 同时发多条 `spr run`。

从代码看，SDK 的调用不阻塞，`Promise.all` 应该已经能用，但没有验证过。验证通过后写进 `/Users/me/Code/x/speedrun/skills/spr/SKILL.md`，提醒先看站点有没有频率限制。

### 4.3 什么时候再考虑

至少两个不同站点的 compose 串行要超过 30 秒，站点不限流，而且 §4.2 的两种写法都解决不了。云端 MCP 的多调用方是另一回事，要的是排队和按账号限速。

## 4A. 先返回结果，再关 run 窗口

`/Users/me/Code/x/speedrun/skills/spr/src/run/runner.ts` 的 `runAction` 在 `finally` 里 `await this.windows.close(key)`，结果要等标签组关完才返回。

- 最外层 run 改成不等 `close`，失败时只写日志，不影响这次结果。
- `host.end(s)` 仍然同步做完：它清原始请求和 `waits`，后面的 run 不能读到残留。
- `finishRun` 要写 meta 和 `result.json`，这些走窗口目录，不依赖浏览器标签组。
- daemon 退出前等后台关闭完成，否则会留下灰色组。
- 失败截图 `failureShot` 在 `close` 之前，顺序不变。

验证：跑完灰色组照常消失；连续 run 不串页面；两个 run 同时跑互不影响。

## 4B. 去掉不必要的 `navigate`

逐个看 `/Users/me/.speedrun/sites/*/actions` 里用 `navigate` 的 14 个 action：

1. 去掉 `navigate`，只留 `request`，跑一次真实 run。
2. 成功就保留。被 401/403 拒，说明要页面上的请求头或签名，改回 `navigate`，把原因写进 `@note`。
3. 只读的先试；带 `@write` 的不为了测试真发，等用户真要做时再改。

查机器列表的 action（2.8 秒）先试。这是 action 文件的改动，不动 speedrun 代码。learn 指引补一句：写完 action 先试不带 `navigate` 的版本。

## 4C. 学习路线加上页面函数

### 4C.1 为什么

在线表格的内容画在 canvas 上，改动也录不到 HTTP 请求，learn 的提示和指引都指向 DOM，结果用了 127 条命令逐格操作。其实页面有现成接口（2026-11-05 只读探查，写入未验证）：

| 操作 | 接口 |
|---|---|
| 写一块单元格 | `SpreadsheetApp.behaviorApi.cellApi.setRangeValue` |
| 写一格 | `SpreadsheetApp.behaviorApi.cellApi.setSingleValue` |
| 清空内容 | `SpreadsheetApp.behaviorApi.cellApi.clearContent` |
| 插入、删除行列 | `SpreadsheetApp.behaviorApi.dimensionApi.insertRows`、`deleteRows` 等 |
| 读单元格 | `SpreadsheetApp.workbook.activeSheet.getCellDataAtPosition` |

这类接口不是网络请求，是页面里的函数。调用它们时，版本和同步由页面自己处理。这种方式对协作文档和 canvas 应用通用，但前提是页面把接口暴露出来，很多打包后的网站拿不到。

### 4C.2 学习路线

能用上面的就不用下面的，写进 `/Users/me/Code/x/speedrun/skills/spr/SKILL.md` 和 learn 指引：

1. 官方 API：最稳，但需要凭证，适用范围有限。
2. HTTP 请求：`request`、`waitRequest`。
3. 页面函数：`evaluate` 调用页面自己的接口。
4. WebSocket 读取：只读实时数据。
5. DOM 或真实输入：通用兜底。

**停止规则**：同一种页面操作连续失败两次，换下一层，不继续试。

### 4C.3 页面函数：快照落盘，按需录制

页面函数和接口一样要落盘累积，不是每次重新查：agent 用 `rg` 读文件，省上下文，下次也不用再摸一遍。不做常开录制：页面函数太多，全包会拖慢甚至破坏页面，多数站点也用不到。

| 文件 | 内容 | 谁写 |
|---|---|---|
| `learn-windows/<句柄>/page-api/` | 这个窗口的全局对象和方法快照 | learn 窗口自动写 |
| `learn-windows/<句柄>/calls/` | `trace` 记录的调用详情 | `trace` |
| `sites/<站点>/page-api.json` | 站点累积：对象路径、方法名、参数结构、用过它的 action、记录时间和页面版本 | 只由 learn 窗口累积，类似 `endpoints.json` |

流程：

1. learn 窗口打开、页面安静后自动做快照；页面跳转后、第一次操作后再补一次，单页应用的对象可能晚点才出现。
2. 观察里只放一行线索：`页面接口：SpreadsheetApp（查看 page-api/）`。
3. agent 用 `rg` 搜文件，确定候选函数。
4. 要参数时用 `trace`，结构累积到站点文件。

快照规则：

- 只遍历非浏览器自带的全局对象，限制深度和数量。
- **只记名字、类型和结构，不记值。**
- **只读属性描述，不调用 getter**，避免触发页面逻辑。
- 只在 learn 窗口做，run 窗口不扫描。

命令，都不改变页面，不计操作次数：

- `spr learn <句柄> inspect --path <对象路径>`：快照没覆盖到更深的对象时补充查询，规则和快照相同，结果并入站点文件。
- `spr learn <句柄> trace <路径...> --seconds 10`：临时包住这些函数，记下这段时间内的调用，到时间或窗口结束后恢复原函数。这期间用现有命令操作一次页面。

`trace` 的记录：

- 记函数名、参数、返回值的结构和次数，写进 `calls/`，经现有脱敏处理，输出里只给摘要；站点文件只存类型和结构。
- 参数放不下或不能序列化时记类型，不报错。
- 只包 agent 指定的函数；包裹后不改变参数和返回值，函数抛错照常抛出。
- 这是 learn 窗口专用功能，run 窗口不用。

### 4C.4 提示

操作后页面变了但没有新请求，或页面主体是 canvas 时，把「下一步」的提示改成先看 `page-api/`，不再只提示 DOM。

`evaluate` 的 SDK 注释从「兜底」改成「调用页面函数，或做 SDK 覆盖不到的事」。

### 4C.5 先用表格验证

1. 快照和 `trace` 做好后，手动写一格，抓到 `setRangeValue` 和 `deleteRows` 的真实参数。
2. 写 3 个 action，放在 `/Users/me/.speedrun/sites/doc.weixin.qq.com/actions/`：
   - `wedoc-sheet-read`：读一个区域。
   - `wedoc-sheet-write`：`@write`，写一个区域。
   - `wedoc-sheet-delete-rows`：`@write`，删除指定行。
3. 写操作的保护：
   - 接口不存在时明确报错，不静默失败。
   - 写之前读目标区域，非空就先停下来确认，除非调用时明确允许覆盖。
   - 写完读回校验，再重新打开页面确认已保存。
   - 用 `waitFor` 等 `SpreadsheetApp` 就绪，不用固定 `sleep`。
4. 确认撤销和其他人协作时的同步正常。这些都是推测，没实测前不下结论。
5. Word 类文档用同样的方法探查，有接口就走接口，没有就用 `type`。需要一个可以随便改的测试文档。

### 4C.6 改动

- `/Users/me/Code/x/speedrun/skills/spr/src/commands/learn.ts`：新增 `inspect`、`trace`，打开窗口和跳转后做快照。
- `/Users/me/Code/x/speedrun/skills/spr/src/browser/host.ts`：提供这些操作，用现有的 `evaluate` 通道。
- 新增 `/Users/me/Code/x/speedrun/skills/spr/src/learn/page-api.ts`：快照、合并进 `sites/<站点>/page-api.json`。
- `/Users/me/Code/x/speedrun/skills/spr/ARCHITECTURE.md`、`/Users/me/Code/x/speedrun/PRIVACY.md`：写清新文件和记录范围。
- `/Users/me/Code/x/speedrun/skills/spr/src/learn/observe.ts`：改「下一步」的提示。
- `/Users/me/Code/x/speedrun/skills/spr/src/action-lib/index.js`：改 `evaluate` 的注释。

要确认：页面跳转后包裹的函数会丢失，`trace` 要明确报告，不能当成没有调用。

## 4D. 录制更多通道（要改扩展）

录制的目的是看懂页面，不是全都重放。WebSocket 消息往往依赖连接状态、版本号和确认，重放可能写坏数据。

现在是在页面里包住 `fetch` 和 XHR，所以其他通道都看不到。改用 CDP 的 `Network` 事件：

| 通道 | 用途 | 重放 | 决定 |
|---|---|---|---|
| Worker 里的请求 | 本质是 HTTP，现在漏了 | 大多能 | 录 |
| 事件流（SSE） | 推送和流式内容 | 发起请求，读取结果 | 录 |
| WebSocket | 看懂实时数据和保存通道 | 读取可以，写入不做 | 录，只用于观察和读取 |
| `sendBeacon` | 大多是埋点 | 没必要 | 不录内容 |

规则：

- 默认只记摘要：地址、方向、大小、次数，内容按需查看，心跳不进观察。
- 内容走现有脱敏，并设大小上限。PRIVACY.md 要写清录了什么。
- 不提供重放 WebSocket 写入的 SDK。
- 提供读取推送的 SDK `waitMessage`，用法类似 `waitRequest`：等到匹配的消息后返回。

要验证：`chrome.debugger` 下这些事件能否收全，Worker 是否要单独附着，开启后对页面速度的影响。

## 4E. 输出遵循渐进式发现

### 4E.1 原则

默认只给结论和线索，agent 需要时再往下看，每一层都说明下一步去哪看：

| 层 | 给什么 | 例子 |
|---|---|---|
| 1. 结论 | 这一步发生了什么 | `ok`，3 个新接口，页面是 canvas |
| 2. 线索 | 少量重要条目和下一步 | 相关接口名、「用 `inspect` 查页面函数」 |
| 3. 索引 | 文件路径或查询命令 | `requests/….json`、`--path` |
| 4. 原文 | 完整内容 | 只在主动读取时看 |

判断标准：这条信息会改变 agent 的下一步吗；需要时能找到吗；输出有上限吗，超了有没有说明还有多少、在哪里。

### 4E.2 关键信号

观察里加一行短信号，它们能直接改变 agent 的方向：

- 页面主体是 canvas。
- 发现页面接口，如 `SpreadsheetApp`。
- 操作后页面变了，但没有新请求。
- 有 WebSocket 消息。

### 4E.3 请求按相关性排序

不做精确判断，只决定谁排在前面。**其余不隐藏，折叠成数量和查看方式**，排错了也找得到。

| 信号 | 影响 | 现状 |
|---|---|---|
| 这一步操作引发的（`cause`、`phase`） | 强加分 | 已有 |
| 请求里出现了 agent 输入的值 | 强加分 | 要做 |
| 响应里出现了页面上看得到的文字 | 强加分 | 要做 |
| 同站、JSON、响应体有内容 | 加分 | 已有 |
| 已标记为埋点（`noise`） | 强减分 | 已有 |
| 路径含 `report`、`log`、`track`、`gray`、`config`、`version` | 减分 | 要做 |
| 空闲时定期发出（轮询） | 减分 | 已有 |
| 静态资源、失败请求 | 减分 | 已有 |

输出示例：

```text
请求：可能相关 3 个
  #120339 GET /dop-api/get/sheet → 200 JSON
  ...
其余 32 个（配置和上报）：见 timeline.jsonl
```

内容匹配要在 daemon 里比较输入值、响应和页面文字，比较时用真值，输出只给结果，不输出值。

### 4E.4 文档和工具

- `/Users/me/Code/x/speedrun/skills/spr/SKILL.md`（约 18KB）只留主流程，canvas、签名、表格这类专题放单独文件，遇到时再读。
- 页面函数分层：线索一行 → `page-api/` 文件 → `calls/` 调用详情。
- MCP 的 `search_actions` 同样先给名字和一句话，选中后再看参数。

### 4E.5 改动

- `/Users/me/Code/x/speedrun/skills/spr/src/learn/observe.ts`：请求排序、折叠，加关键信号。
- `/Users/me/Code/x/speedrun/skills/spr/src/learn/explore.selfcheck.ts`：排序后折叠的请求数量正确，没有请求被丢掉。
- `/Users/me/Code/x/speedrun/skills/spr/src/learn/guide.ts`：同步学习路线和专题入口。

## 5. 验证

### 5.1 先留基线

改代码之前，用同样的参数把下面三件事各跑一次，记下时间：

- 搜索的 action、读文档的 action：单次 run。

耗时从 `run-windows/<名字>/timeline.jsonl` 的首尾时间算，不新增统计功能。

### 5.2 自检

`npm run check`、`npm test`。`/Users/me/Code/x/speedrun/skills/spr/src/run/runner.selfcheck.ts` 只加「坏了会静默出错」的点：


### 5.3 真实 Chrome

按 AGENTS.md §2.3，`node /Users/me/Code/x/speedrun/skills/spr/setup.js` 重装后验证，全程记录前台应用和选中的标签页：

- `type`：写一个 action，在企业微信测试表格里写入中文，刷新后还在。
- `Promise.all`：一个 action 里同时发 5 个 `request`，结果都对；带签名头的站点也要试。
- SDK 新增函数：在 run 窗口里各跑一次；`find` 返回的结果能直接交给 `click`。
- 观察：表格页面有 canvas 和 `SpreadsheetApp` 的信号；相关请求排在前面，其余数量对得上。
- 快照、`inspect`、`trace`：文件和输出里没有值和票据；快照不触发 getter；`trace` 结束后函数恢复原样，页面照常工作；页面跳转时有明确提示。
- `sites/<站点>/page-api.json`：新窗口不重新探查也能用 `rg` 查到，run 不写它。
- 录制通道：WebSocket、Worker、事件流都录到摘要，内容脱敏；开启后页面速度没有明显变慢。
- 表格 action：按 §4C.5 验证，写完重新打开页面内容一致。

### 5.4 完成标准

- 表格 action 能重复运行。
- 学一个新页面需要的命令数比这次表格（127 条）明显减少。
- 把 `Promise.all` 的验证结果写回本文。

## 6. 这次不做

- `@cache`：最近 100 次 run 里，参数完全相同的真实重复大约只有 6 次，每次只省约 0.5 秒。等 MCP 有多个调用方再做。
- 常驻页面（`@warm`）、`navigate` 轻量模式、learn 一次执行一批操作：等这次的数据出来再排。
- 上传、下载、真实粘贴：这次范围外，要做时另写方案。系统弹窗已提前做（`page/dialogs.js`）：实现时发现离开确认会抢前台并阻塞 run。
- compose 并发（`parallel`）和跨 run 的站点限速。
