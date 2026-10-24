/**
 * 命令行的全部命令都在这里：tabbot <argv> 原样发给 holder，holder 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 第一行是结论；失败是 { status: "failure", error }，握手类失败是 { status: "need-*", guide }，退出码非零。
 */
import * as os from "node:os";
import { USAGE, handshakeStatusFromError, formatErrorStdout, formatHandshakeStdout } from "../protocol.ts";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR } from "../utils/constants.ts";
import { buildCatalog, buildContext, formatCatalog, normalizeSite } from "./digest.ts";
import { formatEvent } from "./format.ts";
import type { Ingestor } from "./ingest.ts";
import type { Leases } from "./lease.ts";
import { findInBodies, formatRows, lastSeq, readEvents, readEventBySeq, runSql, status as journalStatus, waitForHuman } from "./query.ts";
import type { RawStore } from "./raw.ts";
import { applySets, isSafeMethod, replayHeaders, UNREPLAYABLE_BODY } from "./replay-core.ts";
import { pickReplayTab, summarizeBody, templateFromRow } from "./replay.ts";
import { renderSnapshot, type Snapshot } from "./render.ts";
import type { EventRow, Src } from "./types.ts";

export type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; status: string };

/** holder 提供给命令的能力。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  /** 在标签页里计算表达式。 */
  call(tab: number, expr: string, options?: { timeoutMs?: number; onNavigate?: "ok" | "fail" }): Promise<unknown>;
  goto(tab: number, url: string): Promise<void>;
  /** 等标签页加载完，返回最终地址和标题。 */
  waitLoaded(tab: number): Promise<{ url: string; title: string } | undefined>;
  leases: Leases;
  ingest: Ingestor;
  raw: RawStore;
  daemon(): { extension: boolean; pid: number };
}

class Output {
  private readonly lines: string[] = [];
  code = 0;
  private override: string | undefined;
  line(text: string): void { this.lines.push(text); }
  fail(error: string): void { this.override = formatErrorStdout(error); this.code = 1; }
  handshake(stdout: string): void { this.override = stdout; this.code = 1; }
  result(): { stdout: string; code: number } { return { stdout: this.override ?? this.lines.join("\n"), code: this.code }; }
}

type Flags = { values: Map<string, string>; bools: Set<string>; rest: string[] };

/** `--名字 值` 或 `--名字=值`；bool 里列出的是不带值的开关。 */
export function parseFlags(args: string[], bool: string[] = []): Flags | { error: string } {
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

/** 执行一条命令。argv 是 `tabbot` 后面的全部参数。 */
export async function runCommand(argv: string[], ctx: Ctx): Promise<{ stdout: string; code: number }> {
  const out = new Output();
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "context": await contextCommand(args, out); break;
      case "api": await apiCommand(args, ctx, out); break;
      case "tabs": await tabsCommand(ctx, out); break;
      case "log": await logCommand(args, out); break;
      case "sql": await sqlCommand(args, out); break;
      case "snapshot": await snapshotCommand(args, ctx, out); break;
      case "text": await textCommand(args, ctx, out); break;
      case "wait": await waitCommand(args, out); break;
      case "status": await statusCommand(ctx, out); break;
      case "takeover": await takeoverCommand(args, ctx, out); break;
      case "release": await releaseCommand(args, ctx, out); break;
      case "act": await actCommand(args, ctx, out); break;
      case "req": await reqCommand(args, out); break;
      case "replay": await replayCommand(args, ctx, out); break;
      default: out.fail(USAGE);
    }
  } catch (error) {
    const status = handshakeStatusFromError(error);
    if (status) out.handshake(formatHandshakeStdout(status));
    else out.fail(error instanceof Error ? error.message : String(error));
  }
  return out.result();
}

// ---- 观察 ----

/** 日志行里有 cause 指向更早的行（可能不在已读出的这批里）：把缺的补读出来，返回按 seq 查的函数。 */
async function causeResolver(rows: EventRow[]): Promise<(seq: number) => EventRow | undefined> {
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  for (const seq of new Set(rows.map((r) => r.cause).filter((c): c is number => typeof c === "number" && !bySeq.has(c)))) {
    const row = await readEventBySeq(seq);
    if (row) bySeq.set(seq, row);
  }
  return (seq) => bySeq.get(seq);
}

