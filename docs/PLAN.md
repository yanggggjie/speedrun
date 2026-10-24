# 计划：人做一半，agent 接着做完——并把做过的事都变成 task

2026-10-24。接在"薄扩展 + holder 大脑 + context/api"之后。上一版计划（薄扩展、分段日志、context/api）已实现，状态见 git 历史（`refactor/thin-extension` 分支）。设计依据见 `/Users/me/Code/x/TwoCursor/docs/DESIGN.md`，当前实现见 `/Users/me/Code/x/TwoCursor/skills/tabbot/ARCHITECTURE.md`。

## 1. 为什么要改

yodo 的基准：同一个任务，学会后运行 56 秒、$0.24，`agent-browser` 6 分 25 秒、$0.83（`/Users/me/Code/x/yodo/yodo-browser-skill/README.md`）。它好用有四个原因：学到的东西变成**带参数、验证过的 task 代码**；在**自己的窗口**里运行，不碰用户的标签页；录制保真；边界清楚。

我们上一版做了"升级"，但：

- 把学到的知识留在原始日志里，每次任务让 agent 临场重新逆向（X「不感兴趣」的 `action_metadata` 是手工从时间线响应里翻出来的），**没有 task 层，就没有"学一次、以后秒做"**。
- 把"接力"做成**在用户正在用的页面上继续操作**，和用户同时使用浏览器天然冲突：后台标签页不渲染、租约被用户滚动打断、要求用户保持不动。
- 依赖一个新的、没在真实 Chrome 里验证过的东西（`chrome.userScripts` 开关），旧扩展的内容脚本残留还造成重复录制和响应体被截断。

结果是 X 上"筛选并批量标记"这件事，用户配合了五六次，仍然没做完。

## 2. 范围与原则

**只做一个方向：人做一半，agent 接着做完。** 不做"agent 做一半、交给人"。登录、验证码、支付确认这类需要人的步骤，agent 只一次性报告"需要你先在自己的 Chrome 里完成 X，然后再叫我"，不等待、不抢控制、不回头问页面。写操作（公开发布、删除、支付）是否执行，放在对话里确认。

**不再有租约。** agent 在自己的 `tabbot run` 窗口里干活，不碰用户的标签页，所以没有抢控制的问题。

原则（按优先级）：

1. **快**。已会的事查表直接跑；请求优先；不会的事只探索一次。
2. **所有做过的事都要成为知识**，知识就是 task（代码）。日志是原料，不是知识。
3. **DOM 只做一次**：agent 不得不用页面操作完成的事，做完立刻固化——能看出稳定的请求就固化成请求，看不出才保留 DOM 步骤。
4. **可靠性先于功能**：没有真实扩展的端到端测试，不交付。

## 3. 使用场景

核心句式只有一个：**我先做一部分，你接着做完。**

| 场景 | 例子 | 靠什么 |
|---|---|---|
| 1. 举一反三，批量化 | 我手动给一条帖子点了「不感兴趣」/点赞/收藏/加购，"按这个标准把剩下的都做了" | 日志里有我那次点击的接口；agent 取列表、按标准筛，批量重放 |
| 2. 读取并整理我正在看的东西 | 我打开了订单页/日志平台/讨论串，"把这个列表全拉下来，汇总一下" | 日志里有列表接口，用游标翻页，不滚动 |
| 3. 跨站搬运 | 我在 X 上看到一篇，"总结后发到知乎和即刻" | 读 X 的来源数据；知乎/即刻的发布来自我之前发过的记录，没有就让我先发一次 |
| 4. 同一件事再做一遍 | 我昨天查了一次某条件的日志，"换成最近 1 小时再查"，或"以后每天帮我查" | 事后学习成 task，带参数复用 |
| 5. 回忆我做过什么 | "我刚在 V2EX 看了什么？""我看过那个帖子的链接" | 日志检索（`context`、`req find`） |
| 6. 我卡住了，请你接着查 | 页面报错/结果不对，"看我刚才的操作和请求，帮我找原因或换个方式" | 日志里有我的步骤和请求 |

