/**
 * 学习会话里“一步动作之后看什么”的纯函数：这一步引发了哪些请求（含 GET，写明有没有响应体）、可贴进 task 的一行。
 * 引发请求就转去学请求（pointerCommand 据此锁定后续动作，见 commands.ts）；没有请求时这一行就是 DOM 步骤的草稿。
 */
import type { RequestFile, Row } from "./types.ts";

/** 静态资源不算“引发了请求”：脚本、样式、图片、字体。 */
const STATIC = /\.(?:m?js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|map|mp4|webm)(?:$|\?)/i;

export type PeriodicStat = { count: number; idle: number; userTriggered: number };

/** 周期性接口（轮询、心跳）：多数调用是 idle，用户动作从没引发过。它们落在动作后两秒内也不算这一步引发的。 */
export function isPeriodic(stat: PeriodicStat | undefined): boolean {
  return !!stat && stat.idle >= 3 && stat.idle * 2 >= stat.count && stat.userTriggered === 0;
}

/** 从这一步之后新增的时间线行里挑出引发的请求：非噪声、非重放、非 idle、非静态资源、非周期性接口。 */
export function causedRequests(rows: Row[], stats: ReadonlyMap<string, PeriodicStat>): Row[] {
  return rows.filter((r) =>
    r.type === "request" && !r.noise && r.requestType !== "replay" && r.phase !== "idle"
    && !STATIC.test(r.url ?? "") && !isPeriodic(r.endpoint ? stats.get(r.endpoint) : undefined));
}

/** 一个请求的一行描述：编号、方法、地址、状态、内容类型、有没有响应体（没有就写原因）、请求文件。 */
export function describeRequest(r: Pick<Row, "seq" | "method" | "url" | "status">, file: RequestFile | undefined, abs: string | undefined): { line: string; readable: boolean } {
  const ct = file?.responseHeaders?.["content-type"]?.split(";")[0]?.trim() || "未知类型";
  const readable = !!file?.responseBodyPath;
  const body = readable ? "有响应体" : `无响应体（${file?.bodyOmitted ?? "没存"}）`;
  return { line: `#${r.seq} ${r.method ?? "?"} ${r.url ?? ""} → ${r.status ?? "?"} ${ct}，${body}，请求文件 ${abs ?? "（未找到）"}`, readable };
}

type StepCmd = { kind: string; text?: string; key?: string; dx?: number; dy?: number; to?: string };

/** 可贴进 task 草稿的一行（SDK 见 src/task-lib/index.js）。 */
export function stepLine(cmd: StepCmd, loc: unknown): string {
  const where = loc ? JSON.stringify(loc) : undefined;
  switch (cmd.kind) {
    case "click": return where ? `await click(page, ${where});` : "// 这一步点击没有拿到持久定位：换个更具体的位置再点";
    case "type": return where ? `await fill(page, ${where}, ${JSON.stringify(cmd.text ?? "")});` : `// 输入 ${JSON.stringify(cmd.text ?? "")}：先 click 输入框拿到定位，再写 await fill(page, <定位>, …);`;
    case "key": return `await press(page, ${JSON.stringify(cmd.key ?? "")});`;
    case "scroll": {
      const opts = cmd.to ? { to: cmd.to } : { dy: cmd.dy };
      return `await scroll(page, ${JSON.stringify(where ? { loc, ...opts } : opts)});`;
    }
    default: return "";
  }
}
