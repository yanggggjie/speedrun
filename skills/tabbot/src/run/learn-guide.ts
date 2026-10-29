import type { EndpointJson } from "../journal/endpoints.ts";
import type { Manifest } from "../journal/material.ts";
import { DEBUG_IDLE_MS, DEBUG_MAX_OPS, type DebugWindow } from "./debug-windows.ts";

export type LearnInfo = {
  siteDir: string;
  tasksDir: string;
  /** debug 窗口的工作区：草稿、中间结果放这里，窗口收回时整个删除。 */
  workDir: string;
  materialDir: string;
  logDir: string;
  libDir: string;
  manifest: Manifest;
  /** 要学会的那一个请求：`方法 接口名`，和 endpoints.json 的 key 一致；用 find 开会话的时候没有，要自己找出来。 */
  endpoint?: string;
  /** 只知道要什么、不知道接口时：要的那一个数据或动作（一个请求的产物）。 */
  find?: string;
  /** 对这个请求的补充（--note）。 */
  note?: string;
  stat?: EndpointJson;
  /** --fix 或续草稿时已有的 task 文件。 */
  existing?: string;
};

/**
 * 开学习会话时给主 agent 自己看的指引（tabbot learn 的输出）：自包含，写清楚这次学什么、材料在哪、怎么做、纪律是什么。
 * 学习会话的产出是一份 task；用户的结果必须来自 tabbot run，不能来自探索。数据是文件，用 rg / node / Python 读。
 */
