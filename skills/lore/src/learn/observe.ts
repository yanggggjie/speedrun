import type { TabInfo } from "../browser/extension.ts";
import type { RunHost, Session } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import { authSpecs, classifyAuth, describeAuth, type AuthSnapshot } from "../record/auth.ts";
import { looksReadOnly } from "../record/digest.ts";
import type { EndpointIndex } from "../record/endpoints.ts";
import type { Ingestor } from "../record/ingest.ts";
import type { RawEntry, RawStore } from "../record/raw.ts";
import { readableUrl } from "../record/reqfile.ts";
import type { RequestFile, Row } from "../record/types.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { dependencies, describeRequest, shownRequests } from "./explore.ts";
import type { LearnWindow } from "./windows.ts";

/** 一次观察最多列多少个请求（列最近的）。 */
const OBSERVE_MAX = 30;

export type ObserveDeps = {
  ingest: Ingestor;
  log: WindowLog;
  win: Pick<AgentWindows, "windowIdOf" | "isAgentTab">;
  tabs(): Promise<TabInfo[]>;
  index: EndpointIndex;
  raw: RawStore;
  host: Pick<RunHost, "authSnapshot">;
};

/**
 * 观察：游标之后这个 learn 窗口发生的变化（页面、导航、请求、请求之间的依赖），然后把游标移到最新。
 * 晚到的请求（懒加载、轮询、防抖）下次观察时出现，不会丢也不会重复。
 * 请求默认只列这个窗口里第一次出现的 endpoint 和所有写请求，其余只计数；all 为真列全部。
 * 最多 3 个请求带 auth 来源和一行可以贴进 action 的 request() 草稿：写请求优先，再是这一步引发的，再是最新的。
 */
