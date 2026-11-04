/**
 * 事件来源：只录 agent 的窗口，agent 窗口里发生的一切都算 agent 的（speedrun 的动作，以及页面脚本触发的请求和导航）。
 * page 只在摄入时用（页面脚本触发的），写入时记为 agent。
 */
export type Src = "agent" | "page";
/** request 是 fetch / XHR，cmd 是 agent 的命令记录（每一步操作），doc 是主文档渲染后的 HTML，snap 是页面快照（a11y 是 read_page 的 a11y 树）。 */
export type RowType = "request" | "nav" | "doc" | "snap" | "cmd" | "tab";
/** 请求发生的阶段：load 是页面刚加载（或单页应用刚路由）的那几秒，cmd 是 agent 的命令引发的，idle 是轮询、后台自发。 */
export type Phase = "load" | "cmd" | "idle";

/** 不是 agent 窗口的标签页（用户自己的）：它的一切都不录。agent 的窗口是 learn 窗口（句柄）和 run 窗口（名字）。 */
export const USER_WIN = "user";

/** 窗口目录里 timeline.jsonl 的一行。 */
export type Row = {
  seq: number;
  /** 毫秒时间戳。 */
  t: number;
  win: string;
  /** 这一行属于哪个站点：请求按发出它的页面的 host（去 www.），命令按它所在页面。 */
  site?: string;
  src: Src;
  tab: number;
  frame?: number;
  type: RowType;
  /** 页面地址（脱敏、不含参数）。 */
  page?: string;
  url?: string;
  /** cmd / snap 的种类：left_click、form_input、scroll、key、navigate、request……；target 是元素的简短描述，如 button[Like]。 */
  kind?: string;
  target?: string;
  /** cmd：agent 用 --description 写的这一步要做什么（用户的话，description）。这一步引发的请求经 cause 指向这一行。 */
  description?: string;
  /** cmd 的结果。 */
  ok?: boolean;
  error?: string;
  detail?: Record<string, unknown>;
  /** request：fetch / xhr。 */
  requestType?: string;
  method?: string;
  status?: number;
  size?: number;
  /** request：`方法 路径`，也就是 action 文件头 @endpoint 的写法。 */
  endpoint?: string;
  /** 1 = 埋点、广告等噪声，默认不看。 */
  noise?: 1;
  /** 这个请求由哪个动作引发：同一标签页 2 秒内最近一次 agent 命令的 seq，causeDt 是相隔的毫秒数。 */
  cause?: number;
  causeDt?: number;
  phase?: Phase;
  /** nav / tab：load、pushState、popstate…。 */
  via?: string;
  /** 指向请求文件、页面或截图，路径相对窗口目录：`requests/001203-GET-api-v4-search_v3.json`。 */
  file?: string;
};

export type { ParsedUrl } from "../utils/url.ts";
import type { ParsedUrl } from "../utils/url.ts";

/** 一次请求的完整元数据，一个请求一个 JSON 文件：seq / win / 因果 / endpoint 名 / rid 之外是请求本身。秘密都是别名。 */
export type RequestFile = {
  seq: number;
  win: string;
  endpoint: string;
  requestType: string;
  /** 发出请求的标签页；原始请求在内存里按 标签页 + rid 存。 */
  tab?: number;
  /** 页面脚本给的请求编号；原始请求（含 token 真值）在 daemon 内存里，靠它找回来（继承请求头、生成草稿）。 */
  rid?: string;
  cause?: number;
  causeDt?: number;
  phase?: Phase;
  method: string;
  url: ParsedUrl;
  frameUrl?: ParsedUrl;
  headers: Record<string, string>;
  /** JSON 请求体解析成对象；表单解析成对象；其它是脱敏后的文字，或页面脚本放的占位文字。 */
  requestBody?: unknown;
  requestBodyTruncated?: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  /** 相对窗口目录：`requests/<…>.response.json`；没存响应体时没有这个字段，bodyOmitted 写明原因。 */
  responseBodyPath?: string;
  responseSize?: number;
  truncated?: boolean;
  bodyOmitted?: string;
  error?: string;
  startedAt: number;
  endedAt: number;
};
