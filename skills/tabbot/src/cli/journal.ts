/**
 * 常驻录制的命令：sites、tabs、log、sql、snapshot、wait、status。
 * 读日志直接开 ~/.tabbot/journal 里的只读 SQLite（holder 没起来也能看历史）；
 * 只有 sites 生效、tabs、snapshot 需要经 holder 问扩展。输出是给 agent 读的文本，第一行是结论；失败仍是 { status: "failure", error }。
 */
import * as os from "node:os";
import { ensureSessionAndRpc, tryPing } from "./session.ts";
import { formatHandshakeStdout, formatErrorStdout, isHandshakeStatus } from "../protocol.ts";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR } from "../utils/constants.ts";
import { findInBodies, formatRows, lastSeq, readEvents, readEventBySeq, runSql, status as journalStatus, waitForHuman } from "../journal/query.ts";
import { isSafeMethod, templateFromRow } from "../journal/replay.ts";
import { formatEvent } from "../journal/format.ts";
import { renderSnapshot, type Snapshot } from "../journal/render.ts";
import { BUILTIN_EXCLUDE, describeConfig, normalizeHost, readConfig, writeConfig, type SitesConfig } from "../journal/sites.ts";
import type { Src } from "../journal/types.ts";

type Flags = { values: Map<string, string>; bools: Set<string>; rest: string[] };

/** `--名字 值` 或 `--名字=值`；bool 里列出的是不带值的开关。 */
function parseFlags(args: string[], bool: string[] = []): Flags | { error: string } {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (bool.includes(name)) { bools.add(name); continue; }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return { error: `--${name} 缺少值` };
    values.set(name, value);
  }
  return { values, bools, rest };
}

function intFlag(flags: Flags, name: string): number | undefined | { error: string } {
  const raw = flags.values.get(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : { error: `--${name} 需要非负整数` };
}

const isError = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;

function out(text: string): void { console.log(text); }
function fail(error: string): void { console.log(formatErrorStdout(error)); process.exitCode = 1; }

/** 经 holder 问扩展；握手类失败按统一格式输出。 */
async function ask(method: "journal.sync" | "journal.tabs" | "journal.snapshot" | "journal.lease" | "journal.act" | "journal.replay", params?: Record<string, unknown>, ms = 15_000): Promise<unknown | undefined> {
  try { return await ensureSessionAndRpc(method, params, ms); } catch (error) {
    const value = error as { data?: { status?: string }; message?: string };
    if (value.data?.status && isHandshakeStatus(value.data.status)) { console.log(formatHandshakeStdout(value.data.status)); process.exitCode = 1; } else fail(value.message ?? String(error));
    return undefined;
  }
}

const SITES_USAGE = "用法：tabbot sites | sites --builtin | sites exclude <域名> ... | sites include <域名> ... | sites only <域名> ... | sites all";

/** 保存配置，并让扩展立刻生效；扩展没连上也不要紧，下次连上会自动下发。 */
async function saveSites(config: SitesConfig, verb: string): Promise<void> {
  writeConfig(config);
  let applied = false;
  try { await ensureSessionAndRpc("journal.sync", undefined, 15_000); applied = true; } catch { /* 下次扩展连上时生效 */ }
  out(`${verb}。现在：${describeConfig(readConfig())}。${applied ? "已在扩展里生效，已打开的页面已补注入。" : "扩展没连上，连上后自动生效。"}`);
}

export async function sitesCommand(args: string[]): Promise<void> {
  const [sub, ...names] = args;
  const config = readConfig();
  if (sub === undefined) return out(describeConfig(config));
  if (sub === "--builtin") return out(`内置排除的 ${BUILTIN_EXCLUDE.length} 个敏感站点（包含子域名；用 tabbot sites include <域名> 可以重新打开其中某个）：\n${BUILTIN_EXCLUDE.join("\n")}`);
  if (sub === "all") return saveSites({ ...config, mode: "all" }, "已切换到录制所有站点");
  if (sub !== "exclude" && sub !== "include" && sub !== "only") return fail(SITES_USAGE);
  if (names.length === 0) return fail(`用法：tabbot sites ${sub} <域名> ...`);
  const parsed = names.map((n) => ({ n, host: normalizeHost(n) }));
  const bad = parsed.find((p) => !p.host);
  if (bad) return fail(`不是有效的域名：${bad.n}`);
  const hosts = parsed.map((p) => p.host!);
  if (sub === "only") return saveSites({ ...config, mode: "only", only: hosts }, "已切换到只录点名的站点");
  if (sub === "exclude") return saveSites({ ...config, exclude: [...config.exclude, ...hosts], allow: config.allow.filter((d) => !hosts.includes(d)) }, `已排除 ${hosts.join(", ")}`);
  // include：用户排除的就从排除里拿掉；内置排除的记到 allow 里重新打开
  const reopened = hosts.filter((h) => BUILTIN_EXCLUDE.includes(h));
  return saveSites({ ...config, exclude: config.exclude.filter((d) => !hosts.includes(d)), allow: [...config.allow, ...reopened] }, `已重新打开 ${hosts.join(", ")}`);
}

type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; lease?: boolean; humanIdleMs?: number | null };

