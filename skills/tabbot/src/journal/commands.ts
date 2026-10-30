/**
 * 命令行的全部命令都在这里：tabbot <argv> 原样发给 holder，holder 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 第一行是结论；失败是 { status: "failure", error }，握手类失败是 { status: "need-*", guide }，退出码非零。
 *
 * 只保留必须由 TabBot 做的事：控制浏览器（run / compose / learn / debug）、持有不能落盘的原始请求（debug replay）、运维。
 * 读日志不是命令：日志是 <sitesDir>/<站点>/ 下的文件（timeline.<窗口>.jsonl、请求文件、endpoints.json），用 rg / node / Python 读，见 SKILL.md。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { USAGE, handshakeStatusFromError, formatErrorStdout, formatHandshakeStdout } from "../protocol.ts";
import { COMPOSE_DIR, LOG_LIMITS, MB } from "../utils/constants.ts";
import { DEBUG_MAX_OPS, type DebugWindow, type DebugWindows } from "../run/debug-windows.ts";
import { Session, type RunHost } from "../run/host.ts";
import { makeLearnGuide } from "../run/learn-guide.ts";
import type { TaskRunner } from "../run/runner.ts";
import { blockTask, draftTasks, findTask, parseCliParams, saveCompose, taskSummary, tasksDirOf } from "../run/tasks.ts";
import type { AgentWindows } from "../run/window.ts";
import { normalizeSite } from "./digest.ts";
import type { EndpointIndex } from "./endpoints.ts";
import { causedRequests, describeRequest, stepLine } from "./explore.ts";
import { OTHER_SITE, type Ingestor } from "./ingest.ts";
import { exportMaterial } from "./material.ts";
import type { RawStore } from "./raw.ts";
import { applySets, isSafeMethod, replayHeaders, UNREPLAYABLE_BODY } from "./replay-core.ts";
import { summarizeBody, templateFromRequestFile } from "./replay.ts";
import type { SiteLog } from "./sitelog.ts";
import type { Row } from "./types.ts";
import { siteOfUrl } from "../utils/url.ts";

export type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; status: string; anchor?: boolean };

/** holder 提供给命令的能力。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  host: RunHost;
  runner: TaskRunner;
  win: AgentWindows;
  debugWindows: DebugWindows;
  /** 调试用的页面，按学习会话（debug 窗口）号各一个，每个会话有自己的 agent 窗口。 */
  sessions: Map<string, Session>;
  ingest: Ingestor;
  raw: RawStore;
  /** 站点日志；log.dir 就是 sites 目录（task 也在它下面）。 */
  log: SiteLog;
  index: EndpointIndex;
  daemon(): { extension: boolean; pid: number };
  /** 成功的 compose 存在这里（不给就是 ~/.tabbot/compose）。 */
  composeDir?: string;
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
    if (arg === "-n") { const v = args[++i]; if (v === undefined) return { error: "-n 缺少值" }; values.set("n", v); continue; }
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

/** 已经没有的命令：日志和 task 现在是文件，给出去哪里读，免得 agent 按老习惯一直试。 */
/** 动作在新标签页里打开了页面时，最多等这么久收集新页面的请求。 */
const NEW_TAB_WAIT_MS = 5_000;
/** 打开起点后等这么久再收集加载期的请求。 */
const LOAD_SETTLE_MS = 1_500;

const REMOVED = new Set(["log", "sql", "req", "context", "api", "task", "replay", "open", "snapshot", "act", "delegate"]);

/** 执行一条命令。argv 是 `tabbot` 后面的全部参数。 */
export async function runCommand(argv: string[], ctx: Ctx): Promise<{ stdout: string; code: number }> {
  const out = new Output();
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "tabs": await tabsCommand(ctx, out); break;
      case "status": await statusCommand(ctx, out); break;
      case "run": await runTaskCommand(args, ctx, out); break;
      case "compose": await composeCommand(args, ctx, out); break;
      case "learn": await learnCommand(args, ctx, out); break;
      case "debug": await debugCommand(args, ctx, out); break;
      default:
        if (cmd === "delegate") out.fail("tabbot delegate 已经没有了：没有 subagent，学会一个请求由你自己做：tabbot learn <task 名> --site <站点> --endpoint \"方法 接口名\"（或 --find \"要的数据或动作\"），格式见 SKILL.md。");
        else if (cmd && REMOVED.has(cmd)) out.fail(`tabbot ${cmd} 已经没有了：日志和 task 是文件，在 ${ctx.log.dir}/<站点>/ 下（endpoints.json 是接口清单，log/<段>/timeline.<窗口>.jsonl 是时间线，tasks/ 是 task），用 rg / node / Python 读，格式见 SKILL.md。调试在学习会话里做：tabbot learn …。`);
        else out.fail(USAGE);
    }
  } catch (error) {
    const status = handshakeStatusFromError(error);
    if (status) out.handshake(formatHandshakeStdout(status));
    else out.fail(error instanceof Error ? error.message : String(error));
  }
  return out.result();
}

// ---- 观察 ----

/** 你自己（用户）的标签页；tabbot agent 窗口里 agent 的页面不在这里。 */
async function tabsCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const tabs = (await ctx.tabs()).filter((t) => !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (tabs.length === 0) return out.line("没有打开的 http/https 标签页。");
  out.line(`${tabs.length} 个标签页`);
  for (const t of tabs) out.line(`tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"} ${t.url} "${t.title}"`);
}

