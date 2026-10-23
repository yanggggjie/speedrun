/**
 * 常驻录制的命令：sites、tabs、log、sql、snapshot、wait、status。
 * 读日志直接开 ~/.twocursor/journal 里的只读 SQLite（holder 没起来也能看历史）；
 * 只有 sites 生效、tabs、snapshot 需要经 holder 问扩展。输出是给 agent 读的文本，第一行是结论；失败仍是 { status: "failure", error }。
 */
import * as os from "node:os";
import { ensureSessionAndRpc, tryPing } from "./session.ts";
import { formatHandshakeStdout, formatErrorStdout, isHandshakeStatus } from "../protocol.ts";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR } from "../utils/constants.ts";
import { formatRows, lastSeq, readEvents, runSql, status as journalStatus, waitForHuman } from "../journal/query.ts";
import { renderSnapshot, type Snapshot } from "../journal/render.ts";
import { normalizeSite, readSites, writeSites } from "../journal/sites.ts";
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
async function ask(method: "journal.sync" | "journal.tabs" | "journal.snapshot", params?: Record<string, unknown>): Promise<unknown | undefined> {
  try { return await ensureSessionAndRpc(method, params, 15_000); } catch (error) {
    const value = error as { data?: { status?: string }; message?: string };
    if (value.data?.status && isHandshakeStatus(value.data.status)) { console.log(formatHandshakeStdout(value.data.status)); process.exitCode = 1; } else fail(value.message ?? String(error));
    return undefined;
  }
}

export async function sitesCommand(args: string[]): Promise<void> {
  const [sub, ...names] = args;
  const current = readSites();
  if (sub === "add" || sub === "rm") {
    if (names.length === 0) return fail(`用法：twocursor sites ${sub} <域名> ...`);
    const parsed = names.map((n) => ({ n, site: normalizeSite(n) }));
    const bad = parsed.find((p) => !p.site);
    if (bad) return fail(`不是有效的域名：${bad.n}`);
    const sites = sub === "add" ? [...current, ...parsed.map((p) => p.site!)] : current.filter((s) => !parsed.some((p) => p.site === s));
    writeSites(sites);
    const now = readSites();
    // 保存之后让扩展立刻生效；扩展没连上也不要紧，下次连上会自动下发。
    let applied = false;
    try { await ensureSessionAndRpc("journal.sync", undefined, 15_000); applied = true; } catch { /* 下次扩展连上时生效 */ }
    return out(`${sub === "add" ? "已加入" : "已移除"}，现在录制 ${now.length} 个站点：${now.join(", ") || "（无）"}。${applied ? "已在扩展里生效，已打开的页面已补注入。" : "扩展没连上，连上后自动生效。"}`);
  }
  if (sub !== undefined && sub !== "list") return fail("用法：twocursor sites [list] | sites add <域名> ... | sites rm <域名> ...");
  out(current.length ? `录制 ${current.length} 个站点：${current.join(", ")}` : "还没有录制任何站点。用 twocursor sites add <域名> 添加（只录你点名的站点）。");
}

export async function tabsCommand(): Promise<void> {
  const res = (await ask("journal.tabs")) as { tabs: { tabId: number; windowId: number; active: boolean; url: string; title: string }[] } | undefined;
  if (!res) return;
  if (res.tabs.length === 0) return out("白名单站点里没有打开的标签页。");
  out(`${res.tabs.length} 个标签页（白名单站点）`);
  for (const t of res.tabs) out(`tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"} ${t.url} "${t.title}"`);
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
  if (!query) return fail("用法：twocursor sql \"SELECT ... FROM events ...\"（表 events，最近 7 天，只读）");
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
    if (tab === undefined) return fail("白名单站点里没有打开的标签页");
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
  out(`录制：${readSites().length} 个站点，${st.days.length} 天 ${events} 条事件，占用 ${mb}MB / ${Math.round(JOURNAL_CAP_BYTES / 1024 / 1024)}MB`);
  out(`daemon：${ping ? `在运行，扩展${ping.extension ? "已连接" : "未连接"}` : "未运行"}`);
  out(`目录：${JOURNAL_DIR.replace(os.homedir(), "~")}（日志 <日期>.db，响应体 bodies/<日期>/，快照 snapshots/<日期>/）`);
  out(`站点：${readSites().join(", ") || "（无）"}`);
}
