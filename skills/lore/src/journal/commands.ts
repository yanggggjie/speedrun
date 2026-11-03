/**
 * 命令行的全部命令都在这里：lore <argv> 原样发给 daemon，daemon 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 输出约定见 protocol.ts：第一行 ok / fail / ask，后面是「标题：内容」的几段。
 *
 * 只保留必须由 lore 做的事：控制浏览器（learn / run）、持有不能落盘的原始请求、运维。两种窗口：
 * learn 窗口（lore learn）带持久的句柄，一直保留，learn 都在里面做；run 窗口（lore run）每次新开，跑完就关。
 * 读日志不是命令：日志是窗口目录里的文件（learn-windows/<句柄>/、run-windows/<名字>/），action 和 endpoints.json 在 sites/<站点>/，用 rg / node / Python 读，见 SKILL.md。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, USAGE, handshakeStatusFromError, formatErrorStdout, formatHandshakeStdout } from "../protocol.ts";
import { COMPOSE_DIR, LOG_LIMITS, MB } from "../utils/constants.ts";
import { HANDLE, type LearnWindow, type LearnWindows } from "../run/learn-windows.ts";
import { Session, type RunHost } from "../run/host.ts";
import { makeLearnGuide } from "../run/learn-guide.ts";
import type { ActionRunner, JournalEntry, Outcome, AskState } from "../run/runner.ts";
import { actionSummary, composeTarget, draftActions, findAction, isComposed, parseCliParams, promoteAction, pruneUnnamed, resolveCompose, saveComposed } from "../run/actions.ts";
import type { AgentWindows } from "../run/window.ts";
import { looksReadOnly, normalizeSite } from "./digest.ts";
import type { EndpointIndex } from "./endpoints.ts";
import { dependencies, describeRequest, missingInSequence, shownRequests, stepLine } from "./explore.ts";
import type { Ingestor } from "./ingest.ts";
import type { RawEntry, RawStore } from "./raw.ts";
import { authSpecs, classifyAuth, describeAuth, type AuthSnapshot } from "./auth.ts";
import { readableUrl } from "./reqfile.ts";
import type { WindowLog } from "./windowlog.ts";
import type { RequestFile, Row } from "./types.ts";
import { siteOfUrl } from "../utils/url.ts";

export type TabInfo = { tabId: number; windowId: number; active: boolean; url: string; title: string; status: string; anchor?: boolean };

/** daemon 提供给命令的能力。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  host: RunHost;
  runner: ActionRunner;
  win: AgentWindows;
  learn: LearnWindows;
  /** learn 窗口当前的页面，按句柄各一个；daemon 重启后为空，下次操作时从上次的 URL 重开。 */
  sessions: Map<string, Session>;
  ingest: Ingestor;
  raw: RawStore;
  /** 窗口日志；log.dir 是 sites 目录（站点的 endpoints.json、actions/ 在它下面）。 */
  log: WindowLog;
  index: EndpointIndex;
  daemon(): { extension: boolean; pid: number };
  /** compose 存放的目录（不给就是 ~/.lore/compose）。 */
  composeDir?: string;
}

class Output {
  private readonly lines: string[] = [];
  code: number = EXIT.ok;
  private override: string | undefined;
  line(text: string): void { this.lines.push(text); }
  fail(error: string): void { this.override = formatErrorStdout(error); this.code = EXIT.fail; }
  handshake(stdout: string): void { this.override = stdout; this.code = EXIT.wait; }
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

/** 页面操作之后等页面消息经扩展到 daemon 的时间。 */
const AFTER_OP_MS = 300;
/** 打开起点、打开网址后等这么久再观察（加载期的请求）。 */
const LOAD_SETTLE_MS = 1_500;
/** 一次观察最多列多少个请求（列最近的）。 */
const OBSERVE_MAX = 30;

/** 执行一条命令。argv 是 `lore` 后面的全部参数。 */
export async function runCommand(argv: string[], ctx: Ctx): Promise<{ stdout: string; code: number }> {
  const out = new Output();
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "tabs": await tabsCommand(ctx, out); break;
      case "status": await statusCommand(ctx, out); break;
      case "run": await runActionCommand(args, ctx, out); break;
      case "learn": await learnCommand(args, ctx, out); break;
      default: out.fail(USAGE);
    }
  } catch (error) {
    const status = handshakeStatusFromError(error);
    if (status) out.handshake(formatHandshakeStdout(status));
    else out.fail(error instanceof Error ? error.message : String(error));
  }
  return out.result();
}

const composeDirOf = (ctx: Pick<Ctx, "composeDir">): string => ctx.composeDir ?? COMPOSE_DIR;
const idleMin = (w: LearnWindow): number => Math.round((Date.now() - w.lastActive) / 60_000);