export function makeLearnGuide(t: DebugWindow, info: LearnInfo): string {
  const dbg = "tabbot debug";
  const taskFile = `${info.tasksDir}/${t.task}.js`;
  const own = `${info.logDir}/*/timeline.${t.id}.jsonl`;
  const warnings = info.manifest.warnings.length ? info.manifest.warnings.map((w) => `  - ${w}`).join("\n") : "  （无）";
  const stat = !info.stat ? "" : `
  - 在日志里出现 ${info.stat.count} 次（用户动作引发 ${info.stat.userTriggered} 次，页面加载期 ${info.stat.onLoad} 次，其余 ${info.stat.idle} 次），最近一次 #${info.stat.lastSeq} ${info.stat.lastStatus ?? ""}，最近的触发动作：${info.stat.lastCause ?? "无"}
  - 变量：${info.stat.variables.join(", ") || "无"}；响应结构：${info.stat.shape ?? "未知"}；原始请求${info.stat.replayable ? "还在内存里，可以直接重放" : "已不在内存里（replayable 为 false），要自己触发一次才能重放"}`;
  return `学习会话已开：这次只学会一个请求，写成一份 task。

# 目标
${info.endpoint
  ? `学会请求 ${info.endpoint}：弄清它的入参（哪些是变量）、怎么判断成功、响应里有什么，写成一份可重复执行的 task。`
  : `找到并学会「${info.find}」背后的那一个请求，写成一份可重复执行的 task。不知道是哪个接口：先在材料和 endpoints.json 里找（用户做过的话，userTriggered 大于 0 且 onLoad 为 0 的、lastCause 对得上的最像；也可以 rg 响应体里页面上看到的值），材料里没有再在自己的 agent 窗口里把它触发出来。找到后弄清入参（哪些是变量）、怎么判断成功、响应里有什么。`}${info.note ? `\n- 补充：${info.note}` : ""}
- 只学这一个请求：${info.endpoint ? "" : "最终只写一个 @endpoint；如果发现要靠好几个请求才能拿到这个结果，先学主要的这一个，其余记下来，学完再 tabbot learn 开下一个。"}不要在 task 里遍历、聚合、整理成业务报告，也不要替用户决定业务口径（要选的做成参数）。批量和业务组合在学完之后用 task 循环和 compose 完成。
- task 名：${t.task}${t.fix ? `（已存在，要接着做或修好它：${info.existing ?? taskFile}）` : ""}
- 站点：${t.site}（页面要登录就停下来，请用户在 Chrome 里登录，不要自己登录）
- 接口：${info.endpoint ?? "（待你找出来）"}${stat}
- 学习会话：${t.id}（最多 ${DEBUG_MAX_OPS} 次调试操作；这是独立的 agent 窗口，不会打扰用户；${Math.round(DEBUG_IDLE_MS / 60_000)} 分钟没有操作会被收回）。会话开着时 tabbot debug 不用带 --window；同时开了几个会话才要写 --window ${t.id}

# 纪律（为什么要这样）
- 调试一次慢，按 task 执行只要几十毫秒；批量的事用 task 循环就是最快的做法。所以这个会话的产出必须是一份 task，不是眼前的一个答案。
- **用户的结果必须来自 tabbot run 的返回值**，不能来自你在会话里看到、读到的东西。学完以后用 task 真跑一次拿结果，最终回复要引用 run 输出里的回执。
- 学习时真发的写操作（点赞、提交、删除）先问用户，先用 --dry 看会发什么；只做学习必需的最少几次，批量留给 task 循环；做过什么要在最终回复里告诉用户。
- 试错、失败的尝试、大响应体留在这个会话里：读响应体用 rg / node -e 取字段，不要整段读进来；截图只在需要时截。

# 你手里的材料（都是文件，用 rg / node / Python 读；没有读日志的 TabBot 命令）
- 交接材料（开会话时导出的，冻结的）：${info.materialDir}/
  - manifest.json：里面有什么、缺什么。**先读它。** 当前的缺口：
${warnings}
  - timeline.<窗口>.jsonl：一行一条，type 是 request / action / nav / cmd / tab / bg；win 是窗口（user 是用户自己，run 是 run 窗口，debug-… 是别的学习会话留下的历史）；request 行的 cause 是引发它的动作的 seq，causeDt 是相隔毫秒，phase 是 load（页面刚加载）/ action（动作引发）/ idle（轮询等）。
  - <段>/<编号>_<方法>_<地址>.json：一个请求的完整元数据（url.query 和 requestBody 已解析成对象，秘密是 ⟨secret_…⟩ 别名）；.response.json 是响应体（只给了锚点请求的）。
- 这个站点的接口清单：${info.siteDir}/endpoints.json（每个接口的次数、阶段统计、变量、响应结构、样本、被哪个 task 覆盖）。
- 全部日志（会随时间增长，包含用户此刻的操作，和这次无关的别去读）：${info.logDir}/<段>/。
- 这个会话里你做过什么：cat ${own}
- 工作区：${info.workDir}/（草稿放这里）。已有的 task：${info.tasksDir}/。

# 怎么做
**探索即写 task**：成本顺序是 读文件 < replay 重放录制里的请求 < 一次页面动作；每一步之后先看输出，再决定下一步。**先 network，不行才 dom**：
- **network**（默认）：用请求本身，task 里用 \`request(page, …)\` 直接发这个请求。
- **dom**（兜底，也是正当的结果）：请求读不了响应体（流式、二进制）、必须由页面脚本带签名发出、或页面上有数据却没有可用的请求时，task 做页面操作并用 \`text\` / \`query\` 取数据；用 \`${dbg} close --blocked\` 之前先试过它。

1. 读 manifest.json，再读目标接口的请求文件：方法、地址、请求体里哪些是变量、响应长什么样。**有请求就用请求。**
2. 请求能直接重放：\`${dbg} replay <编号> --set 名字=值\`（编号是请求文件名开头的数字）。非 GET 的请求要 --yes，并且先问过用户。原始请求不在内存里时（replayable 为 false）：自己在页面上触发一次，它就进内存了，再用新的编号重放。
3. 要动页面：\`${dbg} open <网址>\` 打开，\`${dbg} screenshot\` 截图（存成文件，用读图片的方式看它），再按图上的坐标操作：\`${dbg} click <x> <y>\`、\`${dbg} type "文字"\`（先 click 输入框）、\`${dbg} key Enter\`、\`${dbg} scroll down [像素] [x y]\`。没有页面结构、没有元素编号，只靠看图。**每个动作的输出写明这一步引发了哪些请求**（含 GET，内容类型，有没有响应体）**和一行可贴进 task 的代码**。**引发请求后会锁定**：先把它写进 task 草稿 ${taskFile}（读不了响应体就把这一步写成 DOM 步骤），才能继续 open / click / type / key / scroll；replay 和 screenshot 不受限。没引发请求的动作，把那一行贴进草稿，不要空翻。
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

5. 会话只有两种结束。跑通：\`tabbot run ${t.task} --参数 值 --window ${t.id}\`（有副作用且想先看看会发什么：加 \`--dry\`），跑通一次自动变成 verified，会话随之收回。确认学不会：\`${dbg} close --blocked "原因和证据"\`（试过哪些请求编号、做过几次动作、为什么 network 和 DOM 都不行），task 标成 blocked，之后不再探索；最终回复说明卡在哪，需要时请用户示范一次。两种结束都有回执，最终回复要引用。
6. 学完以后：用这份 task（以及别的 task，用 tabbot compose 组合）去完成用户真正要的事，结果来自 tabbot run。

# 写 task 的规则
- SDK：\`import { tabbot, goto, request, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, serializeUrl } from "../../../lib/index.js"\`（路径相对 ${info.tasksDir}/，SDK 在 ${info.libDir}/），入口 \`await tabbot.run(async ({ page }) => { ... })\`，返回值就是结果。
- \`request(page, {url, method?, headers?, json?})\` 默认继承页面自己最近发出的请求头（token 真值只在 holder 内存里）；内存里没有可继承的头时会自动打开站点首页让页面自己发请求。
- 参数用 \`tabbot.params.名字\`（字符串）；变化的值（id、关键词、页码）都做成参数。
- 成功判断：检查 HTTP 状态码和业务码；结果必须对应本次参数；有副作用的先读状态，已满足返回 already；返回被操作对象的稳定 id。
- 定位用 \`{role,name}\` 或 CSS；\`query(page, {css, fields})\` 取数；\`evaluate\` 是兜底（严格 CSP 的页面会被拒）。
- 一次调用只发这一个请求一次：翻页、批量、多个对象都做成参数，由 task 循环调用（tabbot compose），task 里不写循环。
- 返回值只放这个请求结果里有用的字段，不要把整段响应原样返回，也不要做业务汇总。
`;
}
