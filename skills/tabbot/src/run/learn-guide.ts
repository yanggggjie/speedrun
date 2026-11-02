import { LEARN_IDLE_MS, LEARN_MAX_OPS, type LearnWindow } from "./learn-windows.ts";

export type LearnInfo = {
  /** 学习窗口的目录：meta.json、timeline.jsonl、requests/、pages/、screenshots/。 */
  winDir: string;
  /** 知识目录：<站点>/endpoints.json、<站点>/actions/。 */
  sitesDir: string;
  /** 跨站点的组合。 */
  composeDir: string;
  libDir: string;
};

/**
 * 打开学习窗口时给 agent 自己看的指引（tabbot learn --url 的输出）：自包含，写清楚怎么拆、怎么学、文件在哪、纪律是什么。
 * 一个学习窗口可以学多个 action；用户的结果必须来自 tabbot run，不能来自探索。数据是文件，用 rg / node / Python 读。
 */
export function makeLearnGuide(w: LearnWindow, info: LearnInfo): string {
  const cmd = `tabbot learn ${w.id}`;
  const actionsDir = `${info.sitesDir}/<站点>/actions`;
  return `学习窗口已开：在这里探索、学会这件事要的全部 action（可以是多个），再用 tabbot run 交付。

# 要做的事
「${w.description}」
- 起点站点：${w.site}（页面要登录就停下来，请用户在 Chrome 里登录，不要自己登录）
- 句柄：${w.id}，持久的：关了窗口、holder 重启了，再对它操作就从上次的 URL 重开（页面状态会丢），日志接着写进同一个目录
- 最多 ${LEARN_MAX_OPS} 次页面操作；独立的 agent 窗口，不会打扰用户；${Math.round(LEARN_IDLE_MS / 60_000)} 分钟没有操作会关掉 Chrome 窗口

# 先拆分，再判断通用操作
- 先把事情拆成要学的 action（一个 action = 一个业务动作），按数据依赖排好顺序，标出哪些已有（rg 过 ${actionsDir} 和 ${info.composeDir}）、哪些要学。这个窗口按顺序一路学下去，前一个学到的页面状态就是后一个的起点。
- 同一种操作作用在不同对象上（给任意一条回答点赞、收藏任意一篇文章、翻到任意一页），只是参数不同，就是**通用操作**：只在**最容易的那个对象**上做一次（第一张卡片、第一页、不用滚动就能点到的），学到请求后把对象换成参数；能用 \`${cmd} replay <编号> --set …\` 换一个对象验证就验证一次。不在每个对象上重复操作。
- 用户点名的对象（"第 30 条"）是参数和组合里的口径，不是学习时要去操作的对象。

# 粒度：一个 action = 一个业务动作
通常就是一个请求；可以包含只为它服务的前置请求（凭证、nonce、上传），文件头按发送顺序写多行 @endpoint；中间结果本身有业务含义的，拆成两个 action 再组合。一步操作引发多个请求时：
- 主请求加顺带请求（发评论后刷新列表、埋点）：只学主请求；
- 依赖链、中间结果没有业务含义（拿上传凭证 → 上传 → 提交）：放进同一个 action，@endpoint 按发送顺序写多行；
- 依赖链、每一步都有业务含义（创建草稿 → 发布草稿）：拆成两个 action；
- 并行展开（详情页同时拉正文、评论、作者）：只学要的那一个；
- 复现不了（前端签名、多步状态机）：页面实现（DOM）。
观察结果会标出请求之间的依赖（"#813 用了 #812 响应的 data.token"），据此判断。翻页：请求实现的翻页交给组合里的循环；"第 N 条"这类口径写在组合里，底层 action 只如实返回列表和每条的类型。

# 观察：每一步之后看发生了什么
- 页面操作（open、click、type、key、scroll、replay）执行完会等页面稳定，然后**自动附带一次观察**：上次观察以来的页面状态、导航、请求（★ 是写请求，带请求文件名）、请求之间的依赖、编号范围。
- 请求晚到（懒加载、防抖、新标签页加载）：等一会儿再 \`${cmd} observe\`，只给上次之后的新东西，不漏不重。\`${cmd} observe --since <编号>\` 重看某个编号之后的。
- 每一步的输出都对应文件：请求文件 \`requests/<编号>-<方法>-<接口名>.json\`（url.query 和 requestBody 已解析，秘密是 ⟨secret_…⟩ 别名），响应体同名加 \`.response.json\`，都在窗口目录里。

# 写请求：你判断严重程度
页面发什么就真的发什么（学习窗口不拦）。做会引发写请求的操作之前先判断：
- 轻量、可撤销、只影响用户自己的（点赞、收藏、关注、标已读）：直接做；
- 删除、支付、下单、发布或发给别人、改设置、不可撤销的：先问用户，同意了再做。
\`replay\` 重发非 GET 请求要加 \`--yes\`，按同样的标准判断要不要先问。真发过的写操作要在最终回复里告诉用户。

# 文件在哪（用 rg / node / Python 读；没有读日志的 TabBot 命令）
- 这个窗口：${info.winDir}/
  - timeline.jsonl：这个窗口发生的一切，一行一条，按编号递增；type 是 request / input / nav / cmd / doc / snap / tab；site 是这一行属于的站点；request 行的 cause 是引发它的命令的编号，phase 是 load / cmd / idle。
  - requests/、pages/（页面 HTML、快照）、screenshots/（截图）。
- 接口清单：${info.sitesDir}/<站点>/endpoints.json（次数、阶段统计、变量、响应结构、样本、业务含义 descriptions、被哪个 action 覆盖）。
- 已有的 action：${actionsDir}/、${info.composeDir}/。SDK：${info.libDir}/。

# 怎么做
成本顺序：读文件 < replay < 一次页面操作。**先 network，不行才 DOM**：
- **network**（默认）：action 里用 \`request(page, …)\` 直接发这个请求。
- **DOM**（兜底，也是正当的结果）：请求读不了响应体（流式、二进制）、必须由页面脚本带签名发出、或数据在页面里没有可用的请求时，action 做页面操作并用 \`text\` / \`query\` 取数据。

1. 截图看页面：\`${cmd} screenshot\`（存成文件，用读图片的方式看），按图上的坐标操作：\`${cmd} click <x> <y> --description "点开某某"\`、\`${cmd} type "文字" --description "…"\`（先 click 输入框）、\`${cmd} key Enter --description "…"\`、\`${cmd} scroll down [像素] [x y] --description "…"\`、\`${cmd} open <网址> --description "…"\`。没有页面结构、没有元素编号，只靠看图。
2. 页面操作和 replay 都要带 \`--description\`：一句话用用户的话说这一步要做什么，它会存成接口的业务含义。
3. 看到要的请求就读它的请求文件，用 \`${cmd} replay <编号> --set 名字=值 --description "…"\` 在当前页面重发、试参数。replay 和 action 里的 \`request()\` 走同一条路径（同一套请求头继承，\`--inherit-from <接口路径>\` 对应 \`inheritFrom\`），输出写明请求头继承自哪里、**身份头来源**（cookie、localStorage、meta、签名……）、签名和参数对不上的提示，以及一行可贴进 action 的 \`request(...)\`（带 \`auth\` 声明）。\`--raw\` 是原样重放，只用来排查，不代表 action 能跑通。replay 成功后写进草稿，马上 run 一次，以 run 为准。
4. 写 action 文件 ${actionsDir}/<名字>.js（名字小写字母数字和 -，全局唯一；站点是请求所在页面的 host 去 www.）。文件头：

\`\`\`javascript
/**
 * @summary 一句话：做什么（业务动作）
 * @status draft
 * @endpoint 方法 接口名
 * @param 参数名 说明（可选参数写成 参数名? 说明）
 * @note 经验：签名、风控、必须先做的步骤、踩过的坑（一行一条）
 */
\`\`\`
   前置请求也要发时，@endpoint 按发送顺序写多行；run 时会检查实际发出的顺序，不对就不晋升。
5. 学完一个就接着学下一个；都写好后 \`tabbot run --compose '代码' --name 名字 --description "…"\`（或单个 \`tabbot run <名字>\`）在新的 run 窗口里跑。草稿真跑成功就晋升 verified。写操作可以先 \`--dry\`：只打印要发的写请求，不真发、不晋升（GET 和标了 \`readOnly\` 的照常发）。
6. run 出问题：回到这个窗口继续观察、重放，或对比本窗口和 run 窗口目录里的 timeline.jsonl 找原因，改了再 run。
7. 学不会：把 action 文件头改成 \`@status blocked\`，\`@note\` 写原因和证据（试过哪些请求编号、为什么 network 和 DOM 都不行），最终回复说明卡在哪。verified 的坏了：改回 \`@status draft\`，\`@note\` 写原因，回来修，run 通过再晋升。
8. 事情做完由你决定 \`${cmd} close\`（关掉 Chrome 窗口，句柄和目录保留）。

# 写 action 的规则
- SDK：\`import { tabbot, goto, request, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, serializeUrl } from "../../../lib/index.js"\`，入口 \`await tabbot.run(async ({ page }) => { ... })\`，返回值就是结果。
- \`request(page, {url, method?, headers?, json?, inheritFrom?, readOnly?})\` 默认继承 agent 窗口里同站点页面最近发出的请求头（token 真值只在 holder 内存里）；没有可继承的头时会自动打开站点首页让页面自己发请求。签名和接口绑定的站点（换个接口的签名会被拒）用 \`inheritFrom: "/接口路径"\` 只从那个接口继承，先 \`goto\` 会发它的页面；签名还和完整 URL 绑定（\`replay --set\` 改参数就被拒）的，改页面实现。只读的 POST（查列表、搜索）加 \`readOnly: true\`，\`--dry\` 时照常发，写操作的 action 才能在试运行里先读到状态。
- **身份头说清来源**：值来自 cookie、localStorage / sessionStorage、meta 的，用 \`auth: { "x-xsrftoken": "cookie:_xsrf", authorization: "Bearer local:token" }\` 声明，发送时在页面里现读，holder 重启也能用；来自前序响应的（上传凭证、nonce），先发前序请求再取值（多行 @endpoint）；签名不能继承，用页面实现。观察里 ★ 写请求和 replay 的输出会写出每个身份头的来源。
- run 窗口每次从空白开始，不沿用学习窗口的页面状态：页面实现的 action 自己 \`goto\` 起点。
- 参数用 \`tabbot.params.名字 ?? 默认值\`（字符串）；变化的值（id、关键词、页码）都做成参数；返回字段用页面上的词命名。
- 成功判断：检查 HTTP 状态码和业务码；结果必须对应本次参数；有副作用的先读状态，已满足返回 already；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS；\`query(page, {css, fields})\` 取数；\`evaluate\` 是兜底（严格 CSP 的页面会被拒）。
- 一次调用只做这一个业务动作：翻页、批量、多个对象都做成参数，由组合循环调用。返回值只放有用的字段。

# 纪律
- **用户的结果必须来自 tabbot run 的返回值**，不能来自你在学习窗口里看到的东西；最终回复引用 run 输出里的回执。
- 大响应体用 rg / node -e 取字段，不要整段读进来；截图只在需要时截。
`;
}