// ---- 用户的标签页、状态 ----

/** 用户自己的标签页；agent 窗口里的不在这里。 */
async function tabsCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const tabs = (await ctx.tabs()).filter((t) => !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (tabs.length === 0) return out.line("ok 没有打开的 http/https 标签页");
  out.line(`ok ${tabs.length} 个标签页`);
  for (const t of tabs) out.line(`  tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"} ${t.url} "${t.title}"`);
}

async function statusCommand(ctx: Ctx, out: Output): Promise<void> {
  const u = ctx.log.usage();
  const mb = (n: number): string => (n / MB).toFixed(1);
  const d = ctx.daemon();
  out.line(`ok daemon 在运行（pid ${d.pid}），扩展${d.extension ? "已连接" : "未连接"}`);
  out.line(`日志：learn 窗口 ${ctx.log.listWindows("learn").length} 个窗口，时间线和请求文件 ${mb(u.learn.light)}MB / ${LOG_LIMITS.totalLight / MB}MB，响应体、页面和截图 ${mb(u.learn.heavy)}MB / ${LOG_LIMITS.totalHeavy / MB}MB；run 窗口日志 ${ctx.log.listWindows("run").length} 个；最新编号 #${ctx.log.lastSeq()}`);
  const drafts = draftActions(ctx.log.dir);
  if (drafts.length) out.line(`还没跑通的 draft（@status draft）：${drafts.map((t) => `${t.name}（${t.site}${t.write ? "，@write" : ""}）`).join("、")}；lore run --action <名字> 真跑成功就变成 verified；带 @write 的等用户真要做这件事时再跑，不用为了变成 verified 去真发`);
  out.line(`learn 窗口：lore learn list`);
  out.line(`目录：learn 窗口 ${path.join(ctx.log.root, "learn-windows")}，run 窗口 ${path.join(ctx.log.root, "run-windows")}，站点目录 ${ctx.log.dir}（每个站点：endpoints.json、actions/），compose ${composeDirOf(ctx)}`);
}

// ---- learn 窗口：学 action 都在这里。每一步都进日志，操作后附带一次观察 ----

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

/** 取出不带值的开关（如 --all），其余参数原样返回。 */
function takeSwitch(args: string[], name: string): { on: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== `--${name}`);
  return { on: rest.length !== args.length, rest };
}

/** 关键命令都要带 --description：一句话用用户的话说这一步要做什么。lore 把它存进时间线和 endpoints.json，当成 endpoint 的 description。 */
export const DESCRIPTION_HINT = '要带 --description "一句话，用用户的话说这一步要做什么"（如"点开变更单里的 MR"，不是"click 410 421"）；它会存下来，成为这个 endpoint、action、compose 的 description';
const SUBS = new Set(["open", "screenshot", "click", "type", "key", "scroll", "observe", "run", "close"]);
const NEEDS_DESCRIPTION = new Set(["open", "click", "type", "key", "scroll", "run"]);
const PAGE_OPS = new Set(["open", "click", "type", "key", "scroll", "run"]);
const LEARN_USAGE = 'lore learn new --url <链接|tab 号> --description "要做的事"（打开 learn 窗口，返回句柄）；lore learn <句柄> open|screenshot|click|type|key|scroll|observe|run|close …；lore learn list（列出 learn 窗口）';
const indent = (text: string): string => text.split("\n").map((l) => `  ${l}`).join("\n");

/** lore learn new …：打开；lore learn list：列出；lore learn <句柄> <操作>：在那个 learn 窗口里操作。 */
async function learnCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const [first, ...rest] = args;
  if (first === "new") return startLearn(rest, ctx, out);
  if (first === "list" && rest.length === 0) return listLearn(ctx, out);
  if (!first || first.startsWith("--")) return out.fail(`用法：${LEARN_USAGE}`);
  const [sub, ...more] = rest;
  if (!sub || !SUBS.has(sub)) {
    if (HANDLE.test(first)) return out.fail(`不认识的操作「${sub ?? ""}」。用法：${LEARN_USAGE}`);
    return out.fail(`「${first}」不是 learn 窗口的句柄。用法：${LEARN_USAGE}`);
  }
  return windowCommand(first, sub, more, ctx, out);
}

function listLearn(ctx: Ctx, out: Output): void {
  const all = ctx.learn.list();
  if (!all.length) return out.line(`ok 还没有 learn 窗口\n下一步：${LEARN_USAGE}`);
  out.line(`ok ${all.length} 个 learn 窗口（新的在前，最多列 10 个）`);
  for (const w of all.slice(0, 10)) out.line(`  ${w.id} ${w.open ? "开着" : "已关"} ${w.url} 操作 ${w.ops} 次，空闲 ${idleMin(w)} 分钟「${w.description}」`);
}