/** tabbot context [站点] [--minutes 180]：用户最近在各个站点上做了什么——接到任务的第一步。 */
async function contextCommand(args: string[], out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const minutes = intFlag(flags, "minutes"); if (isError(minutes)) return out.fail(minutes.error);
  const window = (minutes as number | undefined) || 180;
  const site = flags.rest[0] ? normalizeSite(flags.rest[0]) : undefined;
  if (flags.rest[0] && !site) return out.fail(`不是有效的站点：${flags.rest[0]}`);
  const since = Date.now() - window * 60_000;
  const rows = (await readEvents({ limit: 5000 })).filter((r) => r.ts >= since);
  for (const line of buildContext(rows, { causeOf: await causeResolver(rows), minutes: window, site })) out.line(line);
}

/** tabbot api <站点> [-n 30]：这个站点上出现过的接口，以及触发它们的用户操作——找"能不能直接重放"的第一步。 */
async function apiCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const n = intFlag(flags, "n"); if (isError(n)) return out.fail(n.error);
  const site = normalizeSite(flags.rest[0] ?? "");
  if (!site) return out.fail("用法：tabbot api <站点>（如 tabbot api x.com）");
  const rows = await readEvents({ limit: 20_000 });
  const canReplay = (row: EventRow): boolean => {
    try { const rid = (JSON.parse(row.detail ?? "{}") as { rid?: string }).rid; return !!rid && !!ctx.raw.get(row.tab, rid); } catch { return false; }
  };
  for (const line of formatCatalog(buildCatalog(rows, site, { causeOf: await causeResolver(rows), canReplay }), site, (n as number | undefined) || 30)) out.line(line);
}

async function tabsCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const tabs = await ctx.tabs();
  if (tabs.length === 0) return out.line("没有打开的 http/https 标签页。");
  out.line(`${tabs.length} 个标签页`);
  for (const t of tabs) {
    const idle = ctx.leases.humanIdleMs(t.tabId);
    out.line(`tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"}${ctx.leases.has(t.tabId) ? " 租约:agent" : ""}${idle !== undefined ? ` 人静默${Math.round(idle / 1000)}s` : ""} ${t.url} "${t.title}"`);
  }
}

async function logCommand(args: string[], out: Output): Promise<void> {
  const flags = parseFlags(args, ["all", "json"]);
  if ("error" in flags) return out.fail(flags.error);
  const since = intFlag(flags, "since"), tab = intFlag(flags, "tab"), n = intFlag(flags, "n");
  for (const v of [since, tab, n]) if (isError(v)) return out.fail(v.error);
  const src = flags.values.get("src");
  if (src !== undefined && !["human", "agent", "page"].includes(src)) return out.fail("--src 只能是 human、agent、page");
  const rows = await readEvents({ since: since as number | undefined, tab: tab as number | undefined, src: src as Src | undefined, all: flags.bools.has("all"), limit: (n as number | undefined) ?? 50 });
  if (flags.bools.has("json")) return out.line(JSON.stringify(rows, null, 1));
  const cursor = rows.length ? rows[rows.length - 1]!.seq : (since as number | undefined) ?? (await lastSeq());
  if (rows.length === 0) return out.line(`无新事件（游标 ${cursor}）`);
  const humans = rows.filter((r) => r.src === "human").length;
  out.line(`${rows.length} 条事件${humans ? `，其中人的操作 ${humans} 条` : ""}（游标 ${cursor}，下次加 --since ${cursor}）`);
  out.line(formatRows(rows));
}

async function sqlCommand(args: string[], out: Output): Promise<void> {
  const flags = parseFlags(args, ["json"]);
  if ("error" in flags) return out.fail(flags.error);
  const query = flags.rest.join(" ");
  if (!query) return out.fail("用法：tabbot sql \"SELECT ... FROM events ...\"（表 events，最新的 10 段，只读）");
  const limit = intFlag(flags, "limit");
  if (isError(limit)) return out.fail(limit.error);
  const res = await runSql(query, { limit: limit as number | undefined });
  if (flags.bools.has("json")) return out.line(JSON.stringify(res, null, 1));
  out.line(`${res.rows.length} 行${res.truncated ? "（已截断，加 --limit 调大）" : ""}`);
  out.line(res.columns.join("\t"));
  for (const row of res.rows) out.line(row.map((v) => (v === null ? "" : String(v))).join("\t"));
}

