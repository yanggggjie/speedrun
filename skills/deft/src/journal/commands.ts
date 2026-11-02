/**
 * 命令行的全部命令都在这里：deft <argv> 原样发给 holder，holder 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 第一行是结论；失败是 { status: "failure", error }，握手类失败是 { status: "need-*", guide }，退出码非零。
 *
 * 只保留必须由 Deft 做的事：控制浏览器（learn / run）、持有不能落盘的原始请求（learn … replay）、运维。两种窗口：
 * 学习窗口（deft learn）带持久的句柄，一直保留，探索和学习都在里面做；run 窗口（deft run）每次新开，跑完就关。
 * 读日志不是命令：日志是窗口目录里的文件（learn-windows/<句柄>/、run-windows/<名字>/），知识在 sites/<站点>/，用 rg / node / Python 读，见 SKILL.md。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { USAGE, handshakeStatusFromError, formatErrorStdout, formatHandshakeStdout } from "../protocol.ts";
import { COMPOSE_DIR, LOG_LIMITS, MB } from "../utils/constants.ts";
import { HANDLE, type LearnWindow, type LearnWindows } from "../run/learn-windows.ts";
import { Session, type RequestSource, type RunHost } from "../run/host.ts";
import { makeLearnGuide } from "../run/learn-guide.ts";
import type { ActionRunner, JournalEntry, Outcome, Replay } from "../run/runner.ts";
import { ACTION_NAME, actionSummary, composeHash, composeTarget, draftActions, isWriteAction, findAction, isComposed, parseCliParams, promoteAction, pruneUnnamed, saveComposed } from "../run/actions.ts";
import type { AgentWindows } from "../run/window.ts";
import { looksReadOnly, normalizeSite } from "./digest.ts";
import type { EndpointIndex } from "./endpoints.ts";
import { dependencies, describeRequest, missingInSequence, shownRequests, stepLine } from "./explore.ts";
import type { Ingestor } from "./ingest.ts";
import type { RawEntry, RawStore } from "./raw.ts";
import { applySets, isSafeMethod, replayHeaders, UNREPLAYABLE_BODY } from "./replay-core.ts";
import { summarizeBody, templateFromRequestFile } from "./replay.ts";
import { authSpecs, classifyAuth, describeAuth, type AuthSnapshot } from "./auth.ts";
import { readableUrl } from "./reqfile.ts";
import type { WindowLog } from "./windowlog.ts";
import type { RequestFile } from "./types.ts";
import { siteOfUrl } from "../utils/url.ts";

export type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; status: string; anchor?: boolean };

/** holder 提供给命令的能力。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  host: RunHost;
  runner: ActionRunner;
  win: AgentWindows;
  learn: LearnWindows;
  /** 学习窗口当前的页面，按句柄各一个；holder 重启后为空，下次操作时从上次的 URL 重开。 */
  sessions: Map<string, Session>;
  ingest: Ingestor;
  raw: RawStore;
  /** 窗口日志；log.dir 是 sites 目录（站点的 endpoints.json、actions/ 在它下面）。 */
  log: WindowLog;
  index: EndpointIndex;
  daemon(): { extension: boolean; pid: number };
  /** 跨站点的组合和没起名字的组合（不给就是 ~/.deft/compose）。 */
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

/** 页面操作之后等页面消息经扩展到 holder 的时间。 */
const AFTER_OP_MS = 300;
/** 打开起点、打开网址后等这么久再观察（加载期的请求）。 */
const LOAD_SETTLE_MS = 1_500;
/** 一次观察最多列多少个请求（列最近的）。 */
const OBSERVE_MAX = 30;

const REMOVED = new Set(["log", "sql", "req", "context", "api", "task", "replay", "open", "snapshot", "act", "delegate", "debug", "compose", "verify"]);

/** 执行一条命令。argv 是 `deft` 后面的全部参数。 */
export async function runCommand(argv: string[], ctx: Ctx): Promise<{ stdout: string; code: number }> {
  const out = new Output();
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "tabs": await tabsCommand(ctx, out); break;
      case "status": await statusCommand(ctx, out); break;
      case "run": await runActionCommand(args, ctx, out); break;
      case "learn": await learnCommand(args, ctx, out); break;
      default:
        if (cmd && REMOVED.has(cmd)) out.fail(`deft ${cmd} 已经没有了：探索和学习都在学习窗口里做（deft learn --url … 拿到句柄，再 deft learn <句柄> click|observe|replay …），执行用 deft run；日志在 ${path.join(ctx.log.root, "learn-windows")}/<句柄>/ 下，见 SKILL.md。`);
        else out.fail(USAGE);
    }
  } catch (error) {
    const status = handshakeStatusFromError(error);
    if (status) out.handshake(formatHandshakeStdout(status));
    else out.fail(error instanceof Error ? error.message : String(error));
  }
  return out.result();
}

const composeDirOf = (ctx: Pick<Ctx, "composeDir">): string => ctx.composeDir ?? COMPOSE_DIR;
const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);
const idleMin = (w: LearnWindow): number => Math.round((Date.now() - w.lastActive) / 60_000);

// ---- 用户的标签页、状态 ----

/** 用户自己的标签页；agent 窗口里的不在这里。 */
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
  out.line(`学习窗口日志：${ctx.log.listWindows("learn").length} 个窗口，轻量层（时间线、请求文件）${mb(u.learn.light)}MB / ${LOG_LIMITS.totalLight / MB}MB，重量层（响应体、页面、截图）${mb(u.learn.heavy)}MB / ${LOG_LIMITS.totalHeavy / MB}MB；run 窗口日志 ${ctx.log.listWindows("run").length} 个；最新编号 #${ctx.log.lastSeq()}`);
  const d = ctx.daemon();
  out.line(`daemon：在运行 pid=${d.pid}，扩展${d.extension ? "已连接" : "未连接"}`);
  const open = ctx.learn.opened();
  out.line(open.length ? `开着的学习窗口：${open.map((w) => `${w.id}（${w.url}，空闲 ${idleMin(w)} 分钟）`).join("；")}` : "开着的学习窗口：无");
  const drafts = draftActions(ctx.log.dir);
  const list = (xs: typeof drafts): string => xs.map((t) => `${t.name}（${t.site}）`).join("、");
  const writes = drafts.filter((t) => isWriteAction(t.file)), others = drafts.filter((t) => !isWriteAction(t.file));
  if (others.length) out.line(`还没跑通的草稿（@status draft）：${list(others)}；deft run <名字> 真跑成功就晋升 verified`);
  if (writes.length) out.line(`写操作的草稿（等第一次真用）：${list(writes)}；--dry 不晋升，用户真要做这件事时跑成功就晋升，不用为了晋升去真发`);
  out.line(`目录：学习窗口 ${path.join(ctx.log.root, "learn-windows")}，run 窗口 ${path.join(ctx.log.root, "run-windows")}，知识 ${ctx.log.dir}（每个站点：endpoints.json、actions/），跨站点的组合 ${composeDirOf(ctx)}`);
}