export async function observe(d: ObserveDeps, w: LearnWindow, sess: Session | undefined, step?: string, all = false): Promise<string> {
  d.ingest.flush();
  const from = w.cursor;
  const to = d.log.lastSeq();
  const timeline = d.log.readRows(w.id, { limit: 1_000_000 });
  const rows = timeline.filter((r) => r.seq > from && r.seq <= to);
  const lines = [`观察：${to > from ? `#${from + 1} → #${to}` : `#${from} 之后没有新的编号`}`];
  // 页面：窗口里的 agent 标签页（用户在这个窗口里自己开的不列），当前页面在前
  const winId = d.win.windowIdOf(w.id);
  const tabs = w.open && winId !== undefined ? (await d.tabs()).filter((t) => t.windowId === winId && !t.anchor && d.win.isAgentTab(t.tabId)) : [];
  const current = tabs.find((t) => t.tabId === sess?.tab) ?? tabs[0];
  if (current) { w.url = current.url; w.title = current.title; }
  lines.push(current ? `页面：${current.url} "${current.title}"${tabs.length > 1 ? `；窗口里共 ${tabs.length} 个标签页，其余：${tabs.filter((t) => t !== current).map((t) => t.url).join("、")}` : ""}` : `页面：Chrome 窗口没开（上次在 ${w.url}）`);
  const navs = rows.filter((r) => r.type === "nav" && r.via !== "replaceState");
  if (navs.length) lines.push(`导航：${navs.slice(-5).map((r) => `#${r.seq} ${r.url}${r.site && r.site !== w.site ? `（${r.site}）` : ""}`).join(" → ")}`);
  // 请求
  type Stat = { count: number; idle: number; cmdTriggered: number; descriptions?: Array<{ text: string }>; auth?: Record<string, string>; signed?: boolean };
  const statsOf = new Map<string, Map<string, Stat>>();
  const stats = (site: string): Map<string, Stat> => { let m = statsOf.get(site); if (!m) { m = new Map(d.index.snapshot(site).endpoints.map((e) => [e.key, e])); statsOf.set(site, m); } return m; };
  const merged = new Map<string, Stat>();
  for (const site of new Set(rows.map((r) => r.site ?? w.site))) for (const [k, v] of stats(site)) merged.set(k, v);
  const { shown, noise, periodic, assets } = shownRequests(rows, merged);
  // 默认只列这个窗口里第一次出现的 endpoint 和所有写请求；页面重新加载时的 /me 这类不再列
  // 请求文件：时间线行的 file（相对窗口目录）；请求文件先写、行后追加，有行就有文件
  const fileOf = (r: Row): RequestFile | undefined => { const text = r.file ? d.log.readText(w.id, r.file) : undefined; try { return text ? (JSON.parse(text) as RequestFile) : undefined; } catch { return undefined; } };
  const files = new Map(shown.map((r) => [r.seq, fileOf(r)]));
  const isWrite = (r: Row): boolean => { const f = files.get(r.seq); return !looksReadOnly(r.method, f?.url.bareUrl ?? r.url ?? "", f?.requestBody); };
  const seen = new Set(all ? [] : timeline.filter((r) => r.type === "request" && r.seq <= from && r.endpoint).map((r) => r.endpoint!));
  const picked = shown.filter((r) => {
    if (all || !r.endpoint || isWrite(r)) return true;
    if (seen.has(r.endpoint)) return false;
    seen.add(r.endpoint);
    return true;
  });
  const repeated = shown.length - picked.length;
  if (!picked.length) lines.push("请求：没有新的请求");
  else {
    const list = picked.slice(-OBSERVE_MAX);
    const rawOf = (r: Row): RawEntry | undefined => { const f = files.get(r.seq); return f?.rid && f.tab !== undefined ? d.raw.get(f.tab, f.rid) : undefined; };
    const drafted = new Set([...list.filter(isWrite), ...list.filter((r) => r.phase === "cmd"), ...[...list].reverse()].filter((r) => rawOf(r)).slice(0, 3).map((r) => r.seq));
    lines.push(`请求：${picked.length > list.length ? `（共 ${picked.length} 个，列最近 ${list.length} 个）` : ""}`);
    let snap: AuthSnapshot | undefined, snapped = false;
    for (const r of list) {
      const f = files.get(r.seq);
      const site = r.site ?? w.site;
      const st = r.endpoint ? stats(site).get(r.endpoint) : undefined;
      const known = st?.descriptions?.find((x) => x.text !== step)?.text;
      lines.push(`  ${describeRequest(r, f, { write: isWrite(r), other: site !== w.site ? site : undefined, known }).line.trimStart()}`);
      if (st?.signed) lines.push(`    签名：${Object.entries(st.auth ?? {}).filter(([, v]) => v === "signed").map(([h]) => h).join(", ")}（每次都变，换参数可能被拒）`);
      const raw = drafted.has(r.seq) ? rawOf(r) : undefined;
      if (!raw) continue;
      if (!snapped) { snapped = true; snap = sess?.tab !== undefined ? await d.host.authSnapshot(sess.tab) : undefined; }
      const { history, siteHistory } = headerHistory(d.raw, raw);
      const sources = classifyAuth(raw.headers, snap, history, siteHistory);
      if (Object.keys(sources).length) {
        lines.push(`    auth 来源：${describeAuth(sources)}`);
        if (r.endpoint) d.index.setAuth(site, r.endpoint, Object.fromEntries(Object.entries(sources).map(([h, x]) => [h, x.spec ?? x.kind])), Object.values(sources).some((x) => x.kind === "signed"));
      }
      lines.push(`    草稿：${requestLine(d.ingest, { method: raw.method.toUpperCase(), url: raw.url, body: raw.body, auth: authSpecs(sources) })}`);
    }
    const deps = dependencies(list, (seq) => files.get(seq), (f) => (f.responseBodyPath ? d.log.readText(w.id, f.responseBodyPath) : undefined), (f) => (f.tab !== undefined && f.rid ? d.raw.get(f.tab, f.rid) : undefined));
    if (deps.length) lines.push(`依赖：\n${deps.map((x) => `  #${x.to} 用了 #${x.from} 响应的 ${x.field}`).join("\n")}`);
  }
  const folded = [repeated ? `之前出现过的 ${repeated}` : "", noise ? `埋点广告 ${noise}` : "", periodic ? `轮询 ${periodic}` : "", assets ? `静态资源 ${assets}` : ""].filter(Boolean);
  if (folded.length) lines.push(`没列出：${folded.join("，")}${repeated ? "（observe --all 看全部）" : "（在 timeline.jsonl 里）"}`);
  if (!picked.length && !repeated) lines.push("下一步：页面可能还在加载，等一会儿再 observe；或者数据在页面里，用 DOM 取");
  w.cursor = Math.max(w.cursor, to);
  return lines.join("\n");
}

/** 同名请求头在同一 endpoint（history）和同站别的 endpoint（siteHistory）的各次请求里的值：判断签名和不变的值。 */
function headerHistory(store: RawStore, raw: RawEntry): { history: Record<string, string[]>; siteHistory: Record<string, string[]> } {
  const history: Record<string, string[]> = {}, siteHistory: Record<string, string[]> = {};
  let me: URL;
  try { me = new URL(raw.url); } catch { return { history, siteHistory }; }
  for (const e of store.all((x) => x !== raw)) {
    let u: URL;
    try { u = new URL(e.url); } catch { continue; }
    if (u.origin !== me.origin) continue;
    const into = u.pathname === me.pathname ? history : siteHistory;
    for (const [k, v] of Object.entries(e.headers)) (into[k.toLowerCase()] ??= []).push(v);
  }
  return { history, siteHistory };
}

/** 可贴进 action 的一行 request()：地址和请求体里的秘密写成别名（换成 lore.params 或删掉），带上判断出的 auth。 */
function requestLine(ingest: Pick<Ingestor, "sanitizer">, r: { method: string; url: string; body: string | null; inheritFrom?: string; auth: Record<string, string> }): string {
  const u = ingest.sanitizer.url(r.url);
  const opts: string[] = [`url: ${JSON.stringify(readableUrl(u))}`];
  if (r.method !== "GET") opts.push(`method: ${JSON.stringify(r.method)}`);
  if (r.body !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.body); } catch { /* 不是 JSON */ }
    const shown = parsed !== undefined ? JSON.stringify(ingest.sanitizer.body(parsed)) : JSON.stringify(ingest.sanitizer.body(r.body, true));
    opts.push(parsed !== undefined ? `json: ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}` : `body: ${shown}`);
  }
  if (r.inheritFrom) opts.push(`inheritFrom: ${JSON.stringify(r.inheritFrom)}`);
  if (Object.keys(r.auth).length) opts.push(`auth: ${JSON.stringify(r.auth)}`);
  return `await request({ ${opts.join(", ")} });`;
}
