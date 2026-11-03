import { LEARN_IDLE_MS, LEARN_MAX_OPS } from "./learn-windows.ts";

export type LearnInfo = {
  /** learn 窗口的目录都在这下面：<句柄>/meta.json、timeline.jsonl、requests/、pages/、screenshots/。 */
  learnDir: string;
  /** 站点目录：<站点>/endpoints.json、<站点>/actions/。 */
  sitesDir: string;
  composeDir: string;
  libDir: string;
  /** agent 自己抽出来的纯函数，不会被覆盖。 */
  helpersDir: string;
};

/**
 * learn 指引：给 agent 自己看的，写清楚怎么拆、怎么学、文件在哪、纪律是什么。和具体窗口无关（句柄写成 <句柄>），
 * 存在 ~/.lore/learn-guide.md；内容变了（第一次、或升级后）才在 lore learn new 的输出里给全文，其余时候只给路径。
 * 一个 learn 窗口可以学多个 action；用户的结果必须来自 lore run，不能来自 learn 窗口里看到的东西。数据是文件，用 rg / node / Python 读。
 */
export function makeLearnGuide(info: LearnInfo): string {
  const cmd = "lore learn <句柄>";
  const actionsDir = `${info.sitesDir}/<站点>/actions`;
  return `# learn 指引

在 learn 窗口里学会这件事要的全部 action（可以是多个），再用 lore run 交付。

## 窗口
- 句柄是持久的：关了窗口、daemon 重启了，再对它操作就从上次的 URL 重开（页面状态会丢），日志接着写进同一个目录。
- 最多 ${LEARN_MAX_OPS} 次页面操作；独立的 agent 窗口，不会打扰用户；${Math.round(LEARN_IDLE_MS / 60_000)} 分钟没有操作会关掉 Chrome 窗口。
- 遇到登录页：点一下就能登录的（「快速登录」「检测到当前已登录账号」「使用此账号继续」这类）你自己点：先截图确认只要点一下，点完再截图确认登进去了；要输入账号密码、扫二维码、收验证码的停下来请用户在 Chrome 里登录。登录态整个 Chrome 共用，learn 窗口里登进去，run 窗口也就登进去了。

## 先拆分，同一种操作只学一次
- 先把事情拆成要学的 action（一个 action = 一个业务动作），按数据依赖排好顺序，标出哪些已有（rg 过 ${actionsDir} 和 ${info.composeDir}）、哪些要学。一个窗口按顺序一路学下去，前一个学到的页面状态就是后一个的起点。
- 只是作用对象不同的操作（给任意一条回答点赞、收藏任意一篇文章、翻到任意一页）只在**最容易的那个对象**上做一次（第一张卡片、第一页、不用滚动就能点到的），学到请求后把对象换成参数，写好 action 后用 \`${cmd} run --action <名> --参数 值\` 换一个对象验证一次。
- 用户点名的对象（"第 30 条"）写成参数或 compose 里的条件，不是 learn 时要去操作的对象。

## 粒度：一个 action = 一个业务动作
通常就是一个请求；可以包含只为它服务的前置请求（凭证、nonce、上传），文件头按发送顺序写多行 @endpoint；中间结果本身有业务含义的，拆成两个 action 再用 compose 串起来。一步操作引发多个请求时：
- 主请求加顺带请求（发评论后刷新列表、埋点）：只学主请求；
- 依赖链、中间结果没有业务含义（拿上传凭证 → 上传 → 提交）：放进同一个 action，@endpoint 按发送顺序写多行；
- 依赖链、每一步都有业务含义（创建草稿 → 发布草稿）：拆成两个 action；
- 并行展开（详情页同时拉正文、评论、作者）：只学要的那一个；
- 复现不了（前端签名、多步状态机）：用 DOM。
观察里的「依赖」一段标出请求之间的依赖（"#813 用了 #812 响应的 data.token"），据此判断。翻页：请求实现的翻页交给 compose 里的循环；"第 N 条"怎么算写在 compose 里，底层 action 只如实返回列表和每条的类型。

## 观察：每一步之后看发生了什么
- 页面操作（open、click、type、key、scroll）和 \`run\` 执行完会等页面稳定，然后自动附带一次观察：上次观察以来的页面、导航、请求、请求之间的依赖。
- 请求只列这个窗口里第一次出现的 endpoint 和所有写请求；之前出现过的只计数，\`${cmd} observe --all\` 看全部。
- 每个请求一行：行首 \`write\` 表示写请求；后面是编号、\`方法 路径\`（就是 @endpoint 的写法）、状态、内容类型、有没有响应体、请求文件、以前的 description。重要的几个请求下面带 \`auth 来源\` 和一行 \`草稿\`：可以直接贴进 action 的 \`request(...)\`。auth 来源里「签名」每次都变、换参数可能被拒；「不变的值」「来源不明」会从最近的请求继承。
- 请求晚到（懒加载、防抖、新标签页加载）：等一会儿再 \`${cmd} observe\`，只给上次之后的新东西，不漏不重。\`--since <编号>\` 重看某个编号之后的（不推进游标）。

## 写请求：你判断严重程度
页面发什么就真的发什么（learn 窗口不拦）。做会引发写请求的操作之前先判断：
- 轻量、可撤销、只影响用户自己的（点赞、收藏、关注、标已读）：直接做；
- 删除、支付、下单、发布或发给别人、改设置、不可撤销的：先问用户，同意了再做。
在 learn 窗口里 \`run\` 带 \`@write\` 的 action 也一样：Lore 不拦，输出最后的「已发出的 write 请求」列出这次真发了什么。真发过的写操作要在最终回复里告诉用户。
批量写（给 10 条点赞、删一批记录）在 compose 里先跑读的 action 拿到目标，用 \`lore.ask\` 停下来确认（严重的交给用户确认），再循环跑写的 action。

## 文件在哪（用 rg / node / Python 读；没有读日志的 Lore 命令）
- 每个窗口：${info.learnDir}/<句柄>/
  - timeline.jsonl：这个窗口发生的一切，一行一条，按编号递增；type 是 request / input / nav / cmd / doc / snap / tab；site 是这一行属于的站点；request 行的 cause 是引发它的命令的编号，phase 是 load / cmd / idle。
  - requests/<编号>-<方法>-<endpoint 名>.json（url.query 和 requestBody 已解析，秘密是 ⟨secret_…⟩ 别名），响应体同名加 .response.json；pages/（页面 HTML、快照）、screenshots/（截图）。
- endpoint 清单：${info.sitesDir}/<站点>/endpoints.json（次数、阶段统计、变量、响应结构、样本、descriptions、auth、被哪个 action 覆盖）。
- 已有的 action：${actionsDir}/、${info.composeDir}/。SDK：${info.libDir}/index.js（每个函数的注释就是用法；daemon 每次启动整个覆盖，别在那里改）。
- 你自己的函数：${info.helpersDir}/（不会被覆盖）。

## 怎么做
成本顺序：读文件 < 在 learn 窗口里 run 一次 action < 一次页面操作。**先 network，不行才 DOM**：
- **network**（默认）：action 里用 \`request({…})\` 直接发这个请求。
- **等页面发**：请求必须由页面脚本带签名发出、或请求体由页面拼出来复现不了，但响应能读的，用 \`waitRequest("方法 路径", 触发动作)\`：触发动作（\`goto\` 带参数的页面、\`click\`）让页面自己发，action 拿它的响应。
- **DOM**（兜底，也是正当的结果）：请求读不了响应体（流式、二进制）、或数据在页面里没有可用的请求时，action 做页面操作并用 \`text\` / \`query\` 取数据。

1. 截图看页面：\`${cmd} screenshot\`（存成文件，用读图片的方式看），按图上的坐标操作：\`${cmd} click <x> <y> --description "点开某某"\`、\`${cmd} type "文字" --description "…"\`（先 click 输入框）、\`${cmd} key Enter --description "…"\`、\`${cmd} scroll down [像素] [x y] --description "…"\`、\`${cmd} open <网址> --description "…"\`。没有页面结构、没有元素编号，只靠看图。
2. 页面操作和 run 都要带 \`--description\`：一句话用用户的话说这一步要做什么，它会存成 endpoint 的 description。
3. 看到要的请求就读它的请求文件，把观察里的「草稿」那一行写进 action。
4. 写 action 文件 ${actionsDir}/<名字>.js（名字小写字母数字和 -，全局唯一；站点是请求所在页面的 host 去 www.）。文件头：

\`\`\`javascript
/**
 * @summary 一句话：做什么（业务动作）
 * @status draft
 * @write（会发 write 请求才写，如点赞、提交、删除）
 * @start 起点页面的地址（用 DOM 的 action 写；run 时先打开它）
 * @endpoint 方法 路径
 * @param 参数名 说明（可选写成 参数名?；不是字符串的写类型：参数名:number、参数名?:boolean、参数名:json）
 * @note 经验：签名、风控、必须先做的步骤、踩过的坑（一行一条）
 */
\`\`\`
   前置请求也要发时，@endpoint 按发送顺序写多行；run 时会检查实际发出的顺序，不对就不变成 verified。
5. 在这个窗口里试：\`${cmd} run --action <名字> --参数 值 --description "…"\`。在当前页面执行（有 @start 先打开它），日志进这个窗口，不变成 verified；换参数多试几次，改了文件再试。
6. 学完一个就接着学下一个；都写好后 \`lore run --compose-code '代码' --description "…"\`（或单个 \`lore run --action <名字>\`）在新的 run 窗口里交付。draft 真跑成功就变成 verified。
7. run 出问题：回到这个窗口继续观察、在窗口里 run，或对比本窗口和 run 窗口目录里的 timeline.jsonl 找原因，改了再 run。
8. 学不会：把 action 文件头改成 \`@status blocked\`，\`@note\` 写原因和证据（试过哪些请求编号、为什么 network 和 DOM 都不行），最终回复说明卡在哪。verified 的坏了：改回 \`@status draft\`，\`@note\` 写原因，回来修，run 通过再变成 verified。
9. 事情做完由你决定 \`${cmd} close\`（关掉 Chrome 窗口，句柄和目录保留）。

## 写 action 的规则
- SDK：\`import { lore, goto, request, waitRequest, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, serializeUrl } from "../../../lib/index.js"\`，入口 \`export default async () => { ... }\`，返回值就是结果。函数都不用传 page：\`goto(url)\`、\`click(定位)\`、\`request({…})\`。
- **请求头里的认证**（Cookie 由浏览器自动带上，不用管）：按下表从上往下选，前一种不行再用后一种。观察里的「auth 来源」和「草稿」已经替你判断好了。

| 情况 | 写法 |
|---|---|
| 大多数站点 | 什么都不写：默认继承这个站点页面最近一次带身份信息的请求的请求头（真值只在 daemon 内存里；内存里没有就自动打开站点首页让页面发一次）。公开接口写 \`inherit: false\` |
| 值来自 cookie、localStorage / sessionStorage、meta | \`auth: { "x-xsrftoken": "cookie:_xsrf", authorization: "Bearer local:token" }\`：发送时在页面里现读，daemon 重启也能用；取不到就报错 |
| 值来自另一个 endpoint 的请求头 | \`auth: { "x-token": "from:/api/session" }\` |
| 签名和 endpoint 绑定（换个 endpoint 的签名会被拒，如知乎 x-zse-96） | \`inheritFrom: "/路径"\`：只从那个 endpoint 最近一次请求继承整组头，先 \`goto\` 会发它的页面 |
| API 在另一个域名（页面是 a.com，接口是 api.a.com / internal.a.com） | \`pageOrigin: "https://a.com"\`：从站点页面发出（带它的登录态），不写就在接口自己的域名上开页面发 |
| 值来自前序响应（上传凭证、nonce） | 先发前序请求再取值，@endpoint 写多行 |
| 签名还和完整 URL 绑定（换参数就被拒），或请求体由页面拼出来 | \`waitRequest\` 让页面自己发 |
| 页面也不发请求 | DOM |

- run 窗口每次从空白开始，不沿用 learn 窗口的页面状态：用 DOM 的 action 写 \`@start\`，run 时先打开它。action 里不能调用别的 action，要串起来写 compose。
- 参数用 \`lore.params.名字 ?? 默认值\`，按 @param 的类型转好（没写类型是字符串）；变化的值（id、关键词、页码）都做成参数；返回字段用页面上的词命名。
- **小函数放进 ${info.helpersDir}/**：写 action 前先 \`ls ${info.helpersDir}\` 看有什么；同一个小函数（去 HTML 标签、格式化时间、拼 URL）第二次出现就挪进去，按用途分文件（如 text.js、time.js），action 里 \`import { stripHtml } from "../../../helpers/text.js"\`。只放纯函数：要发请求或操作页面的写成 action。
- 成功判断：action 自己判断任务有没有正确完成，不看最后停在什么页面。检查 HTTP 状态码和业务码；读页面内容的要检查拿到的确实是目标内容（标题、关键元素），停在登录页、错误页就抛错，不能把登录页的文字当结果返回；结果必须对应本次参数；会发 write 请求的先读状态，已满足返回 already，并在文件头写 @write；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS；\`query({css, fields})\` 取数；\`evaluate\` 是兜底（严格 CSP 的页面会被拒）。
- 一次调用只做这一个业务动作：翻页、批量、多个对象都做成参数，由 compose 循环调用。返回值只放有用的字段。

## 纪律
- **用户的结果必须来自 lore run 的返回值**，不能来自你在 learn 窗口里看到的东西。
- 大响应体用 rg / node -e 取字段，不要整段读进来；截图只在需要时截。
`;
}