明确的限制：没有体现在地址或请求里的页面状态（未提交的草稿、弹窗、前端临时筛选）接力不了，agent 会说明"这部分我没法接"；风控站点（抖音、小红书）只能靠页面操作；重复动作要先读状态，task 要幂等。

## 4. 目标架构

```
CLI（argv→RPC→打印） ──socket──▶ holder（大脑） ◀──ext.sock── relay ◀──native messaging── 扩展（固定 ABI，无状态）
                                   │                                                        │
                                   ├ 日志（常驻录制，分段队列）                               ├ 内容脚本（随扩展打包）：录制 + 执行
                                   ├ task 运行时（worker 线程）                               └ 管理 `tabbot run` 窗口里的标签页
                                   └ `tabbot run` 窗口与标签页池
```

### 4.1 `tabbot run` 窗口（和 yodo 一样，不打扰用户）

- agent 的所有页面都在一个单独的窗口里：窗口里有一个锚点标签页（`about:blank`，标题 `tabbot run`）保证窗口存活，task 需要的页面在锚点旁边开，用完关。
- 开窗口 `focused: false`，不抢焦点；用户关掉窗口，下次需要时静默重建；holder 退出时关闭。
- **归属记在 holder 里**，扩展不存任何状态：holder 记 `runWindowId` 和它开的标签页。扩展握手（`hello`）之后 holder 做一次对账：按标题 `tabbot run` 找窗口，当前 `runWindowId` 保留，其余孤儿整扇关闭；从不按 id 关用户的窗口。
- **页面操作只能在窗口里自己开的标签页上做**（`goto`、点击、填写、按键、滚动）；**纯 `fetch`/重放（不改页面）可以在任意同源标签页里发**，包括用户的，因为不影响页面，也不需要租约。同源标签页都没有时，在 run 窗口里开一个。
- **标签页池**：同一个源的标签页开一次留一段时间（默认 5 分钟空闲），后续 task 复用，冷启动 3–5 秒、热启动接近零；空闲到期再关。一个 task 里只 `goto` 一次的约束沿用 yodo。
- 已知限制：macOS 上窗口被别的窗口完全遮住时，Chrome 可能把它当后台页面，不渲染。所以 task 默认不依赖滚动/懒加载，用接口取数据；必须靠渲染的 task 在文档里注明，需要时可以把 run 窗口放在屏幕边角。

### 4.2 扩展（固定 ABI，仍然无状态）

扩展只做管道，但这一版**页面脚本随扩展打包**，不再依赖 `chrome.userScripts`：

- `manifest.json` 静态声明内容脚本：`common.js`、`recorder.js`、`executor.js` 合成一份，`world: "MAIN"`，`run_at: document_start`，所有 frame，匹配 http/https；`bridge.js` 在 `ISOLATED` world，把页面消息转给扩展。权限：`tabs`、`nativeMessaging`、`alarms`、`scripting`、`host_permissions: <all_urls>`；去掉 `userScripts`。
- ABI 2：`call { tabId, fn, args }`（在页面 MAIN world 里调用 `window.__tcr.exec.<fn>`，用 `chrome.scripting.executeScript`，结果直接返回，页面跳转打断时返回 `navigated`）、`tabs`（列所有标签页，含 `about:blank` 锚点和标题）、`openWindow`、`openTab`、`closeTab`、`closeWindow`。**没有任意代码执行入口**。
- 与上一版决定不同的地方（需要你确认）：上一版选了"任意代码 + `userScripts`"，为的是改页面脚本不用刷新扩展。实际代价更大——一个新的用户开关、Chrome 135 以上的要求、旧内容脚本残留造成重复录制和响应体截断，还没在真实 Chrome 里验证过。这一版把可靠性放在便利前面：页面脚本稳定之后很少改，改了刷新一次扩展即可。
- 从旧版本升级时，旧扩展注册过的内容脚本会残留（重复录制的原因）：这一版 `manifest` 用静态内容脚本，旧的动态注册脚本在升级时需要**移除扩展再重新加载一次**（扩展 ID 由 `key` 固定，不变）；`install.md` 写明。