/** --url 的值：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（lore tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `--url 要是 http(s) 链接，或 lore tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (!tab) return { error: `没有标签页 ${given}：先 lore tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/**
 * lore learn new --url <链接|tab 号> --description "…"：打开一个 learn 窗口，返回句柄、窗口目录、learn 指引和起点的观察。
 * learn 指引写在 ~/.lore/learn-guide.md：内容变了（第一次、或升级后）才在输出里给全文，其余时候只给路径。
 */
async function startLearn(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const { description, rest } = takeDescription(args);
  const flags = parseFlags(rest);
  if ("error" in flags) return out.fail(flags.error);
  const usage = `用法：${LEARN_USAGE}`;
  if (flags.rest.length || [...flags.values.keys()].some((k) => k !== "url")) return out.fail(`多余的参数：learn 窗口只要 --url 和 --description。${usage}`);
  const given = flags.values.get("url");
  if (!given) return out.fail(`要带 --url（起点：链接，或 lore tabs 列出的标签页号）。${usage}`);
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
  const guideFile = path.join(ctx.log.root, "learn-guide.md");
  const guide = makeLearnGuide({ learnDir: path.join(ctx.log.root, "learn-windows"), sitesDir: ctx.log.dir, composeDir: composeDirOf(ctx), libDir: path.join(ctx.log.root, "lib"), helpersDir: path.join(ctx.log.root, "helpers") });
  let fresh = true;
  try { fresh = fs.readFileSync(guideFile, "utf8") !== guide; } catch { /* 第一次 */ }
  if (fresh) fs.writeFileSync(guideFile, guide);
  out.line([
    `ok learn 窗口已打开：${w.id}`,
    `句柄：${w.id}（之后的命令：lore learn ${w.id} <操作>）`,
    `要做的事：${description}`,
    `窗口目录：${ctx.log.winDir(w.id)}`,
    `learn 指引：${guideFile}${fresh ? "（第一次给出或有更新，全文在最后）" : "（开始前先读一遍）"}`,
    ...lines,
    ...(fresh ? ["", guide] : []),
  ].join("\n"));
}