async function statusCommand(ctx: Ctx, out: Output): Promise<void> {
  const u = ctx.log.usage();
  const mb = (n: number): string => (n / MB).toFixed(1);
  out.line(`录制：${Object.keys(u.sites).length} 个站点，轻量层（时间线、请求文件）${mb(u.light)}MB / ${LOG_LIMITS.totalLight / MB}MB，重量层（响应体、文档、快照）${mb(u.heavy)}MB / ${LOG_LIMITS.totalHeavy / MB}MB，最新编号 #${ctx.log.lastSeq()}`);
  const d = ctx.daemon();
  out.line(`daemon：在运行 pid=${d.pid}，扩展${d.extension ? "已连接" : "未连接"}`);
  const dbg = ctx.debugWindows.active();
  out.line(dbg.length ? `学习会话：${dbg.map((w) => `${w.id}（${w.site}，${w.task}，${w.ops}/${DEBUG_MAX_OPS}）`).join("；")}` : "学习会话：无");
  const drafts = draftTasks(ctx.log.dir).filter((t) => !dbg.some((w) => w.task === t.name));
  if (drafts.length) out.line(`没完成的草稿 task（@status: draft）：${drafts.map((t) => `${t.name}（${t.site}）`).join("、")}；用 tabbot learn <名字> --site <站点> --fix 续`);
  out.line(`目录：${ctx.log.dir}（每个站点：endpoints.json、tasks/、log/<段>/）`);
}

// ---- 调试（学习会话里）：在会话自己的 agent 窗口里打开页面、看、操作。每一步都进日志 ----

/** 收回一个 debug 窗口（交付、放弃、超时）：登记、页面状态、浏览器窗口、工作区（含交接材料）一起清掉；它留下的日志是历史，不删。 */
export async function releaseDebugWindow(ctx: Pick<Ctx, "debugWindows" | "sessions" | "win" | "log">, id: string): Promise<void> {
  const w = ctx.debugWindows.finish(id);
  ctx.sessions.delete(id);
  await ctx.win.dispose(id);
  if (w) fs.rmSync(path.join(ctx.log.siteDir(w.site), "debug", id), { recursive: true, force: true });
}

/** 取出 `--window <号>`（也认 `--window=<号>`），其余参数原样返回。 */
function takeWindowFlag(args: string[]): { windowId: string | undefined; rest: string[] } {
  let windowId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--window") windowId = args[++i];
    else if (a.startsWith("--window=")) windowId = a.slice(9);
    else rest.push(a);
  }
  return { windowId, rest };
}

/** 取出 `--description "…"`（也认 `--description=…`），其余参数原样返回。 */
export function takeDescription(args: string[]): { description: string | undefined; rest: string[] } {
  let description: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--description") description = args[++i];
    else if (a.startsWith("--description=")) description = a.slice(14);
    else rest.push(a);
  }
  return { description: description?.trim() || undefined, rest };
}

/** 关键命令都要带 --description：一句话用用户的话说这一步要做什么。TabBot 把它存进时间线和 endpoints.json，当成接口的业务含义。 */
export const DESCRIPTION_HINT = '要带 --description "一句话，用用户的话说这一步要做什么"（业务含义，如"点开变更单里的 MR"，不是"click 410 421"）；它会存下来，成为这个接口、task、组合的业务知识';
const NEEDS_DESCRIPTION = new Set(["open", "click", "type", "key", "scroll", "replay"]);

/** debug 子命令的入口：只能在学习会话里（开着一个会话可以不写 --window；run 窗口不能调试）。 */
async function debugCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const { windowId, rest } = takeWindowFlag(args);
  const w = ctx.debugWindows.use(windowId);
  if ("error" in w) return out.fail(w.error);
  const [sub, ...subArgs0] = rest;
  const { description, rest: subArgs } = takeDescription(subArgs0);
  let sess = ctx.sessions.get(w.id);
  if (!sess) { sess = new Session(w.id); ctx.sessions.set(w.id, sess); }
  out.line(`[调试] 学习会话 ${w.id}（${w.ops}/${DEBUG_MAX_OPS}），站点 ${w.site}，目标 task：${w.task}`);
  if (sub && NEEDS_DESCRIPTION.has(sub) && !description) { w.ops--; return out.fail(`debug ${sub} ${DESCRIPTION_HINT}`); }
  if (sub === "open" || sub === "click" || sub === "type" || sub === "key" || sub === "scroll") {
    const locked = lockReason(ctx, w);
    if (locked) { w.ops--; return out.fail(locked); } // 被拒绝的动作不占操作次数
  }
  switch (sub) {
    case "open": return openCommand(subArgs, ctx, out, sess, description!);
    case "screenshot": return screenshotCommand(ctx, out, sess, w);
    case "click": case "type": case "key": case "scroll": return pointerCommand(sub, subArgs, ctx, out, sess, w, description!);
    case "replay": return replayCommand(subArgs, ctx, out, w, description!);
    case "close": return closeCommand(subArgs, ctx, out, w);
    default: return out.fail("用法：tabbot debug --window <窗口号> open|screenshot|click|type|key|scroll|replay|close ...");
  }
}

