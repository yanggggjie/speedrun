/**
 * 把原始日志整理成 agent 一眼能用的两份材料（纯函数，输入是已经读出来的行）：
 * - context：用户最近在各个站点上做了什么（访问的页面、自己的操作、操作引发的请求、agent 的命令）；
 * - api：某个站点上出现过的接口清单（方法 + 接口名、次数、变量、触发它的用户操作、响应结构、能不能直接重放）。
 */
import * as fs from "node:fs";
import { getDomain } from "tldts";
import { clock } from "./format.ts";
import { bodyPath } from "./store.ts";
import type { EventRow } from "./types.ts";

/** 站点：注册域名（x.com、zhihu.com）；不是网址返回空串。 */
export function siteOf(url: string | undefined): string {
  try { const host = new URL(url ?? "").hostname; return getDomain(host) ?? host; } catch { return ""; }
}

/** 把用户输入（域名或网址）变成站点。 */
export function normalizeSite(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return "";
  return siteOf(text.includes("://") ? text : `https://${text}`);
}

const ID_SEG = /^(\d{5,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 接口名：GraphQL 取操作名（/graphql/<queryId>/<操作名>，queryId 会变），其它取路径并把长数字、哈希、uuid 换成 :id。 */
export function endpointOf(url: string): { host: string; name: string } {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const gi = segs.indexOf("graphql");
    if (gi >= 0 && segs.length > gi + 2) return { host: u.hostname, name: `graphql ${segs[gi + 2]}` };
    return { host: u.hostname, name: "/" + segs.map((s) => (ID_SEG.test(s) ? ":id" : s)).join("/") };
  } catch {
    return { host: "", name: url.slice(0, 60) };
  }
}

/** 一行的"谁做了什么"：`human click span[19K]`。 */
export function actionLabel(row: EventRow): string {
  return `${row.src} ${row.kind === "cmd" ? "cmd " : ""}${row.verb}${row.target ? ` ${row.target}` : ""}`.trim();
}

function jsonKeys(v: unknown): string[] {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : [];
}

/** 请求里能改的变量：请求体 JSON（有 variables 就取它里面的）或查询参数里 JSON 的 variables。 */
function variablesOf(row: EventRow): string[] {
  const out: string[] = [];
  try {
    const detail = JSON.parse(row.detail ?? "{}") as { reqBody?: unknown };
    let body: unknown = detail.reqBody;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = undefined; } }
    const vars = (body as { variables?: unknown } | undefined)?.variables;
    out.push(...(jsonKeys(vars).length ? jsonKeys(vars) : jsonKeys(body).filter((k) => k !== "queryId")));
  } catch { /* 没有细节 */ }
  try {
    const u = new URL(row.url!);
    const raw = u.searchParams.get("variables");
    if (raw) { try { out.push(...jsonKeys(JSON.parse(raw)).map((k) => `variables.${k}`)); } catch { /* 不是 JSON */ } }
    for (const k of u.searchParams.keys()) if (!["variables", "features", "fieldToggles"].includes(k) && out.length < 12) out.push(k);
  } catch { /* 地址不合法 */ }
  return [...new Set(out)].slice(0, 12);
}

