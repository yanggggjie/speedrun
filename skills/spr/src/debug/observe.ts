import type { TabInfo } from "../browser/extension.ts";
import type { RunHost, Session } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import { describeHeaders, describeQuery, headerSignals, querySignals, type AuthSnapshot, type HeaderSignal } from "../record/auth.ts";
import { headerKinds, type HeaderKind } from "../record/headers.ts";
import type { EndpointIndex } from "../record/endpoints.ts";
import type { Ingestor } from "../record/ingest.ts";
import type { RawEntry, RawStore } from "../record/raw.ts";
import type { RequestFile, Row } from "../record/types.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { LOGIN_HINT, isLoginUrl, siteOfUrl } from "../utils/url.ts";
import { dependencies, describeRequest, relevance, shownRequests, valuesOf } from "./explore.ts";
import type { DebugWindow } from "./windows.ts";

/** 一次观察最多列多少个请求（按相关性，其余折叠成数量，都在 timeline.jsonl 里）。 */
const OBSERVE_MAX = 6;
/** 比内容时最多读多少个响应。 */
const MATCH_FILES = 15;
/** 响应里有这么多个值出现在页面文字上，才算对得上。 */
const PAGE_HITS = 3;
/** 找依赖的来源时，往前看这个窗口里最近多少个请求。 */
const DEP_SOURCES = 50;
/** 重复的 endpoint 最多列多少个。 */
const REPEAT_MAX = 6;

export type ObserveDeps = {
  ingest: Ingestor;
  log: WindowLog;
  win: Pick<AgentWindows, "groupOf">;
  tabs(): Promise<TabInfo[]>;
  index: EndpointIndex;
  raw: RawStore;
  host: Pick<RunHost, "authSnapshot" | "peek">;
};

/**
 * 观察：游标之后这个 debug 窗口发生的变化（页面、导航、请求、请求之间的依赖），然后把游标移到最新。
 * 晚到的请求（懒加载、轮询、防抖）下次观察时出现（computer wait 就是等一会儿再观察），不会丢也不会重复。
 * 请求只列这个窗口里第一次出现的 endpoint，其余只计数（全部都在 timeline.jsonl 里）。
 * 列出的请求带一行「请求头」信号：每个要关心的头值怎么变、页面存储里的来源（在内存里比真值，只输出类别和来源），同时记进 endpoints.json。
 */