/** debug close --blocked "原因和证据"：试过、确认学不会。task 标成 blocked（@note 写原因），发回执，会话收回。没有 --blocked 不让关：会话要么 run 通过，要么留下学不会的记录。 */
async function closeCommand(args: string[], ctx: Ctx, out: Output, w: DebugWindow): Promise<void> {
  const flags = parseFlags(args);
  if ("error" in flags) return out.fail(flags.error);
  const reason = flags.values.get("blocked")?.trim();
  if (!reason) return out.fail(`会话只能以两种方式结束：task 跑通（tabbot run ${w.task} --window ${w.id}），或确认学不会：tabbot debug close --blocked "原因和证据"（试过哪些请求编号、做过几次动作、为什么 network 和 DOM 都不行）`);
  const file = path.join(tasksDirOf(ctx.log.dir, w.site), `${w.task}.js`);
  blockTask(file, reason);
  const receipt = issueReceipt(ctx, { mode: "学不会", task: w.task, status: "blocked", window: w.id });
  await releaseDebugWindow(ctx, w.id);
  out.line(JSON.stringify({ mode: "学不会", receipt, status: "blocked", task: w.task, file, note: reason }, null, 2));
  out.line("学习会话已收回（工作区已删除）。这件事已经确认学不会：最终回复里说明卡在哪、做过什么（尤其真发过的写操作）。");
}

async function openCommand(args: string[], ctx: Ctx, out: Output, sess: Session, description: string): Promise<void> {
  const url = args[0];
  if (!url) return out.fail("用法：tabbot debug --window <窗口号> open <网址>（在你自己的 agent 窗口里打开，不打扰用户）");
  await ctx.ensureExtension();
  const res = (await ctx.host.op(sess, "goto", { url, description })) as { url: string; title: string };
  out.line(`✓ 已在 agent 窗口打开 ${res.url} "${res.title}"（debug screenshot 截图看页面）`);
}

function requireExplore(sess: Session): void {
  if (sess.tab === undefined) throw new Error("agent 窗口里还没有打开页面：先 tabbot debug --window <窗口号> open <网址>");
}

/** 截图：存成文件，agent 用读图片的方式看它。图上的坐标就是 click / scroll 要的坐标。 */
async function screenshotCommand(ctx: Ctx, out: Output, sess: Session, w: DebugWindow): Promise<void> {
  await ctx.ensureExtension();
  requireExplore(sess);
  const shot = (await ctx.host.op(sess, "screenshot", {})) as { data: string; mime: string; w: number; h: number };
  const dir = path.join(ctx.log.siteDir(w.site), "debug", w.id, "shots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(fs.readdirSync(dir).length + 1).padStart(3, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"), { mode: 0o600 });
  out.line(`✓ 截图 ${file}（${shot.w}×${shot.h}，用读图片的方式看它）。图上的像素坐标就是 click / scroll 的坐标，左上角 (0,0)；截图只是此刻的画面，页面变了要重新截。`);
}

export type PointerCmd = { kind: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; to?: string };

const NUM = /^-?\d+(\.\d+)?$/;

/** 解析按坐标的操作：click <x> <y> | type "文字" | key <键> | scroll down|up [像素] [x y] | scroll top|bottom [x y]。 */
export function parsePointer(kind: string, args: string[]): { cmd: PointerCmd } | { error: string } {
  switch (kind) {
    case "click": {
      if (args.length !== 2 || !args.every((a) => NUM.test(a))) return { error: "用法：tabbot debug click <x> <y>（坐标取自截图，像素，左上角 (0,0)）" };
      return { cmd: { kind, x: Number(args[0]), y: Number(args[1]) } };
    }
    case "type": {
      if (!args.length) return { error: "用法：tabbot debug type \"文字\"（输入到当前获得焦点的输入框，先 click 输入框）" };
      return { cmd: { kind, text: args.join(" ") } };
    }
    case "key": {
      if (!args[0]) return { error: "用法：tabbot debug key Enter（组合键如 Ctrl+K、Cmd+A，作用在当前获得焦点的元素上）" };
      return { cmd: { kind, key: args[0] } };
    }
    case "scroll": {
      const dir = args[0];
      if (!dir || !["down", "up", "top", "bottom"].includes(dir)) return { error: "用法：tabbot debug scroll down|up [像素] [x y] | scroll top|bottom [x y]（给了 x y 就滚动那个位置所在的可滚动区域，否则滚整页）" };
      const rest = args.slice(1);
      const amount = (dir === "down" || dir === "up") && rest[0] !== undefined && rest.length !== 2 && NUM.test(rest[0]) ? Number(rest.shift()) : 600;
      if (rest.length !== 0 && !(rest.length === 2 && rest.every((a) => NUM.test(a)))) return { error: "滚动的位置要写成 x y 两个数" };
      const at = rest.length === 2 ? { x: Number(rest[0]), y: Number(rest[1]) } : {};
      if (dir === "top" || dir === "bottom") return { cmd: { kind, to: dir, ...at } };
      return { cmd: { kind, dy: dir === "up" ? -amount : amount, ...at } };
    }
    default: return { error: "用法：tabbot debug --window <窗口号> open|screenshot|click|type|key|scroll|replay|close ..." };
  }
}

