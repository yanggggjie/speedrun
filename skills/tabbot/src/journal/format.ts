import type { EventRow } from "./types.ts";

const pad = (n: number): string => String(n).padStart(2, "0");
export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hostOf(url: string | undefined): string {
  try { return new URL(url ?? "").host; } catch { return ""; }
}

/** 同站请求只显示路径，跨站显示 host + 路径，太长截断。 */
function shortUrl(url: string | undefined, page: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    // URL 会把别名里的 ⟨ ⟩ 编码掉，这里还原，agent 才能把别名原样写进 --set
    const text = ((u.host === hostOf(page) ? "" : u.host) + u.pathname + u.search).replace(/%E2%9F%A8/g, "⟨").replace(/%E2%9F%A9/g, "⟩");
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  } catch { return url.slice(0, 90); }
}

function size(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** agent 的命令失败了：日志行末尾带上原因。 */
function failure(row: EventRow): string {
  if (row.kind !== "cmd" || !row.detail) return "";
  try {
    const d = JSON.parse(row.detail) as { ok?: boolean; error?: string; rejected?: string };
    return d.ok === false ? ` ✗ ${d.error ?? d.rejected ?? "失败"}` : "";
  } catch { return ""; }
}

function bodyOf(row: EventRow): string {
  switch (row.kind) {
    case "net": {
      const parts = [row.method ?? "", shortUrl(row.url, row.page), row.status ?? "ERR", size(row.size)];
      if (row.body) parts.push(`body:${row.body}`);
      if (row.dup > 1) parts.push(`×${row.dup}`);
      if (row.noise) parts.push("[noise]");
      if (row.cause) parts.push(`← #${row.cause}`);
      return parts.filter((p) => p !== "").join(" ");
    }
    case "input": case "cmd": {
      const extra = (row.verb === "input" || row.verb === "fill") && row.size ? ` ${row.size}字` : row.verb === "scroll" && row.size != null ? ` ${row.size > 0 ? "↓" : "↑"}${Math.abs(row.size)}px` : "";
      return `${row.kind === "cmd" ? "cmd " : ""}${row.verb} ${row.target ?? ""}${extra}${failure(row)}`.trim();
    }
    case "doc": return `doc ${shortUrl(row.url, row.page)} ${size(row.size)}${row.body ? ` body:${row.body}` : ""}`.trim();
    case "nav": return `nav ${row.target ?? ""} ${shortUrl(row.url, undefined)}`.trim();
    case "snap": return `snap ${row.target ?? ""} file:${row.body ?? ""}`.trim();
    case "bg": return `bg ×${row.size ?? 0} 个请求（后台）`;
    default: return `${row.kind} ${row.verb} ${row.url ?? row.page ?? ""}`.trim();
  }
}

/** 一行一个事件：`#203 14:03:21 tab3 human click button[取消]`。 */
export function formatEvent(row: EventRow): string {
  return `#${row.seq} ${clock(row.ts)} tab${row.tab} ${row.src.padEnd(5)} ${bodyOf(row)}`;
}
