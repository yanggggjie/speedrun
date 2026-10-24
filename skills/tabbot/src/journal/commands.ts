/**
 * 命令行的全部命令都在这里：tabbot <argv> 原样发给 holder，holder 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 第一行是结论；失败是 { status: "failure", error }，握手类失败是 { status: "need-*", guide }，退出码非零。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { USAGE, handshakeStatusFromError, formatErrorStdout, formatHandshakeStdout } from "../protocol.ts";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR, TASK_DIR } from "../utils/constants.ts";
import type { RunHost, Session } from "../run/host.ts";
import { generateTask } from "../run/generate.ts";
import type { TaskRunner } from "../run/runner.ts";
import { listTasks, parseCliParams, taskFile } from "../run/tasks.ts";
import type { RunWindow } from "../run/window.ts";
import { buildCatalog, buildContext, formatCatalog, normalizeSite } from "./digest.ts";
import { formatEvent } from "./format.ts";
import type { Ingestor } from "./ingest.ts";
import { findInBodies, formatRows, lastSeq, readEvents, readEventBySeq, runSql, status as journalStatus } from "./query.ts";
import type { RawStore } from "./raw.ts";
import { applySets, isSafeMethod, replayHeaders, UNREPLAYABLE_BODY } from "./replay-core.ts";
import { summarizeBody, templateFromRow } from "./replay.ts";
import { renderSnapshot, type Snapshot } from "./render.ts";
import type { EventRow, Src } from "./types.ts";

export type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; status: string; anchor?: boolean };

/** holder 提供给命令的能力。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  host: RunHost;
  runner: TaskRunner;
  win: RunWindow;
  /** 探索用的页面（tabbot open / snapshot / act 共用），在 tabbot run 窗口里。 */
  explore: Session;
  /** 重放请求临时用的页面，用完还回去。 */
  replaySession: Session;
  ingest: Ingestor;
  raw: RawStore;
  taskDir?: string;
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
      case "status": await statusCommand(ctx, out); break;
      case "open": await openCommand(args, ctx, out); break;
      case "snapshot": await snapshotCommand(args, ctx, out); break;
      case "text": await textCommand(args, ctx, out); break;
      case "act": await actCommand(args, ctx, out); break;
      case "close": await closeCommand(ctx, out); break;
      case "req": await reqCommand(args, out); break;
      case "replay": await replayCommand(args, ctx, out); break;
      case "task": await taskCommand(args, ctx, out); break;
      case "eval": await evalCommand(args, ctx, out); break;
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

/** 你自己（用户）的标签页；tabbot run 窗口里 agent 的页面不在这里。 */
async function tabsCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const tabs = (await ctx.tabs()).filter((t) => !t.anchor && !ctx.win.isRunTab(t.tabId));
  if (tabs.length === 0) return out.line("没有打开的 http/https 标签页。");
  out.line(`${tabs.length} 个标签页`);
  for (const t of tabs) out.line(`tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"} ${t.url} "${t.title}"`);
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

// ---- 探索：在 tabbot run 窗口里打开页面、看、操作。每一步都进日志，之后可以 tabbot task new 变成 task ----

async function openCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const url = args[0];
  if (!url) return out.fail("用法：tabbot open <网址>（在 tabbot run 窗口里打开，不打扰你的窗口）");
  await ctx.ensureExtension();
  const res = (await ctx.host.op(ctx.explore, "goto", { url })) as { url: string; title: string };
  out.line(`✓ 已在 tabbot run 窗口打开 ${res.url} "${res.title}"（tabbot snapshot 看元素，tabbot text 读文字）`);
}

async function closeCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.host.end(ctx.explore);
  out.line("✓ 已还回探索用的页面（窗口里的标签页留着给下次复用，空闲 5 分钟自动关）");
}

function requireExplore(ctx: Ctx): void {
  if (ctx.explore.tab === undefined) throw new Error("tabbot run 窗口里还没有打开页面：先 tabbot open <网址>");
}

async function snapshotCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args, ["full"]);
  if ("error" in flags) return out.fail(flags.error);
  await ctx.ensureExtension();
  requireExplore(ctx);
  const snap = (await ctx.host.op(ctx.explore, "snapshot", { full: flags.bools.has("full") })) as Snapshot;
  out.line(renderSnapshot(snap, ctx.explore.tab!));
}

/** 当前页面的可见文字（正文、评论），给“读内容”用；要点击或填写仍用 snapshot 取元素引用。 */
async function textCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const max = intFlag(flags, "max"); if (isError(max)) return out.fail(max.error);
  await ctx.ensureExtension();
  requireExplore(ctx);
  const limit = Math.max(1, Math.min((max as number | undefined) || 20_000, 200_000));
  const res = (await ctx.host.op(ctx.explore, "text", { max: limit })) as { url: string; title: string; total: number; text: string };
  const cut = res.total > res.text.length;
  out.line(`${res.url} "${res.title}"${cut ? `\n（只给前 ${res.text.length} 字，全文 ${res.total} 字；用 --max N 取更多）` : ""}\n\n${res.text}`);
}