async function pointerCommand(kind: string, args: string[], ctx: Ctx, out: Output, sess: Session, w: DebugWindow, description: string): Promise<void> {
  const parsed = parsePointer(kind, args);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  requireExplore(sess);
  ctx.ingest.flush();
  const before = ctx.log.lastSeq();
  const winId = ctx.win.windowIdOf?.(w.id);
  const tabsBefore = winId === undefined ? undefined : new Set((await ctx.tabs()).filter((t) => t.windowId === winId).map((t) => t.tabId));
  const res = (await ctx.host.op(sess, "pointer", { ...parsed.cmd, settle: true, description })) as { navigated?: boolean; url?: string; title?: string; loc?: unknown; scrollY?: number; settle?: { settled: boolean; waitedMs: number } };
  const lines = [`✓ ${kind}${res.loc ? ` 元素的持久定位（写 task 用这个）${JSON.stringify(res.loc)}` : ""}${res.scrollY !== undefined ? `，滚动位置 ${res.scrollY}` : ""}${res.settle ? (res.settle.settled ? `（页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s）` : "（等了很久页面还在变化，没有稳定）") : ""}`];
  if (res.navigated) lines.push(`页面已跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  else if (res.url) lines.push(`页面：${res.url} "${res.title ?? ""}"`);
  lines.push("看效果要重新 debug screenshot。");
  // 这一步引发的请求（含 GET，写明有没有响应体）：有请求就转去学请求，并锁定后续动作，直到 task 草稿被更新
  await new Promise((r) => setTimeout(r, 100));
  ctx.ingest.flush();
  // 点开了新标签页（target=_blank）：新页面要加载一会儿，等它的请求到了再列（最多几秒，请求停了就不等）
  if (tabsBefore && (await ctx.tabs()).some((t) => t.windowId === winId && !tabsBefore.has(t.tabId))) {
    lines.push("这一步在新标签页里打开了页面。");
    let last = -1;
    for (const t0 = Date.now(); Date.now() - t0 < NEW_TAB_WAIT_MS;) {
      await new Promise((r) => setTimeout(r, 400));
      ctx.ingest.flush();
      const now = ctx.log.lastSeq();
      if (now === last && ctx.ingest.sitesSince(w.id, before).some((x) => x !== w.site && x !== OTHER_SITE)) break;
      last = now;
    }
  }
  const step = stepLine(parsed.cmd, res.loc);
  if (step) lines.push(`可贴进 task：${step}`);
  // 页面跳到了别的站点（或在新标签页打开了别的站点）：请求记在那个站点下，也要列出来（跨站点的关系就是在这一刻发现的）
  const landed = res.url ? normalizeSite(siteOfUrl(res.url)) : "";
  const others = [...new Set([...(landed && landed !== w.site ? [landed] : []), ...ctx.ingest.sitesSince(w.id, before).filter((s) => s !== w.site && s !== OTHER_SITE)])];
  for (const o of others) lines.push(`页面跳到了 ${o}（另一个站点），这一步的请求记在那边：${ctx.log.logDir(o)}/`);
  const parts = [listCaused(ctx, w.site, w.id, before, description), ...others.map((o) => listCaused(ctx, o, w.id, before, description))];
  const caused = parts.flatMap((p) => p.rows);
  if (caused.length) {
    const shown = parts.flatMap((p) => p.lines);
    lines.push(`这一步引发了请求${caused.length > shown.length ? `（共 ${caused.length} 个，列最近 ${shown.length} 个）` : ""}：\n  ${shown.map((s) => s.line).join("\n  ")}`);
    lines.push(shown.some((s) => !s.readable)
      ? "有请求读不了响应体（流式、二进制或没存）：network 这条路可能走不通，先 debug replay 试一下；不行就把这一步写成 DOM 步骤。"
      : `有请求就改用请求：读请求文件，用 tabbot debug --window ${w.id} replay <编号> 试，再写进 task。`);
    w.lock = { t: Date.now(), seqs: caused.map((r) => r.seq) };
    lines.push(`已锁定：先更新 task 草稿 ${path.join(tasksDirOf(ctx.log.dir, w.site), `${w.task}.js`)}，才能继续 open / click / type / key / scroll（screenshot 和 replay 不受限）。`);
  }
  out.line(lines.join("\n"));
}

/** 这个会话窗口在 before 之后、在 site 下引发的请求，以及最近 5 个的一行描述（带接口以前的 description，不含这一步刚写的 current）。 */
function listCaused(ctx: Ctx, site: string, win: string, before: number, current?: string): { rows: Row[]; lines: { line: string; readable: boolean }[] } {
  const stats = new Map(ctx.index.snapshot(site).endpoints.map((e) => [e.key, e]));
  const rows = causedRequests(ctx.log.readRows(site, { wins: [win], sinceSeq: before, limit: 200 }), stats);
  const lines = rows.slice(-5).map((r) => describeRequest(r, ctx.log.readRequestFile(site, r.seq)?.file, ctx.log.findRequestFile(site, r.seq)?.abs, r.endpoint ? stats.get(r.endpoint)?.descriptions?.find((d) => d.text !== current)?.text : undefined));
  return { rows, lines };
}

/** 引发请求后的锁定：task 草稿在锁定之后被改过才解锁。草稿还没写过也算没改。返回拒绝的原因，没锁返回 undefined。 */
export function lockReason(ctx: Pick<Ctx, "log">, w: DebugWindow): string | undefined {
  if (!w.lock) return undefined;
  const file = path.join(tasksDirOf(ctx.log.dir, w.site), `${w.task}.js`);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* 草稿还没写 */ }
  if (mtime > w.lock.t) { w.lock = undefined; return undefined; }
  return `已锁定：上一步引发了请求（${w.lock.seqs.slice(-5).map((s) => `#${s}`).join("、")}），先把它写进 task 草稿 ${file}，再继续动作。有请求就改用请求：读请求文件，tabbot debug replay <编号> 试；读不了响应体就写 DOM 步骤；确实不用它，也在草稿里写一行说明。改了这个文件就解锁；screenshot 和 replay 不受限。`;
}

// ---- task：学会的做法 ----

/** tabbot run <task> [--参数 值] [--dry] [--window 窗口号]：执行。用户拿到的结果必须来自这里。不带 --window 在 run 窗口里跑。 */
async function runTaskCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const { description, rest: args1 } = takeDescription(args);
  const [name, ...rest0] = args1;
  if (!name) return out.fail(`用法：tabbot run <task 名> --description "…" [--参数 值 ...] [--dry]（task 在 ${ctx.log.dir}/<站点>/tasks/ 下，ls 看有哪些）`);
  if (!description) return out.fail(`tabbot run ${DESCRIPTION_HINT}`);
  let dry = false;
  const rest: string[] = [];
  const { windowId, rest: rest1 } = takeWindowFlag(rest0);
  for (const a of rest1) { if (a === "--dry") dry = true; else rest.push(a); }
  const parsed = parseCliParams(rest);
  if ("error" in parsed) return out.fail(parsed.error);
  const dbg = windowId ? ctx.debugWindows.get(windowId) : undefined;
  if (windowId && !dbg) return out.fail(`${windowId} 不是 debug 窗口，或已失效（holder 重启过？）`);
  if (dbg?.done) return out.fail(`debug 窗口 ${dbg.id} 已经收回，不能再跑`);
  if (dbg) dbg.lastActive = Date.now();
  await ctx.ensureExtension();
  const outcome = await ctx.runner.runTask(name, parsed.params, undefined, { key: dbg?.id, dry });
  if (outcome.status !== "success") out.code = 1;
  // 真跑成功：这句话记成 task 覆盖的接口的业务含义
  if (outcome.status === "success" && !dry) {
    const found = findTask(ctx.log.dir, name);
    if (found) for (const ep of taskSummary(found.file).endpoints) ctx.index.describe(found.site, ep, { text: description, from: "run" });
  }
  // 学习会话里把它绑定的那份 task 真跑通了：会话收回
  if (dbg && outcome.status === "success" && !dry && name === dbg.task) await releaseDebugWindow(ctx, dbg.id);
  const receipt = issueReceipt(ctx, { mode: dry ? "试运行" : "执行", task: name, status: outcome.status, ...(dbg ? { window: dbg.id } : {}) });
  out.line(JSON.stringify({ mode: dry ? "试运行" : "执行", receipt, ...outcome }, null, 2));
}

/** 回执：每次 run / compose 发一个，写进 sites/.receipts.jsonl。最终回复要引用本轮 run 的回执，证明结果来自 task（hooks/stop-receipt.mjs 检查）。 */
function issueReceipt(ctx: Pick<Ctx, "log">, info: { mode: string; task: string; status: string; window?: string }): string {
  const id = `RC-${randomBytes(4).toString("hex")}`;
  try { fs.appendFileSync(path.join(ctx.log.dir, ".receipts.jsonl"), `${JSON.stringify({ receipt: id, t: Date.now(), ...info })}\n`, { mode: 0o600 }); } catch { /* 回执文件写不了不影响执行 */ }
  return id;
}

/**
 * tabbot compose --description "…" <文件 | '代码'> [--参数 值] [--timeout 秒]：只组合 task（task(名字, 参数)），不碰页面。
 * 参数以 tabbot.params.名字 读到。成功的代码由 TabBot 存进 ~/.tabbot/compose/（带 description、用到的 task 和参数），下次 rg 能找到、直接拿文件带参数跑。
 */
async function composeCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：tabbot compose --description "这段回答什么问题" <文件 | 'const a = await task("名字", { 参数: tabbot.params.x }); return a;'> [--参数 值 ...] [--timeout 秒，默认 115]（compose 里只能组合 task）`;
  const { description, rest: rest0 } = takeDescription(args);
  let timeoutSec = 115;
  const positional: string[] = [], flags: string[] = [];
  for (let i = 0; i < rest0.length; i++) {
    const a = rest0[i]!;
    if (a === "--timeout") { timeoutSec = Number(rest0[++i]); continue; }
    if (a.startsWith("--")) { flags.push(a); if (!a.includes("=") && rest0[i + 1] !== undefined) flags.push(rest0[++i]!); continue; }
    positional.push(a);
  }
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return out.fail("--timeout 需要正数（秒）");
  const given = positional.join(" ").trim();
  if (!given) return out.fail(usage);
  if (!description) return out.fail(`tabbot compose ${DESCRIPTION_HINT}`);
  const parsed = parseCliParams(flags);
  if ("error" in parsed) return out.fail(parsed.error);
  let code = given;
  if (positional.length === 1 && !/[\s;(]/.test(given)) {
    try { code = fs.readFileSync(given, "utf8"); } catch { return out.fail(`读不到文件 ${given}（代码要用引号括起来，文件要写对路径）`); }
  }
  await ctx.ensureExtension();
  const outcome = await ctx.runner.runCompose(code, undefined, timeoutSec * 1000, parsed.params);
  if (outcome.status !== "success") out.code = 1;
  const receipt = issueReceipt(ctx, { mode: "执行", task: "(compose)", status: outcome.status });
  out.line(JSON.stringify({ mode: "执行", receipt, ...outcome }, null, 2));
  if (outcome.status === "success") {
    const saved = saveCompose(ctx.composeDir ?? COMPOSE_DIR, code, description);
    out.line(`这段已存为 ${saved.file}（下次：tabbot compose --description "…" ${saved.file} --参数 值）${saved.params.length ? "" : "\n提示：变化的值写成 tabbot.params.名字 ?? 默认值，下次直接换参数复用，不用改代码。"}`);
  }
}

/** --url 的值：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（tabbot tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `--url 要是 http(s) 链接，或 tabbot tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (!tab) return { error: `没有标签页 ${given}：先 tabbot tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/**
 * tabbot learn <task 名> [--site <站点>] [--url <链接|tab 号>] (--endpoint "方法 接口名" | --find "要的那一个数据或动作") [--note "补充说明"] [--fix]：
 * 开一个学习会话学会一个请求：开一个 debug 窗口，导出冻结的交接材料，在会话窗口里打开起点（--url，没有就是站点首页），
 * 输出学习指引和加载期的请求。只录 agent 自己的窗口：用户的页面要重新在会话窗口里打开才能看到它的请求。
 * 粒度固定是一个请求；入口二选一：知道接口名用 --endpoint，只知道要什么用 --find（自己找到那个请求）。
 * 业务目标、批量、聚合都不在这里，学完之后用 task 循环和 compose 完成。
 */
async function learnCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const flags = parseFlags(args, ["fix"]);
  if ("error" in flags) return out.fail(flags.error);
  const name = flags.rest[0];
  const note = flags.values.get("note") ?? "";
  const usage = '用法：tabbot learn <task 名，小写字母数字和 -> [--site <站点>] [--url <链接|tab 号>] (--endpoint "方法 接口名" | --find "要的那一个数据或动作") [--note "补充说明"] [--fix]（一次只学一个请求；接口名照抄 endpoints.json 的 key；--url 是起点页面，用户说"我的某某页面"时用 tabbot tabs 对出标签页号）';
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return out.fail(usage);
  const urlFlag = flags.values.get("url");
  const start = urlFlag ? await resolveStartUrl(ctx, urlFlag) : undefined;
  if (start && "error" in start) return out.fail(start.error);
  const site = normalizeSite(flags.values.get("site") ?? (start ? siteOfUrl(start.url) : ""));
  if (!site) return out.fail(`需要 --site <站点>（页面的 host，如 x.com、docs.google.com），或 --url。${usage}`);
  const fix = flags.bools.has("fix");
  const found = findTask(ctx.log.dir, name);
  const siteKey = ctx.log.siteKey(site);
  if (found && !fix) {
    const status = taskSummary(found.file).status;
    return out.fail(status === "blocked"
      ? `task ${name} 是学不会的记录（@status: blocked，原因见 ${found.file} 的 @note）：不要再探索，向用户说明卡在哪；有新证据（站点改版、换了入口）才用 --fix 重开`
      : status === "draft"
        ? `task ${name} 是上次没完成的草稿（@status: draft，${found.file}）：用 --fix 接着做`
        : `task ${name} 已存在：直接 tabbot run，或坏了用 --fix 开会话修`);
  }
  if (!found && fix) return out.fail(`task ${name} 不存在，不能 --fix`);
  if (found && found.site !== siteKey) return out.fail(`task ${name} 在站点 ${found.site} 下（${found.file}），不在 ${siteKey}：task 名全局唯一，换个名字，或 --site ${found.site}`);
  // 重开学不会的 task：改回草稿，否则 run 会拒绝
  if (found && fix && taskSummary(found.file).status === "blocked") fs.writeFileSync(found.file, fs.readFileSync(found.file, "utf8").replace(/^(\s*\*?\s*@status:?\s*)blocked\b/m, "$1draft"), "utf8");
  // 一次只学一个请求。入口二选一：--endpoint（知道接口）或 --find（只知道要什么，自己找）；
  // --fix 时缺省取现有 task 文件头的 @endpoint
  const find = flags.values.get("find")?.trim() || undefined;
  const given = flags.values.get("endpoint")?.trim().replace(/\s+/g, " ") || undefined;
  if (find && given) return out.fail(`--endpoint 和 --find 只能给一个：知道接口名用 --endpoint，只知道要什么用 --find。${usage}`);
  const endpoint = given ?? (find || !found ? undefined : taskSummary(found.file).endpoints[0]);
  if (!endpoint && !find) return out.fail(`需要 --endpoint "方法 接口名"（照抄 ${ctx.log.siteDir(site)}/endpoints.json 的 key），或 --find "要的那一个数据或动作"（不知道是哪个接口时，自己找）。一个 subagent 只学一个请求；业务目标、批量、聚合不在学习会话里做，学完用 task 循环和 compose 完成。${usage}`);
  // 先把内存里的写进日志和 endpoints.json，材料才是此刻最新的
  ctx.ingest.flush();
  ctx.index.touch(site);
  ctx.index.flush();
  const stat = endpoint ? ctx.index.snapshot(site).endpoints.find((e) => e.key === endpoint) : undefined;

  const t = ctx.debugWindows.open({ task: name, goal: find ?? note, site, fix });
  if ("error" in t) return out.fail(t.error);
  const tasksDir = tasksDirOf(ctx.log.dir, site);
  const workDir = path.join(ctx.log.siteDir(site), "debug", t.id);
  const materialDir = path.join(workDir, "material");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const manifest = exportMaterial(ctx.log, ctx.index, { site, dir: materialDir, endpoint, excludeWins: ctx.debugWindows.active().filter((w) => w.id !== t.id).map((w) => w.id) });
  const lines: string[] = [];
  if (endpoint && !stat) lines.push(`⚠ ${site} 的 endpoints.json 里没有接口「${endpoint}」（写法是 \`方法 接口名\`，和 endpoints.json 的 key 一致）：材料里没有它的样本，要自己在页面上触发出来。接口名写错的话，改用 --find。`);
  out.line(`${lines.length ? `${lines.join("\n")}\n\n` : ""}${makeLearnGuide(t, { siteDir: ctx.log.siteDir(site), tasksDir, workDir, materialDir, logDir: ctx.log.logDir(site), libDir: path.join(path.dirname(ctx.log.dir), "lib"), manifest, endpoint, find, note, stat, existing: found?.file })}`);
  out.line(`\n${await openStart(ctx, t, start?.url ?? `https://${site}/`)}`);
}

/** 在会话窗口里打开起点页面，列出加载期的请求（不锁定）。打不开不影响会话：agent 自己 debug open。 */
async function openStart(ctx: Ctx, w: DebugWindow, url: string): Promise<string> {
  let sess = ctx.sessions.get(w.id);
  if (!sess) { sess = new Session(w.id); ctx.sessions.set(w.id, sess); }
  try {
    await ctx.ensureExtension();
    ctx.ingest.flush();
    const before = ctx.log.lastSeq();
    const res = (await ctx.host.op(sess, "goto", { url })) as { url: string; title: string };
    await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS));
    ctx.ingest.flush();
    const stats = new Map(ctx.index.snapshot(w.site).endpoints.map((e) => [e.key, e]));
    const caused = causedRequests(ctx.log.readRows(w.site, { wins: [w.id], sinceSeq: before, limit: 500 }), stats);
    const shown = caused.slice(0, 15).map((r) => describeRequest(r, ctx.log.readRequestFile(w.site, r.seq)?.file, ctx.log.findRequestFile(w.site, r.seq)?.abs, r.endpoint ? stats.get(r.endpoint)?.descriptions?.[0]?.text : undefined).line);
    return [
      `# 起点：已在会话窗口打开 ${res.url} "${res.title}"（debug screenshot 截图看页面）`,
      caused.length ? `加载期的请求（共 ${caused.length} 个${caused.length > shown.length ? `，列前 ${shown.length} 个` : ""}）：\n  ${shown.join("\n  ")}` : "加载期没有录到请求（页面可能还在加载，截图看看；或者数据在页面里，用 DOM 取）。",
    ].join("\n");
  } catch (e) {
    return `# 起点：没能在会话窗口打开 ${url}（${e instanceof Error ? e.message : String(e)}）：自己 tabbot debug open <网址>`;
  }
}