/** JSON 的结构概要：沿着只有一个键的对象往下走，到第一个有多个键的地方列出键，如 data.home.home_timeline_urt.{instructions,metadata}。 */
export function shapeOf(value: unknown): string {
  const path: string[] = [];
  let cur = value;
  for (let depth = 0; depth < 8; depth++) {
    if (Array.isArray(cur)) return `${path.join(".")}[${cur.length}]${cur[0] && typeof cur[0] === "object" ? `{${Object.keys(cur[0] as object).slice(0, 8).join(",")}}` : ""}`.replace(/^\[/, "[");
    const keys = jsonKeys(cur);
    if (keys.length === 0) return path.join(".") || "（空）";
    if (keys.length > 1) return `${path.length ? `${path.join(".")}.` : ""}{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}}`;
    path.push(keys[0]!);
    cur = (cur as Record<string, unknown>)[keys[0]!];
  }
  return path.join(".");
}

function responseShape(row: EventRow, dir: string | undefined): string | undefined {
  if (!row.body) return undefined;
  try { return shapeOf(JSON.parse(fs.readFileSync(bodyPath(row.body, "bodies", dir), "utf8"))); } catch { return undefined; }
}

export type ApiGroup = {
  method: string; host: string; name: string; count: number; firstSeq: number; last: EventRow;
  causes: Map<string, number>; variables: string[]; shape?: string; replayable: boolean;
};

/** 某个站点的接口清单。causeOf 给出触发某个请求的那一行；canReplay 判断这一行的原始内容现在还能不能直接重放。 */
export function buildCatalog(rows: EventRow[], site: string, options: { causeOf: (seq: number) => EventRow | undefined; canReplay: (row: EventRow) => boolean; dir?: string }): ApiGroup[] {
  const groups = new Map<string, ApiGroup>();
  for (const row of rows) {
    if (row.kind !== "net" || row.verb === "replay" || !row.url || !row.method || siteOf(row.url) !== site) continue;
    const { host, name } = endpointOf(row.url);
    const key = `${row.method} ${host} ${name}`;
    let g = groups.get(key);
    if (!g) { g = { method: row.method, host, name, count: 0, firstSeq: row.seq, last: row, causes: new Map(), variables: [], replayable: false }; groups.set(key, g); }
    g.count += row.dup || 1;
    if (row.seq >= g.last.seq) g.last = row;
    if (row.seq < g.firstSeq) g.firstSeq = row.seq;
    const cause = row.cause ? options.causeOf(row.cause) : undefined;
    if (cause && cause.kind !== "net") { const label = actionLabel(cause); g.causes.set(label, (g.causes.get(label) ?? 0) + 1); }
  }
  for (const g of groups.values()) {
    g.variables = variablesOf(g.last);
    g.replayable = options.canReplay(g.last);
    g.shape = g.last.status && g.last.status < 300 ? responseShape(g.last, options.dir) : undefined;
  }
  // 有副作用的、有用户操作触发的排前面，其余按次数
  return [...groups.values()].sort((a, b) =>
    Number(b.method !== "GET") - Number(a.method !== "GET") || b.causes.size - a.causes.size || b.count - a.count);
}

/** `@endpoint` 的写法就是这里的“方法 接口名”（和 tabbot api 输出的一致）。 */
export const endpointKey = (g: { method: string; name: string }): string => `${g.method} ${g.name}`;

export function formatCatalog(all: ApiGroup[], site: string, limit: number, covered: Map<string, string> = new Map()): string[] {
  // 还没有 recipe 覆盖的排前面：那是 Chef 要派 Cook 去学的
  const groups = [...all.filter((g) => !covered.has(endpointKey(g))), ...all.filter((g) => covered.has(endpointKey(g)))];
  if (groups.length === 0) return [`没有 ${site} 的请求记录（只记 HTML 文档、XHR、fetch；先在页面上操作一下，或确认扩展在线：tabbot doctor）`];
  const lines = [`${site} 的接口：${groups.length} 个（编号用于 tabbot req show <编号>；✓ = 现在就能直接重放，✗ = 要先在页面上再触发一次；recipe:名字 = 已有 recipe 覆盖，没标的是还没学会的）`];
  for (const g of groups.slice(0, limit)) {
    const where = g.host === site || g.host === `www.${site}` ? "" : `${g.host} `;
    const causes = [...g.causes].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ""}`).join("；");
    lines.push(`${g.method.padEnd(4)} ${where}${g.name}  ×${g.count}  #${g.last.seq} ${g.last.status ?? "ERR"} ${g.replayable ? "✓" : "✗"}${g.variables.length ? `  变量：${g.variables.join(", ")}` : ""}${causes ? `  ← ${causes}` : ""}${covered.has(endpointKey(g)) ? `  recipe:${covered.get(endpointKey(g))}` : ""}${g.shape ? `\n      响应：${g.shape}` : ""}`);
  }
  if (groups.length > limit) lines.push(`…还有 ${groups.length - limit} 个（加 -n 调大）`);
  return lines;
}

// ---- context ----

type Section = { site: string; first: number; last: number; events: number; tabs: Set<number>; pages: string[]; human: EventRow[]; agent: EventRow[]; scrolls: number; caused: Map<string, { label: string; req: string; seq: number; n: number }> };