export async function tabsCommand(): Promise<void> {
  const res = (await ask("journal.tabs")) as { tabs: TabInfo[] } | undefined;
  if (!res) return;
  if (res.tabs.length === 0) return out("录制范围内没有打开的标签页。");
  out(`${res.tabs.length} 个标签页（录制范围内）`);
  for (const t of res.tabs) out(`tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"}${t.lease ? " 租约:agent" : ""}${t.humanIdleMs != null ? ` 人静默${Math.round(t.humanIdleMs / 1000)}s` : ""} ${t.url} "${t.title}"`);
}

export async function logCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["all", "json"]);
  if ("error" in flags) return fail(flags.error);
  const since = intFlag(flags, "since"), tab = intFlag(flags, "tab"), n = intFlag(flags, "n");
  for (const v of [since, tab, n]) if (isError(v)) return fail(v.error);
  const src = flags.values.get("src");
  if (src !== undefined && !["human", "agent", "page"].includes(src)) return fail("--src 只能是 human、agent、page");
  const rows = await readEvents({ since: since as number | undefined, tab: tab as number | undefined, src: src as Src | undefined, all: flags.bools.has("all"), limit: (n as number | undefined) ?? 50 });
  if (flags.bools.has("json")) return out(JSON.stringify(rows, null, 1));
  const cursor = rows.length ? rows[rows.length - 1]!.seq : (since as number | undefined) ?? (await lastSeq());
  if (rows.length === 0) return out(`无新事件（游标 ${cursor}）`);
  const humans = rows.filter((r) => r.src === "human").length;
  out(`${rows.length} 条事件${humans ? `，其中人的操作 ${humans} 条` : ""}（游标 ${cursor}，下次加 --since ${cursor}）`);
  out(formatRows(rows));
}

export async function sqlCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["json"]);
  if ("error" in flags) return fail(flags.error);
  const query = flags.rest.join(" ");
  if (!query) return fail("用法：tabbot sql \"SELECT ... FROM events ...\"（表 events，最近 7 天，只读）");
  const limit = intFlag(flags, "limit");
  if (isError(limit)) return fail(limit.error);
  try {
    const res = await runSql(query, { limit: limit as number | undefined });
    if (flags.bools.has("json")) return out(JSON.stringify(res, null, 1));
    out(`${res.rows.length} 行${res.truncated ? "（已截断，加 --limit 调大）" : ""}`);
    out(res.columns.join("\t"));
    for (const row of res.rows) out(row.map((v) => (v === null ? "" : String(v))).join("\t"));
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}

export async function snapshotCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["full"]);
  if ("error" in flags) return fail(flags.error);
  let tab = intFlag(flags, "tab");
  if (isError(tab)) return fail(tab.error);
  if (tab === undefined) {
    const list = (await ask("journal.tabs")) as { tabs: { tabId: number; active: boolean }[] } | undefined;
    if (!list) return;
    tab = (list.tabs.find((t) => t.active) ?? list.tabs[0])?.tabId;
    if (tab === undefined) return fail("录制范围内没有打开的标签页");
  }
  const res = (await ask("journal.snapshot", { tabId: tab, full: flags.bools.has("full") })) as { snap: Snapshot } | undefined;
  if (res) out(renderSnapshot(res.snap, tab as number));
}

