import { LEARN_IDLE_MS, LEARN_MAX_OPS } from "./windows.ts";

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
- \`request\` 被拒（签名和参数绑定）、请求体由页面拼出来：用 \`waitRequest\`；页面不发请求、请求读不了：用 DOM。
观察里的「依赖」一段标出请求之间的依赖（"#813 用了 #812 响应的 data.token"），据此判断。翻页：请求实现的翻页交给 compose 里的循环；"第 N 条"怎么算写在 compose 里，底层 action 只如实返回列表和每条的类型。

## 观察：每一步之后看发生了什么
- 页面操作（open、click、type、key、scroll）和 \`run\` 执行完会等页面安静、这一步引发的记录都到了（最多 2 秒），然后自动附带一次观察：上次观察以来的页面、导航、请求、请求之间的依赖。「稳定：」一行写等了多久、页面有没有安静下来。
- 请求只列这个窗口里第一次出现的 endpoint；之前出现过的只计数，\`${cmd} observe --all\` 看全部。
- 每个请求一行：编号、\`方法 路径\`（就是 @endpoint 的写法）、状态、内容类型、有没有响应体、请求文件、以前的 description。带非浏览器头的请求下面有一行 \`请求头\`：每个头的值在这个窗口的请求里怎么变（页面级不变 / 按 endpoint 不变 / 每次都变 / 样本太少），和它在页面里的位置（← cookie _xsrf）。这是信号：请求头 lore 会自动抄，你只在 run 被拒时照它改。
- 请求晚到（懒加载、防抖、新标签页加载）：等一会儿再 \`${cmd} observe\`，只给上次之后的新东西，不漏不重。

## 写请求：你判断有没有副作用、多严重
页面发什么就真的发什么（learn 窗口不拦），lore 也不替你判断哪个请求是写：看 endpoint 名、请求体和业务含义。做会引发写请求的操作之前先判断：
- 轻量、可撤销、只影响用户自己的（点赞、收藏、关注、标已读）：直接做；
- 删除、支付、下单、发布或发给别人、改设置、不可撤销的：先问用户，同意了再做。
在 learn 窗口里 \`run\` 带 \`@write\` 的 action 也一样：lore 不拦，输出最后的「已发出的非 GET 请求」列出这次实际发出的（只看方法，查询用的 POST 也在里面）：核对有没有意料之外的，真发过的写操作要在最终回复里告诉用户。
批量写（给 10 条点赞、删一批记录）在 compose 里先跑读的 action 拿到目标，用 \`lore.ask\` 停下来确认（严重的交给用户确认），再循环跑写的 action。

## 文件在哪（用 rg / node / Python 读；没有读日志的 lore 命令）
- 每个窗口：${info.learnDir}/<句柄>/
  - timeline.jsonl：这个窗口发生的一切，一行一条，按编号递增；type 是 request / input / nav / cmd / doc / snap / tab；site 是这一行属于的站点；request 行的 cause 是引发它的命令的编号，phase 是 load / cmd / idle。
  - requests/<编号>-<方法>-<endpoint 名>.json（url.query 和 requestBody 已解析，秘密是 ⟨secret_…⟩ 别名），响应体同名加 .response.json；pages/（页面 HTML、快照）、screenshots/（截图）。
- endpoint 清单：${info.sitesDir}/<站点>/endpoints.json（次数、阶段统计、变量、响应结构、样本、descriptions、headers（请求头的信号）、被哪个 action 覆盖）。
- 已有的 action：${actionsDir}/、${info.composeDir}/。SDK：${info.libDir}/index.js（每个函数的注释就是用法；daemon 每次启动整个覆盖，别在那里改）。
- 你自己的函数：${info.helpersDir}/（不会被覆盖）。

## 怎么做
成本顺序：读文件 < 在 learn 窗口里 run 一次 action < 一次页面操作。三种实现方式，按这个顺序选，前一种不行再用后一种：
- **\`request\`**（默认）：\`request({ url, method, json })\` 直接发。请求头不用写，lore 从这次窗口里页面发过的请求自动抄。
- **\`waitRequest\`**：\`request\` 被拒（签名和参数绑定）、或请求体由页面拼出来复现不了，但响应能读的，用 \`waitRequest("方法 路径", 触发动作)\`：触发动作（\`goto\` 带参数的页面、\`click\`）让页面自己发，action 拿它的响应，签名由页面算。
- **DOM**（兜底，也是正当的结果）：页面不发请求、或请求读不了响应体（流式、二进制）时，action 做页面操作并用 \`text\` / \`query\` 取数据。

1. 截图看页面：\`${cmd} screenshot\`（存成文件，用读图片的方式看），按图上的坐标操作：\`${cmd} click <x> <y> --description "点开某某"\`、\`${cmd} type "文字" --description "…"\`（先 click 输入框）、\`${cmd} key Enter --description "…"\`、\`${cmd} scroll down [像素] [x y] --description "…"\`、\`${cmd} open <网址> --description "…"\`。没有页面结构、没有元素编号，只靠看图。
2. 页面操作和 run 都要带 \`--description\`：一句话用用户的话说这一步要做什么，它会存成 endpoint 的 description。
3. 看到要的请求就读它的请求文件（地址、方法、请求体），自己写 \`request({ url, method, json })\`；变化的值换成 \`lore.params\`。
4. 写 action 文件 ${actionsDir}/<名字>.js（名字小写字母数字和 -，全局唯一；站点是请求所在页面的 host 去 www.）。文件头：

\`\`\`javascript
/**
 * @summary 一句话：做什么（业务动作）
 * @status draft
 * @write（这个 action 会改东西才写，如点赞、提交、删除）
 * @start 起点页面的地址（run 时先打开它：request 要从这个页面发过的请求抄头，DOM 要在它上面操作）
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
- SDK：\`import { lore, goto, request, waitRequest, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, sleep } from "../../../lib/index.js"\`，入口 \`export default async () => { ... }\`，返回值就是结果。函数都不用传 page：\`goto(url)\`、\`click(定位)\`、\`request({…})\`。
- **请求头**：lore 按顺序凑齐，你一般什么都不用写：
  1. 浏览器自己带的（cookie）；
  2. 从这次窗口里页面发过的请求抄：页面发过同一个 endpoint 就整组抄它的（签名和 endpoint 绑定的站点靠这个），否则只抄值都一样的头，每次都变的不跨 endpoint 抄。所以 action 先 \`goto\`（或写 \`@start\`）打开会发这些请求的页面；
  3. 页面这次没发带某个头的请求时：照观察「请求头」给的位置写 \`auth: { "x-xsrftoken": "cookie:_xsrf", authorization: "Bearer local:token" }\`，发送时在页面里现读；
  4. 值来自前序响应（上传凭证、nonce）：先 \`request\` 前序请求，再 \`headers: { "x-token": r.json().token }\`，照观察里的「依赖」写，@endpoint 写多行；
  5. 被拒（401/403）：失败输出写了抄了什么、没抄什么、下一步；每次都变的头被拒的，改用 \`waitRequest\` 或 DOM。
  接口在另一个子域（页面是 a.com，接口是 api.a.com）不用另写，lore 在当前页面上发。
- run 窗口每次从空白开始，不沿用 learn 窗口的页面状态：action 写 \`@start\`（或第一步 \`goto\`），run 时先打开它。action 里不能调用别的 action，要串起来写 compose。
- 参数用 \`lore.params.名字 ?? 默认值\`，按 @param 的类型转好（没写类型是字符串）；变化的值（id、关键词、页码）都做成参数；返回字段用页面上的词命名。
- **小函数放进 ${info.helpersDir}/**：写 action 前先 \`ls ${info.helpersDir}\` 看有什么；同一个小函数（去 HTML 标签、格式化时间、拼 URL）第二次出现就挪进去，按用途分文件（如 text.js、time.js），action 里 \`import { stripHtml } from "../../../helpers/text.js"\`。只放纯函数：要发请求或操作页面的写成 action。
- **等待**：等渲染完用 \`goto(url, { settle: true })\`、操作带 \`{ settle: true }\`（等页面安静，最多 2 秒），或 \`waitFor(定位)\` 等具体元素；等页面自己发的请求用 \`waitRequest\`。不要用 \`sleep\` 等页面：快的页面白等、慢的不够。\`sleep\` 只用在轮询后台状态（隔一秒查一次建好了没有）。
- 成功判断：action 自己判断任务有没有正确完成，不看最后停在什么页面。检查 HTTP 状态码和业务码；读页面内容的要检查拿到的确实是目标内容（标题、关键元素），停在登录页、错误页就抛错，不能把登录页的文字当结果返回；结果必须对应本次参数；会改东西的先读状态，已满足返回 already，并在文件头写 @write；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS；\`query({css, fields})\` 取数；\`evaluate\` 是兜底（严格 CSP 的页面会被拒）。
- 一次调用只做这一个业务动作：翻页、批量、多个对象都做成参数，由 compose 循环调用。返回值只放有用的字段。

## 纪律
- **用户的结果必须来自 lore run 的返回值**，不能来自你在 learn 窗口里看到的东西。
- 大响应体用 rg / node -e 取字段，不要整段读进来；截图只在需要时截。
`;
}