/** 用户最近在各个站点上做了什么。rows 是时间窗口内的行（从旧到新）。 */
export function buildContext(rows: EventRow[], options: { causeOf: (seq: number) => EventRow | undefined; minutes: number; site?: string }): string[] {
  // 先看每个标签页最近在哪个站点，没有地址的行（命令）按标签页归属
  const tabSite = new Map<number, string>();
  for (const row of rows) { const s = siteOf(row.page || row.url); if (s) tabSite.set(row.tab, s); }
  const sections = new Map<string, Section>();
  for (const row of rows) {
    const site = siteOf(row.url && row.kind !== "net" ? row.url : row.page) || tabSite.get(row.tab) || "";
    if (!site || (options.site && site !== options.site)) continue;
    let s = sections.get(site);
    if (!s) { s = { site, first: row.ts, last: row.ts, events: 0, tabs: new Set(), pages: [], human: [], agent: [], scrolls: 0, caused: new Map() }; sections.set(site, s); }
    s.events++; s.last = Math.max(s.last, row.ts); s.tabs.add(row.tab);
    if ((row.kind === "doc" || row.kind === "nav" || row.kind === "tab") && row.url) {
      try { const u = new URL(row.url); const p = `${u.host}${u.pathname}${u.search.length > 40 ? u.search.slice(0, 40) + "…" : u.search}`; if (s.pages[s.pages.length - 1] !== p) s.pages.push(p); } catch { /* 地址不合法 */ }
    }
    if (row.kind === "input" && row.src === "human") { if (row.verb === "scroll") s.scrolls++; else s.human.push(row); }
    if (row.kind === "cmd") s.agent.push(row);
    if (row.kind === "net" && row.cause && row.method && row.url) {
      const cause = options.causeOf(row.cause);
      if (cause && cause.kind !== "net") {
        const { host, name } = endpointOf(row.url);
        const req = `${row.method} ${host === site || host === `www.${site}` ? "" : `${host} `}${name}`;
        const key = `${actionLabel(cause)} → ${req}`;
        const e = s.caused.get(key);
        if (e) e.n++; else s.caused.set(key, { label: actionLabel(cause), req, seq: row.seq, n: 1 });
      }
    }
  }
  const list = [...sections.values()].sort((a, b) => b.last - a.last);
  if (list.length === 0) return [`最近 ${options.minutes} 分钟没有${options.site ? ` ${options.site} 的` : ""}活动记录。`];
  const lines = [`最近 ${options.minutes} 分钟的活动：${list.length} 个站点（看某个站点出现过的接口：tabbot api <站点>）`];
  for (const s of list) {
    lines.push("", `■ ${s.site}  ${clock(s.first)}–${clock(s.last)}  ${s.events} 条事件  ${[...s.tabs].map((t) => `tab${t}`).join(" ")}`);
    if (s.pages.length) lines.push(`  访问：${s.pages.slice(-5).join(" → ")}`);
    if (s.human.length || s.scrolls) {
      const compact: string[] = [];
      for (const r of s.human.slice(-12)) {
        const text = `${r.verb}${r.target ? ` ${r.target}` : ""}`;
        const prev = compact[compact.length - 1];
        const m = prev && /^(.*?)(?: ×(\d+))?$/.exec(prev);
        if (m && m[1] === `${clock(r.ts)} ${text}`) compact[compact.length - 1] = `${m[1]} ×${Number(m[2] ?? 1) + 1}`; else compact.push(`${clock(r.ts)} ${text}`);
      }
      lines.push(`  你的操作：${compact.join("；")}${s.scrolls ? `（另有滚动 ${s.scrolls} 次）` : ""}`);
    }
    const caused = [...s.caused.values()].sort((a, b) => Number(b.req.startsWith("GET")) - Number(a.req.startsWith("GET")) || b.n - a.n).slice(0, 8);
    if (caused.length) {
      lines.push("  操作引发的请求（可以直接重放，省掉点页面）：");
      for (const c of caused) lines.push(`    ${c.label} → ${c.req}${c.n > 1 ? ` ×${c.n}` : ""}  最近 #${c.seq}`);
    }
    if (s.agent.length) lines.push(`  agent 的命令：${s.agent.slice(-5).map((r) => `${clock(r.ts)} ${r.verb}${r.target ? ` ${r.target}` : ""}`).join("；")}`);
  }
  return lines;
}
