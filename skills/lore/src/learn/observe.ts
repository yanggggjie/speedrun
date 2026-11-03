import type { TabInfo } from "../browser/extension.ts";
import type { RunHost, Session } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import { describeHeaders, headerSignals, type AuthSnapshot, type HeaderSignal } from "../record/auth.ts";
import { headerKinds, type HeaderKind } from "../record/headers.ts";
import type { EndpointIndex } from "../record/endpoints.ts";
import type { Ingestor } from "../record/ingest.ts";
import type { RawEntry, RawStore } from "../record/raw.ts";
import type { RequestFile, Row } from "../record/types.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { siteOfUrl } from "../utils/url.ts";
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
 * 请求默认只列这个窗口里第一次出现的 endpoint，其余只计数；all 为真列全部。
 * 列出的请求带一行「请求头」信号：每个要关心的头值怎么变、页面存储里的来源（在内存里比真值，只输出类别和来源），同时记进 endpoints.json。
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
  type Stat = { count: number; idle: number; cmdTriggered: number; descriptions?: Array<{ text: string }>; headers?: Record<string, HeaderSignal>; action?: string | null };
  const statsOf = new Map<string, Map<string, Stat>>();
  const stats = (site: string): Map<string, Stat> => { let m = statsOf.get(site); if (!m) { m = new Map(d.index.snapshot(site).endpoints.map((e) => [e.key, e])); statsOf.set(site, m); } return m; };
  const merged = new Map<string, Stat>();
  for (const site of new Set(rows.map((r) => r.site ?? w.site))) for (const [k, v] of stats(site)) merged.set(k, v);
  const { shown, noise, periodic, assets } = shownRequests(rows, merged);
  // 默认只列这个窗口里第一次出现的 endpoint；页面重新加载时的 /me 这类不再列
  // 请求文件：时间线行的 file（相对窗口目录）；请求文件先写、行后追加，有行就有文件
  const fileOf = (r: Row): RequestFile | undefined => { const text = r.file ? d.log.readText(w.id, r.file) : undefined; try { return text ? (JSON.parse(text) as RequestFile) : undefined; } catch { return undefined; } };
  const files = new Map(shown.map((r) => [r.seq, fileOf(r)]));
  const seen = new Set(all ? [] : timeline.filter((r) => r.type === "request" && r.seq <= from && r.endpoint).map((r) => r.endpoint!));
  const picked = shown.filter((r) => {
    if (all || !r.endpoint) return true;
    if (seen.has(r.endpoint)) return false;
    seen.add(r.endpoint);
    return true;
  });
  const repeated = shown.length - picked.length;
  if (!picked.length) lines.push("请求：没有新的请求");
  else {
    const list = picked.slice(-OBSERVE_MAX);
    const rawOf = (r: Row): RawEntry | undefined => { const f = files.get(r.seq); return f?.rid && f.tab !== undefined ? d.raw.get(w.id, f.tab, f.rid) : undefined; };
    // 请求头怎么变：按站点统计这个窗口里的同站原始请求
    const kindsOf = new Map<string, Map<string, HeaderKind>>();
    const kinds = (site: string): Map<string, HeaderKind> => {
      let k = kindsOf.get(site);
      if (!k) { k = headerKinds(d.raw.inWindow(w.id).filter((e) => siteOfUrl(e.page) === site)); kindsOf.set(site, k); }
      return k;
    };
    lines.push(`请求：${picked.length > list.length ? `（共 ${picked.length} 个，列最近 ${list.length} 个）` : ""}`);
    let snap: AuthSnapshot | undefined, snapped = false;
    for (const r of list) {
      const f = files.get(r.seq);
      const site = r.site ?? w.site;
      const st = r.endpoint ? stats(site).get(r.endpoint) : undefined;
      const known = st?.descriptions?.find((x) => x.text !== step)?.text;
      lines.push(`  ${describeRequest(r, f, { other: site !== w.site ? site : undefined, known }).line}`);
      // 原始请求还在内存里就现算；不在（daemon 重启过、窗口关过）就用 endpoints.json 里上次记下的
      const raw = rawOf(r);
      let signals = st?.headers;
      if (raw) {
        if (!snapped) { snapped = true; snap = sess?.tab !== undefined ? await d.host.authSnapshot(sess.tab) : undefined; }
        signals = headerSignals(raw.headers, snap, kinds(site));
        if (r.endpoint && Object.keys(signals).length) d.index.setHeaders(site, r.endpoint, signals);
      }
      if (signals && Object.keys(signals).length) lines.push(`    请求头：${describeHeaders(signals)}`);
    }
    const deps = dependencies(list, (seq) => files.get(seq), (f) => (f.responseBodyPath ? d.log.readText(w.id, f.responseBodyPath) : undefined), (f) => (f.tab !== undefined && f.rid ? d.raw.get(w.id, f.tab, f.rid) : undefined));
    if (deps.length) lines.push(`依赖：\n${deps.map((x) => `  #${x.to} 用了 #${x.from} 响应的 ${x.field}`).join("\n")}`);
  }
  const folded = [repeated ? `之前出现过的 ${repeated}` : "", noise ? `埋点广告 ${noise}` : "", periodic ? `轮询 ${periodic}` : "", assets ? `静态资源 ${assets}` : ""].filter(Boolean);
  if (folded.length) lines.push(`没列出：${folded.join("，")}${repeated ? "（observe --all 看全部）" : "（在 timeline.jsonl 里）"}`);
  if (!picked.length && !repeated) lines.push("下一步：页面可能还在加载，等一会儿再 observe；或者数据在页面里，用 DOM 取");
  // 这一步引发了还没有 action 覆盖的 endpoint：提醒写成 action（computer 只是触发，结果要来自 lore run）
  if (step !== undefined) {
    const uncovered = [...new Set(picked.filter((r) => r.phase === "cmd" && r.endpoint && !stats(r.site ?? w.site).get(r.endpoint)?.action).map((r) => r.endpoint!))].slice(0, 3);
    if (uncovered.length) lines.push(`下一步：${uncovered.join("、")} 还没有 action 覆盖 → 要用的写成 action，lore learn ${w.id} run --action <名> 试，lore run 交付`);
  }
  w.cursor = Math.max(w.cursor, to);
  return lines.join("\n");
}