### 4.3 录制（常驻，不再看前后台）

- 去掉 `recorder.js` 里的前台门槛：所有 http/https 页面、所有标签页（包括 run 窗口里的）都完整录。体量靠已有的噪声过滤、去重和 500MB 的先进先出队列控制。
- 来源仍只看 `isTrusted`（真是 `human`，假是 `page`）；agent 的命令记录（`cmd`）保留，**并且记下耐久定位**（role、name、CSS）——这是 DOM 步骤能固化成 task 的前提。
- `presence`/在场信号、租约事件删除。

### 4.4 task 层（从 yodo 搬格式，重写运行时）

**位置与命名**：`~/.tabbot/task/<站点>-<动作>.js`，如 `x-home-timeline.js`、`x-not-interested.js`。文件头沿用 yodo：`@summary`、`@param 名字 说明`（`?` 可选）、`@status: draft|verified`、`@timeout`，新增 `@source <日志编号>`（学自哪几条记录，方便重学）和 `@note`（坑，如 queryId 会变）。

**运行时**：task 在 holder 里的 worker 线程运行（可超时终止，不拖垮 holder）。`tabbot.run(async ({ page, params }) => …)`，原语很少：

| 原语 | 作用 |
|---|---|
| `page.fetch(url, init)` | 在同源标签页里发请求，带登录态；结果是 `{ status, body }`；不改页面 |
| `page.eval(fn, ...args)` | 在页面里执行函数 |
| `page.goto(url)` | 在 run 窗口的标签页里导航（一个 task 只 `goto` 一次） |
| `click/fill/press/select/check/scroll(page, {role,name}\|css)` | 页面操作，只在 run 窗口的标签页；动作自动等元素可见可用 |
| `expect(res, { status, path, equals })` | 检查状态码和业务码，不对就抛错 |

沿用 yodo 的规则：结果必须对应本次参数；检查 HTTP 状态和业务码；有副作用的 task 先读状态、已满足返回 `already`；有副作用的操作返回被操作对象的稳定 id。步骤超时 60 秒、整个 task 默认 115 秒。**参数支持数组**（`--ids a,b,c`），内部限并发（默认 4）发请求，一次调用处理一批。`run`、`eval`（组合）、参数校验、运行历史沿用。

**固化是懒的**：第一次需要时才写，不预先烧 token。规则写进 skill：做完一件可能再做的事，就把它写成 task，验证一遍，标 `verified`。

### 4.5 学习工具（让"写 task"的机械部分自动化）

拟用名（你确认再落盘）：

| 命令 | 作用 |
|---|---|
| `tabbot task [站点]` | 列出已会的 task（站点、参数、状态） |
| `tabbot origin <编号>` | 对某个请求，把每个参数值去更早的响应里找，告诉你它出现在哪个请求、哪个 JSON 路径；解决 `action_metadata`、`tweet_id` 这类参数来源 |
| `tabbot task new <编号> [--name x-like]` | 根据某条请求生成 draft：请求模板、变量变成 `@param`、`origin` 推出的取值代码、`expect` 检查。agent 只补语义的部分 |
| `tabbot context` | 在现有输出上加：该站点"已会的 task"，和"录到了但还没有 task 的操作"（如 `POST FavoriteTweet`） |

`api`、`req find`、`replay` 保留，`replay` 变成 task 底层和临场探索的原语。

### 4.6 skill 的流程（先查再做）

1. `tabbot context [站点]`：用户最近做了什么、已会哪些 task、哪些操作还没固化。
2. 有对应 task：直接 `tabbot run`。
3. 没有但日志里有对应请求：`tabbot task new <编号>` 生成 draft → 补参数和判断 → `run` 验证 → 标 `verified`。
4. 日志里也没有：在 run 窗口里用页面操作做**一次**，做完立刻回到第 3 步，把这次的命令记录和它引发的请求固化。
5. 需要人：一次性报告，不等待。

## 5. 删除、保留、改动