/**
 * learn 窗口的 Chrome 窗口开着就直接用它当前的页面；没开（刚创建、close 过、空闲关了、daemon 重启过）就打开窗口，到上次的 URL。
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
    ? `重新打开：${res.url} "${res.title}"（Chrome 窗口之前关了，页面状态没了，回到了上次的 URL）`
    : `起点：${res.url} "${res.title}"`);
  return sess;
}

/** 关掉 learn 窗口的 Chrome 窗口（agent 显式 close，或空闲太久）；句柄和目录保留。 */
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
  const found = counts ? ctx.learn.use(id) : ctx.learn.get(id) ?? { error: `没有 learn 窗口 ${id}：lore learn list 列出有哪些` };
  if ("error" in found) return out.fail(found.error);
  const w = found;
  if (NEEDS_DESCRIPTION.has(sub) && !description) { if (counts) w.ops--; return out.fail(`learn ${id} ${sub} ${DESCRIPTION_HINT}`); }
  if (sub === "close") {
    if (!w.open) return out.line(`ok learn 窗口 ${id} 的 Chrome 窗口已经关了\n窗口目录：${ctx.log.winDir(id)}`);
    await closeLearnWindow(ctx, w);
    return out.line(`ok 已关掉 learn 窗口 ${id}\n窗口目录：${ctx.log.winDir(id)}（句柄和目录保留，再对它操作会从 ${w.url} 重新打开）`);
  }
  if (sub === "observe") {
    const { on: all, rest: a1 } = takeSwitch(args, "all");
    const flags = parseFlags(a1);
    if ("error" in flags) return out.fail(flags.error);
    const since = flags.values.get("since");
    if (since !== undefined && !/^#?\d+$/.test(since)) return out.fail("--since 要是日志编号");
    if (w.open) await ctx.ensureExtension();
    const text = await observe(ctx, w, ctx.sessions.get(id), since !== undefined ? Number(since.replace("#", "")) : undefined, undefined, all);
    ctx.learn.save(w);
    return out.line(`ok 观察 ${id}\n${text}`);
  }
  await ctx.ensureExtension();
  const head: string[] = [];
  const sess = await ensureOpen(ctx, w, head);
  w.lastActive = Date.now();
  let first = `ok ${sub}`;
  const body: string[] = [];
  switch (sub) {
    case "screenshot": {
      const shot = (await ctx.host.op(sess, "screenshot", {})) as { data: string; mime: string; w: number; h: number };
      const rel = ctx.log.putFile(id, `screenshots/${String(ctx.log.reserve()).padStart(6, "0")}-screenshot.${shot.mime.includes("png") ? "png" : "jpg"}`, Buffer.from(shot.data, "base64"));
      ctx.learn.save(w);
      return out.line([`ok 截图 ${shot.w}×${shot.h}`, ...head, `文件：${ctx.log.abs(id, rel)}（用读图片的方式看；图上的像素坐标就是 click / scroll 的坐标，左上角 (0,0)；页面变了要重新截）`].join("\n"));
    }
    case "open": {
      const url = args[0];
      if (!url) { w.ops--; return out.fail(`用法：lore learn ${id} open <网址> --description "…"`); }
      const res = (await ctx.host.op(sess, "goto", { url, description })) as { url: string; title: string };
      first = `ok 已打开 ${res.url}`;
      break;
    }
    case "run": {
      const at = args.indexOf("--action");
      const name = at >= 0 ? args[at + 1] : undefined;
      if (!name) { w.ops--; return out.fail(`用法：lore learn ${id} run --action <名> [--参数 值] --description "…"`); }
      const parsed = parseCliParams([...args.slice(0, at), ...args.slice(at + 2)]);
      if ("error" in parsed) { w.ops--; return out.fail(parsed.error); }
      const target = findAction(ctx.log.dir, name, composeDirOf(ctx));
      if (!target) { w.ops--; return out.fail(`action 不存在：${name}（在 ${ctx.log.dir}/<站点>/actions/ 下）`); }
      const summary = actionSummary(target.file, target.site);
      if (isComposed(summary)) { w.ops--; return out.fail(`${name} 是 compose：用 lore run --compose ${name} 跑`); }
      const o = await ctx.runner.runInLearn(name, parsed.params, sess);
      if (o.status === "success") {
        first = `ok ${name}`;
        body.push(`结果：\n${indent(JSON.stringify(o.result ?? null, null, 2))}`);
        if (target.site) for (const ep of summary.endpoints) ctx.index.describe(target.site, ep, { text: description!, from: "learn" });
      } else {
        out.code = EXIT.fail;
        first = `fail ${name}：${o.status === "failure" ? o.error : "action 里不能用 lore.ask"}`;
      }
      if (o.writes?.length) body.push(`已发出的 write 请求：\n${indent(o.writes.join("\n"))}`);
      break;
    }
    default: {
      const parsed = parsePointer(sub, args);
      if ("error" in parsed) { w.ops--; return out.fail(parsed.error); }
      const res = (await ctx.host.op(sess, "pointer", { ...parsed.cmd, settle: true, description })) as { navigated?: boolean; url?: string; title?: string; loc?: unknown; scrollY?: number; settle?: { settled: boolean; waitedMs: number } };
      if (res.loc) body.push(`定位：${JSON.stringify(res.loc)}`);
      if (res.scrollY !== undefined) body.push(`滚动位置：${res.scrollY}`);
      if (res.settle) body.push(res.settle.settled ? `稳定：页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s` : "稳定：等了很久页面还在变化");
      if (res.navigated) body.push(`跳转：${res.url ?? ""} "${res.title ?? ""}"`);
      const step = stepLine(parsed.cmd, res.loc);
      if (step) body.push(`草稿：${step}`);
    }
  }
  await new Promise((r) => setTimeout(r, AFTER_OP_MS));
  const obs = await observe(ctx, w, sess, undefined, description);
  ctx.learn.save(w);
  out.line([first, ...head, ...body, obs].join("\n"));
}

/**
 * 观察：游标之后这个 learn 窗口发生的变化（页面、导航、请求、请求之间的依赖），然后把游标移到最新。
 * since 给了就重看那个编号之后的，不推进游标。晚到的请求（懒加载、轮询、防抖）下次观察时出现，不会丢也不会重复。
 * 请求默认只列这个窗口里第一次出现的 endpoint 和所有写请求，其余只计数；all 为真列全部。
 * 最多 3 个请求带 auth 来源和一行可以贴进 action 的 request() 草稿：写请求优先，再是这一步引发的，再是最新的。
 */