export async function waitCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return fail(flags.error);
  const since = intFlag(flags, "since"), tab = intFlag(flags, "tab"), idle = intFlag(flags, "idle"), timeout = intFlag(flags, "timeout");
  for (const v of [since, tab, idle, timeout]) if (isError(v)) return fail(v.error);
  const start = (since as number | undefined) ?? (await lastSeq());
  const res = await waitForHuman({ since: start, tab: tab as number | undefined, idleMs: ((idle as number | undefined) ?? 3) * 1000, timeoutMs: ((timeout as number | undefined) ?? 30) * 1000 });
  const cursor = res.rows.length ? res.rows[res.rows.length - 1]!.seq : start;
  if (res.timedOut && !res.humanActive) return out(`无变化（等了 ${(timeout as number | undefined) ?? 30}s，游标 ${cursor}）`);
  if (res.timedOut) return out(`人还在操作，未停手（游标 ${cursor}；新增 ${res.rows.length} 条）\n${formatRows(res.rows)}`);
  out(`人已停手（静默 ${(idle as number | undefined) ?? 3}s），新增 ${res.rows.length} 条（游标 ${cursor}）\n${formatRows(res.rows)}`);
}

export async function statusCommand(): Promise<void> {
  const [st, ping] = await Promise.all([journalStatus(), tryPing()]);
  const mb = (st.bytes / 1024 / 1024).toFixed(1);
  const events = st.days.reduce((a, d) => a + d.events, 0);
  out(`录制：${st.days.length} 天 ${events} 条事件，占用 ${mb}MB / ${Math.round(JOURNAL_CAP_BYTES / 1024 / 1024)}MB`);
  out(`daemon：${ping ? `在运行，扩展${ping.extension ? "已连接" : "未连接"}` : "未运行"}`);
  out(`目录：${JOURNAL_DIR.replace(os.homedir(), "~")}（日志 <日期>.db，响应体 bodies/<日期>/，快照 snapshots/<日期>/）`);
  out(`范围：${describeConfig(readConfig())}`);
}

// ---- 在原页面上操作：takeover / release / act ----

export type ActCmd = { kind: string; ref?: string; text?: string; key?: string; dx?: number; dy?: number; to?: string; checked?: boolean; url?: string };

const REF = /^@?e\d+$/;
const normRef = (r: string): string => (r.startsWith("@") ? r : `@${r}`);

/** 解析 act 的参数（不含 --tab）：click @e1 | fill @e1 "文字" | select @e1 "选项" | check @e1 [--off] | press Enter [@e1] | scroll down|up [px] [@e1] | scroll top|bottom [@e1] | goto <url>。 */
export function parseAct(args: string[]): { cmd: ActCmd } | { error: string } {
  const flags = parseFlags(args, ["off"]);
  if ("error" in flags) return { error: flags.error };
  const [kind, ...rest] = flags.rest;
  const ref = (v: string | undefined): string | { error: string } => (v && REF.test(v) ? normRef(v) : { error: `需要元素引用，如 @e12（先用 tabbot snapshot 取）` });
  switch (kind) {
    case "click": { const r = ref(rest[0]); return typeof r === "string" ? { cmd: { kind, ref: r } } : r; }
    case "fill": case "select": {
      const r = ref(rest[0]); if (typeof r !== "string") return r;
      if (rest[1] === undefined) return { error: `用法：tabbot act ${kind} @e12 "文字"` };
      return { cmd: { kind, ref: r, text: rest.slice(1).join(" ") } };
    }
    case "check": { const r = ref(rest[0]); return typeof r === "string" ? { cmd: { kind, ref: r, checked: !flags.bools.has("off") } } : r; }
    case "press": {
      if (!rest[0]) return { error: "用法：tabbot act press Enter [@e12]（组合键如 Ctrl+K、Cmd+A）" };
      if (rest[1] !== undefined && !REF.test(rest[1])) return { error: "press 的第二个参数应该是元素引用，如 @e12" };
      return { cmd: { kind, key: rest[0], ...(rest[1] ? { ref: normRef(rest[1]) } : {}) } };
    }
    case "scroll": {
      const refArg = rest.find((x) => REF.test(x));
      const other = rest.filter((x) => !REF.test(x));
      const dir = other[0];
      const amount = other[1] === undefined ? 600 : Number(other[1]);
      if (!Number.isFinite(amount)) return { error: "滚动的距离要是数字（像素）" };
      const base = refArg ? { ref: normRef(refArg) } : {};
      if (dir === "top" || dir === "bottom") return { cmd: { kind, to: dir, ...base } };
      if (dir === "down") return { cmd: { kind, dy: amount, ...base } };
      if (dir === "up") return { cmd: { kind, dy: -amount, ...base } };
      return { error: "用法：tabbot act scroll down|up [像素] [@e12] | scroll top|bottom [@e12]" };
    }
    case "goto": {
      const url = rest[0];
      if (!url) return { error: "用法：tabbot act goto <网址>" };
      try { const u = new URL(url.includes("://") ? url : `https://${url}`); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("协议"); return { cmd: { kind, url: u.href } }; } catch { return { error: `不是有效的网址：${url}` }; }
    }
    default: return { error: "用法：tabbot act click|fill|select|check|press|scroll|goto ...（元素引用 @e12 来自 tabbot snapshot）" };
  }
}

