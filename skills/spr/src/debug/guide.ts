import { DEBUG_IDLE_MS, DEBUG_MAX_OPS } from "./windows.ts";

export type DebugInfo = {
  /** debug 窗口的目录都在这下面：<id>/meta.json、timeline.jsonl、requests/、pages/、screenshots/。 */
  debugDir: string;
  /** 站点目录：<站点>/endpoints.json、<站点>/。 */
  actionDir: string;
  composeDir: string;
  libDir: string;
  /** agent 自己抽出来的纯函数，不会被覆盖。 */
  helpersDir: string;
};

/**
 * debug 指引：给 agent 自己看的，写清楚怎么写 action、文件在哪、纪律是什么。和具体窗口无关（compose 写成 <compose>），
 * 存在 ~/.speedrun/debug-guide.md；内容变了（第一次、或升级后）才在第一次打开窗口的输出里给全文，其余时候只给路径。
 * 一个 debug 窗口可以写多个 action；用户的结果必须来自 spr run，不能来自 debug 窗口里看到的东西。数据是文件，用 rg / node / Python 读。
 */
export function makeDebugGuide(info: DebugInfo): string {
  const cmd = "spr debug <compose>";
  const siteDir = `${info.actionDir}/<站点>`;
  return `# debug 指引

在 debug 窗口里写好或修好 compose 缺的 action，然后回到 spr run。完整流程是 Find、Write、Debug、Run，这里是 Debug。

## 窗口
- 窗口属于 compose：\`spr debug <compose> navigate <网址|tab 号>\` 打开，一个窗口可以处理它缺的多个 action，也可以跨站点。
- spr run 成功或失败都不关这个窗口。close、空闲 ${Math.round(DEBUG_IDLE_MS / 60_000)} 分钟、daemon 重启、扩展重连、标签组被关才关；关了之后重新 navigate，在新窗口里复现到要的页面状态。
- 最多 ${DEBUG_MAX_OPS} 次页面操作；在用户窗口里 speedrun 自己的折叠标签组里干活，不会切换用户的标签页、不抢前台；页面自己要新开的标签页由 speedrun 开在同一个组里。
- 遇到登录页：点一下就能登录的（「快速登录」「检测到当前已登录账号」「使用此账号继续」这类）你自己点：先 find / read_page 确认只要点一下，点完再看一次确认登进去了；要输入账号密码、扫二维码、收验证码的停下来请用户在 Chrome 里登录。登录态整个 Chrome 共用，debug 窗口里登进去，run 窗口也就登进去了。

## 做到最小触发就停
- 只为写出 action 才操作页面。每条命令输出的末行写着目标和还缺的 action，不要去做用户的整件事。
- 只是作用对象不同的操作（给任意一条回答点赞、收藏任意一篇文章、翻到任意一页）只在**最容易的那个对象**上做一次（第一张卡片、第一页、不用滚动就能点到的），把对象换成参数。
- 用户点名的对象（"第 30 条"）写成参数或 compose 里的条件，不是 debug 时要去操作的对象。

## 选实现方式：能用上面的就不用下面的
站点有官方 API 时先用官方 API，否则按这四层选。达到当前层的停止条件就写 action，不继续往下试；同一种页面操作连续失败两次，换下一层。
1. **HTTP 请求**（\`request\`、\`waitRequest\`）：页面发了可用请求。停止条件：参数能由 action 参数决定，响应里有要的数据。
   - \`request({ url, method, json })\` 直接发，请求头 speedrun 从这次窗口里页面发过的请求自动抄。
   - \`request\` 被拒（签名和参数绑定）、或请求体由页面拼出来复现不了，但响应能读的，用 \`waitRequest("方法 路径", 触发动作)\`：触发动作让页面自己发，action 拿它的响应。
2. **页面函数**（\`evaluate\`）：没有可用请求，但页面有自己的接口。先 rg 窗口的 page-api/，要参数用 trace。停止条件：调用函数能完成动作或取到数据。
3. **WebSocket、事件流**（\`waitMessage\`）：数据从长连接或事件流来。停止条件：收到的消息里有要的数据。
4. **DOM 或真实输入**（\`query\`、\`get_page_text\`、页面操作）：上面都不行。停止条件：操作完成，或页面里读到目标数据。
四层都不行：文件头写 \`@status blocked\` 和 \`@note\`（写清试过什么、为什么不行），向用户说明卡在哪。

## 粒度：一个 action = 一个业务动作
通常就是一个请求；可以包含只为它服务的前置请求（凭证、nonce、上传），文件头按发送顺序写多行 @endpoint；中间结果本身有业务含义的，拆成两个 action，由 compose 串起来。一步操作引发多个请求时：
- 主请求加顺带请求（发评论后刷新列表、埋点）：只写主请求；
- 依赖链、中间结果没有业务含义（拿上传凭证 → 上传 → 提交）：放进同一个 action，@endpoint 按发送顺序写多行；
- 依赖链、每一步都有业务含义（创建草稿 → 发布草稿）：拆成两个 action；
- 并行展开（详情页同时拉正文、评论、作者）：只写要的那一个；
- \`request\` 被拒（签名和参数绑定）、请求体由页面拼出来：用 \`waitRequest\`；页面不发请求、请求读不了：用 DOM。
观察里的「依赖」一段标出请求之间的依赖（"#813 用了 #812 响应的 data.token"），据此判断。翻页：请求实现的翻页交给 compose 里的循环；"第 N 条"怎么算写在 compose 里，底层 action 只如实返回列表和每条的类型。

## 观察：每一步之后看发生了什么
- 改变页面的操作（computer 的点击、输入、滚动，form_input、navigate）执行完会等页面安静、这一步引发的记录都到了（最多 2 秒），然后自动附带一次观察：上次观察以来的页面、导航、请求、请求之间的依赖。「稳定：」一行写等了多久、页面有没有安静下来。
- 请求只列这个窗口里第一次出现的 endpoint；之前出现过的只计数，全部都在 timeline.jsonl 里。
- 每个请求一行：编号、\`方法 路径\`（就是 @endpoint 的写法）、状态、内容类型、有没有响应体、请求文件。带非浏览器头的请求下面有一行 \`请求头\`：每个头的值在这个窗口的请求里怎么变（页面级不变 / 按 endpoint 不变 / 每次都变 / 样本太少），和它在页面里的位置（← cookie _xsrf）。这是信号：请求头 speedrun 会自动抄，你只在 try_action 被拒时照它改。
- 请求晚到（懒加载、防抖、新标签页加载）：\`${cmd} computer wait 2\`，等完附带一次观察，只给上次之后的新东西，不漏不重。
- find、read_page、get_page_text、点击和输入都只在标签页的主文档里：iframe 里的内容看不到、点不到（iframe 里的请求照样录）。要操作 iframe 里的东西，用 \`${cmd} navigate <iframe 的地址>\` 直接打开它。

## 写请求：你判断有没有副作用、多严重
页面发什么就真的发什么（debug 窗口不拦），speedrun 也不替你判断哪个请求是写：看 endpoint 名、请求体和业务含义。做会引发写请求的操作之前先判断：
- 轻量、可撤销、只影响用户自己的（点赞、收藏、关注、标已读）：直接做；
- 删除、支付、下单、发布或发给别人、改设置、不可撤销的：先问用户，同意了再做。
run 输出最后的「已发出的非 GET 请求」列出实际发出的（只看方法，查询用的 POST 也在里面）：核对有没有意料之外的，真发过的写操作要在最终回复里告诉用户。
批量写（给 10 条点赞、删一批记录）在 compose 里先跑读的 action 拿到目标，用 \`ask\` 停下来确认（严重的交给用户确认），再循环跑写的 action。

## 文件在哪（用 rg / node / Python 读；没有读日志的 spr 命令）
- 每个窗口：${info.debugDir}/<id>/（打开窗口时输出了这个目录）
  - timeline.jsonl：这个窗口发生的一切，一行一条，按编号递增；type 是 request / nav / cmd / doc / snap / tab；site 是这一行属于的站点；request 行的 cause 是引发它的命令的编号，phase 是 load / cmd / idle。
  - requests/<编号>-<方法>-<endpoint 名>.json（url.query 和 requestBody 已解析，秘密是 ⟨secret_…⟩ 别名），响应体同名加 .response.json；pages/（页面 HTML、快照、read_page 的 a11y 树）、screenshots/（截图）。
- endpoint 清单：${info.actionDir}/<站点>/endpoints.json（次数、阶段统计、变量、响应结构、样本、headers（请求头的信号）、被哪个 action 覆盖）。
- 已有的 action：${siteDir}/、${info.composeDir}/。SDK：${info.libDir}/index.js（每个函数的注释就是用法；daemon 每次启动整个覆盖，别在那里改）。
- 你自己的函数：${info.helpersDir}/（不会被覆盖）。

## 怎么做
1. 工具和 Claude in Chrome 一样（同样的名字、参数、语义），写成命令；**先看结构再动手，不靠截图猜坐标**：
   - 看结构：\`${cmd} find "搜索框"\`（按目的或文字找，最多 20 个，带 ref、坐标、定位）、\`${cmd} read_page --filter interactive\`（可交互元素的 a11y 树，\`--ref ref_N\` 只看一块，\`--filter all\` 看全部）、\`${cmd} get_page_text\`（正文）
   - 点：\`${cmd} computer left_click --ref ref_12\`，还有 \`right_click\`、\`double_click\`、\`triple_click\`、\`hover\`、\`left_click_drag --ref ref_A --to ref_B\`，\`--modifiers cmd+shift\`；元素在视口外会先滚进来
   - 填：\`${cmd} form_input ref_9 华为\`（文本框先清空再填，下拉框写选项，复选框写 true / false）；也可以 \`computer left_click --ref …\` 再 \`computer type "文字"\`
   - 按：\`${cmd} computer key "Enter"\`（\`cmd+a\`、\`"Backspace Backspace"\`，\`--repeat n\`）
   - 滚：\`${cmd} computer scroll_to --ref ref_57\`（把元素滚到视口中央）、\`${cmd} computer scroll --ref ref_3 down 3\`（一格 100 像素，滚完附截图）；等：\`${cmd} computer wait 2\`（等完附带一次观察）
   - 打开：\`${cmd} navigate <网址|tab 号|back|forward>\`
   - 截图只用来确认视觉效果：\`${cmd} computer screenshot [--scale 0.5]\`、\`${cmd} computer zoom <x0> <y0> <x1> <y1>\`；a11y 树里找不到的（画布、图片里的字），才按截图坐标操作（\`computer left_click <x> <y>\`）。
   ref 只在当前页面里有效（页面跳转、元素被移除后失效，重新 find）；**写进 action 文件的是操作输出的「定位：…」**，不写死 ref；action 运行时用 \`find\` 现查的结果可以。输入都是真实输入（CDP），和用户自己点一样。**这里的工具只是探索、触发页面行为，让 speedrun 录到请求、写出 action；它们不交付结果，用户要的结果只能来自 spr run。**
2. 看到要的请求就读它的请求文件（地址、方法、请求体），自己写 \`request({ url, method, json })\`；变化的值换成函数参数。写完先试不带 \`navigate\` 的版本，只发请求比打开页面快几倍；被 401/403 拒再加回 \`navigate\`，原因写进 \`@note\`。操作后页面变了但没有请求、或观察说页面是 canvas、发现页面接口时，读 \`~/.speedrun/topics/canvas-and-page-functions.md\`，用页面函数（窗口目录的 page-api/、\`${cmd} trace <函数路径>\`）。同一种页面操作连续失败两次就换一层，不继续试。
3. 写 action 文件 ${siteDir}/<名字>.js（名字小写字母数字和 -，全局唯一；站点是请求所在页面的 host 去 www.）。文件头：

\`\`\`javascript
/**
 * @description 一句话：做什么（业务动作）
 * @status draft
 * @write（这个 action 会改东西才写，如点赞、提交、删除）
 * @endpoint 方法 路径
 * @param 参数名 说明（可选写成 参数名?；不是字符串的写类型：参数名:number、参数名?:boolean、参数名:json）
 * @returns 返回什么（可选）
 * @note 经验：签名、风控、必须先做的步骤、踩过的坑（一行一条）
 */
\`\`\`
   前置请求也要发时，@endpoint 按发送顺序写多行。
4. 这个窗口接着写下一个缺的 action。都写好了就 \`spr run <compose>\`，draft 真跑成功就变成 verified。想先验证一个 action，写一个只调用它的小 compose 再 run。
5. run 失败：输出里有出错的 action、页面、截图、run 窗口目录和恢复编号。用 rg 对比两个窗口目录的 timeline.jsonl 找原因，需要页面就回这个窗口复现，修好后用输出里的 \`spr resume <编号>\` 接着跑，已完成的 action 不重跑。
6. 写不出来：把 action 文件头改成 \`@status blocked\`，\`@note\` 写原因和证据，最终回复说明卡在哪。verified 的坏了：改回 \`@status draft\`，\`@note\` 写原因，修好后 run 通过再变成 verified。

## 写 action 的规则
- SDK：\`import { navigate, request, waitRequest, click, hover, key, scroll, scroll_to, form_input, waitFor, get_page_text, query, evaluate, sleep } from "spr"\`，入口 \`export default async ({ 参数 }) => { ... }\`，返回值就是结果。函数都不用传 page：\`navigate(url)\`、\`click(定位)\`、\`request({…})\`。名字和 debug 的工具对齐，区别只有一个：debug 用 ref（或坐标），action 用持久定位（action 要在别的窗口重放）。操作输出的「定位：…」原样放进去：\`computer left_click --ref …\` → \`click(定位)\`（右键、双击：\`click(定位, { button: "right" })\`、\`{ count: 2 }\`）；\`computer hover\` → \`hover(定位)\`；\`form_input ref_9 值\` → \`form_input(定位, 值)\`；\`computer key "cmd+a"\` → \`key("cmd+a", { loc })\`；\`computer scroll … down 3\` → \`scroll({ direction: "down", amount: 3, loc })\`；\`computer scroll_to\` → \`scroll_to(定位)\`；\`get_page_text\` → \`get_page_text({ max })\`。输入和 debug 走同一条路径（CDP 真实输入），debug 里点得动的，回放也点得动。
- **请求头**：speedrun 按顺序凑齐，你一般什么都不用写：
  1. 浏览器自己带的（cookie）；
  2. 从这次窗口里页面发过的请求抄：页面发过同一个 endpoint 就整组抄它的（签名和 endpoint 绑定的站点靠这个），否则只抄值都一样的头，每次都变的不跨 endpoint 抄。所以 action 先 \`navigate\` 打开会发这些请求的页面；
  3. 页面这次没发带某个头的请求时：照观察「请求头」给的位置写 \`auth: { "x-xsrftoken": "cookie:_xsrf", authorization: "Bearer local:token" }\`，发送时在页面里现读；
  4. 值来自前序响应（上传凭证、nonce）：先 \`request\` 前序请求，再 \`headers: { "x-token": r.json().token }\`，照观察里的「依赖」写，@endpoint 写多行；
  5. 被拒（401/403）：失败输出写了抄了什么、没抄什么、下一步；每次都变的头被拒的，改用 \`waitRequest\` 或 DOM。
  接口在另一个子域（页面是 a.com，接口是 api.a.com）不用另写，speedrun 在当前页面上发。
- run 窗口每次从空白开始，不沿用 debug 窗口的页面状态：action 第一步 \`navigate\` 要用的页面（\`request\` 从这个页面发过的请求抄头，DOM 在它上面操作）。action 里不能调用别的 action，要串起来写 compose。
- 参数是函数参数，默认值写在解构里（\`async ({ q, n = 30 }) =>\`），按 @param 的类型转好（没写类型是字符串）；变化的值（id、关键词、页码）都做成参数；返回字段用页面上的词命名。
- **小函数放进 ${info.helpersDir}/**：写 action 前先 \`ls ${info.helpersDir}\` 看有什么；同一个小函数（去 HTML 标签、格式化时间、拼 URL）第二次出现就挪进去，按用途分文件（如 text.js、time.js），action 里 \`import { stripHtml } from "../../helpers/text.js"\`。只放纯函数：要发请求或操作页面的写成 action。
- **等待**：等渲染完用 \`navigate(url, { settle: true })\`、操作带 \`{ settle: true }\`（等页面安静，最多 2 秒），或 \`waitFor(定位)\` 等具体元素；等页面自己发的请求用 \`waitRequest\`。不要用 \`sleep\` 等页面：快的页面白等、慢的不够。\`sleep\` 只用在轮询后台状态（隔一秒查一次建好了没有）。
- 成功判断：action 自己判断任务有没有正确完成，不看最后停在什么页面。检查 HTTP 状态码和业务码；读页面内容的要检查拿到的确实是目标内容（标题、关键元素），停在登录页、错误页就抛错，不能把登录页的文字当结果返回；结果必须对应本次参数；会改东西的先读状态，已满足返回 already，并在文件头写 @write；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS（\`{role,name}\` 就是 find / read_page 显示的 \`role "name"\`）；读正文用 \`get_page_text({ max })\`（返回 url、title、text），按结构取数用 \`query({css, fields})\`；\`evaluate\` 是兜底，只在这两个都不够时用。
- 一次调用只做这一个业务动作：翻页、批量、多个对象都做成参数，由 compose 循环调用。返回值只放有用的字段。

## 纪律
- **用户的结果必须来自 spr run 的返回值**，不能来自你在 debug 窗口里看到的东西。
- 大响应体用 rg / node -e 取字段，不要整段读进来；看页面先 find / read_page，截图只在要确认视觉效果时截。
`;
}