| 删除 | 保留 | 改动 |
|---|---|---|
| 租约、`takeover`/`release`/`wait`、你页面上的 `act`、在场信号与撤销逻辑、`userScripts` 依赖和 `register`/`exec` 任意代码、`PageHost` 的 uid 回程通道 | 常驻录制、分段日志、`context`、`api`、`req`、`replay`、别名替换、脱敏、holder 当大脑、CLI 零逻辑 | `recorder.js`（去门槛）、`executor.js`（只在 run 窗口标签页上做页面操作，加 role/name 定位）、`ingest.ts`（`cmd` 记耐久定位）、`pages.ts`（改成 `call`）、`commands.ts`（删租约命令，加 task 相关命令）、扩展 ABI 2、`doctor`（去掉 user-scripts 检查，加 run 窗口检查） |

## 6. 阶段与验收

每个阶段单独提交，阶段结束前跑 `npm run check`、`npm test`；涉及真实扩展的阶段再跑端到端。

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0. 真实扩展端到端测试 | 用 Chrome for Testing + 一次性 profile 加载扩展，注册该 profile 的 native messaging host，拉起 daemon，在本地夹具站点（带 fetch/XHR、列表、表单）上自动验证：装脚本、录制、重放、`call`、开关标签页和窗口 | `npm run e2e` 一条命令通过，不依赖用户的 Chrome；失败就不交付 |
| 1. 页面脚本随扩展打包 | 静态内容脚本、`call`、ABI 2；删 `userScripts`、`register`、`exec`；录制去门槛；`install.md` 写明移除旧扩展再加载 | 端到端通过；旧脚本不再残留重复录制 |
| 2. `tabbot run` 窗口与标签页池 | 开/关窗口和标签页、对账、池化复用、页面操作限定在自己的标签页 | 端到端：开窗口不抢焦点、关窗口静默重建、孤儿清理、池复用 |
| 3. task 运行时 | worker 线程、SDK 原语、`run`、`eval`、参数（含数组）、`expect`、运行历史、超时 | 夹具站点上的 task 能在后台窗口里跑通；批量 20 条 < 3 秒 |
| 4. 学习工具 | `cmd` 记耐久定位、`origin`、`task`、`task new`、`context` 加"已会/未固化"；skill 重写成"先查再做" | 夹具上：从一次手动点击出发，`task new` 生成的 task 不改就能跑通 |
| 5. 清理 | 删租约相关命令、事件、文档；更新 `ARCHITECTURE.md`、`DESIGN.md`、`SKILL.md`、`CHANGELOG.md`、`PRIVACY.md` | `check`、`test`、`e2e`、`verify:pack` 全过 |
| 6. 真实站点验收 | ① X：从推荐流取帖子、按标准筛、批量「不感兴趣」，用户只配合"先手动做一次"；② yodo 基准：读 X Following 最近 3 条 → 摘要 → 发到知乎和即刻 | ① 用户配合 ≤ 1 次，总耗时 < 2 分钟；② 学会后 ≤ 1 分钟 |

## 7. 风险与取舍

- **常驻录制的保真度低于 CDP**：缺请求头里浏览器管的部分、Worker 请求；对绝大多数站点够用。关键任务学习时如需要，可只对 run 窗口的标签页临时加 CDP 验证（会有调试横幅，仅限 run 窗口）。
- **签名类请求头**（如 X 的 `x-client-transaction-id`）可能让原样重放被拒：被拒就降级到页面操作，做一次后固化；这在阶段 6 的 X 验收里实测。
- **task 会过期**：站点改版会让 task 失败。失败时 agent 回到日志重学，不是重新探索；`@source` 记录了出处。
- **agent 在你的登录态里无人看着执行**：写操作的确认在对话里；task 不保存任何凭据，只在页面里借当前登录态。
- **macOS 窗口遮挡**：见 4.1。
- **ABI 变化**：阶段 1 之后你需要移除并重新加载一次扩展；此后稳定。

## 8. 暂不做

- agent 做一半、交给人；在用户的标签页上操作；租约；本机 MITM 代理；常驻 `chrome.debugger`。
- 站点笔记文件（先用 task 头部的 `@note`，不够用再加）。
- Windows / Linux 的取舍，保持现状。