/** 选标签页：--tab 优先；否则按场景挑（需要租约的挑持有租约的，takeover 挑前台的）；挑不出唯一的就说明。 */
async function pickTab(flagTab: number | undefined, mode: "lease" | "front"): Promise<number | undefined> {
  if (flagTab !== undefined) return flagTab;
  const res = (await ask("journal.tabs")) as { tabs: TabInfo[] } | undefined;
  if (!res) return undefined;
  const pool = mode === "lease" ? res.tabs.filter((t) => t.lease) : res.tabs.filter((t) => t.active);
  if (pool.length === 1) return pool[0]!.tabId;
  if (pool.length === 0) { fail(mode === "lease" ? "没有持有租约的标签页：先 tabbot takeover --tab N（tabbot tabs 看标签页）" : "录制范围内没有前台标签页：用 --tab N 指定（tabbot tabs 看标签页）"); return undefined; }
  fail(`有 ${pool.length} 个${mode === "lease" ? "持有租约" : "前台"}的标签页，用 --tab N 指定：${pool.map((t) => `tab${t.tabId}`).join(" ")}`);
  return undefined;
}

function humanSince(ms: number | undefined): string { return ms === undefined ? "" : `${Math.round(ms / 1000)} 秒前`; }

export async function takeoverCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return fail(t.error);
  const tab = await pickTab(t as number | undefined, "front"); if (tab === undefined) return;
  const res = (await ask("journal.lease", { op: "acquire", tabId: tab })) as { granted: boolean; already?: boolean; reason?: string; idleMs?: number } | undefined;
  if (!res) return;
  if (!res.granted) { process.exitCode = 1; return out(`✗ 没有获取租约：人还在操作 tab${tab}（${humanSince(res.idleMs)}有输入）。用 tabbot wait --tab ${tab} 等人停手，再重试 takeover`); }
  const rows = await readEvents({ tab, limit: 8 });
  out(`✓ 已获取 tab${tab} 的租约${res.already ? "（本来就持有）" : ""}。人一动手租约立刻撤销；操作前先 tabbot snapshot --tab ${tab} 取元素引用。`);
  if (rows.length) out(`这个标签页最近的事件：\n${formatRows(rows)}`);
}

export async function releaseCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return fail(t.error);
  const tab = await pickTab(t as number | undefined, "lease"); if (tab === undefined) return;
  const res = (await ask("journal.lease", { op: "release", tabId: tab, reason: flags.values.get("reason") })) as { released: boolean } | undefined;
  if (res) out(res.released ? `✓ 已交还 tab${tab} 的租约${flags.values.get("reason") ? `（${flags.values.get("reason")}）` : ""}` : `tab${tab} 本来就没有租约`);
}