export async function observe(d: ObserveDeps, w: DebugWindow, sess: Session | undefined, inputs: string[] = []): Promise<string> {
  d.ingest.flush();
  d.ingest.flushSockets();
  const from = w.cursor;
  const to = d.log.lastSeq();
  const timeline = d.log.readRows(w.id, { limit: 1_000_000 });
  const rows = timeline.filter((r) => r.seq > from && r.seq <= to);
  const lines = [`观察：${to > from ? `#${from + 1} → #${to}` : `#${from} 之后没有新的编号`}`];
  // 页面：这个窗口（speedrun 组）里的标签页，当前页面在前
  const group = d.win.groupOf(w.id);
  const tabs = w.open && group !== undefined ? (await d.tabs()).filter((t) => t.groupId === group) : [];
  const current = tabs.find((t) => t.tabId === sess?.tab) ?? tabs[0];
  if (current) { w.url = current.url; w.title = current.title; }
  lines.push(current ? `页面：${current.url} "${current.title}"${tabs.length > 1 ? `；窗口里共 ${tabs.length} 个标签页，其余：${tabs.filter((t) => t !== current).map((t) => t.url).join("、")}` : ""}` : `页面：speedrun 组没开（上次在 ${w.url}）`);
  const navs = rows.filter((r) => r.type === "nav" && r.via !== "replaceState");
  const opened = rows.filter((r) => r.type === "tab" && (r.via === "opened" || r.via === "leaked"));
  if (opened.length) lines.push(`新标签页：页面打开了 ${opened.slice(-5).map((r) => `#${r.seq} ${r.url}`).join("、")}（在同一个组里；页面里的新开都由 speedrun 接管，不会切走用户的标签页）`);
  const dialogs = rows.filter((r) => r.type === "tab" && r.via === "dialog");
  if (dialogs.length) lines.push(`系统弹窗：${dialogs.slice(-3).map((r) => r.target).join("、")}（已拦下，没有弹出来：alert 放过，confirm、prompt 选取消，离开确认直接离开）`);
  if (navs.length) lines.push(`导航：${navs.slice(-5).map((r) => `#${r.seq} ${r.url}${r.site && r.site !== w.site ? `（${r.site}）` : ""}`).join(" → ")}`);
  // 请求
  type Stat = { count: number; idle: number; cmdTriggered: number; headers?: Record<string, HeaderSignal>; action?: string | null };
  const statsOf = new Map<string, Map<string, Stat>>();
  const stats = (site: string): Map<string, Stat> => { let m = statsOf.get(site); if (!m) { m = new Map(d.index.snapshot(site).endpoints.map((e) => [e.key, e])); statsOf.set(site, m); } return m; };
  const merged = new Map<string, Stat>();
  for (const site of new Set(rows.map((r) => r.site ?? w.site))) for (const [k, v] of stats(site)) merged.set(k, v);
  const { shown, noise, telemetry, periodic, assets } = shownRequests(rows, merged);
  // 默认只列这个窗口里第一次出现的 endpoint；页面重新加载时的 /me 这类不再列
  // 请求文件：时间线行的 file（相对窗口目录）；请求文件先写、行后追加，有行就有文件
  const fileOf = (r: Row): RequestFile | undefined => { const text = r.file ? d.log.readText(w.id, r.file) : undefined; try { return text ? (JSON.parse(text) as RequestFile) : undefined; } catch { return undefined; } };
  const files = new Map(shown.map((r) => [r.seq, fileOf(r)]));
  const seen = new Set(timeline.filter((r) => r.type === "request" && r.seq <= from && r.endpoint).map((r) => r.endpoint!));
  const picked = shown.filter((r) => {
    if (!r.endpoint) return true;
    if (seen.has(r.endpoint)) return false;
    seen.add(r.endpoint);
    return true;
  });
  const repeated = shown.length - picked.length;
  // 重复的 endpoint：只列事实（这个窗口里第几次、上次的编号），对不对由 agent 判断
  const pickedSeqs = new Set(picked.map((r) => r.seq));
  const lastRepeat = new Map<string, Row>();
  for (const r of shown) if (r.endpoint && !pickedSeqs.has(r.seq)) lastRepeat.set(r.endpoint, r);
  if (!picked.length) lines.push("请求：没有新的请求");
  else {
    const rawOf = (r: Row): RawEntry | undefined => { const f = files.get(r.seq); return f?.rid && f.tab !== undefined ? d.raw.get(w.id, f.tab, f.rid) : undefined; };
    // 放不下时按相关性挑：内容能对上的最靠前；比较用真值，只在这里用，不输出值
    let list = picked;
    if (picked.length > OBSERVE_MAX) {
      const text = sess ? await d.host.peek(sess, () => document.body?.innerText?.slice(0, 50_000) ?? "").catch(() => undefined) ?? "" : "";
      const decoded = (u: string): string => { try { return decodeURIComponent(u); } catch { return u; } };
      const sentIt = (r: Row): boolean => { const raw = rawOf(r); return inputs.some((v) => v.length >= 2 && (decoded(raw?.url ?? r.url ?? "").includes(v) || (raw?.body ?? "").includes(v))); };
      const onPage = (f: RequestFile | undefined): boolean => {
        const body = f?.responseBodyPath ? d.log.readText(w.id, f.responseBodyPath) : undefined;
        return !!body && !!text && [...valuesOf(body).keys()].filter((v) => text.includes(v)).length >= PAGE_HITS;
      };
      const base = (r: Row): number => relevance(r, files.get(r.seq), { input: sentIt(r) });
      const top = new Set([...picked].sort((a, b) => base(b) - base(a)).slice(0, MATCH_FILES).map((r) => r.seq));
      const score = new Map(picked.map((r) => [r.seq, relevance(r, files.get(r.seq), { input: sentIt(r), pageText: top.has(r.seq) && onPage(files.get(r.seq)) })]));
      list = [...picked].sort((a, b) => score.get(b.seq)! - score.get(a.seq)! || b.seq - a.seq).slice(0, OBSERVE_MAX).sort((a, b) => a.seq - b.seq);
    }
    // 请求头怎么变：按站点统计这个窗口里的同站原始请求
    const kindsOf = new Map<string, Map<string, HeaderKind>>();
    const kinds = (site: string): Map<string, HeaderKind> => {
      let k = kindsOf.get(site);
      if (!k) { k = headerKinds(d.raw.inWindow(w.id).filter((e) => siteOfUrl(e.page) === site)); kindsOf.set(site, k); }
      return k;
    };
    lines.push(`请求：${picked.length > list.length ? `可能相关 ${list.length} 个（共 ${picked.length} 个）` : ""}`);
    let snap: AuthSnapshot | undefined, snapped = false;
    for (const r of list) {
      const f = files.get(r.seq);
      const site = r.site ?? w.site;
      const st = r.endpoint ? stats(site).get(r.endpoint) : undefined;
      lines.push(`  ${describeRequest(r, f, { other: site !== w.site ? site : undefined }).line}`);
      // 原始请求还在内存里就现算；不在（daemon 重启过、窗口关过）就用 endpoints.json 里上次记下的
      const raw = rawOf(r);
      let signals = st?.headers;
      if (raw) {
        if (!snapped) { snapped = true; snap = sess?.tab !== undefined ? await d.host.authSnapshot(sess.tab) : undefined; }
        signals = headerSignals(raw.headers, snap, kinds(site));
        if (r.endpoint && Object.keys(signals).length) d.index.setHeaders(site, r.endpoint, signals);
      }
      if (signals && Object.keys(signals).length) lines.push(`    请求头：${describeHeaders(signals)}`);
      // 查询参数里的值在页面存储里找得到的：给 authQuery 用（只写名字和来源，不写值）
      const query = raw ? querySignals(raw.url, snap) : {};
      if (Object.keys(query).length) lines.push(`    查询参数：${describeQuery(query)}`);
    }
    // 依赖的来源不只看这次列出的：这个窗口里更早的请求（之前几步的、这次没列出的重复 endpoint）也算，最近 DEP_SOURCES 个
    const listed = new Set(list.map((r) => r.seq));
    const upto = Math.max(...list.map((r) => r.seq));
    const sources = timeline.filter((r) => r.type === "request" && !r.noise && r.file && r.seq < upto && !listed.has(r.seq)).slice(-DEP_SOURCES);
    const rowOf = new Map(sources.map((r) => [r.seq, r]));
    const fileAt = (seq: number): RequestFile | undefined => { if (!files.has(seq) && rowOf.has(seq)) files.set(seq, fileOf(rowOf.get(seq)!)); return files.get(seq); };
    const deps = dependencies([...sources, ...list], fileAt, (f) => (f.responseBodyPath ? d.log.readText(w.id, f.responseBodyPath) : undefined), (f) => (f.tab !== undefined && f.rid ? d.raw.get(w.id, f.tab, f.rid) : undefined), listed);
    if (deps.length) lines.push(`依赖（值相同，可能是巧合）：\n${deps.map((x) => `  #${x.to} 里有一个值与 #${x.from} 响应的 ${x.field} 相同`).join("\n")}`);
  }
  const others = picked.length > OBSERVE_MAX ? picked.length - OBSERVE_MAX : 0;
  if (lastRepeat.size) {
    const reqRows = timeline.filter((r) => r.type === "request" && !r.noise && r.endpoint);
    const items = [...lastRepeat.values()].map((r) => {
      const before = reqRows.filter((x) => x.endpoint === r.endpoint && x.seq < r.seq);
      const action = stats(r.site ?? w.site).get(r.endpoint!)?.action;
      return `  ${r.endpoint} 这个窗口里第 ${before.length + 1} 次${before.length ? `（上次 #${before.at(-1)!.seq}）` : ""}${action ? `（已有 action ${action}）` : ""}`;
    });
    lines.push(`重复（这个窗口里之前出现过的 endpoint）：\n${items.slice(0, REPEAT_MAX).join("\n")}${items.length > REPEAT_MAX ? `\n  还有 ${items.length - REPEAT_MAX} 个，见 timeline.jsonl` : ""}`);
  }
  // WebSocket、事件流：每条连接只给最新的累计数，内容在 sockets/ 文件里
  const sockets = new Map(rows.filter((r) => r.type === "socket" && r.file).map((r) => [r.file!, r]));
  if (sockets.size) lines.push(`通道：\n${[...sockets.values()].slice(0, 5).map((r) => `  ${r.channel === "sse" ? "事件流" : "WebSocket"} ${r.url} 发 ${r.sent ?? 0} 收 ${r.received ?? 0}，${r.file}`).join("\n")}${sockets.size > 5 ? `\n  另有 ${sockets.size - 5} 条` : ""}`);
  // 页面函数快照的信号：只在有新信号时说一次
  if (w.page?.fresh) {
    w.page.fresh = false;
    lines.push(`页面：${[w.page.canvas ? "主体是 canvas，内容不在 DOM 里" : "", w.page.api.length ? `发现页面接口 ${w.page.api.join("、")}` : ""].filter(Boolean).join("；")}（${w.page.dir}，用 rg 搜方法名）`);
  }
  const folded = [others ? `其余 ${others} 个` : "", noise ? `命中广告规则 ${noise}` : "", telemetry ? `可能是埋点 ${telemetry}（按路径、域名规则判断，可能误判）` : "", periodic ? `轮询 ${periodic}` : "", assets ? `静态资源 ${assets}` : ""].filter(Boolean);
  if (folded.length) lines.push(`没列出：${folded.join("，")}（都在 timeline.jsonl 里）`);
  // 登录相关的事实：这一段里有同站请求被 401/403 拒，或者页面地址命中登录页规则。是不是登录失效由 agent 看页面判断
  const denied = rows.filter((r) => r.type === "request" && !r.noise && (r.status === 401 || r.status === 403) && (r.site ?? w.site) === w.site).slice(-3);
  const atLogin = current ? isLoginUrl(current.url) : navs.some((r) => isLoginUrl(String(r.url ?? "")));
  if (denied.length || atLogin) lines.push(`被拒或登录页：${[...denied.map((r) => `#${r.seq} ${r.endpoint ?? r.url} ${r.status}`), ...(atLogin ? ["页面地址命中登录页规则（login、sso、passport 这类）"] : [])].join("、")}。401/403 也可能是限流、没权限：先 computer screenshot 或 read_page 看页面；如果是登录失效：${LOGIN_HINT}`);
  if (!picked.length && !repeated) {
    const api = w.page?.canvas || w.page?.api.length;
    lines.push(api ? `下一步：没有新请求，改动可能走页面函数或 WebSocket：先用 rg 搜 ${w.page!.dir} 的方法名，要参数用 trace；都没有再用页面操作` : "下一步：页面可能还在加载，computer wait 2 等一会儿再看；或者数据在页面里，用 DOM 取（get_page_text、read_page）");
  }
  w.cursor = Math.max(w.cursor, to);
  return lines.join("\n");
}
