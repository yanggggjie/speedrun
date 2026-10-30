/**
 * 事件来源：只录 agent 的窗口，所以几乎都是 agent（TabBot 的动作、重放，以及 agent 窗口里页面脚本触发的请求和导航）；
 * user 只在有人在 agent 窗口里真的动了一下时出现（isTrusted 为真）。page 是旧版本留下的行。
 */
export type Src = "user" | "agent" | "page";
/** request 是 fetch / XHR / 重放，action 是页面里的输入事件，cmd 是 agent 的命令记录，doc 是主文档渲染后的 HTML，snap 是页面快照。 */
export type RowType = "request" | "action" | "nav" | "doc" | "snap" | "cmd" | "tab";
/** 请求发生的阶段：load 是页面刚加载（或单页应用刚路由）的那几秒，action 是动作引发的，idle 是轮询、后台自发。 */
export type Phase = "load" | "action" | "idle";

/** 不是 agent 窗口的标签页（用户自己的）：它的一切都不录。agent 的窗口是 run 和学习会话的 debug-xxxx。 */
export const USER_WIN = "user";

/** timeline.<窗口>.jsonl 里的一行。字段名沿用 yodo 的录制材料（type / actionType / requestType / selector / role / name）。 */
export type Row = {
  seq: number;
  /** 毫秒时间戳。 */
  t: number;
  win: string;
  src: Src;
  tab: number;
  frame?: number;
  type: RowType;
  /** 页面地址（脱敏、不含参数）。 */
  page?: string;
  url?: string;
  /** action / cmd：click、input、scroll、key、goto、request……；target 是元素的简短描述，如 button[Like]。 */
  actionType?: string;
  target?: string;
  /** cmd：agent 用 --description 写的这一步要做什么（用户的话，业务含义）。这一步引发的请求经 cause 指向这一行。 */
  description?: string;
  role?: string;
  name?: string;
  selector?: string;
  key?: string;
  deltaY?: number;
  /** input 事件合并后的字数。 */
  n?: number;
  /** cmd 的结果。 */
  ok?: boolean;
  error?: string;
  detail?: Record<string, unknown>;
  /** request：fetch / xhr / replay。 */
  requestType?: string;
  method?: string;
  status?: number;
  size?: number;
  /** request：`方法 接口名`，也就是 task 文件头 @endpoint 的写法。 */
  endpoint?: string;
  /** 1 = 埋点、广告等噪声，默认不看。 */
  noise?: 1;
  /** 这个请求由哪个动作引发：同一标签页 2 秒内最近一次用户事件或 agent 命令的 seq，causeDt 是相隔的毫秒数。 */
  cause?: number;
  causeDt?: number;
  phase?: Phase;
  replayOf?: number;
  /** nav / tab：load、pushState、popstate…；count：旧版本的 bg 行留下的请求数。 */
  via?: string;
  count?: number;
  /** 指向请求文件、文档或快照，路径相对站点的 log/ 目录：`<段>/<文件名>`。 */
  file?: string;
};

export type ParsedUrl = { bareUrl: string; query: Record<string, string> };

/** 一次请求的完整元数据，一个请求一个 JSON 文件；沿用 yodo 的请求文件，另加 seq / win / 因果 / 接口名 / rid。秘密都是别名。 */
export type RequestFile = {
  seq: number;
  win: string;
  endpoint: string;
  requestType: string;
  /** 发出请求的标签页；原始请求在内存里按 标签页 + rid 存。 */
  tab?: number;
  /** 页面脚本给的请求编号；原始请求（含 token 真值）在 holder 内存里，靠它找回来重放。 */
  rid?: string;
  cause?: number;
  causeDt?: number;
  phase?: Phase;
  replayOf?: number;
  /** 重放时 --set 改了哪些名字（只记名字，不记值）。 */
  set?: string[];
  method: string;
  url: ParsedUrl;
  frameUrl?: ParsedUrl;
  headers: Record<string, string>;
  /** JSON 请求体解析成对象；表单解析成对象；其它是脱敏后的文字，或页面脚本放的占位文字。 */
  requestBody?: unknown;
  requestBodyTruncated?: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  /** 相对站点 log/ 目录：`<段>/<文件名>`；没存响应体时没有这个字段，bodyOmitted 写明原因。 */
  responseBodyPath?: string;
  responseSize?: number;
  truncated?: boolean;
  bodyOmitted?: string;
  error?: string;
  startedAt: number;
  endedAt: number;
};