// ---- 学习窗口：探索和学习都在这里。每一步都进日志，操作后附带一次观察 ----

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

/** 取出不带值的开关（如 --dry），其余参数原样返回。 */
function takeSwitch(args: string[], name: string): { on: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== `--${name}`);
  return { on: rest.length !== args.length, rest };
}

/** 关键命令都要带 --description：一句话用用户的话说这一步要做什么。Deft 把它存进时间线和 endpoints.json，当成接口的业务含义。 */
export const DESCRIPTION_HINT = '要带 --description "一句话，用用户的话说这一步要做什么"（业务含义，如"点开变更单里的 MR"，不是"click 410 421"）；它会存下来，成为这个接口、action、组合的业务知识';
const SUBS = new Set(["open", "screenshot", "click", "type", "key", "scroll", "observe", "replay", "close"]);
const NEEDS_DESCRIPTION = new Set(["open", "click", "type", "key", "scroll", "replay"]);
const PAGE_OPS = new Set(["open", "click", "type", "key", "scroll", "replay"]);
const LEARN_USAGE = 'deft learn --url <链接|tab 号> --description "要做的事"（打开学习窗口，返回句柄）；deft learn <句柄> open|screenshot|click|type|key|scroll|observe|replay|close …；deft learn（列出学习窗口）';

/** deft learn …：没有参数是列出，--url 开头是打开，句柄开头是在那个学习窗口里操作。 */
async function learnCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  if (args.length === 0) return listLearn(ctx, out);
  if (args[0]!.startsWith("--")) return startLearn(args, ctx, out);
  const [id, sub, ...rest] = args as [string, string | undefined, ...string[]];
  if (!sub || !SUBS.has(sub)) {
    if (HANDLE.test(id)) return out.fail(`不认识的操作「${sub ?? ""}」。用法：${LEARN_USAGE}`);
    return out.fail(`「${id}」不是学习窗口的句柄：学习窗口不再按 action 名开，一个窗口里可以学多个 action。用法：${LEARN_USAGE}`);
  }
  return windowCommand(id, sub, rest, ctx, out);
}

function listLearn(ctx: Ctx, out: Output): void {
  const all = ctx.learn.list();
  if (!all.length) return out.line(`还没有学习窗口：${LEARN_USAGE}`);
  out.line(`${all.length} 个学习窗口（新的在前，最多列 10 个）`);
  for (const w of all.slice(0, 10)) out.line(`${w.id} ${w.open ? "开着" : "已关"} ${w.url} 操作 ${w.ops} 次，空闲 ${idleMin(w)} 分钟「${w.description}」`);
}

/** --url 的值：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（deft tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `--url 要是 http(s) 链接，或 deft tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (!tab) return { error: `没有标签页 ${given}：先 deft tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/** deft learn --url <链接|tab 号> --description "…"：打开一个学习窗口，返回句柄、窗口目录、学习指引和起点的观察结果。 */
async function startLearn(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const { description, rest } = takeDescription(args);
  const flags = parseFlags(rest);
  if ("error" in flags) return out.fail(flags.error);
  const usage = `用法：${LEARN_USAGE}`;
  if (flags.rest.length || [...flags.values.keys()].some((k) => k !== "url")) return out.fail(`多余的参数：学习窗口只要 --url 和 --description（--endpoint、--reopen、--site 已经没有了）。${usage}`);
  const given = flags.values.get("url");
  if (!given) return out.fail(`要带 --url（起点：链接，或 deft tabs 列出的标签页号）。${usage}`);
  if (!description) return out.fail(`要带 --description "要做的事"（用户的话，如"在知乎搜 agent，给硬核技术的回答点赞同"）。${usage}`);
  const start = await resolveStartUrl(ctx, given);
  if ("error" in start) return out.fail(start.error);
  await ctx.ensureExtension();
  const w = ctx.learn.create({ site: normalizeSite(siteOfUrl(start.url)), description, url: start.url });
  const lines: string[] = [];
  const sess = await ensureOpen(ctx, w, lines, false);
  await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS));
  lines.push(await observe(ctx, w, sess));
  ctx.learn.save(w);
  out.line([
    `学习窗口 ${w.id}（句柄，之后的命令都用它：deft learn ${w.id} <操作>）`,
    `窗口目录 ${ctx.log.winDir(w.id)}`,
    "",
    makeLearnGuide(w, { winDir: ctx.log.winDir(w.id), sitesDir: ctx.log.dir, composeDir: composeDirOf(ctx), libDir: path.join(ctx.log.root, "lib") }),
    "",
    ...lines,
  ].join("\n"));
}

/**
 * 学习窗口的 Chrome 窗口开着就直接用它当前的页面；没开（刚创建、close 过、空闲关了、holder 重启过）就打开窗口，到上次的 URL。
 * 重开时页面状态没了，在 lines 里写明。
 */
async function ensureOpen(ctx: Ctx, w: LearnWindow, lines: string[], reopening = true): Promise<Session> {
  let sess = ctx.sessions.get(w.id);
  if (sess && w.open && sess.tab !== undefined && await ctx.win.isOpen(w.id)) return sess;
  ctx.log.openWindow(w.id, "learn");
  sess = new Session(w.id);
  ctx.sessions.set(w.id, sess);
  const res = (await ctx.host.op(sess, "goto", { url: w.url || `https://${w.site}/` })) as { url: string; title: string };
  w.open = true;
  w.url = res.url;
  w.title = res.title;
  lines.push(reopening
    ? `# 学习窗口重新打开：${res.url} "${res.title}"（Chrome 窗口之前关了，页面状态没了，回到了上次的 URL）`
    : `# 起点：已在学习窗口打开 ${res.url} "${res.title}"（deft learn ${w.id} screenshot 截图看页面）`);
  return sess;
}

/** 关掉学习窗口的 Chrome 窗口（agent 显式 close，或空闲太久）；句柄和目录保留。 */
export async function closeLearnWindow(ctx: Pick<Ctx, "learn" | "sessions" | "win" | "host">, w: LearnWindow): Promise<void> {
  const sess = ctx.sessions.get(w.id);
  ctx.sessions.delete(w.id);
  if (sess) await ctx.host.end(sess);
  await ctx.win.dispose(w.id);
  w.open = false;
  ctx.learn.save(w);
}