export type ActCmd = { kind: string; ref?: string; loc?: unknown; text?: string; key?: string; dx?: number; dy?: number; to?: string; checked?: boolean };

const REF = /^@?e\d+$/;
const normRef = (r: string): string => (r.startsWith("@") ? r : `@${r}`);
/** 目标：元素引用 @e12（来自 snapshot），或持久定位——CSS 选择器，或 JSON 如 {"role":"button","name":"提交"}。 */
function targetOf(v: string | undefined): Partial<ActCmd> | { error: string } {
  if (!v) return { error: "需要目标：元素引用 @e12（先 tabbot snapshot），或 CSS 选择器，或 JSON 定位 {\"role\":\"button\",\"name\":\"提交\"}" };
  if (REF.test(v)) return { ref: normRef(v) };
  if (v.startsWith("{")) { try { return { loc: JSON.parse(v) as unknown }; } catch { return { error: `定位不是合法 JSON：${v}` }; } }
  return { loc: v };
}

/** 解析 act 的参数：click <目标> | fill <目标> "文字" | select <目标> "选项" | check <目标> [--off] | press <键> [目标] | scroll down|up [像素] [目标] | scroll top|bottom [目标]。 */
export function parseAct(args: string[]): { cmd: ActCmd } | { error: string } {
  const flags = parseFlags(args, ["off"]);
  if ("error" in flags) return { error: flags.error };
  const [kind, ...rest] = flags.rest;
  switch (kind) {
    case "click": { const t = targetOf(rest[0]); return isError(t) ? t : { cmd: { kind, ...t } }; }
    case "fill": case "select": {
      const t = targetOf(rest[0]); if (isError(t)) return t;
      if (rest[1] === undefined) return { error: `用法：tabbot act ${kind} <目标> "文字"` };
      return { cmd: { kind, ...t, text: rest.slice(1).join(" ") } };
    }
    case "check": { const t = targetOf(rest[0]); return isError(t) ? t : { cmd: { kind, ...t, checked: !flags.bools.has("off") } }; }
    case "press": {
      if (!rest[0]) return { error: "用法：tabbot act press Enter [目标]（组合键如 Ctrl+K、Cmd+A）" };
      if (rest[1] === undefined) return { cmd: { kind, key: rest[0] } };
      const t = targetOf(rest[1]); return isError(t) ? t : { cmd: { kind, key: rest[0], ...t } };
    }
    case "scroll": {
      const dirIdx = rest.findIndex((x) => ["down", "up", "top", "bottom"].includes(x));
      if (dirIdx < 0) return { error: "用法：tabbot act scroll down|up [像素] [目标] | scroll top|bottom [目标]" };
      const dir = rest[dirIdx]!;
      const after = rest.slice(dirIdx + 1);
      const amountArg = after[0] !== undefined && /^-?\d+(\.\d+)?$/.test(after[0]) ? after.shift() : undefined;
      const target = after[0] ? targetOf(after[0]) : {};
      if (isError(target)) return target;
      if (dir === "top" || dir === "bottom") return { cmd: { kind, to: dir, ...target } };
      const amount = amountArg === undefined ? 600 : Number(amountArg);
      return { cmd: { kind, dy: dir === "up" ? -amount : amount, ...target } };
    }
    default: return { error: "用法：tabbot act click|fill|select|check|press|scroll ...（目标：@e12、CSS、或 JSON 定位；网址用 tabbot open）" };
  }
}

