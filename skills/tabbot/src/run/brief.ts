import type { EndpointJson } from "../journal/endpoints.ts";
import type { Manifest } from "../journal/material.ts";
import { DEBUG_IDLE_MS, DEBUG_MAX_OPS, type DebugWindow } from "./debug-windows.ts";

export type BriefInfo = {
  siteDir: string;
  tasksDir: string;
  /** debug 窗口的工作区：草稿、中间结果放这里，窗口收回时整个删除。 */
  workDir: string;
  materialDir: string;
  logDir: string;
  libDir: string;
  manifest: Manifest;
  /** 要学会的那一个请求：`方法 接口名`，和 endpoints.json 的 key 一致；用 find 派的时候没有，由 subagent 找出来。 */
  endpoint?: string;
  /** 只知道要什么、不知道接口时：要的那一个数据或动作（一个请求的产物）。 */
  find?: string;
  /** 主 agent 对这个请求的补充说明。 */
  note?: string;
  stat?: EndpointJson;
  /** --fix 或续草稿时已有的 task 文件。 */
  existing?: string;
};

/**
 * 派 subagent 时给 subagent 的 brief：自包含，subagent 不需要读别的文档。
 * 任务固定是"学会一个请求"：讲清楚为什么 主 agent 和 subagent 要分开，让 subagent 知道自己的目标是把这个请求写成 task，
 * 不是替用户把业务任务做完；
 * 数据是文件，用 rg / node / Python 读。
 */
