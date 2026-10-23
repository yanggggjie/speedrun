import type { EventRow } from "./types.ts";
import { dayOf } from "./store.ts";

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
    const text = (u.host === hostOf(page) ? "" : u.host) + u.pathname + u.search;
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  } catch { return url.slice(0, 90); }
}

function size(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

function bodyOf(row: EventRow): string {
  switch (row.kind) {
    case "net": {
      const parts = [row.method ?? "", shortUrl(row.url, row.page), row.status ?? (row.verb === "beacon" ? "beacon" : "ERR"), size(row.size)];
      if (row.body) parts.push(`body:${dayOf(row.ts)}/${row.body}`);
      if (row.dup > 1) parts.push(`×${row.dup}`);
      if (row.noise) parts.push("[noise]");
      if (row.cause) parts.push(`← #${row.cause}`);
      return parts.filter((p) => p !== "").join(" ");
    }
    case "input": {
      const extra = row.verb === "input" && row.size ? ` ${row.size}字` : row.verb === "scroll" && row.size != null ? ` ${row.size > 0 ? "↓" : "↑"}${Math.abs(row.size)}px` : "";
      return `${row.verb} ${row.target ?? ""}${extra}`.trim();
    }
    case "nav": return `nav ${row.target ?? ""} ${shortUrl(row.url, undefined)}`.trim();
    case "snap": return `snap ${row.target ?? ""} file:${dayOf(row.ts)}/${row.body ?? ""}`.trim();
    case "ws": return `ws ${row.verb} ${row.target ?? ""}`.trim();
    case "bg": return `bg ×${row.size ?? 0} 个请求（后台）`;
    default: return `${row.kind} ${row.verb} ${row.url ?? row.page ?? ""}`.trim();
  }
}

/** 一行一个事件：`#203 14:03:21 tab3 human click button[取消]`。 */
export function formatEvent(row: EventRow): string {
  return `#${row.seq} ${clock(row.ts)} tab${row.tab} ${row.src.padEnd(5)} ${bodyOf(row)}`;
}