// ---- 重放 ----

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
    else if (seq === undefined) { const n = Number(a.replace(/^#/, "")); if (!Number.isInteger(n)) return { error: `日志编号要是整数（请求文件名开头的数字），收到：${a}` }; seq = n; }
    else return { error: `多余的参数：${a}` };
  }
  if (seq === undefined) return { error: "用法：tabbot debug replay <编号> [--set 名字=值 ...] [--yes]（同时开着几个学习会话时要加 --window <窗口号>）" };
  return { seq, sets, yes };
}

type ReplayResult = { endpoint?: string; ok?: boolean; error?: string; method?: string; status?: number; size?: number; ms?: number; truncated?: boolean; summary?: string; preview?: string; bodyFile?: string; replaySeq?: number; requestFile?: string; warnings?: string[] };

/**
 * 重放日志里的一个请求：原始内容（含 token 真值）在 holder 的内存里，这里应用 --set（值里可以写别名），
 * 在学习会话自己的 agent 窗口里和原来同一个 origin 的页面里原样发出（带登录态），响应脱敏后记进日志。非 GET 要 --yes。
 * 请求文件在 debug 窗口绑定的站点里找。
 */
export async function runReplay(ctx: Ctx, params: { seq: number; sets: string[]; yes: boolean }, w: Pick<DebugWindow, "id" | "site">): Promise<ReplayResult> {
  const replaySession = new Session(w.id);
  const fail = (error: string): ReplayResult => ({ ok: false, error });
  const found = ctx.log.readRequestFile(w.site, params.seq);
  if (!found) return fail(`找不到站点 ${w.site} 的请求 #${params.seq}：请求文件在 ${ctx.log.logDir(w.site)}/<段>/ 下，文件名以 ${String(params.seq).padStart(6, "0")}_ 开头；编号看 endpoints.json 的 samples，或 rg 时间线`);
  const base = templateFromRequestFile(found.file);
  if ("error" in base) return fail(base.error);
  const rid = found.file.rid;
  const raw = rid && found.file.tab !== undefined ? ctx.raw.get(found.file.tab, rid) : undefined;
  if (!raw) return fail(`#${found.file.seq} 的原始内容已经不在 holder 的内存里了（holder 重启过、太旧被清掉，或者不是页面里发的请求）。tabbot debug --window ${w.id} open 打开页面再 act 触发一次这个操作（或让用户自己做一次），再用新的编号重试`);
  if (raw.body && UNREPLAYABLE_BODY.test(raw.body)) return fail("这个请求的请求体是文件、二进制或表单数据，没法重放");
  if (!isSafeMethod(raw.method) && !params.yes) return fail(`${raw.method} 请求可能有副作用（下单、提交、删除）：确认要重放请加 --yes，并且先问过用户`);
  let sets: string[];
  try { sets = params.sets.map((s) => ctx.ingest.sanitizer.resolve(s)); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const applied = applySets({ method: raw.method, url: raw.url, headers: replayHeaders(raw.headers), body: raw.body }, sets);
  if ("error" in applied) return fail(applied.error);
  const req = { ...applied.template, method: applied.template.method.toUpperCase() };
  const tab = await ctx.host.bind(replaySession, new URL(raw.page).origin);
  const ts = Date.now();
  try {
    const res = (await ctx.host.callTab(tab, "replay", [{ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null }])) as { ok?: boolean; error?: string; status?: number; ct?: string; size?: number; text?: string; truncated?: boolean; ms?: number };
    const setKeys = params.sets.map((x) => x.split("=")[0]!);
    const common = { site: w.site, page: raw.page, method: req.method, rawUrl: req.url, replayOf: params.seq, setKeys, headers: req.headers };
    if (res.ok === false) {
      ctx.ingest.recordReplay(tab, ts, { ...common, error: res.error });
      return { ok: false, error: res.error };
    }
    const rec = ctx.ingest.recordReplay(tab, ts, { ...common, status: res.status, ct: res.ct, size: res.size, text: res.text, ms: res.ms, reqBody: req.body ?? undefined });
    return {
      ok: true, status: res.status, size: res.size, ms: res.ms, truncated: res.truncated === true, replaySeq: rec.seq, endpoint: rec.endpoint,
      bodyFile: rec.bodyFile ? ctx.log.abs(w.site, rec.bodyFile) : undefined, requestFile: ctx.log.findRequestFile(w.site, rec.seq)?.abs,
      method: req.method, summary: summarizeBody(rec.preview, res.ct ?? ""), preview: rec.preview.slice(0, 1500), warnings: base.warnings,
    };
  } finally {
    await ctx.host.end(replaySession);
  }
}

async function replayCommand(args: string[], ctx: Ctx, out: Output, w: DebugWindow, description: string): Promise<void> {
  const p = parseReplayArgs(args);
  if ("error" in p) return out.fail(p.error);
  await ctx.ensureExtension();
  const res = await runReplay(ctx, p, w);
  if (res.ok === false) { out.code = 1; return out.line(`✗ 重放 #${p.seq}：${res.error ?? "失败"}`); }
  const bad = (res.status ?? 0) >= 400;
  if (bad) out.code = 1;
  if (res.endpoint && (res.status ?? 0) >= 200 && (res.status ?? 0) < 300) ctx.index.describe(w.site, res.endpoint, { text: description, from: "replay" });
  const kb = (res.size ?? 0) >= 1024 ? `${((res.size ?? 0) / 1024).toFixed(1)}KB` : `${res.size ?? 0}B`;
  const lines = [`${bad ? "✗" : "✓"} 重放 #${p.seq}${p.sets.length ? `（改了 ${p.sets.map((x) => x.split("=")[0]).join(", ")}）` : ""}：${res.method} → ${res.status}，${kb}，${res.ms}ms；${res.summary ?? ""}`];
  if (bad) lines.push(res.status === 401 || res.status === 403 ? "服务器拒绝了：登录态过期、需要签名，或这个请求依赖页面上一步的状态。改用 tabbot debug open + act 在页面上做。" : "服务器返回了错误，先看下面的响应内容再决定。");
  lines.push(`这次重放记为 #${res.replaySeq}${res.requestFile ? `，请求文件 ${res.requestFile}` : ""}${res.bodyFile ? `，响应体 ${res.bodyFile}（可以直接 rg）` : ""}`);
  if (res.truncated) lines.push("⚠ 响应超过 1MB，只取了前 1MB");
  for (const warn of res.warnings ?? []) lines.push(`⚠ ${warn}`);
  if (res.preview) lines.push(`响应（前 ${Math.min(res.preview.length, 1500)} 字符，已脱敏）：\n${res.preview}`);
  out.line(lines.join("\n"));
}