/** 选标签页：--tab 优先；否则按场景挑（需要租约的挑持有租约的，takeover 挑前台的）；挑不出唯一的就说明。 */
async function pickTab(flagTab: number | undefined, mode: "lease" | "front", ctx: Ctx, out: Output): Promise<number | undefined> {
  if (flagTab !== undefined) return flagTab;
  await ctx.ensureExtension();
  const tabs = await ctx.tabs();
  const pool = mode === "lease" ? tabs.filter((t) => ctx.leases.has(t.tabId)) : tabs.filter((t) => t.active);
  if (pool.length === 1) return pool[0]!.tabId;
  if (pool.length === 0) { out.fail(mode === "lease" ? "没有持有租约的标签页：先 tabbot takeover --tab N（tabbot tabs 看标签页）" : "没有前台标签页：用 --tab N 指定（tabbot tabs 看标签页）"); return undefined; }
  out.fail(`有 ${pool.length} 个${mode === "lease" ? "持有租约" : "前台"}的标签页，用 --tab N 指定：${pool.map((t) => `tab${t.tabId}`).join(" ")}`);
  return undefined;
}

async function snapshotCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args, ["full"]);
  if ("error" in flags) return out.fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return out.fail(t.error);
  await ctx.ensureExtension();
  const tab = await pickTab(t as number | undefined, "front", ctx, out); if (tab === undefined) return;
  const snap = (await ctx.call(tab, `window.__tcr.exec.snapshot(${flags.bools.has("full")})`)) as Snapshot;
  out.line(renderSnapshot(snap, tab));
}

/** 当前页面的可见文字（正文、评论），给“读内容”用；要点击或填写仍用 snapshot 取元素引用。 */
async function textCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const t = intFlag(flags, "tab"), max = intFlag(flags, "max");
  for (const v of [t, max]) if (isError(v)) return out.fail(v.error);
  await ctx.ensureExtension();
  const tab = await pickTab(t as number | undefined, "front", ctx, out); if (tab === undefined) return;
  const limit = Math.max(1, Math.min((max as number | undefined) || 20_000, 200_000));
  const res = (await ctx.call(tab, `window.__tcr.exec.text(${limit})`)) as { url: string; title: string; total: number; text: string };
  const cut = res.total > res.text.length;
  out.line(`tab${tab} ${res.url} "${res.title}"${cut ? `\n（只给前 ${res.text.length} 字，全文 ${res.total} 字；用 --max N 取更多）` : ""}\n\n${res.text}`);
}

async function waitCommand(args: string[], out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const since = intFlag(flags, "since"), tab = intFlag(flags, "tab"), idle = intFlag(flags, "idle"), timeout = intFlag(flags, "timeout");
  for (const v of [since, tab, idle, timeout]) if (isError(v)) return out.fail(v.error);
  const start = (since as number | undefined) ?? (await lastSeq());
  const res = await waitForHuman({ since: start, tab: tab as number | undefined, idleMs: ((idle as number | undefined) ?? 3) * 1000, timeoutMs: ((timeout as number | undefined) ?? 30) * 1000 });
  const cursor = res.rows.length ? res.rows[res.rows.length - 1]!.seq : start;
  if (res.timedOut && !res.humanActive) return out.line(`无变化（等了 ${(timeout as number | undefined) ?? 30}s，游标 ${cursor}）`);
  if (res.timedOut) return out.line(`人还在操作，未停手（游标 ${cursor}；新增 ${res.rows.length} 条）\n${formatRows(res.rows)}`);
  out.line(`人已停手（静默 ${(idle as number | undefined) ?? 3}s），新增 ${res.rows.length} 条（游标 ${cursor}）\n${formatRows(res.rows)}`);
}

