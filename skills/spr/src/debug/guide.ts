import { DEBUG_IDLE_MS, DEBUG_MAX_OPS } from "./windows.ts";

export type DebugInfo = {
  debugDir: string;
  actionDir: string;
  libDir: string;
  helpersDir: string;
};

/**
 * debug 指引：给操作浏览器窗口的 agent 以及沉淀 action 的 distiller subagent 查阅。
 * 存在 ~/.speedrun/debug-guide.md；内容变了才在第一次打开窗口时附全文，其余时候只给路径。
 */
export function makeDebugGuide(info: DebugInfo): string {
  const cmd = "spr debug <名>";
  const siteDir = `${info.actionDir}/<站点>`;
  return `# debug 与写 action 指引

debug 窗口在用户 Chrome 的折叠标签组里操作页面并自动录制请求（不切换用户标签页、不抢前台）：
- **单次新任务**：直接在这里完成操作或读取数据，当场回复用户；收到输出末尾的「未沉淀窗口」提示时，派发后台 subagent 读取 \`~/.speedrun/agents/distiller.md\` 把窗口日志提炼成可复用的 action。
- **批量 / 翻页新任务**：在这里做第 1 条看清接口，当场写成 action 再用 \`spr run -e\` 批量跑完。
- **修已有的 action**：在这里复现问题、核对请求和响应，修好文件后用 \`spr run <action>\` 验证。

## 窗口与操作
- \`${cmd} navigate <网址|tab 号>\` 打开窗口（<名> 用小写字母、数字和 -，无需预先建文件）；close、空闲 ${Math.round(DEBUG_IDLE_MS / 60_000)} 分钟、daemon 重启、扩展重连、标签组被关时关闭，最多 ${DEBUG_MAX_OPS} 次页面操作。
- 遇到登录页：点一下就能登录的自己点（点前点后 find / read_page 确认）；要账号密码、二维码、验证码的停下来请用户在 Chrome 里登录。
- 工具和 Claude in Chrome 对齐（先 find / read_page 看结构拿 ref，不靠截图猜坐标）：
  - 看结构：\`${cmd} find "搜索框"\`、\`${cmd} read_page --filter interactive\`、\`${cmd} get_page_text\`
  - 操作：\`${cmd} computer left_click --ref ref_12\`（及 right_click / double_click / hover / left_click_drag / scroll / scroll_to / type / key / wait / screenshot / zoom）、\`${cmd} form_input ref_9 值\`、\`${cmd} navigate <网址|back|forward>\`
  - 页面接口：\`${cmd} inspect --path <对象>\`、\`${cmd} trace <函数路径…>\`
- 写请求判断：页面发什么就真发什么。轻量可撤销的（点赞、收藏）直接做；删除、支付、下单、发布、改设置等不可撤销的先问用户。

## 五层实现优先级（写 action 时从上往下选，不跳层）
1. **不需要 token 的官方 API**（或只靠网站 cookie 就能调的公开接口）
2. **页面发的 HTTP 请求**（\`request({ url, method, json, auth?, authQuery? })\`；签名与参数强绑定的用 \`waitRequest("<METHOD> <path>", trigger)\`）
3. **页面函数**（\`evaluate\` 调页面自己的接口，配合窗口 \`page-api/\` 与 \`trace\`，详见 \`~/.speedrun/topics/canvas-and-page-functions.md\`）
4. **WebSocket、事件流**（\`waitMessage\`）
5. **DOM 或真实输入**（\`query\`、\`get_page_text\`、\`click(<定位>)\`、\`form_input(<定位>, 值)\`）

不在第 1 层的 action，\`@note\` 按层写明上面每一层试了什么、为什么不行；五层都不行的写 \`@status blocked\` 和 \`@note\`。

## action 文件规范（\`${siteDir}/<名字>.js\`）
\`\`\`javascript
/**
 * @description 一句话说明业务动作
 * @status draft
 * @from <debug窗口id>（从 debug 窗口提炼时写上窗口目录名）
 * @write（会改动网站数据时才写）
 * @endpoint <METHOD> <path>（可多行，按发送顺序）
 * @param <name> 说明（可选加 ?，类型支持 :number / :boolean / :json，默认字符串）
 * @returns 返回字段说明（可选）
 * @note 分层依据与踩坑经验
 */
import { navigate, request } from "spr";
export default async ({ q, page = 1 }) => {
  await navigate("https://example.com/search");
  const res = await request({ url: \`https://example.com/api/search?q=\${encodeURIComponent(q)}&page=\${page}\` });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json().items;
};
\`\`\`

- **独立可重放**：run 窗口每次从空白页开始，需要抄页面请求头或操作 DOM 时第一步先 \`navigate\`；只靠 cookie 就能发的 \`request\` 可不写 \`navigate\`（更快，被 401/403 拒再加回）。
- **定位与命名**：debug 操作输出的「定位：…」原样放进 \`click\` / \`form_input\`，不写死 \`ref_N\`；变量、参数、返回字段一律用英文 camelCase，拿不到预期数据时抛错（不返回空值蒙混成 verified）。
- **复用与组合**：返回整理好的完整业务字段（去掉无用的大段 HTML / base64）；公共纯函数放进 \`${info.helpersDir}/<文件>.js\`，脚本里统一写 \`import { … } from "spr/helpers/<文件>.js"\`；同站两步工作流可在 action 内调用 \`await action("other", params)\`（最多 2 层），一次性批量或过滤直接用 \`spr run -e '<js>'\`。
- **验证**：只读 action 写完跑一次 \`spr run <名字>\` 真实验证成 \`verified\`；带 \`@write\` 的写操作如果探索时已经做过，保留 \`@status draft\` 不要为了验证再发第二次。

## 日志文件位置（用 rg / jq / node 直接读）
- 窗口目录：\`${info.debugDir}/<id>/\`（\`timeline.jsonl\`、\`requests/<编号>-<方法>-<名>.json\` 及 \`.response.json\`、\`pages/\`、\`screenshots/\`、\`page-api/\`、\`sockets/\`）
- 站点汇总：\`${siteDir}/endpoints.json\`、\`${siteDir}/page-api.json\`
- SDK 定义与完整注释：\`${info.libDir}/index.js\`
`;
}