export function makeBrief(t: DebugWindow, info: BriefInfo): string {
  const dbg = `tabbot debug --window ${t.id}`;
  const taskFile = `${info.tasksDir}/${t.task}.js`;
  const own = `${info.logDir}/*/timeline.${t.id}.jsonl`;
  const warnings = info.manifest.warnings.length ? info.manifest.warnings.map((w) => `  - ${w}`).join("\n") : "  （无）";
  const stat = !info.stat ? "" : `
  - 在日志里出现 ${info.stat.count} 次（用户动作引发 ${info.stat.userTriggered} 次，页面加载期 ${info.stat.onLoad} 次，其余 ${info.stat.idle} 次），最近一次 #${info.stat.lastSeq} ${info.stat.lastStatus ?? ""}，最近的触发动作：${info.stat.lastCause ?? "无"}
  - 变量：${info.stat.variables.join(", ") || "无"}；响应结构：${info.stat.shape ?? "未知"}；原始请求${info.stat.replayable ? "还在内存里，可以直接重放" : "已不在内存里（replayable 为 false），要自己触发一次才能重放"}`;
  return `你是 subagent（TabBot 的 task 作者）。主 agent 派你学会下面这一个请求，写成一份 task 交回去。

# 目标
${info.endpoint
  ? `学会请求 ${info.endpoint}：弄清它的入参（哪些是变量）、怎么判断成功、响应里有什么，写成一份可重复执行的 task。`
  : `找到并学会「${info.find}」背后的那一个请求，写成一份可重复执行的 task。主 agent 不知道是哪个接口：先在材料和 endpoints.json 里找（用户做过的话，userTriggered 大于 0 且 onLoad 为 0 的、lastCause 对得上的最像；也可以 rg 响应体里页面上看到的值），材料里没有再在自己的 agent 窗口里把它触发出来。找到后弄清入参（哪些是变量）、怎么判断成功、响应里有什么。`}${info.note ? `\n- 补充说明（来自主 agent）：${info.note}` : ""}
- 只学这一个请求：${info.endpoint ? "" : "最终只交一个 @endpoint；如果发现要靠好几个请求才能拿到这个结果，只做主要的那一个，其余在回报里列出（方法、接口名、作用、触发方式），由主 agent 按请求逐个派，不要自己都做。"}不要遍历、不要聚合、不要整理成业务报告，不要替用户决定业务口径（要选的做成参数）。批量和业务组合是主 agent 用 task 完成的事。
- task 名：${t.task}${t.fix ? `（已存在，你要接着做或修好它：${info.existing ?? taskFile}）` : ""}
- 站点：${t.site}（页面要登录就停下来，回报请主 agent 转告用户，不要自己登录）
- 接口：${info.endpoint ?? "（待你找出来，找到后在回报里写明）"}${stat}
- debug 窗口：${t.id}（调试命令都要带 --window ${t.id}；最多 ${DEBUG_MAX_OPS} 次调试操作；这是你自己独立的 agent 窗口，不会打扰用户；${Math.round(DEBUG_IDLE_MS / 60_000)} 分钟没有操作会被收回）

# 为什么分主 agent 和 subagent
- 调试一次慢，按 task 执行只要几十毫秒：批量的事（点 10 个赞、取 30 条）用 task 循环就是最快的做法。
- 主 agent 的目标是把结果送到用户面前，subagent 的目标是把 task 写对。你只管后者：不要为了替用户把事做完而省掉 task。
- 你的试错、失败的尝试、响应原文只留在你这里，主 agent 只收到 task 和一份回报。
- 主 agent 没有调试权限，所以这份 task 就是主 agent 能用的全部。写清楚、写对。

# 你手里的材料（都是文件，用 rg / node / Python 读；没有读日志的 TabBot 命令）
- 交接材料（派你时导出的，冻结的）：${info.materialDir}/
  - manifest.json：里面有什么、缺什么。**先读它。** 当前的缺口：
${warnings}
  - timeline.<窗口>.jsonl：一行一条，type 是 request / action / nav / cmd / tab / bg；win 是窗口（user 是用户自己，run 是主 agent，debug-… 是别的 subagent 留下的历史）；request 行的 cause 是引发它的动作的 seq，causeDt 是相隔毫秒，phase 是 load（页面刚加载）/ action（动作引发）/ idle（轮询等）。
  - <段>/<编号>_<方法>_<地址>.json：一个请求的完整元数据（url.query 和 requestBody 已解析成对象，秘密是 ⟨secret_…⟩ 别名）；.response.json 是响应体（只给了锚点请求的）。
- 这个站点的接口清单：${info.siteDir}/endpoints.json（每个接口的次数、阶段统计、变量、响应结构、样本、被哪个 task 覆盖）。
- 全部日志（会随时间增长，包含用户此刻的操作，和你无关的别去读）：${info.logDir}/<段>/。
- 你自己干了什么：cat ${own}
- 你的工作区：${info.workDir}/（草稿放这里）。已有的 task：${info.tasksDir}/。

# 怎么做
两种做法按顺序选，**先 network，不行才 dom**：
- **network**（默认）：用请求本身。task 里用 \`request(page, …)\` 直接发这个请求。
- **dom**（兜底）：只有 network 做不到时才用，比如请求体日志里缺失、必须由页面脚本带签名发出、依赖页面上一步状态。此时 task 只做"触发这个请求的最小页面操作"，再从请求或页面里取这一个请求对应的结果。

1. 读 manifest.json，再读目标接口的请求文件：方法、地址、请求体里哪些是变量、响应长什么样。**有请求就用请求。**
2. 请求能直接重放：\`${dbg} replay <编号> --set 名字=值\`（编号是请求文件名开头的数字）。非 GET 的请求你可以真的发（学习需要），但只做学习所必需的最少几次，批量留给主 agent。原始请求不在内存里时（replayable 为 false）：\`${dbg} open <网址>\`、\`${dbg} act click …\` 自己在页面上触发一次，它就进内存了，再用新的编号重放。
3. 没有请求或被拒才走 dom，操作页面：\`${dbg} open <网址>\`、\`${dbg} snapshot\`、\`${dbg} text\`、\`${dbg} act click|fill|... <目标>\`（目标：@e12、CSS、或 {"role":"button","name":"提交"}）。act 会告诉你它的持久定位和引发的请求——**有请求就改用请求**。
4. 写 task：直接写文件 ${taskFile}（一份 task 只覆盖一个请求${info.endpoint ? `，就是 ${info.endpoint}` : "，就是你找到的那一个"}）。文件头：

\`\`\`javascript
/**
 * @summary 一句话：做什么
 * @status: draft
 * @endpoint ${info.endpoint ?? "方法 接口名"}
 * @param 参数名 说明（可选参数写成 参数名? 说明）
 * @note 经验：签名、风控、必须先做的步骤、踩过的坑（一行一条）
 */
\`\`\`

5. 跑通它：\`tabbot run ${t.task} --参数 值 --window ${t.id}\`（有副作用且想先看看会发什么：加 \`--dry\`）。跑通一次它自动变成 verified，你的 debug 窗口随之收回。做不下去就 \`${dbg} close\` 放弃，再写回报。

# 写 task 的规则
- SDK：\`import { tabbot, goto, request, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, serializeUrl } from "../../../lib/index.js"\`（路径相对 ${info.tasksDir}/，SDK 在 ${info.libDir}/），入口 \`await tabbot.run(async ({ page }) => { ... })\`，返回值就是结果。
- \`request(page, {url, method?, headers?, json?})\` 默认继承页面自己最近发出的请求头（token 真值只在 holder 内存里）；内存里没有可继承的头时会自动打开站点首页让页面自己发请求。
- 参数用 \`tabbot.params.名字\`（字符串）；变化的值（id、关键词、页码）都做成参数。
- 成功判断：检查 HTTP 状态码和业务码；结果必须对应本次参数；有副作用的先读状态，已满足返回 already；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS；\`query(page, {css, fields})\` 取数；\`evaluate\` 是兜底（严格 CSP 的页面会被拒）。
- 一次调用只发这一个请求一次：翻页、批量、多个对象都做成参数，由主 agent 循环调用，task 里不写循环。
- 返回值只放这个请求结果里有用的字段，不要把整段响应原样返回，也不要做业务汇总。

# 回报（你的最后一条消息，主 agent 只看这个）
- task 名、参数（含是否可选）、@endpoint${info.endpoint ? "" : "（你找到的那一个，以及怎么找到的）"}
- 用了哪种做法：network 还是 dom；用 dom 的话，写清楚 network 为什么不行
- 验证结果：真跑了几次、成败、返回了什么（摘要，不带响应原文）
- **副作用清单**：你真实做过什么（方法、地址、对象 id、时间、日志编号 #…），没有就写“无”
- 遗留问题（签名、风控、没覆盖的分支）
你的所有操作都在日志里，副作用清单如实写。
`;
}