export async function observe(ctx: Pick<Ctx, "ingest" | "log" | "win" | "tabs" | "index" | "raw" | "host">, w: LearnWindow, sess: Session | undefined, since?: number, step?: string, all = false): Promise<string> {
  ctx.ingest.flush();
  const from = since ?? w.cursor;
  const to = ctx.log.lastSeq();
  const timeline = ctx.log.readRows(w.id, { limit: 1_000_000 });
  const rows = timeline.filter((r) => r.seq > from && r.seq <= to);
  const lines = [`观察：${to > from ? `#${from + 1} → #${to}` : `#${from} 之后没有新的编号`}${since === undefined ? "" : "（重看，不推进游标）"}`];
  // 页面：窗口里的 agent 标签页（用户在这个窗口里自己开的不列），当前页面在前
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
  // 默认只列这个窗口里第一次出现的 endpoint 和所有写请求；页面重新加载时的 /me 这类不再列
  const fileOf = (seq: number): RequestFile | undefined => ctx.log.readRequestFile(seq, w.id)?.file;
  const files = new Map(shown.map((r) => [r.seq, fileOf(r.seq)]));
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
    const rawOf = (r: Row): RawEntry | undefined => { const f = files.get(r.seq); return f?.rid && f.tab !== undefined ? ctx.raw.get(f.tab, f.rid) : undefined; };
    const drafted = new Set([...list.filter(isWrite), ...list.filter((r) => r.phase === "cmd"), ...[...list].reverse()].filter((r) => rawOf(r)).slice(0, 3).map((r) => r.seq));
    lines.push(`请求：${picked.length > list.length ? `（共 ${picked.length} 个，列最近 ${list.length} 个）` : ""}`);
    let snap: AuthSnapshot | undefined, snapped = false;
    for (const r of list) {
      const f = files.get(r.seq);
      const site = r.site ?? w.site;
      const st = r.endpoint ? stats(site).get(r.endpoint) : undefined;
      const known = st?.descriptions?.find((d) => d.text !== step)?.text;
      lines.push(`  ${describeRequest(r, f, { write: isWrite(r), other: site !== w.site ? site : undefined, known }).line.trimStart()}`);
      if (st?.signed) lines.push(`    签名：${Object.entries(st.auth ?? {}).filter(([, v]) => v === "signed").map(([h]) => h).join(", ")}（每次都变，换参数可能被拒）`);
      const raw = drafted.has(r.seq) ? rawOf(r) : undefined;
      if (!raw) continue;
      if (!snapped) { snapped = true; snap = sess?.tab !== undefined ? await ctx.host.authSnapshot(sess.tab) : undefined; }
      const { history, siteHistory } = headerHistory(ctx.raw, raw);
      const sources = classifyAuth(raw.headers, snap, history, siteHistory);
      if (Object.keys(sources).length) {
        lines.push(`    auth 来源：${describeAuth(sources)}`);
        if (r.endpoint) ctx.index.setAuth(site, r.endpoint, Object.fromEntries(Object.entries(sources).map(([h, x]) => [h, x.spec ?? x.kind])), Object.values(sources).some((x) => x.kind === "signed"));
      }
      lines.push(`    草稿：${requestLine(ctx, { method: raw.method.toUpperCase(), url: raw.url, body: raw.body, auth: authSpecs(sources) })}`);
    }
    const deps = dependencies(list, fileOf, (f) => (f.responseBodyPath ? ctx.log.readText(w.id, f.responseBodyPath) : undefined), (f) => (f.tab !== undefined && f.rid ? ctx.raw.get(f.tab, f.rid) : undefined));
    if (deps.length) lines.push(`依赖：\n${deps.map((d) => `  #${d.to} 用了 #${d.from} 响应的 ${d.field}`).join("\n")}`);
  }
  const folded = [repeated ? `之前出现过的 ${repeated}` : "", noise ? `埋点广告 ${noise}` : "", periodic ? `轮询 ${periodic}` : "", assets ? `静态资源 ${assets}` : ""].filter(Boolean);
  if (folded.length) lines.push(`没列出：${folded.join("，")}${repeated ? "（observe --all 看全部）" : "（在 timeline.jsonl 里）"}`);
  if (!picked.length && !repeated) lines.push("下一步：页面可能还在加载，等一会儿再 observe；或者数据在页面里，用 DOM 取");
  if (since === undefined) w.cursor = Math.max(w.cursor, to);
  return lines.join("\n");
}

export type PointerCmd = { kind: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; to?: string };

const NUM = /^-?\d+(\.\d+)?$/;

/** 解析按坐标的操作：click <x> <y> | type "文字" | key <键> | scroll down|up [像素] [x y] | scroll top|bottom [x y]。 */
export function parsePointer(kind: string, args: string[]): { cmd: PointerCmd } | { error: string } {
  switch (kind) {
    case "click": {
      if (args.length !== 2 || !args.every((a) => NUM.test(a))) return { error: "用法：lore learn <句柄> click <x> <y>（坐标取自截图，像素，左上角 (0,0)）" };
      return { cmd: { kind, x: Number(args[0]), y: Number(args[1]) } };
    }
    case "type": {
      if (!args.length) return { error: "用法：lore learn <句柄> type \"文字\"（输入到当前获得焦点的输入框，先 click 输入框）" };
      return { cmd: { kind, text: args.join(" ") } };
    }
    case "key": {
      if (!args[0]) return { error: "用法：lore learn <句柄> key Enter（组合键如 Ctrl+K、Cmd+A，作用在当前获得焦点的元素上）" };
      return { cmd: { kind, key: args[0] } };
    }
    case "scroll": {
      const dir = args[0];
      if (!dir || !["down", "up", "top", "bottom"].includes(dir)) return { error: "用法：lore learn <句柄> scroll down|up [像素] [x y] | scroll top|bottom [x y]（给了 x y 就滚动那个位置所在的可滚动区域，否则滚整页）" };
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

// ---- 观察里的 auth 来源和 request 草稿 ----

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
  return `await request({ ${opts.join(", ")} });`;
}

// ---- 执行 ----

/**
 * lore run --action <名> --description "…" [--参数 值]：执行一个 action（draft 也行，真跑成功就变成 verified）。
 * lore run --compose <名> …：按名字（或哈希的唯一前缀）再跑一个存下来的 compose。
 * lore run --compose-code '代码' --description "…" [--参数 值]：跑一段 compose 代码（只能 action("名字", 参数) 调用 action），跑通就按代码哈希存下来。
 * 三者必须给且只给一个。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。用户拿到的结果必须来自这里。
 */
async function runActionCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：lore run --action <名> --description "…" [--参数 值 ...]；lore run --compose <名> --description "…" [--参数 值 ...]；或 lore run --compose-code 'const a = await action("名字", { 参数: lore.params.x }); return a;' --description "…" [--参数 值 ...]；停在 lore.ask 后用 lore run --resume <编号> --answer '<json>' 恢复（action 在 ${ctx.log.dir}/<站点>/actions/ 和 ${composeDirOf(ctx)}/ 下）`;
  const { description, rest: a1 } = takeDescription(args);
  let code: string | undefined, timeoutSec: number | undefined, resume: string | undefined;
  const params: string[] = [], answers: string[] = [];
  let actionName: string | undefined, composeName: string | undefined;
  for (let i = 0; i < a1.length; i++) {
    const a = a1[i]!;
    if (a === "--resume" || a.startsWith("--resume=")) { resume = a === "--resume" ? a1[++i] : a.slice(9); if (resume === undefined) return out.fail("--resume 缺少恢复编号（AS-…）"); continue; }
    if (a === "--answer" || a.startsWith("--answer=")) { const v = a === "--answer" ? a1[++i] : a.slice(9); if (v === undefined) return out.fail("--answer 缺少回答"); answers.push(v); continue; }
    if (a === "--compose-code" || a.startsWith("--compose-code=")) { code = a === "--compose-code" ? a1[++i] : a.slice(15); if (code === undefined) return out.fail(`--compose-code 缺少代码。${usage}`); continue; }
    if (a === "--compose" || a.startsWith("--compose=")) { composeName = a === "--compose" ? a1[++i] : a.slice(10); if (composeName === undefined) return out.fail(`--compose 缺少名字。${usage}`); continue; }
    if (a === "--action" || a.startsWith("--action=")) { actionName = a === "--action" ? a1[++i] : a.slice(9); if (actionName === undefined) return out.fail(`--action 缺少名字。${usage}`); continue; }
    if (a === "--timeout" || a.startsWith("--timeout=")) { timeoutSec = Number(a === "--timeout" ? a1[++i] : a.slice(10)); continue; }
    if (a.startsWith("--")) { params.push(a); if (!a.includes("=") && a1[i + 1] !== undefined) params.push(a1[++i]!); continue; }
    return out.fail(`多余的参数：${a}（action 名要写成 --action ${a}；参数要写成 --名字 值）。${usage}`);
  }
  if (resume !== undefined) {
    if (code !== undefined || actionName !== undefined || composeName !== undefined || params.length || timeoutSec !== undefined) return out.fail("--resume 只接受 --answer：action、参数、--description 沿用停下时的那次 run");
    const rec = getAsk(resume);
    if (!rec) return out.fail(`恢复编号 ${resume} 不存在（daemon 重启过、已经恢复过，或超过 30 分钟）：重新 run 一次`);
    if (!answers.length) return out.fail(`--resume 要带 --answer '<json>'，回答：${rec.question}`);
    await ctx.ensureExtension();
    const askState: AskState = { journal: rec.journal, answers: [...rec.answers, ...answers.map(parseAnswer)] };
    // 存 compose 用第一次 run 的 --description（用户要做的事）；恢复时的 --description 可省
    const o = { description: rec.description, params: rec.params, timeoutSec: rec.timeoutSec, askState, resumed: resume, priorDrafts: rec.drafts };
    return rec.code !== undefined ? composeRun(ctx, out, { ...o, code: rec.code }) : runNamed(ctx, out, { ...o, actionName: rec.action! });
  }
  if (answers.length) return out.fail("--answer 只配 --resume：lore run --resume <编号> --answer '<json>'");
  const given = [actionName, composeName, code].filter((v) => v !== undefined).length;
  if (given !== 1) return out.fail(`--action、--compose、--compose-code 必须给且只给一个。${usage}`);
  if (!description) return out.fail(`lore run ${DESCRIPTION_HINT}`);
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) return out.fail("--timeout 需要正数（秒）");
  const parsed = parseCliParams(params);
  if ("error" in parsed) return out.fail(parsed.error);
  await ctx.ensureExtension();
  if (code !== undefined) return composeRun(ctx, out, { code, description, params: parsed.params, timeoutSec });
  let runName = (actionName ?? composeName)!;
  if (composeName !== undefined) {
    const r = resolveCompose(composeDirOf(ctx), composeName);
    if (r && "error" in r) return out.fail(r.error);
    if (r) runName = r.name;
  }
  const found = findAction(ctx.log.dir, runName, composeDirOf(ctx));
  if (found && isComposed(actionSummary(found.file)) !== (composeName !== undefined)) return out.fail(composeName !== undefined ? `${runName} 是 action 不是 compose：lore run --action ${runName}` : `${runName} 是 compose 不是 action：lore run --compose ${runName}`);
  return runNamed(ctx, out, { actionName: runName, description, params: parsed.params });
}

/** 一个真跑成功的 draft，和它在哪个 run 窗口里跑的（变成 verified 时按那个窗口的请求检查多行 @endpoint 的顺序）。 */
type DraftRun = { file: string; window: string };
/** priorDrafts：停在 lore.ask 之前那几次 run 里已经成功的 draft（恢复时不会再执行，最终成功时一起变成 verified）。 */
type RunOpts = { description: string; params: Record<string, string>; timeoutSec?: number; askState?: AskState; resumed?: string; priorDrafts?: DraftRun[] };

/** 恢复记录：停在 lore.ask 的 run，只在 daemon 内存里（重启就没了），最多 ASK_KEEP 条、ASK_TTL_MS 过期。 */
type AskRecord = { t: number; question: string; description: string; code?: string; action?: string; params: Record<string, string>; timeoutSec?: number; journal: JournalEntry[]; answers: unknown[]; drafts: DraftRun[] };
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

/**
 * run 的结论和结果，按输出约定写成几段：第一行 ok / fail，然后「结果」（action 的返回值，JSON）、已发出的 write 请求、
 * 出错的地方。run 窗口目录、变成 verified 的 draft 由 finishRun 接在后面。
 */
function outcomeLines(name: string, outcome: Outcome): string[] {
  const lines: string[] = [];
  if (outcome.status === "success") {
    lines.push(`ok ${name}`, `结果：\n${indent(JSON.stringify(outcome.result ?? null, null, 2))}`);
  } else if (outcome.status === "failure") {
    const [head, ...more] = outcome.error.split("\n");
    lines.push(`fail ${name}：${head}`);
    if (more.length) lines.push(`错误：\n${indent(more.join("\n"))}`);
    if (outcome.failedAction) lines.push(`出错的 action：${outcome.failedAction}`);
    if (outcome.page) lines.push(`页面：${outcome.page.url} "${outcome.page.title}"`, ...(outcome.page.screenshot ? [`截图：${outcome.page.screenshot}`] : []));
    if (outcome.hint) lines.push(`下一步：${outcome.hint}`);
  }
  if (outcome.writes?.length) lines.push(`已发出的 write 请求：\n${indent(outcome.writes.join("\n"))}`);
  return lines;
}

/**
 * run 停在 lore.ask：存恢复记录、输出问题和数据，不存 compose（返回 true）。其他结果返回 false。
 * 恢复成功或再次停下后，用过的恢复编号作废；恢复失败时保留，agent 可以改了回答再恢复。
 */
function handleAsk(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts, target: { code?: string; action?: string }): boolean {
  if (outcome.status !== "failure" && o.resumed) pendingAsks.delete(o.resumed);
  if (outcome.status !== "ask") return false;
  const id = `AS-${randomBytes(4).toString("hex")}`;
  pendingAsks.set(id, { t: Date.now(), question: outcome.question, description: o.description, ...target, params: o.params, timeoutSec: o.timeoutSec, journal: outcome.journal, answers: o.askState?.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: outcome.runWindow ?? "" }))] });
  while (pendingAsks.size > ASK_KEEP) pendingAsks.delete(pendingAsks.keys().next().value!);
  out.code = EXIT.wait;
  out.line(`ask ${outcome.question}`);
  out.line(`数据：\n${indent(JSON.stringify(outcome.data ?? null, null, 2))}`);
  if (outcome.writes?.length) out.line(`已发出的 write 请求：\n${indent(outcome.writes.join("\n"))}`);
  out.line(`恢复：lore run --resume ${id} --answer '<json>'（前面已执行的 action 不会重跑；30 分钟内有效）`);
  if (outcome.runWindow) out.line(`run 窗口目录：${ctx.log.winDir(outcome.runWindow)}`);
  return true;
}

/** run 结束后的共同收尾：写 run 窗口的 meta，判断 draft 变成 verified（多行 @endpoint 要按顺序发出才变成 verified），提醒开着的 learn 窗口。返回要追加的文字行。 */
function finishRun(ctx: Ctx, outcome: Outcome, o: RunOpts): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) ctx.log.writeMeta(win, { ...old, description: o.description, status: outcome.status, ...(outcome.writes?.length ? { writes: outcome.writes } : {}), endedAt: Date.now() });
    lines.push(`run 窗口目录：${ctx.log.winDir(win)}（窗口已关，日志留着）`);
  }
  const drafts: DraftRun[] = [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: win ?? "" }))];
  if (outcome.status === "success" && drafts.length) {
    ctx.ingest.flush();
    const sentOf = new Map<string, string[]>();
    const sent = (w: string): string[] => {
      let list = sentOf.get(w);
      if (!list) { list = (w ? ctx.log.readRows(w, { limit: 5000 }) : []).filter((r) => (r.type === "cmd" && r.kind === "request") || (r.type === "request" && !r.noise)).map((r) => (r.type === "cmd" ? String(r.detail?.endpoint ?? "") : r.endpoint ?? "")); sentOf.set(w, list); }
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
    if (promoted.length) lines.push(`已变成 verified：${promoted.join("、")}`);
    if (kept.length) lines.push(`没有变成 verified：${kept.join("；")}`);
  }
  const open = ctx.learn.opened();
  if (outcome.status === "failure" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => w.id).join("、")} 还开着：失败的 action 如果在那里 run 成功过，多半是 action 缺了进入那个页面状态的前置步骤（先 goto 哪个页面、少了哪个前置请求），或者 auth 头没声明来源（看观察里的"auth 来源"，写进 request 的 auth）；对比两个窗口的 timeline.jsonl`);
  if (outcome.status === "success" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => `${w.id}（空闲 ${idleMin(w)} 分钟）`).join("、")} 还开着，事情做完就 lore learn <句柄> close`);
  return lines;
}

async function runNamed(ctx: Ctx, out: Output, o: RunOpts & { actionName: string }): Promise<void> {
  const { actionName, description } = o;
  const found = findAction(ctx.log.dir, actionName, composeDirOf(ctx));
  const outcome = await ctx.runner.runAction(actionName, o.params, undefined, { askState: o.askState });
  if (handleAsk(ctx, out, outcome, o, { action: actionName })) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  if (found && outcome.status === "success") {
    const summary = actionSummary(found.file, found.site);
    // 真跑成功：compose 累加 description 和次数；学出来的 action，这句话记成它覆盖的 endpoint 的 description
    if (isComposed(summary)) saveComposed(found.file, fs.readFileSync(found.file, "utf8"), description);
    else if (found.site) for (const ep of summary.endpoints) ctx.index.describe(found.site, ep, { text: description, from: "run" });
  }
  for (const line of [...outcomeLines(actionName, outcome), ...finishRun(ctx, outcome, o)]) out.line(line);
}

async function composeRun(ctx: Ctx, out: Output, o: RunOpts & { code: string }): Promise<void> {
  const globalDir = composeDirOf(ctx);
  const outcome = await ctx.runner.runCompose(o.code, (o.timeoutSec ?? 115) * 1000, o.params, o.askState, "compose");
  if (handleAsk(ctx, out, outcome, o, { code: o.code })) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  for (const line of outcomeLines("compose", outcome)) out.line(line);
  const tail = finishRun(ctx, outcome, o);
  if (outcome.status === "success") {
    const saved = saveComposed(composeTarget(globalDir, o.code), o.code, o.description);
    pruneUnnamed(globalDir);
    const runName = path.basename(saved.file, ".js");
    out.line(`已存为 compose：${runName}（${saved.file}；下次 lore run --compose ${runName} --description "…" --参数 值；要改就直接改这个文件）`);
    if (!saved.params.length) out.line("下一步：变化的值写成 lore.params.名字 ?? 默认值，下次直接换参数复用，不用改代码");
  }
  for (const line of tail) out.line(line);
}