async function statusCommand(ctx: Ctx, out: Output): Promise<void> {
  const st = await journalStatus();
  const mb = (st.bytes / 1024 / 1024).toFixed(1);
  out.line(`录制：${st.segments} 段 ${st.events} 条事件，占用 ${mb}MB / ${Math.round(JOURNAL_CAP_BYTES / 1024 / 1024)}MB`);
  const d = ctx.daemon();
  out.line(`daemon：在运行 pid=${d.pid}，扩展${d.extension ? "已连接" : "未连接"}`);
  out.line(`目录：${JOURNAL_DIR.replace(os.homedir(), "~")}（每段 seg-<序号>/：events.db、bodies/、snapshots/）`);
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

function humanSince(ms: number | undefined): string { return ms === undefined ? "" : `${Math.round(ms / 1000)} 秒前`; }

async function takeoverCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return out.fail(t.error);
  await ctx.ensureExtension();
  const tab = await pickTab(t as number | undefined, "front", ctx, out); if (tab === undefined) return;
  if (!(await ctx.tabs()).some((x) => x.tabId === tab)) return out.fail(`tab${tab} 不存在，或不是 http/https 页面（tabbot tabs 看标签页）`);
  const res = ctx.leases.acquire(tab);
  if (!res.granted) { out.code = 1; return out.line(`✗ 没有获取租约：人还在操作 tab${tab}（${humanSince(res.idleMs)}有输入）。用 tabbot wait --tab ${tab} 等人停手，再重试 takeover`); }
  const rows = await readEvents({ tab, limit: 8 });
  out.line(`✓ 已获取 tab${tab} 的租约${res.already ? "（本来就持有）" : ""}。人一动手租约立刻撤销；操作前先 tabbot snapshot --tab ${tab} 取元素引用。`);
  if (rows.length) out.line(`这个标签页最近的事件：\n${formatRows(rows)}`);
}

async function releaseCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return out.fail(t.error);
  const tab = await pickTab(t as number | undefined, "lease", ctx, out); if (tab === undefined) return;
  const reason = flags.values.get("reason");
  const released = ctx.leases.release(tab, reason);
  out.line(released ? `✓ 已交还 tab${tab} 的租约${reason ? `（${reason}）` : ""}` : `tab${tab} 本来就没有租约`);
}

type ActResult = { ok?: boolean; error?: string; rejected?: string; humanIdleMs?: number; navigated?: boolean; revokedDuring?: boolean; url?: string; title?: string; target?: unknown; chars?: number; settle?: { settled: boolean; waitedMs: number }; actSeq?: number };

/** 页面里返回的元素描述 { tag, role, text, sel } 变成日志里的 `button[提交]`。 */
function describeTarget(t: unknown): string {
  if (typeof t === "string") return t;
  if (!t || typeof t !== "object") return "";
  const o = t as { tag?: string; role?: string | null; text?: string };
  const name = (o.role || o.tag || "").trim();
  return o.text ? `${name}[${o.text.slice(0, 30)}]` : name;
}