async function windowCommand(id: string, sub: string, args0: string[], ctx: Ctx, out: Output): Promise<void> {
  const { description, rest: args } = takeDescription(args0);
  const counts = PAGE_OPS.has(sub);
  const found = counts ? ctx.learn.use(id) : ctx.learn.get(id) ?? { error: `没有学习窗口 ${id}：deft learn 列出有哪些` };
  if ("error" in found) return out.fail(found.error);
  const w = found;
  if (NEEDS_DESCRIPTION.has(sub) && !description) { if (counts) w.ops--; return out.fail(`learn ${id} ${sub} ${DESCRIPTION_HINT}`); }
  if (sub === "close") {
    if (!w.open) return out.line(`学习窗口 ${id} 的 Chrome 窗口已经关了；句柄和目录 ${ctx.log.winDir(id)} 还在。`);
    await closeLearnWindow(ctx, w);
    return out.line(`✓ 已关掉学习窗口 ${id} 的 Chrome 窗口；句柄和目录 ${ctx.log.winDir(id)} 保留，再对它操作会从 ${w.url} 重新打开`);
  }
  if (sub === "observe") {
    const flags = parseFlags(args);
    if ("error" in flags) return out.fail(flags.error);
    const since = flags.values.get("since");
    if (since !== undefined && !/^#?\d+$/.test(since)) return out.fail("--since 要是日志编号");
    if (w.open) await ctx.ensureExtension();
    out.line(await observe(ctx, w, ctx.sessions.get(id), since !== undefined ? Number(since.replace("#", "")) : undefined));
    ctx.learn.save(w);
    return;
  }
  await ctx.ensureExtension();
  const lines: string[] = [`学习窗口 ${id}（${ctx.log.winDir(id)}）`];
  const sess = await ensureOpen(ctx, w, lines);
  w.lastActive = Date.now();
  switch (sub) {
    case "screenshot": {
      const shot = (await ctx.host.op(sess, "screenshot", {})) as { data: string; mime: string; w: number; h: number };
      const rel = ctx.log.putFile(id, `screenshots/${String(ctx.log.reserve()).padStart(6, "0")}-screenshot.${shot.mime.includes("png") ? "png" : "jpg"}`, Buffer.from(shot.data, "base64"));
      lines.push(`✓ 截图 ${ctx.log.abs(id, rel)}（${shot.w}×${shot.h}，用读图片的方式看它）。图上的像素坐标就是 click / scroll 的坐标，左上角 (0,0)；截图只是此刻的画面，页面变了要重新截。`);
      ctx.learn.save(w);
      return out.line(lines.join("\n"));
    }
    case "open": {
      const url = args[0];
      if (!url) { w.ops--; return out.fail(`用法：deft learn ${id} open <网址> --description "…"`); }
      const res = (await ctx.host.op(sess, "goto", { url, description })) as { url: string; title: string };
      lines.push(`✓ 已在学习窗口打开 ${res.url} "${res.title}"`);
      await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS));
      break;
    }
    case "replay": {
      const p = parseReplayArgs(args);
      if ("error" in p) { w.ops--; return out.fail(p.error); }
      const res = await runReplay(ctx, p, w, sess);
      if (res.ok === false) { out.code = 1; lines.push(`✗ 重放 #${p.seq}：${res.error ?? "失败"}`); break; }
      const bad = (res.status ?? 0) >= 400;
      if (bad) out.code = 1;
      if (res.endpoint && res.site && (res.status ?? 0) >= 200 && (res.status ?? 0) < 300) ctx.index.describe(normalizeSite(res.site), res.endpoint, { text: description!, from: "replay" });
      if (p.raw) lines.push(`原样重放（--raw）：请求头是 #${p.seq} 那一次的，不代表 action 能跑通；验证 action 的写法去掉 --raw`);
      lines.push(`${bad ? "✗" : "✓"} 重放 #${p.seq}${p.sets.length ? `（改了 ${p.sets.map((x) => x.split("=")[0]).join(", ")}）` : ""}：${res.method} → ${res.status}，${kb(res.size ?? 0)}，${res.ms}ms；${res.summary ?? ""}`);
      if (res.where) lines.push(res.where);
      if (!p.raw) lines.push(res.inheritedFrom ? `请求头继承自 ${res.inheritedFrom}（和 action 里 request() 的继承规则一样）` : "没有继承请求头（内存里没有这个站点可继承的请求）");
      if (res.auth) lines.push(`身份头来源：${res.auth}`);
      if (res.mismatch) lines.push(`⚠ ${res.mismatch}`);
      if (bad) lines.push(res.mismatch ? "服务器拒绝了，而且签名和参数对不上：这个接口的签名和请求绑定，用页面实现（goto、scroll、evaluate 从页面上读）。" : res.status === 401 || res.status === 403 ? "服务器拒绝了：登录态过期、需要签名，或这个请求依赖页面上一步的状态。改用页面操作（click、type）在页面上做。" : "服务器返回了错误，先看下面的响应内容再决定。");
      if (res.code && !bad) lines.push(`可贴进 action：${res.code}`);
      lines.push(`这次重放记为 #${res.replaySeq}${res.requestFile ? `，请求文件 ${res.requestFile}` : ""}${res.bodyFile ? `，响应体 ${res.bodyFile}（可以直接 rg）` : ""}`);
      if (res.truncated) lines.push("⚠ 响应超过 1MB，只取了前 1MB");
      for (const warn of res.warnings ?? []) lines.push(`⚠ ${warn}`);
      if (res.preview) lines.push(`响应（前 ${Math.min(res.preview.length, 1500)} 字符，已脱敏）：\n${res.preview}`);
      break;
    }
    default: {
      const parsed = parsePointer(sub, args);
      if ("error" in parsed) { w.ops--; return out.fail(parsed.error); }
      const res = (await ctx.host.op(sess, "pointer", { ...parsed.cmd, settle: true, description })) as { navigated?: boolean; url?: string; title?: string; loc?: unknown; scrollY?: number; settle?: { settled: boolean; waitedMs: number } };
      lines.push(`✓ ${sub}${res.loc ? ` 元素的持久定位（写 action 用这个）${JSON.stringify(res.loc)}` : ""}${res.scrollY !== undefined ? `，滚动位置 ${res.scrollY}` : ""}${res.settle ? (res.settle.settled ? `（页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s）` : "（等了很久页面还在变化，没有稳定）") : ""}`);
      if (res.navigated) lines.push(`页面已跳转：${res.url ?? ""} "${res.title ?? ""}"`);
      const step = stepLine(parsed.cmd, res.loc);
      if (step) lines.push(`可贴进 action：${step}`);
    }
  }
  await new Promise((r) => setTimeout(r, AFTER_OP_MS));
  lines.push(await observe(ctx, w, sess, undefined, description));
  ctx.learn.save(w);
  out.line(lines.join("\n"));
}