export async function actCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["off"]);
  if ("error" in flags) return fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return fail(t.error);
  const rest = args.filter((a, i) => !(a === "--tab" || args[i - 1] === "--tab" || a.startsWith("--tab=")));
  const parsed = parseAct(rest);
  if ("error" in parsed) return fail(parsed.error);
  const tab = await pickTab(t as number | undefined, "lease"); if (tab === undefined) return;
  const res = (await ask("journal.act", { tabId: tab, cmd: parsed.cmd }, 40_000)) as { ok?: boolean; error?: string; rejected?: string; humanIdleMs?: number; navigated?: boolean; revokedDuring?: boolean; url?: string; title?: string; target?: unknown; settle?: { settled: boolean; waitedMs: number }; actSeq?: number } | undefined;
  if (!res) return;
  const cmdText = `${parsed.cmd.kind}${parsed.cmd.ref ? ` ${parsed.cmd.ref}` : ""}${parsed.cmd.key ? ` ${parsed.cmd.key}` : ""}${parsed.cmd.url ? ` ${parsed.cmd.url}` : ""}`;
  if (res.rejected === "no-lease") { process.exitCode = 1; return out(`✗ ${cmdText}：没有租约。${res.humanIdleMs !== undefined && res.humanIdleMs < 60_000 ? `人 ${humanSince(res.humanIdleMs)}刚动过，租约被撤销了：先 tabbot log --tab ${tab} --src human 看人做了什么，再 tabbot takeover --tab ${tab}` : `先 tabbot takeover --tab ${tab}`}`); }
  if (res.ok === false) { process.exitCode = 1; return out(`✗ ${cmdText}：${res.error ?? "失败"}`); }
  const lines = [`✓ ${cmdText}${res.settle ? (res.settle.settled ? `（页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s）` : "（等了很久页面还在变化，没有稳定）") : ""}`];
  if (res.navigated) lines.push(`页面已跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  else if (res.url) lines.push(`页面：${res.url} "${res.title ?? ""}"`);
  if (res.revokedDuring) lines.push(`⚠ 动作执行期间人动手了，租约已被撤销：先 tabbot log --tab ${tab} --src human 看人做了什么，再决定要不要重新 takeover`);
  // 这个动作引发的请求（扩展的事件要一小会儿才到日志里）
  await new Promise((r) => setTimeout(r, 500));
  if (res.actSeq !== undefined) {
    const caused = (await readEvents({ since: res.actSeq, tab, limit: 100 })).filter((r) => r.cause === res.actSeq);
    if (caused.length) lines.push(`引发了 ${caused.length} 个请求：\n${formatRows(caused.slice(0, 8))}${caused.length > 8 ? `\n…还有 ${caused.length - 8} 个（tabbot log --tab ${tab} --since ${res.actSeq}）` : ""}`);
  }
  out(lines.join("\n"));
}

// ---- 请求优先：找请求、看请求、重放请求 ----

/** tabbot req find <页面上看到的文字> [-n 20]：在存下来的响应体里找这段文字，看是哪个请求返回的。 */
export async function reqCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "find") {
    const flags = parseFlags(rest);
    if ("error" in flags) return fail(flags.error);
    const needle = flags.rest.join(" ");
    if (!needle) return fail('用法：tabbot req find "页面上看到的文字" [--n 20]');
    const n = intFlag(flags, "n"); if (isError(n)) return fail(n.error);
    const hits = await findInBodies(needle, { limit: (n as number | undefined) ?? 20 });
    if (hits.length === 0) return out(`没有响应体里包含「${needle}」（只搜最近 7 天存下来的响应体；页面上的字可能是服务器直接渲染在 HTML 里的，不是接口返回的）`);
    out(`${hits.length} 个请求的响应里有「${needle}」：（tabbot req show <编号> 看请求，tabbot replay <编号> 重放）`);
    for (const h of hits) out(`${formatEvent(h.row)}\n    …${h.snippet}…`);
    return;
  }
  if (sub === "show") {
    const seq = Number((rest[0] ?? "").replace(/^#/, ""));
    if (!Number.isInteger(seq)) return fail("用法：tabbot req show <编号>（编号来自 tabbot log 或 req find）");
    const row = await readEventBySeq(seq);
    if (!row) return fail(`找不到事件 #${seq}`);
    out(formatEvent(row));
    const t = templateFromRow(row);
    if ("error" in t) return out(`不能重放：${t.error}`);
    const u = new URL(row.url!);
    const lines = [`地址：${row.url}`];
    const headers = Object.entries(t.template.headers);
    if (headers.length) lines.push(`请求头：\n${headers.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
    if (t.template.body !== undefined) lines.push(`请求体：${t.template.body.length > 600 ? `${t.template.body.slice(0, 600)}…` : t.template.body}`);
    if (row.body) lines.push(`响应体文件：${row.body}（在 ~/.tabbot/journal/bodies 下，可以直接 rg）`);
    const params = [...u.searchParams.keys()];
    lines.push(`重放：tabbot replay ${seq}${isSafeMethod(row.method!) ? "" : " --yes"} [--set 名字=值 ...]；可以改的查询参数：${params.length ? params.join(", ") : "（无）"}${t.template.body !== undefined ? "；请求体字段用 body.字段名=值" : ""}；请求头 header.名字=值`);
    lines.push("token 等秘密在日志里是别名或 [redacted]，真值只在浏览器里，重放时由浏览器带上，你不需要也拿不到它们。");
    for (const w of t.warnings) lines.push(`⚠ ${w}`);
    return out(lines.join("\n"));
  }
  fail('用法：tabbot req find "页面上看到的文字" | req show <编号>');
}

/** 解析 replay 的参数：<编号> [--set k=v]... [--tab N] [--yes]。--set 可以重复。 */
export function parseReplayArgs(args: string[]): { seq: number; sets: string[]; tabId?: number; yes: boolean } | { error: string } {
  const sets: string[] = [];
  let seq: number | undefined, tabId: number | undefined, yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes") yes = true;
    else if (a === "--set") { const v = args[++i]; if (v === undefined) return { error: "--set 缺少值（写成 名字=值）" }; sets.push(v); }
    else if (a.startsWith("--set=")) sets.push(a.slice(6));
    else if (a === "--tab" || a.startsWith("--tab=")) {
      const v = a === "--tab" ? args[++i] : a.slice(6);
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0) return { error: "--tab 需要非负整数" };
      tabId = n;
    } else if (a.startsWith("--")) return { error: `不认识的参数 ${a}` };
    else if (seq === undefined) { const n = Number(a.replace(/^#/, "")); if (!Number.isInteger(n)) return { error: `请求编号要是整数（来自 tabbot log 或 req find），收到：${a}` }; seq = n; }
    else return { error: `多余的参数：${a}` };
  }
  if (seq === undefined) return { error: "用法：tabbot replay <编号> [--set 名字=值 ...] [--tab N] [--yes]" };
  return { seq, sets, ...(tabId !== undefined ? { tabId } : {}), yes };
}

export async function replayCommand(args: string[]): Promise<void> {
  const p = parseReplayArgs(args);
  if ("error" in p) return fail(p.error);
  const res = (await ask("journal.replay", { seq: p.seq, sets: p.sets, tabId: p.tabId, yes: p.yes }, 40_000)) as { ok?: boolean; error?: string; rejected?: string; humanIdleMs?: number; tabId?: number; method?: string; status?: number; size?: number; ms?: number; truncated?: boolean; summary?: string; preview?: string; bodyFile?: string; replaySeq?: number; warnings?: string[] } | undefined;
  if (!res) return;
  if (res.rejected === "no-lease") { process.exitCode = 1; return out(`✗ 重放 #${p.seq}：非 GET 请求需要租约（和 act 一样）。${res.humanIdleMs !== undefined && res.humanIdleMs < 60_000 ? `人刚动过（${humanSince(res.humanIdleMs)}），先 tabbot log --tab ${res.tabId} --src human 看人做了什么，再 tabbot takeover --tab ${res.tabId}` : `先 tabbot takeover --tab ${res.tabId}`}`); }
  if (res.ok === false) { process.exitCode = 1; return out(`✗ 重放 #${p.seq}：${res.error ?? "失败"}`); }
  const bad = (res.status ?? 0) >= 400;
  if (bad) process.exitCode = 1;
  const kb = (res.size ?? 0) >= 1024 ? `${((res.size ?? 0) / 1024).toFixed(1)}KB` : `${res.size ?? 0}B`;
  const lines = [`${bad ? "✗" : "✓"} 重放 #${p.seq}${p.sets.length ? `（改了 ${p.sets.map((x) => x.split("=")[0]).join(", ")}）` : ""}：${res.method} → ${res.status}，${kb}，${res.ms}ms，在 tab${res.tabId} 里发出；${res.summary ?? ""}`];
  if (bad) lines.push(res.status === 401 || res.status === 403 ? "服务器拒绝了：登录态过期、需要签名，或这个请求依赖页面上一步的状态。改用 tabbot act 在页面上做。" : "服务器返回了错误，先看下面的响应内容再决定。");
  if (res.bodyFile) lines.push(`响应体文件：${res.bodyFile}（~/.tabbot/journal/bodies 下，可以直接 rg）`);
  if (res.truncated) lines.push("⚠ 响应超过 1MB，只取了前 1MB");
  for (const w of res.warnings ?? []) lines.push(`⚠ ${w}`);
  if (res.preview) lines.push(`响应（前 ${Math.min(res.preview.length, 1500)} 字符，已脱敏）：\n${res.preview}`);
  out(lines.join("\n"));
}