async function actCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const parsed = parseAct(args);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  requireExplore(ctx);
  const res = (await ctx.host.op(ctx.explore, "act", parsed.cmd)) as { navigated?: boolean; url?: string; title?: string; loc?: unknown; settle?: { settled: boolean; waitedMs: number } };
  const lines = [`✓ ${parsed.cmd.kind}${res.loc ? ` ${JSON.stringify(res.loc)}` : ""}${res.settle ? (res.settle.settled ? `（页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s）` : "（等了很久页面还在变化，没有稳定）") : ""}`];
  if (res.navigated) lines.push(`页面已跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  else if (res.url) lines.push(`页面：${res.url} "${res.title ?? ""}"`);
  out.line(lines.join("\n"));
}

// ---- task：做过的事变成知识 ----

/** tabbot task 列出；tabbot task <名字> [--参数 值] 运行；tabbot task new <名字> [--since 编号] 从探索记录生成草稿。 */
async function taskCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const dir = ctx.taskDir ?? TASK_DIR;
  const [name, ...rest] = args;
  if (!name) {
    const tasks = listTasks(dir);
    if (tasks.length === 0) return out.line("还没有 task。先用 tabbot context / api 看用户做过什么，没有就 tabbot open 探索，再 tabbot task new 把做过的事变成 task。");
    return out.line(JSON.stringify(tasks, null, 2));
  }
  if (name === "new") return taskNew(rest, ctx, dir, out);
  const parsed = parseCliParams(rest);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  const outcome = await ctx.runner.runTask(name, parsed.params);
  if (outcome.status !== "success") out.code = 1;
  out.line(JSON.stringify(outcome, null, 2));
}

async function taskNew(args: string[], ctx: Ctx, dir: string, out: Output): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const name = flags.rest[0];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return out.fail("用法：tabbot task new <名字，小写字母数字和 -> [--since 日志编号] [--summary 一句话]（编号来自 tabbot log --src agent）");
  const since = intFlag(flags, "since"); if (isError(since)) return out.fail(since.error);
  ctx.ingest.flush();
  const start = (since as number | undefined) ?? Math.max(0, (await lastSeq()) - 400);
  const rows = (await readEvents({ since: start, src: "agent", all: true, limit: 2000 })).filter((r) => r.kind === "cmd" || (r.kind === "net" && r.verb === "replay"));
  const gen = generateTask(name, rows, flags.values.get("summary") ?? "");
  if (gen.steps === 0) return out.fail("这个范围里没有 agent 做过的步骤（tabbot log --src agent 看看；--since 指定起点）");
  const file = taskFile(dir, name);
  if (fs.existsSync(file)) return out.fail(`task 已存在：${file}（换个名字，或先删掉）`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, gen.code, "utf8");
  out.line(`✓ 已生成草稿 ${file}（${gen.steps} 步，@status: draft）`);
  out.line(`还要补：${["@summary 与 @param", "把变化的值换成 tabbot.params.xxx", "返回用户要的结果并检查成功条件", ...gen.todo].join("；")}`);
  out.line(`补完后 tabbot task ${name} --参数 值 跑一遍，成功再把 @status 改成 verified。`);
}

/** tabbot eval '<代码>'：顺序组合 task，也可以直接用 SDK；return 的值是 result。 */
async function evalCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const code = args.join(" ").trim();
  if (!code) return out.fail("用法：tabbot eval 'const r = await task(\"名字\", { 参数: 值 }); return r;'");
  await ctx.ensureExtension();
  const outcome = await ctx.runner.runEval(code);
  if (outcome.status !== "success") out.code = 1;
  out.line(JSON.stringify(outcome, null, 2));
}

async function statusCommand(ctx: Ctx, out: Output): Promise<void> {
  const st = await journalStatus();
  const mb = (st.bytes / 1024 / 1024).toFixed(1);
  out.line(`录制：${st.segments} 段 ${st.events} 条事件，占用 ${mb}MB / ${Math.round(JOURNAL_CAP_BYTES / 1024 / 1024)}MB`);
  const d = ctx.daemon();
  out.line(`daemon：在运行 pid=${d.pid}，扩展${d.extension ? "已连接" : "未连接"}`);
  out.line(`目录：${JOURNAL_DIR.replace(os.homedir(), "~")}（每段 seg-<序号>/：events.db、bodies/、snapshots/）`);
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

/** 解析 replay 的参数：<编号> [--set k=v]... [--yes]。--set 可以重复。 */
export function parseReplayArgs(args: string[]): { seq: number; sets: string[]; yes: boolean } | { error: string } {
  const sets: string[] = [];
  let seq: number | undefined, yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes") yes = true;
    else if (a === "--set") { const v = args[++i]; if (v === undefined) return { error: "--set 缺少值（写成 名字=值）" }; sets.push(v); }
    else if (a.startsWith("--set=")) sets.push(a.slice(6));
    else if (a.startsWith("--")) return { error: `不认识的参数 ${a}` };
    else if (seq === undefined) { const n = Number(a.replace(/^#/, "")); if (!Number.isInteger(n)) return { error: `请求编号要是整数（来自 tabbot log 或 req find），收到：${a}` }; seq = n; }
    else return { error: `多余的参数：${a}` };
  }
  if (seq === undefined) return { error: "用法：tabbot replay <编号> [--set 名字=值 ...] [--yes]" };
  return { seq, sets, yes };
}

type ReplayResult = { ok?: boolean; error?: string; method?: string; status?: number; size?: number; ms?: number; truncated?: boolean; summary?: string; preview?: string; bodyFile?: string; replaySeq?: number; warnings?: string[] };

/**
 * 重放日志里的一个请求：原始内容（含 token 真值）在 holder 的内存里，这里应用 --set（值里可以写别名），
 * 在 tabbot run 窗口里和原来同一个 origin 的页面里原样发出（带登录态），响应脱敏后记进日志。非 GET 要 --yes。
 */
export async function runReplay(ctx: Ctx, params: { seq: number; sets: string[]; yes: boolean }): Promise<ReplayResult> {
  const fail = (error: string): ReplayResult => ({ ok: false, error });
  const row = await readEventBySeq(params.seq);
  if (!row) return fail(`找不到事件 #${params.seq}（用 tabbot req find 找请求）`);
  const base = templateFromRow(row);
  if ("error" in base) return fail(base.error);
  let rid: string | undefined;
  try { rid = (JSON.parse(row.detail ?? "{}") as { rid?: string }).rid; } catch { /* 没有细节 */ }
  const raw = rid ? ctx.raw.get(row.tab, rid) : undefined;
  if (!raw) return fail(`#${row.seq} 的原始内容已经不在 holder 的内存里了（holder 重启过、太旧被清掉，或者不是页面里发的请求）。在页面上再触发一次这个操作（tabbot open 打开页面再 act，或用户自己做一次），然后重试`);
  if (raw.body && UNREPLAYABLE_BODY.test(raw.body)) return fail("这个请求的请求体是文件、二进制或表单数据，没法重放");
  if (!isSafeMethod(raw.method) && !params.yes) return fail(`${raw.method} 请求可能有副作用（下单、提交、删除）：确认要重放请加 --yes，并且先问过用户`);
  let sets: string[];
  try { sets = params.sets.map((s) => ctx.ingest.sanitizer.resolve(s)); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const applied = applySets({ method: raw.method, url: raw.url, headers: replayHeaders(raw.headers), body: raw.body }, sets);
  if ("error" in applied) return fail(applied.error);
  const req = { ...applied.template, method: applied.template.method.toUpperCase() };
  const tab = await ctx.host.bind(ctx.replaySession, new URL(raw.page).origin);
  const ts = Date.now();
  try {
    const res = (await ctx.host.callTab(tab, "replay", [{ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null }])) as { ok?: boolean; error?: string; status?: number; ct?: string; size?: number; text?: string; truncated?: boolean; ms?: number };
    const setKeys = params.sets.map((x) => x.split("=")[0]!);
    if (res.ok === false) {
      ctx.ingest.recordReplay(tab, ts, { method: req.method, rawUrl: req.url, replayOf: params.seq, setKeys, error: res.error });
      return { ok: false, error: res.error };
    }
    const rec = ctx.ingest.recordReplay(tab, ts, { method: req.method, rawUrl: req.url, replayOf: params.seq, setKeys, status: res.status, ct: res.ct, size: res.size, text: res.text, ms: res.ms, reqBody: req.body ?? undefined });
    return {
      ok: true, status: res.status, size: res.size, ms: res.ms, truncated: res.truncated === true, replaySeq: rec.seq, bodyFile: rec.bodyFile,
      method: req.method, summary: summarizeBody(rec.preview, res.ct ?? ""), preview: rec.preview.slice(0, 1500), warnings: base.warnings,
    };
  } finally {
    await ctx.host.end(ctx.replaySession);
  }
}

async function replayCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const p = parseReplayArgs(args);
  if ("error" in p) return out.fail(p.error);
  await ctx.ensureExtension();
  const res = await runReplay(ctx, p);
  if (res.ok === false) { out.code = 1; return out.line(`✗ 重放 #${p.seq}：${res.error ?? "失败"}`); }
  const bad = (res.status ?? 0) >= 400;
  if (bad) out.code = 1;
  const kb = (res.size ?? 0) >= 1024 ? `${((res.size ?? 0) / 1024).toFixed(1)}KB` : `${res.size ?? 0}B`;
  const lines = [`${bad ? "✗" : "✓"} 重放 #${p.seq}${p.sets.length ? `（改了 ${p.sets.map((x) => x.split("=")[0]).join(", ")}）` : ""}：${res.method} → ${res.status}，${kb}，${res.ms}ms；${res.summary ?? ""}`];
  if (bad) lines.push(res.status === 401 || res.status === 403 ? "服务器拒绝了：登录态过期、需要签名，或这个请求依赖页面上一步的状态。改用 tabbot open + act 在页面上做。" : "服务器返回了错误，先看下面的响应内容再决定。");
  if (res.bodyFile) lines.push(`响应体文件：${res.bodyFile}（~/.tabbot/journal/seg-<序号>/bodies 下，可以直接 rg）`);
  if (res.truncated) lines.push("⚠ 响应超过 1MB，只取了前 1MB");
  for (const w of res.warnings ?? []) lines.push(`⚠ ${w}`);
  if (res.preview) lines.push(`响应（前 ${Math.min(res.preview.length, 1500)} 字符，已脱敏）：\n${res.preview}`);
  out.line(lines.join("\n"));
}