/**
 * 观察：游标之后这个学习窗口发生的全部变化（页面状态、导航、请求、请求之间的依赖、编号范围），然后把游标移到最新。
 * since 给了就重看那个编号之后的，不推进游标。晚到的请求（懒加载、轮询、防抖）下次观察时出现，不会丢也不会重复。
 * step 是这一步刚带的 --description：接口"以前"的业务含义里不列它。
 */
export async function observe(ctx: Pick<Ctx, "ingest" | "log" | "win" | "tabs" | "index" | "raw" | "host">, w: LearnWindow, sess: Session | undefined, since?: number, step?: string): Promise<string> {
  ctx.ingest.flush();
  const from = since ?? w.cursor;
  const to = ctx.log.lastSeq();
  const rows = ctx.log.readRows(w.id, { sinceSeq: from, limit: 5000 }).filter((r) => r.seq <= to);
  const lines = [`## 观察 ${to > from ? `#${from + 1} → #${to}` : `#${from} 之后没有新的编号`}${since === undefined ? "" : "（重看，不推进游标）"}`];
  // 页面状态：窗口里的 agent 标签页（用户在这个窗口里自己开的不列），当前页面在前
  const winId = ctx.win.windowIdOf(w.id);
  const tabs = w.open && winId !== undefined ? (await ctx.tabs()).filter((t) => t.windowId === winId && !t.anchor && ctx.win.isAgentTab(t.tabId)) : [];
  const current = tabs.find((t) => t.tabId === sess?.tab) ?? tabs[0];
  if (current) { w.url = current.url; w.title = current.title; }
  lines.push(current ? `页面：${current.url} "${current.title}"${tabs.length > 1 ? `；窗口里共 ${tabs.length} 个标签页，其余：${tabs.filter((t) => t !== current).map((t) => t.url).join("、")}` : ""}` : `页面：Chrome 窗口没开（上次在 ${w.url}）`);
  const navs = rows.filter((r) => r.type === "nav" && r.via !== "replaceState");
  if (navs.length) lines.push(`导航：${navs.slice(-5).map((r) => `#${r.seq} ${r.url}${r.site && r.site !== w.site ? `（${r.site}）` : ""}`).join(" → ")}`);
  // 请求
  type Stat = { count: number; idle: number; cmdTriggered: number; descriptions?: Array<{ text: string }>; auth?: Record<string, string>; signed?: boolean };
  const statsOf = new Map<string, Map<string, Stat>>();
  const stats = (site: string): Map<string, Stat> => { let m = statsOf.get(site); if (!m) { m = new Map(ctx.index.snapshot(site).endpoints.map((e) => [e.key, e])); statsOf.set(site, m); } return m; };
  const merged = new Map<string, Stat>();
  for (const site of new Set(rows.map((r) => r.site ?? w.site))) for (const [k, v] of stats(site)) merged.set(k, v);
  const { shown, noise, periodic, assets } = shownRequests(rows, merged);
  const fileOf = (seq: number): RequestFile | undefined => ctx.log.readRequestFile(seq, w.id)?.file;
  if (!shown.length) lines.push("请求：没有新的请求（页面可能还在加载，等一会儿再 observe；或者数据在页面里，用 DOM 取）");
  else {
    const list = shown.slice(-OBSERVE_MAX);
    lines.push(`请求（${shown.length > list.length ? `共 ${shown.length} 个，列最近 ${list.length} 个` : `${shown.length} 个`}；★ 是写请求；文件在窗口目录里）：`);
    let snap: AuthSnapshot | undefined, snapped = false, classified = 0;
    for (const r of list) {
      const f = fileOf(r.seq);
      const site = r.site ?? w.site;
      const st = r.endpoint ? stats(site).get(r.endpoint) : undefined;
      const known = st?.descriptions?.find((d) => d.text !== step)?.text;
      const write = !looksReadOnly(r.method, f?.url.bareUrl ?? r.url ?? "", f?.requestBody);
      lines.push(`  ${describeRequest(r, f, { write, other: site !== w.site ? site : undefined, known }).line}`);
      if (st?.signed) lines.push(`      这个接口带签名头（${Object.entries(st.auth ?? {}).filter(([, v]) => v === "signed").map(([h]) => h).join(", ")}）：换参数可能被拒，以 replay、run 的结果为准，被拒就用页面实现`);
      // ★ 写请求：判断身份头的来源（最多 3 个，省时间）
      const raw = write && f?.rid && f.tab !== undefined && r.requestType !== "replay" ? ctx.raw.get(f.tab, f.rid) : undefined;
      if (raw && classified < 3) {
        classified++;
        if (!snapped) { snapped = true; snap = sess?.tab !== undefined ? await ctx.host.authSnapshot(sess.tab) : undefined; }
        const { history, siteHistory } = headerHistory(ctx.raw, raw);
        const sources = classifyAuth(raw.headers, snap, history, siteHistory);
        if (Object.keys(sources).length) {
          lines.push(`      身份头来源：${describeAuth(sources)}`);
          if (r.endpoint) ctx.index.setAuth(site, r.endpoint, Object.fromEntries(Object.entries(sources).map(([h, x]) => [h, x.spec ?? x.kind])), Object.values(sources).some((x) => x.kind === "signed"));
        }
      }
    }
    const deps = dependencies(list, fileOf, (f) => (f.responseBodyPath ? ctx.log.readText(w.id, f.responseBodyPath) : undefined), (f) => (f.tab !== undefined && f.rid ? ctx.raw.get(f.tab, f.rid) : undefined));
    if (deps.length) lines.push(`请求之间的依赖（后一个用了前一个响应里的值）：\n  ${deps.map((d) => `#${d.to} 用了 #${d.from} 响应的 ${d.field}`).join("\n  ")}\n  依赖链：中间结果没有业务含义就放进同一个 action（@endpoint 按发送顺序写多行），有业务含义就拆成两个 action 再组合。`);
  }
  const folded = [noise ? `埋点广告 ${noise}` : "", periodic ? `轮询 ${periodic}` : "", assets ? `静态资源 ${assets}` : ""].filter(Boolean);
  if (folded.length) lines.push(`没列出：${folded.join("，")}（在 timeline.jsonl 里）`);
  if (since === undefined) w.cursor = Math.max(w.cursor, to);
  return lines.join("\n");
}

export type PointerCmd = { kind: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; to?: string };

const NUM = /^-?\d+(\.\d+)?$/;

/** 解析按坐标的操作：click <x> <y> | type "文字" | key <键> | scroll down|up [像素] [x y] | scroll top|bottom [x y]。 */
export function parsePointer(kind: string, args: string[]): { cmd: PointerCmd } | { error: string } {
  switch (kind) {
    case "click": {
      if (args.length !== 2 || !args.every((a) => NUM.test(a))) return { error: "用法：deft learn <句柄> click <x> <y>（坐标取自截图，像素，左上角 (0,0)）" };
      return { cmd: { kind, x: Number(args[0]), y: Number(args[1]) } };
    }
    case "type": {
      if (!args.length) return { error: "用法：deft learn <句柄> type \"文字\"（输入到当前获得焦点的输入框，先 click 输入框）" };
      return { cmd: { kind, text: args.join(" ") } };
    }
    case "key": {
      if (!args[0]) return { error: "用法：deft learn <句柄> key Enter（组合键如 Ctrl+K、Cmd+A，作用在当前获得焦点的元素上）" };
      return { cmd: { kind, key: args[0] } };
    }
    case "scroll": {
      const dir = args[0];
      if (!dir || !["down", "up", "top", "bottom"].includes(dir)) return { error: "用法：deft learn <句柄> scroll down|up [像素] [x y] | scroll top|bottom [x y]（给了 x y 就滚动那个位置所在的可滚动区域，否则滚整页）" };
      const rest = args.slice(1);
      const amount = (dir === "down" || dir === "up") && rest[0] !== undefined && rest.length !== 2 && NUM.test(rest[0]) ? Number(rest.shift()) : 600;
      if (rest.length !== 0 && !(rest.length === 2 && rest.every((a) => NUM.test(a)))) return { error: "滚动的位置要写成 x y 两个数" };
      const at = rest.length === 2 ? { x: Number(rest[0]), y: Number(rest[1]) } : {};
      if (dir === "top" || dir === "bottom") return { cmd: { kind, to: dir, ...at } };
      return { cmd: { kind, dy: dir === "up" ? -amount : amount, ...at } };
    }
    default: return { error: `用法：${LEARN_USAGE}` };
  }
}

// ---- 重放 ----

/** 解析 replay 的参数：<编号> [--set k=v]... [--yes]。--set 可以重复。 */
export type ReplayParams = { seq: number; sets: string[]; yes: boolean; raw?: boolean; inheritFrom?: string };
export function parseReplayArgs(args: string[]): ReplayParams | { error: string } {
  let seq: number | undefined, inheritFrom: string | undefined;
  const sets: string[] = [];
  let yes = false, raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes") yes = true;
    else if (a === "--raw") raw = true;
    else if (a === "--inherit-from") { const v = args[++i]; if (!v || !v.startsWith("/")) return { error: "--inherit-from 要写接口路径，如 /api/v4/search_v3" }; inheritFrom = v; }
    else if (a === "--set") { const v = args[++i]; if (v === undefined) return { error: "--set 缺少值（写成 名字=值）" }; sets.push(v); }
    else if (a.startsWith("--")) return { error: `不认识的参数 ${a}` };
    else if (seq === undefined) { const n = Number(a.replace(/^#/, "")); if (!Number.isInteger(n)) return { error: `日志编号要是整数（请求文件名开头的数字），收到：${a}` }; seq = n; }
    else return { error: `多余的参数：${a}` };
  }
  if (seq === undefined) return { error: "用法：deft learn <句柄> replay <编号> [--set 名字=值 ...] [--inherit-from <接口路径>] [--yes] [--raw] --description \"…\"" };
  if (raw && inheritFrom) return { error: "--raw 是原样重放，不继承请求头，不能和 --inherit-from 一起用" };
  return { seq, sets, yes, raw, ...(inheritFrom ? { inheritFrom } : {}) };
}

type ReplayResult = { endpoint?: string; site?: string; ok?: boolean; error?: string; method?: string; status?: number; size?: number; ms?: number; truncated?: boolean; summary?: string; preview?: string; bodyFile?: string; replaySeq?: number; requestFile?: string; warnings?: string[]; where?: string; inheritedFrom?: string; auth?: string; mismatch?: string; code?: string };

/**
 * 重放日志里的一个请求，默认和 action 走同一条路径：从请求文件（或内存里的原始内容）取出方法、地址、请求体，套上 --set，
 * 调用和 action 一样的 host.request，请求头按同一套规则继承（--inherit-from 对应 action 的 inheritFrom），
 * 在学习窗口**当前的页面**里发出（当前页面和请求的页面不同源时在同一个窗口另开同源标签页）。所以重放成功，就等于这行 action 代码在当前页面状态下能成功。
 * --raw：原样用那一次请求的请求头（排查用，不代表 action 能跑通）。
 * 同时判断身份头的来源（auth.ts），给出可贴进 action 的一行；响应脱敏后记进这个学习窗口的日志。非 GET 要 --yes。
 */
export async function runReplay(ctx: Ctx, params: ReplayParams, w: Pick<LearnWindow, "id">, sess: Session): Promise<ReplayResult> {
  const fail = (error: string): ReplayResult => ({ ok: false, error });
  const found = ctx.log.readRequestFile(params.seq, w.id) ?? ctx.log.readRequestFile(params.seq);
  if (!found) return fail(`找不到请求 #${params.seq}：请求文件在窗口目录的 requests/ 下，文件名以 ${String(params.seq).padStart(6, "0")}- 开头；编号看观察输出、endpoints.json 的 samples，或 rg 时间线`);
  const base = templateFromRequestFile(found.file);
  if ("error" in base) return fail(base.error);
  const file = found.file;
  const raw = file.rid && file.tab !== undefined ? ctx.raw.get(file.tab, file.rid) : undefined;
  if (params.raw && !raw) return fail(`#${file.seq} 的原始内容已经不在 holder 的内存里了（holder 重启过、太旧被清掉）。--raw 要原始请求头；去掉 --raw 按 action 的方式重放，或在学习窗口里重新触发一次`);
  // 方法、地址、请求体：内存里有原文就用原文，否则用请求文件（别名换回真值）
  let method = file.method.toUpperCase(), url: string, body: string | null;
  try {
    url = raw ? raw.url : ctx.ingest.sanitizer.resolve(base.template.url);
    body = raw ? raw.body : base.template.body !== undefined ? ctx.ingest.sanitizer.resolve(base.template.body) : null;
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (body && UNREPLAYABLE_BODY.test(body)) return fail("这个请求的请求体是文件、二进制或表单数据，没法重放");
  if (!isSafeMethod(method) && !params.yes) return fail(`${method} 请求有副作用：确认要重放请加 --yes（删除、支付、发布、发给别人这类先问过用户）`);
  let sets: string[];
  try { sets = params.sets.map((x) => ctx.ingest.sanitizer.resolve(x)); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const rawHeaders = raw ? replayHeaders(raw.headers) : {};
  const applied = applySets({ method, url, headers: params.raw ? rawHeaders : {}, body }, sets);
  if ("error" in applied) return fail(applied.error);
  ({ method, url } = applied.template);
  method = method.toUpperCase();
  body = applied.template.body ?? null;
  const page = raw?.page ?? (file.frameUrl ? file.frameUrl.bareUrl : url);
  const origin = new URL(page).origin;
  const here = sess.tab !== undefined && sess.origin === origin;
  const other = here ? undefined : new Session(w.id);
  const site = siteOfUrl(page);
  const ts = Date.now();
  // 身份头来源：拿原始请求头的真值和页面存储、同一接口别的请求比对（只出来源，不出值）
  let authText: string | undefined, specs: Record<string, string> = {};
  try {
    const tab = here ? sess.tab! : await ctx.host.bind(other!, origin);
    let res: { ok?: boolean; error?: string; status?: number; ct?: string; size?: number; text?: string; truncated?: boolean; ms?: number; source?: RequestSource };
    if (params.raw) {
      res = await ctx.host.callTab(tab, "replay", [{ method, url, headers: applied.template.headers, body }]);
    } else {
      // 内容类型跟原请求：继承来的头可能来自别的接口
      const ct = (raw ? raw.headers["content-type"] ?? raw.headers["Content-Type"] : file.headers["content-type"]) as string | undefined;
      const headers = { ...(body !== null && ct ? { "content-type": ct } : {}), ...applied.template.headers };
      try {
        res = (await ctx.host.op(here ? sess : other!, "request", { url, method, ...(body !== null ? { body } : {}), headers, pageOrigin: origin, ...(params.inheritFrom ? { inheritFrom: params.inheritFrom } : {}) })) as typeof res;
      } catch (error) { res = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (raw) {
      const { history, siteHistory } = headerHistory(ctx.raw, raw);
      const sources = classifyAuth(raw.headers, await ctx.host.authSnapshot(tab), history, siteHistory);
      if (Object.keys(sources).length) {
        authText = describeAuth(sources);
        specs = authSpecs(sources);
        if (site && file.endpoint) ctx.index.setAuth(normalizeSite(site), file.endpoint, Object.fromEntries(Object.entries(sources).map(([h, x]) => [h, x.spec ?? x.kind])), Object.values(sources).some((x) => x.kind === "signed"));
      }
    }
    const setKeys = params.sets.map((x) => x.split("=")[0]!);
    const inheritedFrom = res.source?.inheritedFrom ? `${res.source.inheritedFrom.endpoint}（${res.source.inheritedFrom.url}）` : undefined;
    const common = { site, page, method, rawUrl: url, replayOf: params.seq, setKeys, headers: applied.template.headers, ...(res.source?.inheritedFrom ? { inheritedFrom: res.source.inheritedFrom.endpoint } : {}) };
    if (res.ok === false) {
      ctx.ingest.recordReplay(tab, ts, { ...common, error: res.error });
      return { ok: false, error: res.error };
    }
    const rec = ctx.ingest.recordReplay(tab, ts, { ...common, status: res.status, ct: res.ct, size: res.size, text: res.text, ms: res.ms, reqBody: body ?? undefined });
    const mm = res.source?.signatureMismatch;
    return {
      ok: true, status: res.status, size: res.size, ms: res.ms, truncated: res.truncated === true, replaySeq: rec.seq, endpoint: rec.endpoint, site,
      bodyFile: rec.bodyFile ? ctx.log.abs(w.id, rec.bodyFile) : undefined, requestFile: ctx.log.abs(w.id, rec.file),
      method, summary: summarizeBody(rec.preview, res.ct ?? ""), preview: rec.preview.slice(0, 1500),
      warnings: base.warnings.filter((x) => !/签名或时间戳/.test(x)),
      ...(here ? {} : { where: `当前页面和原请求不同源（${origin}），这次在同一个窗口里另开的标签页里发的` }),
      ...(inheritedFrom ? { inheritedFrom } : {}),
      ...(authText ? { auth: authText } : {}),
      ...(mm ? { mismatch: `签名头 ${mm.headers.join(", ")} 来自 ${res.source!.inheritedFrom!.endpoint}，这次的${mm.changed.join("、")}和它不一样：服务器可能拒绝（这次${(res.status ?? 0) < 400 ? "没拒，可能只是碰巧" : "拒了"}）；被拒就用页面实现` } : {}),
      ...(params.raw ? {} : { code: requestLine(ctx, { method, url, body, inheritFrom: params.inheritFrom, auth: specs }) }),
    };
  } finally {
    if (other) await ctx.host.end(other);
  }
}

/** 同名请求头在同一接口（history）和同站别的接口（siteHistory）的各次请求里的值：判断签名和不变的值。 */
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

/** 可贴进 action 的一行 request()：地址和请求体里的秘密写成别名（换成 deft.params 或删掉），带上判断出的 auth。 */
function requestLine(ctx: Pick<Ctx, "ingest">, r: { method: string; url: string; body: string | null; inheritFrom?: string; auth: Record<string, string> }): string {
  const u = ctx.ingest.sanitizer.url(r.url);
  const opts: string[] = [`url: ${JSON.stringify(readableUrl(u))}`];
  if (r.method !== "GET") opts.push(`method: ${JSON.stringify(r.method)}`);
  if (r.body !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.body); } catch { /* 不是 JSON */ }
    const shown = parsed !== undefined ? JSON.stringify(ctx.ingest.sanitizer.body(parsed)) : JSON.stringify(ctx.ingest.sanitizer.body(r.body, true));
    opts.push(parsed !== undefined ? `json: ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}` : `body: ${shown}`);
  }
  if (r.inheritFrom) opts.push(`inheritFrom: ${JSON.stringify(r.inheritFrom)}`);
  if (Object.keys(r.auth).length) opts.push(`auth: ${JSON.stringify(r.auth)}`);
  return `await request(page, { ${opts.join(", ")} });`;
}

// ---- 执行 ----

/**
 * deft run <action 名> --description "…" [--参数 值] [--dry]：执行一个 action（草稿也行，真跑成功就晋升 verified）。
 * deft run --compose '代码' --description "…" [--name 名字] [--参数 值] [--dry]：跑一段组合代码（只能 action("名字", 参数) 调用 action），跑通就存成组合实现的 action。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。用户拿到的结果必须来自这里。
 */
async function runActionCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：deft run <action 名> --description "…" [--参数 值 ...] [--dry]；或 deft run --compose 'const a = await action("名字", { 参数: deft.params.x }); return a;' --description "…" [--name 名字] [--参数 值 ...] [--dry]；停在 deft.ask 后用 deft run --resume <编号> --answer '<json>' 恢复（action 在 ${ctx.log.dir}/<站点>/actions/ 和 ${composeDirOf(ctx)}/ 下）`;
  const { description, rest: a1 } = takeDescription(args);
  const { on: dry, rest: a2 } = takeSwitch(a1, "dry");
  let code: string | undefined, name: string | undefined, timeoutSec: number | undefined, resume: string | undefined;
  const params: string[] = [], answers: string[] = [];
  let positional: string | undefined;
  for (let i = 0; i < a2.length; i++) {
    const a = a2[i]!;
    if (a === "--resume" || a.startsWith("--resume=")) { resume = a === "--resume" ? a2[++i] : a.slice(9); if (resume === undefined) return out.fail("--resume 缺少恢复编号（AS-…）"); continue; }
    if (a === "--answer" || a.startsWith("--answer=")) { const v = a === "--answer" ? a2[++i] : a.slice(9); if (v === undefined) return out.fail("--answer 缺少回答"); answers.push(v); continue; }
    if (a === "--compose" || a.startsWith("--compose=")) { code = a === "--compose" ? a2[++i] : a.slice(10); if (code === undefined) return out.fail(`--compose 缺少代码。${usage}`); continue; }
    if (a === "--name" || a.startsWith("--name=")) { name = a === "--name" ? a2[++i] : a.slice(7); continue; }
    if (a === "--timeout" || a.startsWith("--timeout=")) { timeoutSec = Number(a === "--timeout" ? a2[++i] : a.slice(10)); continue; }
    if (a.startsWith("--")) { params.push(a); if (!a.includes("=") && a2[i + 1] !== undefined) params.push(a2[++i]!); continue; }
    if (positional === undefined) { positional = a; continue; }
    return out.fail(`多余的参数：${a}（参数要写成 --名字 值）。${usage}`);
  }
  if (resume !== undefined) {
    if (code !== undefined || positional !== undefined || name !== undefined || params.length || dry || timeoutSec !== undefined) return out.fail("--resume 只接受 --answer：action、参数、--dry、--name、--description 沿用停下时的那次 run");
    const rec = getAsk(resume);
    if (!rec) return out.fail(`恢复编号 ${resume} 不存在（holder 重启过、已经恢复过，或超过 30 分钟）：重新 run 一次`);
    if (!answers.length) return out.fail(`--resume 要带 --answer '<json>'，回答：${rec.question}`);
    await ctx.ensureExtension();
    const replay: Replay = { journal: rec.journal, answers: [...rec.answers, ...answers.map(parseAnswer)] };
    // 存留用第一次 run 的 --description（用户要做的事）；恢复时的 --description 可省
    const o = { description: rec.description, params: rec.params, dry: rec.dry, timeoutSec: rec.timeoutSec, mode: rec.dry ? "试运行" : "执行", replay, resumed: resume, priorDrafts: rec.drafts };
    return rec.code !== undefined ? composeRun(ctx, out, { ...o, code: rec.code, name: rec.name }) : runNamed(ctx, out, { ...o, actionName: rec.action! });
  }
  if (answers.length) return out.fail("--answer 只配 --resume：deft run --resume <编号> --answer '<json>'");
  if (code !== undefined && positional !== undefined) return out.fail(`action 名和 --compose 只能给一个：跑已有的 action 用 deft run <名字>，跑组合代码用 deft run --compose '代码'。`);
  if (code === undefined && positional === undefined) return out.fail(usage);
  if (!description) return out.fail(`deft run ${DESCRIPTION_HINT}`);
  if (name !== undefined && code === undefined) return out.fail("--name 只配 --compose：给跑通的组合代码起名字存下来");
  if (name !== undefined && !ACTION_NAME.test(name)) return out.fail(`--name 要是小写字母数字和 -：${name}`);
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) return out.fail("--timeout 需要正数（秒）");
  const parsed = parseCliParams(params);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  const mode = dry ? "试运行" : "执行";
  if (code !== undefined) return composeRun(ctx, out, { code, name, description, params: parsed.params, dry, timeoutSec, mode });
  return runNamed(ctx, out, { actionName: positional!, description, params: parsed.params, dry, mode });
}

/** 一个真跑成功的草稿，和它在哪个 run 窗口里跑的（晋升时按那个窗口的请求检查多行 @endpoint 的顺序）。 */
type DraftRun = { file: string; window: string };
/** priorDrafts：停在 deft.ask 之前那几次 run 里已经成功的草稿（恢复时不会再执行，最终成功时一起晋升）。 */
type RunOpts = { description: string; params: Record<string, string>; dry: boolean; mode: string; timeoutSec?: number; replay?: Replay; resumed?: string; priorDrafts?: DraftRun[] };

/** 恢复记录：停在 deft.ask 的 run，只在 holder 内存里（重启就没了），最多 ASK_KEEP 条、ASK_TTL_MS 过期。 */
type AskRecord = { t: number; question: string; description: string; code?: string; action?: string; name?: string; params: Record<string, string>; dry: boolean; timeoutSec?: number; journal: JournalEntry[]; answers: unknown[]; drafts: DraftRun[] };
const ASK_KEEP = 20, ASK_TTL_MS = 30 * 60_000;
const pendingAsks = new Map<string, AskRecord>();

function getAsk(id: string): AskRecord | undefined {
  for (const [k, v] of pendingAsks) if (Date.now() - v.t > ASK_TTL_MS) pendingAsks.delete(k);
  return pendingAsks.get(id);
}

/** --answer 按 JSON 解析，解析不了就当字符串（回答一个词不用加引号）。 */
function parseAnswer(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** 打印给 agent 的结果：去掉内部字段（run 窗口名单独一行写目录，草稿另外报晋升，journal 只给恢复用）。 */
function shown(outcome: Outcome): Record<string, unknown> {
  const { runWindow: _w, drafts: _d, ...rest } = outcome as Outcome & { journal?: unknown };
  delete (rest as { journal?: unknown }).journal;
  return rest;
}

/**
 * run 停在 deft.ask：存恢复记录、输出问题和数据，不发回执、不存留（返回 true）。其他结果返回 false，照常发回执。
 * 恢复成功或再次停下后，用过的恢复编号作废；恢复失败时保留，agent 可以改了回答再恢复。
 */
function handleAsk(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts, target: { code?: string; action?: string; name?: string }): boolean {
  if (outcome.status !== "failure" && o.resumed) pendingAsks.delete(o.resumed);
  if (outcome.status !== "ask") return false;
  const id = `AS-${randomBytes(4).toString("hex")}`;
  pendingAsks.set(id, { t: Date.now(), question: outcome.question, description: o.description, ...target, params: o.params, dry: o.dry, timeoutSec: o.timeoutSec, journal: outcome.journal, answers: o.replay?.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: outcome.runWindow ?? "" }))] });
  while (pendingAsks.size > ASK_KEEP) pendingAsks.delete(pendingAsks.keys().next().value!);
  out.line(JSON.stringify({ mode: o.mode, status: "ask", resume: id, question: outcome.question, data: outcome.data, ...(outcome.dry ? { dry: outcome.dry } : {}) }, null, 2));
  if (outcome.runWindow) out.line(`run 窗口目录 ${ctx.log.winDir(outcome.runWindow)}`);
  out.line(`组合停在 deft.ask，等你判断：deft run --resume ${id} --answer '<json>'（前面已执行的 action 不会重跑；30 分钟内有效）`);
  return true;
}

/** run 结束后的共同收尾：写 run 窗口的 meta，判断草稿晋升（多行 @endpoint 要按顺序发出才晋升），提醒开着的学习窗口。返回要追加的文字行。 */
function finishRun(ctx: Ctx, outcome: Outcome, o: RunOpts, receipt: string): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) ctx.log.writeMeta(win, { ...old, description: o.description, status: outcome.status, receipt, dry: o.dry, endedAt: Date.now() });
    lines.push(`run 窗口目录 ${ctx.log.winDir(win)}（窗口已关，日志留着，出问题时对照学习窗口的日志反查）`);
  }
  const drafts: DraftRun[] = [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: win ?? "" }))];
  if (outcome.status === "success" && !o.dry && drafts.length) {
    ctx.ingest.flush();
    const sentOf = new Map<string, string[]>();
    const sent = (w: string): string[] => {
      let list = sentOf.get(w);
      if (!list) { list = (w ? ctx.log.readRows(w, { limit: 5000 }) : []).filter((r) => (r.type === "cmd" && r.kind === "request") || (r.type === "request" && !r.noise && r.requestType !== "replay")).map((r) => (r.type === "cmd" ? String(r.detail?.endpoint ?? "") : r.endpoint ?? "")); sentOf.set(w, list); }
      return list;
    };
    const promoted: string[] = [], kept: string[] = [], seen = new Set<string>();
    for (const { file, window } of drafts) {
      if (seen.has(file)) continue;
      seen.add(file);
      const s = actionSummary(file);
      const missing = s.endpoints.length >= 2 ? missingInSequence(s.endpoints, sent(window)) : undefined;
      if (missing) { kept.push(`${s.name}（没有按 @endpoint 的顺序发出「${missing}」：前置请求漏了，或 @endpoint 写错了顺序）`); continue; }
      if (promoteAction(file)) promoted.push(s.name);
    }
    if (promoted.length) lines.push(`草稿已晋升 verified：${promoted.join("、")}`);
    if (kept.length) lines.push(`草稿没有晋升：${kept.join("；")}`);
  }
  const open = ctx.learn.opened();
  if (outcome.status === "failure" && open.length) lines.push(`学习窗口 ${open.map((w) => w.id).join("、")} 还开着：失败的请求如果在那里重放成功过，多半是 action 缺了进入那个页面状态的前置步骤（先 goto 哪个页面、少了哪个前置请求），或者身份头没声明来源（看 replay 输出的"身份头来源"，写进 request 的 auth）；对比两个窗口的 timeline.jsonl`);
  if (outcome.status === "success" && open.length) lines.push(`学习窗口 ${open.map((w) => `${w.id}（空闲 ${idleMin(w)} 分钟）`).join("、")} 还开着，事情做完就 deft learn <句柄> close`);
  return lines;
}

async function runNamed(ctx: Ctx, out: Output, o: RunOpts & { actionName: string }): Promise<void> {
  const { actionName, description, dry, mode } = o;
  const found = findAction(ctx.log.dir, actionName, composeDirOf(ctx));
  const outcome = await ctx.runner.runAction(actionName, o.params, undefined, { dry, replay: o.replay });
  if (handleAsk(ctx, out, outcome, o, { action: actionName })) return;
  if (outcome.status !== "success") out.code = 1;
  if (found && outcome.status === "success" && !dry) {
    const summary = actionSummary(found.file, found.site);
    // 真跑成功：组合累加 description 和次数；学出来的 action，这句话记成它覆盖的接口的业务含义
    if (isComposed(summary)) saveComposed(found.file, fs.readFileSync(found.file, "utf8"), description);
    else if (found.site) for (const ep of summary.endpoints) ctx.index.describe(found.site, ep, { text: description, from: "run" });
  }
  const receipt = issueReceipt(ctx, { mode, action: actionName, status: outcome.status, window: outcome.runWindow });
  out.line(JSON.stringify({ mode, receipt, ...shown(outcome) }, null, 2));
  for (const line of finishRun(ctx, outcome, o, receipt)) out.line(line);
}

async function composeRun(ctx: Ctx, out: Output, o: RunOpts & { code: string; name?: string }): Promise<void> {
  const globalDir = composeDirOf(ctx);
  if (o.name) {
    const clash = findAction(ctx.log.dir, o.name, globalDir);
    if (clash && !isComposed(actionSummary(clash.file))) return out.fail(`${o.name} 已经是一个学出来的 action（${clash.file}）：组合换个名字`);
  }
  const outcome = await ctx.runner.runCompose(o.code, (o.timeoutSec ?? 115) * 1000, o.params, o.dry, o.replay, o.name ?? "compose");
  if (handleAsk(ctx, out, outcome, o, { code: o.code, name: o.name })) return;
  if (outcome.status !== "success") out.code = 1;
  const receipt = issueReceipt(ctx, { mode: o.mode, action: o.name ?? "(compose)", status: outcome.status, window: outcome.runWindow });
  out.line(JSON.stringify({ mode: o.mode, receipt, ...shown(outcome) }, null, 2));
  const tail = finishRun(ctx, outcome, o, receipt);
  if (outcome.status === "success" && !o.dry) {
    const target = composeTarget({ sitesDir: ctx.log.dir, globalDir, code: o.code, name: o.name });
    const saved = saveComposed(target, o.code, o.description);
    if (o.name) fs.rmSync(path.join(globalDir, `${composeHash(o.code)}.js`), { force: true }); // 起了名字，同样代码的哈希版本就不要了
    else pruneUnnamed(globalDir);
    const runName = path.basename(saved.file, ".js");
    out.line(`这段已存为 action ${runName}：${saved.file}（下次：deft run ${runName} --description "…" --参数 值）${o.name ? "" : "\n提示：给它起个名字更好找：同样的代码加 --name 名字 再跑一次。"}${saved.params.length ? "" : "\n提示：变化的值写成 deft.params.名字 ?? 默认值，下次直接换参数复用，不用改代码。"}`);
  }
  for (const line of tail) out.line(line);
}

/** 回执：每次 run 发一个，写进 sites/.receipts.jsonl。最终回复要引用本轮的回执，证明结果来自 action（hooks/stop-receipt.mjs 检查）。 */
function issueReceipt(ctx: Pick<Ctx, "log">, info: { mode: string; action: string; status: string; window?: string }): string {
  const id = `RC-${randomBytes(4).toString("hex")}`;
  try { fs.appendFileSync(path.join(ctx.log.dir, ".receipts.jsonl"), `${JSON.stringify({ receipt: id, t: Date.now(), ...info })}\n`, { mode: 0o600 }); } catch { /* 回执文件写不了不影响执行 */ }
  return id;
}