/** 执行一个动作：先看租约，写命令记录，在页面里执行（goto 走扩展），动作做完看租约还在不在。 */
export async function runAct(ctx: Ctx, tab: number, cmd: ActCmd): Promise<ActResult> {
  const ts = Date.now();
  const target = cmd.ref ?? cmd.url ?? cmd.key ?? "";
  const detail = { cmd: { ...cmd, text: undefined }, chars: typeof cmd.text === "string" ? cmd.text.length : undefined };
  if (!ctx.leases.use(tab)) {
    const humanIdleMs = ctx.leases.humanIdleMs(tab);
    const ref = ctx.ingest.beginCmd(tab, ts, cmd.kind, target, detail);
    ctx.ingest.endCmd(ref, { detail: { ok: false, rejected: "no-lease" } });
    return { ok: false, rejected: "no-lease", humanIdleMs };
  }
  const ref = ctx.ingest.beginCmd(tab, ts, cmd.kind, target, detail);
  try {
    let result: ActResult;
    if (cmd.kind === "goto") {
      await ctx.goto(tab, cmd.url!);
      result = { ok: true, navigated: true };
    } else {
      result = (await ctx.call(tab, `window.__tcr.exec.act(${JSON.stringify(cmd)})`, { timeoutMs: 30_000, onNavigate: "ok" })) as ActResult;
    }
    if (result.navigated) {
      const loaded = await ctx.waitLoaded(tab);
      if (loaded) { result.url = loaded.url; result.title = loaded.title; }
    }
    if (!ctx.leases.has(tab)) result.revokedDuring = true; // 动作执行期间，人动手了
    ctx.ingest.endCmd(ref, { target: describeTarget(result.target) || target, size: result.chars, detail: { ok: result.ok, error: result.error, rejected: result.rejected } });
    return { ...result, actSeq: ref.seq };
  } catch (error) {
    ctx.ingest.endCmd(ref, { detail: { ok: false, error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

async function actCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args, ["off"]);
  if ("error" in flags) return out.fail(flags.error);
  const t = intFlag(flags, "tab"); if (isError(t)) return out.fail(t.error);
  const rest = args.filter((a, i) => !(a === "--tab" || args[i - 1] === "--tab" || a.startsWith("--tab=")));
  const parsed = parseAct(rest);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  const tab = await pickTab(t as number | undefined, "lease", ctx, out); if (tab === undefined) return;
  const res = await runAct(ctx, tab, parsed.cmd);
  const cmdText = `${parsed.cmd.kind}${parsed.cmd.ref ? ` ${parsed.cmd.ref}` : ""}${parsed.cmd.key ? ` ${parsed.cmd.key}` : ""}${parsed.cmd.url ? ` ${parsed.cmd.url}` : ""}`;
  if (res.rejected === "no-lease") { out.code = 1; return out.line(`✗ ${cmdText}：没有租约。${res.humanIdleMs !== undefined && res.humanIdleMs < 60_000 ? `人 ${humanSince(res.humanIdleMs)}刚动过，租约被撤销了：先 tabbot log --tab ${tab} --src human 看人做了什么，再 tabbot takeover --tab ${tab}` : `先 tabbot takeover --tab ${tab}`}`); }
  if (res.ok === false) { out.code = 1; return out.line(`✗ ${cmdText}：${res.error ?? "失败"}`); }
  const lines = [`✓ ${cmdText}${res.settle ? (res.settle.settled ? `（页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s）` : "（等了很久页面还在变化，没有稳定）") : ""}`];
  if (res.navigated) lines.push(`页面已跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  else if (res.url) lines.push(`页面：${res.url} "${res.title ?? ""}"`);
  if (res.revokedDuring) lines.push(`⚠ 动作执行期间人动手了，租约已被撤销：先 tabbot log --tab ${tab} --src human 看人做了什么，再决定要不要重新 takeover`);
  // 这个动作引发的请求（页面的消息要一小会儿才到日志里）
  await new Promise((r) => setTimeout(r, 500));
  ctx.ingest.flush();
  if (res.actSeq !== undefined) {
    const caused = (await readEvents({ since: res.actSeq, tab, limit: 100 })).filter((r) => r.cause === res.actSeq);
    if (caused.length) lines.push(`引发了 ${caused.length} 个请求：\n${formatRows(caused.slice(0, 8))}${caused.length > 8 ? `\n…还有 ${caused.length - 8} 个（tabbot log --tab ${tab} --since ${res.actSeq}）` : ""}`);
  }
  out.line(lines.join("\n"));
}

// ---- 请求优先：找请求、看请求、重放请求 ----

async function reqCommand(args: string[], out: Output): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "find") {
    const flags = parseFlags(rest);
    if ("error" in flags) return out.fail(flags.error);
    const needle = flags.rest.join(" ");
    if (!needle) return out.fail('用法：tabbot req find "页面上看到的文字" [--n 20]');
    const n = intFlag(flags, "n"); if (isError(n)) return out.fail(n.error);
    const hits = await findInBodies(needle, { limit: (n as number | undefined) ?? 20 });
    if (hits.length === 0) return out.line(`没有响应体或页面里包含「${needle}」（只搜保留下来的响应体和页面 HTML）`);
    out.line(`${hits.length} 处有「${needle}」：（tabbot req show <编号> 看请求，tabbot replay <编号> 重放）`);
    for (const h of hits) out.line(`${formatEvent(h.row)}\n    …${h.snippet}…`);
    return;
  }
  if (sub === "show") {
    const seq = Number((rest[0] ?? "").replace(/^#/, ""));
    if (!Number.isInteger(seq)) return out.fail("用法：tabbot req show <编号>（编号来自 tabbot log 或 req find）");
    const row = await readEventBySeq(seq);
    if (!row) return out.fail(`找不到事件 #${seq}`);
    out.line(formatEvent(row));
    const t = templateFromRow(row);
    if ("error" in t) return out.line(`不能重放：${t.error}`);
    const u = new URL(row.url!.replace(/⟨[^⟩]*⟩/g, "x"));
    const lines = [`地址：${row.url}`];
    const headers = Object.entries(t.template.headers);
    if (headers.length) lines.push(`请求头：\n${headers.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
    if (t.template.body !== undefined) lines.push(`请求体：${t.template.body.length > 600 ? `${t.template.body.slice(0, 600)}…` : t.template.body}`);
    if (row.body) lines.push(`响应体文件：${row.body}（在 ~/.tabbot/journal/seg-<序号>/bodies 下，可以直接 rg）`);
    const params = [...u.searchParams.entries()].flatMap(([k, v]) => {
      try { const j = JSON.parse(v) as unknown; if (j && typeof j === "object" && !Array.isArray(j)) return Object.keys(j).map((x) => `${k}.${x}`); } catch { /* 不是 JSON */ }
      return [k];
    });
    lines.push(`重放：tabbot replay ${seq}${isSafeMethod(row.method!) ? "" : " --yes"} [--set 名字=值 ...]；可以改的查询参数：${params.length ? params.join(", ") : "（无）"}${t.template.body !== undefined ? "；请求体字段用 body.字段名=值" : ""}；请求头 header.名字=值`);
    lines.push("token 等秘密在日志里是别名或 [redacted]；--set 里可以直接写别名（holder 内存里有对照表，holder 重启后失效），你拿不到真值。");
    for (const w of t.warnings) lines.push(`⚠ ${w}`);
    return out.line(lines.join("\n"));
  }
  out.fail('用法：tabbot req find "页面上看到的文字" | req show <编号>');
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

type ReplayResult = { ok?: boolean; error?: string; rejected?: string; humanIdleMs?: number; tabId?: number; method?: string; status?: number; size?: number; ms?: number; truncated?: boolean; summary?: string; preview?: string; bodyFile?: string; replaySeq?: number; warnings?: string[] };

/**
 * 重放日志里的一个请求：原始内容（含 token 真值）在 holder 的内存里，这里应用 --set（值里可以写别名），
 * 挑一个能发的标签页，在页面里原样发出（带登录态），响应脱敏后记进日志。非 GET 要 yes 和租约。
 */
export async function runReplay(ctx: Ctx, params: { seq: number; sets: string[]; tabId?: number; yes: boolean }): Promise<ReplayResult> {
  const fail = (error: string): ReplayResult => ({ ok: false, error });
  const row = await readEventBySeq(params.seq);
  if (!row) return fail(`找不到事件 #${params.seq}（用 tabbot req find 找请求）`);
  const base = templateFromRow(row);
  if ("error" in base) return fail(base.error);
  let rid: string | undefined;
  try { rid = (JSON.parse(row.detail ?? "{}") as { rid?: string }).rid; } catch { /* 没有细节 */ }
  const raw = rid ? ctx.raw.get(row.tab, rid) : undefined;
  if (!raw) return fail(`#${row.seq} 的原始内容已经不在 holder 的内存里了（holder 重启过、太旧被清掉，或者不是页面里发的请求）。在页面上再触发一次这个操作，然后重试`);
  if (raw.body && UNREPLAYABLE_BODY.test(raw.body)) return fail("这个请求的请求体是文件、二进制或表单数据，没法重放");
  if (!isSafeMethod(raw.method) && !params.yes) return fail(`${raw.method} 请求可能有副作用（下单、提交、删除）：确认要重放请加 --yes，并且先问过用户`);
  let sets: string[];
  try { sets = params.sets.map((s) => ctx.ingest.sanitizer.resolve(s)); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const applied = applySets({ method: raw.method, url: raw.url, headers: replayHeaders(raw.headers), body: raw.body }, sets);
  if ("error" in applied) return fail(applied.error);
  const req = { ...applied.template, method: applied.template.method.toUpperCase() };
  const tabs = await ctx.tabs();
  let tabId = params.tabId;
  if (tabId === undefined) {
    tabId = pickReplayTab(tabs, req.url, raw.page);
    if (tabId === undefined) return fail(`没有能发这个请求的标签页（需要和 ${new URL(raw.page).origin} 同源的页面）：先 tabbot act goto 打开该页面，或用 --tab 指定`);
  } else if (!tabs.some((t) => t.tabId === tabId)) return fail(`tab${tabId} 不存在，或不是 http/https 页面`);
  if (!isSafeMethod(req.method) && !ctx.leases.use(tabId)) return { ok: false, rejected: "no-lease", humanIdleMs: ctx.leases.humanIdleMs(tabId), tabId };
  const ts = Date.now();
  const res = (await ctx.call(tabId, `window.__tcr.exec.replay(${JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null })})`, { timeoutMs: 40_000 })) as { ok?: boolean; error?: string; status?: number; ct?: string; size?: number; text?: string; truncated?: boolean; ms?: number };
  const setKeys = params.sets.map((x) => x.split("=")[0]!);
  if (res.ok === false) {
    ctx.ingest.recordReplay(tabId, ts, { method: req.method, rawUrl: req.url, replayOf: params.seq, setKeys, error: res.error });
    return { ok: false, error: res.error, tabId };
  }
  const rec = ctx.ingest.recordReplay(tabId, ts, { method: req.method, rawUrl: req.url, replayOf: params.seq, setKeys, status: res.status, ct: res.ct, size: res.size, text: res.text, ms: res.ms });
  return {
    ok: true, tabId, status: res.status, size: res.size, ms: res.ms, truncated: res.truncated === true, replaySeq: rec.seq, bodyFile: rec.bodyFile,
    method: req.method, summary: summarizeBody(rec.preview, res.ct ?? ""), preview: rec.preview.slice(0, 1500), warnings: base.warnings,
  };
}

async function replayCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const p = parseReplayArgs(args);
  if ("error" in p) return out.fail(p.error);
  await ctx.ensureExtension();
  const res = await runReplay(ctx, p);
  if (res.rejected === "no-lease") { out.code = 1; return out.line(`✗ 重放 #${p.seq}：非 GET 请求需要租约（和 act 一样）。${res.humanIdleMs !== undefined && res.humanIdleMs < 60_000 ? `人刚动过（${humanSince(res.humanIdleMs)}），先 tabbot log --tab ${res.tabId} --src human 看人做了什么，再 tabbot takeover --tab ${res.tabId}` : `先 tabbot takeover --tab ${res.tabId}`}`); }
  if (res.ok === false) { out.code = 1; return out.line(`✗ 重放 #${p.seq}：${res.error ?? "失败"}`); }
  const bad = (res.status ?? 0) >= 400;
  if (bad) out.code = 1;
  const kb = (res.size ?? 0) >= 1024 ? `${((res.size ?? 0) / 1024).toFixed(1)}KB` : `${res.size ?? 0}B`;
  const lines = [`${bad ? "✗" : "✓"} 重放 #${p.seq}${p.sets.length ? `（改了 ${p.sets.map((x) => x.split("=")[0]).join(", ")}）` : ""}：${res.method} → ${res.status}，${kb}，${res.ms}ms，在 tab${res.tabId} 里发出；${res.summary ?? ""}`];
  if (bad) lines.push(res.status === 401 || res.status === 403 ? "服务器拒绝了：登录态过期、需要签名，或这个请求依赖页面上一步的状态。改用 tabbot act 在页面上做。" : "服务器返回了错误，先看下面的响应内容再决定。");
  if (res.bodyFile) lines.push(`响应体文件：${res.bodyFile}（~/.tabbot/journal/seg-<序号>/bodies 下，可以直接 rg）`);
  if (res.truncated) lines.push("⚠ 响应超过 1MB，只取了前 1MB");
  for (const w of res.warnings ?? []) lines.push(`⚠ ${w}`);
  if (res.preview) lines.push(`响应（前 ${Math.min(res.preview.length, 1500)} 字符，已脱敏）：\n${res.preview}`);
  out.line(lines.join("\n"));
}
