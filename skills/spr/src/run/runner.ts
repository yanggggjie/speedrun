import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { COMPOSE_DIR, SESSION_DIR, ACTION_DIR, HELPERS_DIR } from "../utils/constants.ts";
import { RunHost, Session, type FailurePage } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { PendingAsks } from "./asks.ts";
import { LOGIN_HINT, isLoginUrl } from "../utils/url.ts";
import { actionSummary, actionTimeoutMs, checkParams, coerceParams, findAction, isCompose } from "./actions.ts";
import { composeCallError } from "./link.ts";

/** 最外层 compose 里成功的 action() 调用，按调用顺序。恢复时按内容复用：名字和参数都相同的第 k 次调用返回记下的第 k 个结果，其余照常执行。 */
export type JournalEntry = { name: string; params: Record<string, unknown>; result: unknown };
/** agent 给过的回答：同一个问题的第 k 次 ask 返回第 k 个回答。 */
export type Answer = { question: string; answer: unknown };
/** 最外层 compose 的重跑状态：成功过的 action 和 agent 给过的回答。 */
export type AskState = { journal: JournalEntry[]; answers: Answer[] };
/**
 * 失败的类别，只放 speedrun 确定知道的：not-defined 名字找不到；blocked 依赖写不出来；param 参数不对；usage 写法不对（compose 调用 compose、ask 数据太大）；
 * timeout 超过 @timeout；cancelled 调用 spr 的进程退出了；action-throw action 或 compose 自己抛的错；internal speedrun 自己的错。
 * 请求被拒、登录失效这类靠规则猜的不在这里，只在说明里给事实。
 */
export type ErrorCode = "not-defined" | "blocked" | "param" | "usage" | "timeout" | "cancelled" | "action-throw" | "internal";
/** compose 里每次 action() 调用：名字、耗时、结果；cached 是恢复时直接复用了记下的结果。 */
export type CallRecord = { name: string; ms: number; status: "success" | "failure"; cached?: boolean };
/** ask 的 code：停下那一刻 compose 文件的内容，恢复时照它重放（中途改了文件也不影响）。runWindow：这次 run 用的 run 窗口（名字）；drafts：这次真跑成功的 draft（文件路径），由命令层判断变成 verified；sent：这次实际发出的非 GET 请求（`POST /api/x ×2`）。三者只在最外层有。 */
export type Outcome = (
  | { status: "success"; result: unknown }
  | { status: "failure"; error: string; code?: ErrorCode; at?: string; stack?: string; failedAction?: string; page?: FailurePage; hint?: string; journal?: JournalEntry[]; answers?: Answer[] }
  | { status: "ask"; question: string; data: unknown; journal: JournalEntry[]; code?: string }
) & { runWindow?: string; drafts?: string[]; sent?: string[]; dialogs?: string[]; calls?: CallRecord[] };

const ASK_DATA_LIMIT = 100 * 1024;

/** actionDir：各站点的 action 文件在它下面；composeDir：compose。 */
export type RunnerPaths = { actionDir: string; composeDir: string };
const DEFAULT_PATHS: RunnerPaths = { actionDir: ACTION_DIR, composeDir: COMPOSE_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

/**
 * run 窗口的开和关：每次 run 新开一个（open 返回窗口名，也是 agent 窗口的 key 和日志目录名），跑完关掉浏览器窗口（日志目录留着）。
 * failureFile：失败截图存在哪（不含扩展名）。daemon 里接到 AgentWindows 和 WindowLog；自检里用假的。
 */
export type RunWindows = { open(label: string, meta: Record<string, unknown>): string; close(key: string): Promise<void>; failureFile(key: string): string; shotFile(key: string): string };
const NO_WINDOWS: RunWindows = { open: (label) => label, close: async () => {}, failureFile: (key) => path.join(SESSION_DIR, `${key}-failure`), shotFile: (key) => path.join(SESSION_DIR, `${key}-${Date.now()}`) };

/** daemon 里的 run 窗口：名字 <action 或 compose 名>-<时间>，日志在 run-windows/<名字>/，跑完关掉浏览器窗口。 */
export function runWindowsOf(log: Pick<WindowLog, "freshName" | "openWindow" | "winDir">, win: Pick<AgentWindows, "dispose">): RunWindows {
  return {
    open(label, meta) {
      const key = log.freshName(label);
      log.openWindow(key, "run", meta);
      return key;
    },
    close: (key) => win.dispose(key),
    failureFile: (key) => path.join(log.winDir(key), "screenshots", "failure"),
    shotFile: (key) => path.join(log.winDir(key), "screenshots", `action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
  };
}

/** askState：恢复一次停在 ask 的 compose；code：恢复时用停下那一刻的 compose 代码；from：嵌套调用时，发起调用的 compose 名；signal：取消这次 run（调用 spr 的进程退出了）。 */
export type RunOptions = { askState?: AskState; code?: string; from?: string; signal?: AbortSignal };

/** 一次 run（含 compose 调用的 action）共用的记录：完整报错（含被裁掉的 stack）、每次 action() 调用、最先失败的类别、取消信号。 */
type Trace = { stacks: string[]; calls: CallRecord[]; code?: ErrorCode; signal?: AbortSignal };

/** 用户写的文件：action、compose、helpers。报错里只留这些文件的 stack 帧，speedrun 自己的（worker、lib、node 内部）完整的存进文件。 */
const USER_DIRS = [ACTION_DIR, COMPOSE_DIR, HELPERS_DIR].map((d) => `${d}${path.sep}`);
const isUserFrame = (line: string, dirs: string[]): boolean => /^\s*at /.test(line) && dirs.some((d) => line.includes(d));
/** 报错原文 → 给 agent 看的：错误信息加用户文件的帧；at：第一个用户文件的位置（file:line）。 */
export function trimError(message: string, stack: string, dirs = USER_DIRS): { text: string; at?: string } {
  // 嵌套的 action 失败时，它的帧已经在 message 里了（compose 把它的报错原样再抛一次），不重复列
  const frames = stack.split("\n").filter((l) => isUserFrame(l, dirs) && !message.includes(l.trim())).map((l) => l.trim());
  const first = [...message.split("\n"), ...frames].find((l) => isUserFrame(l, dirs));
  const m = first?.match(/(?:file:\/\/)?(\/[^\s()]+?):(\d+):\d+\)?$/);
  return { text: [message, ...frames].join("\n"), ...(m ? { at: `${m[1]}:${m[2]}` } : {}) };
}
/** 按 key 分组、组内按顺序取用的队列；rest：还没取用的（保持原来的顺序）。 */
function queue<T>(items: Array<[string, T]>): { take(key: string): T | undefined; rest(): T[] } {
  const used = new Set<number>();
  return {
    take(key) { const i = items.findIndex(([k], j) => k === key && !used.has(j)); if (i < 0) return undefined; used.add(i); return items[i]![1]; },
    rest: () => items.filter((_, j) => !used.has(j)).map(([, v]) => v),
  };
}
const keyOf = (name: string, params: Record<string, unknown>): string => `${name} ${stable(params)}`;
/** 参数的规范写法：key 排序、去掉 undefined，同样的参数写法不同也算同一次调用。 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** 在 worker 线程里跑 action。每次 run 有自己的 run 窗口，不同的 run 可以同时跑。 */
export class ActionRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly windows: RunWindows;
  /** 可以接着跑的 run 的恢复记录。 */
  readonly asks = new PendingAsks();
  /** 正在跑的 run 的共用记录，按 run 窗口名。 */
  private readonly traces = new Map<string, Trace>();
  /** 正在后台关的 run 窗口：结果先返回，daemon 退出前等它们关完（drain）。 */
  private readonly closing = new Set<Promise<void>>();
  /** 单个 action 的超时（自检里调小）；默认按文件头的 @timeout 或 ACTION_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: Partial<RunnerPaths> = {}, windows: RunWindows = NO_WINDOWS) { this.host = host; this.paths = { ...DEFAULT_PATHS, ...paths }; this.windows = windows; }

  /** 按名字运行：spr run 跑 compose，compose 里的 action() 调用跑 action（nested 传进来，共用这次 run 的窗口和页面）。compose 不能调用 compose。draft 也能跑。 */
  async runAction(name: string, params: Record<string, unknown>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const found = findAction(this.paths.actionDir, name, this.paths.composeDir);
    const tag = nested ? { failedAction: name } : {};
    if (!found) return { status: "failure", code: "not-defined", error: `${name} is not defined（action 在 ${this.paths.actionDir}/<站点>/，compose 在 ${this.paths.composeDir}/）`, ...tag };
    const file = found.file;
    const summary = actionSummary(file);
    if (summary.status === "blocked") return { status: "failure", code: "blocked", error: `[${name}] 是写不出来的 action（@status blocked，原因见 ${file} 的 @note）：不要再 debug，向用户说明卡在哪；有新证据才把 @status 改回 draft、在 @note 写明为什么，回 debug 窗口修`, ...tag };
    const composed = isCompose(found);
    if (nested && composed) return { status: "failure", code: "usage", error: composeCallError(opts.from ?? "compose", name), ...tag };
    const problem = checkParams(file, params);
    if (problem) return { status: "failure", code: "param", error: `[${name}] ${problem}`, ...tag };
    const typed = coerceParams(file, params);
    if ("error" in typed) return { status: "failure", code: "param", error: `[${name}] ${typed.error}`, ...tag };
    params = typed.params;
    const key = nested?.key ?? this.windows.open(name, { action: name, params });
    if (!nested) this.traces.set(key, { stacks: [], calls: [], ...(opts.signal ? { signal: opts.signal } : {}) });
    const trace = this.traces.get(key)!;
    // 嵌套调用（compose 调用的 action）共用页面状态；compose 的"只能调用 action"只约束 compose 自己的代码
    const session = new Session(key);
    session.composeOnly = composed;
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.fresh = nested.fresh; }
    else this.host.watchSent(key);
    try {
      // compose 带重跑状态（ask 和失败后恢复用）
      const state = composed ? (opts.askState ?? { journal: [], answers: [] }) : undefined;
      const code = composed ? opts.code ?? fs.readFileSync(file, "utf8") : undefined;
      const out: Outcome = code !== undefined
        ? await this.execCompose(file, code, params, actionTimeoutMs(file), session, name, state)
        : await this.work(file, params, actionTimeoutMs(file), session);
      if (out.status === "ask") out.code = code;
      if (out.status === "failure" && nested) { out.failedAction ??= name; trace.code ??= out.code; }
      // compose 里的 action 失败，compose 自己再抛出来：类别以最先失败的 action 为准
      if (out.status === "failure" && !nested) { if (out.failedAction && trace.code) out.code = trace.code; out.code ??= "internal"; if (trace.stacks.length) out.stack = trace.stacks.join("\n\n"); }
      if (out.status === "failure" && state) { out.journal = state.journal; out.answers = state.answers; }
      if (out.status === "failure" && !nested) {
        const page = await this.host.failureShot(session, this.windows.failureFile(key));
        if (page) out.page = page;
        // 只给事实：页面地址是否命中登录页规则；是不是登录失效由 agent 看截图判断
        if (page?.url && isLoginUrl(page.url)) out.hint = `页面地址命中登录页规则（login、sso、passport 这类）：${page.url}。如果是登录失效：${LOGIN_HINT}；要点登录的，用 spr debug ${name} navigate <这个页面> 去点`;
      }
      if (out.status === "failure" && !nested) this.addRejected(out, key);
      if (out.status === "success" && summary.status === "draft") session.draftsOk.push(file);
      if (nested) { nested.tab = session.tab; nested.origin = session.origin; nested.fresh = session.fresh; nested.draftsOk.push(...session.draftsOk); }
      else { out.runWindow = key; out.drafts = [...session.draftsOk]; out.sent = this.host.takeSent(key); out.dialogs = this.host.takeDialogs(key); if (trace.calls.length) out.calls = trace.calls; }
      return out;
    } finally {
      if (!nested) { this.traces.delete(key); this.host.takeSent(key); await this.host.end(session); this.closeLater(key); }
    }
  }

  /** 关 run 窗口不挡结果：关标签组要 0.1～0.5 秒，每个 run 都等就白白变慢。关失败不影响这次结果，daemon 重启时组也会被清掉。 */
  private closeLater(key: string): void {
    const p: Promise<void> = this.windows.close(key).catch(() => {}).finally(() => { this.closing.delete(p); });
    this.closing.add(p);
  }

  /** 等后台关窗口都做完（daemon 退出前），否则会留下 speedrun 的组。 */
  async drain(): Promise<void> { await Promise.all([...this.closing]); }

  /** 失败时，这个窗口里有请求被 401/403 拒过：把抄了什么、没抄什么、下一步放在 hint 最前面。 */
  private addRejected(out: Outcome, key: string): void {
    const why = this.host.takeRejected(key);
    if (why && out.status === "failure") out.hint = out.hint ? `${why}\n${out.hint}` : why;
  }

  /**
   * 跑 compose：把代码写成它旁边的一个临时文件再跑（文件里的相对 import 照样能用）。
   * 每次都跑这一刻读到的代码：恢复时传进来的是停下那一刻的代码，agent 中途改了文件也不影响重放。
   */
  private async execCompose(file: string, code: string, params: Record<string, unknown>, timeoutMs: number, session: Session, owner: string, askState?: AskState): Promise<Outcome> {
    const tmp = path.join(path.dirname(file), `.run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    fs.writeFileSync(tmp, code, "utf8");
    try {
      const out = await this.work(tmp, params, timeoutMs, session, askState, owner);
      // 报错里的临时文件名换回 compose 文件（代码一样，行号对得上）
      if (out.status === "failure") { out.error = out.error.split(tmp).join(file); if (out.at) out.at = out.at.split(tmp).join(file); }
      const trace = this.traces.get(session.key);
      if (trace) trace.stacks = trace.stacks.map((t) => t.split(tmp).join(file));
      return out;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** action 里的截图：图存进窗口目录，只把路径交回去，图的内容不经过结果和上下文。 */
  private async shoot(session: Session, args: Record<string, unknown>): Promise<{ file: string; w: number; h: number; vw: number; vh: number }> {
    const r = (await this.host.op(session, "screenshot", args)) as { data: string; mime: string; w: number; h: number; vw: number; vh: number };
    const file = `${this.windows.shotFile(session.key)}.${r.mime.includes("png") ? "png" : "jpg"}`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"), { mode: 0o600 });
    return { file, w: r.w, h: r.h, vw: r.vw, vh: r.vh };
  }

  /**
   * askState 只有最外层 compose 才有：每次 action() 按调用顺序记进 journal；恢复时从头重跑代码，
   * 前面记下的 action() 直接返回记录的结果（不重复发请求），第 i 次 ask 返回第 i 个回答，没有回答就停下交给 agent。
   */
  private work(file: string, params: Record<string, unknown>, timeoutMs: number, session: Session, askState?: AskState, owner?: string): Promise<Outcome> {
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    const trace = this.traces.get(session.key);
    const userDirs = [this.paths.actionDir, this.paths.composeDir, HELPERS_DIR].map((d) => `${d}${path.sep}`);
    // 恢复时按内容复用：上次成功的调用按「名字 + 参数」分组，同一组按顺序取；这次的调用重新记一遍，没用到的接在后面留给下一次恢复
    const calls = queue<{ name: string; params: Record<string, unknown>; result: unknown }>((askState?.journal ?? []).map((e) => [keyOf(e.name, e.params), e]));
    const answers = queue<Answer>((askState?.answers ?? []).map((a) => [a.question, a]));
    if (askState) askState.journal = [];
    return new Promise((resolve) => {
      const logs: string[] = [];
      const worker = new Worker(WORKER, { workerData: { file, params }, env: {} });
      let settled = false;
      let failedAction: string | undefined;
      const onAbort = (): void => finish({ status: "failure", code: "cancelled", error: "已取消：调用 spr 的进程退出了（被停止、被杀或超时），这次 run 中止" });
      const finish = (out: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        trace?.signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        if (out.status === "failure" && failedAction) out.failedAction ??= failedAction;
        if (askState && out.status !== "success") askState.journal.push(...calls.rest());
        if (out.status === "failure" && logs.length) out.error += `\n--- action 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", code: "timeout", error: `action 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>，超过 2 分钟的用 Bash 的 run_in_background 跑` }), limit);
      if (trace?.signal?.aborted) onAbort();
      else trace?.signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("error", (e) => { trace?.stacks.push(String(e.stack ?? e)); finish({ status: "failure", code: "internal", error: `${e.name}: ${e.message}` }); });
      worker.on("exit", () => finish({ status: "failure", code: "internal", error: "action 没有返回结果就退出了" }));
      worker.on("message", (m: any) => {
        if (m.type === "done") return finish({ status: "success", result: m.result });
        if (m.type === "fail") {
          const stack = String(m.error), message = String(m.message ?? stack.split("\n")[0]);
          trace?.stacks.push(stack);
          const t = trimError(message, stack, userDirs);
          return finish({ status: "failure", code: "action-throw", error: t.text, ...(t.at ? { at: t.at } : {}) });
        }
        if (m.type === "log") { if (logs.length < MAX_LOG_LINES) logs.push(String(m.text).slice(0, 500)); return; }
        if (m.type !== "call") return;
        const reply = (body: Record<string, unknown>): void => { if (!settled) worker.postMessage({ type: "reply", id: m.id, ...body }); };
        if (m.op === "ask") {
          if (!askState) return reply({ error: "ask 只能用在 compose 里，action 里不能用" });
          const question = String(m.args.question ?? "");
          const prev = answers.take(question);
          if (prev) return reply({ result: prev.answer ?? null });
          const size = JSON.stringify(m.args.data ?? null).length;
          if (size > ASK_DATA_LIMIT) return finish({ status: "failure", code: "usage", error: `ask 交回的数据有 ${Math.round(size / 1024)}KB，超过 ${ASK_DATA_LIMIT / 1024}KB：先在 compose 代码里裁剪，只留判断要用的字段` });
          return finish({ status: "ask", question, data: m.args.data ?? null, journal: askState.journal });
        }
        let run: Promise<unknown>;
        if (m.op === "action") {
          if (!session.composeOnly) return reply({ error: "action 里不能调用别的 action：要串起几个 action，写成 compose（~/.speedrun/compose/<名>.js，再 spr run <名>）" });
          const name = String(m.args.name);
          const p = Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
          const prev = calls.take(keyOf(name, p));
          if (prev) {
            askState?.journal.push(prev);
            trace?.calls.push({ name, ms: 0, status: "success", cached: true });
            return reply({ result: prev.result ?? null });
          }
          const t0 = Date.now();
          run = this.runAction(name, p, session, { ...(owner ? { from: owner } : {}) }).then((o) => {
            trace?.calls.push({ name, ms: Date.now() - t0, status: o.status === "success" ? "success" : "failure" });
            if (o.status === "failure") failedAction = o.failedAction ?? name;
            if (o.status !== "success") throw new Error(`[${name}] ${o.status === "failure" ? o.error : "被调用的 action 不能 ask"}`);
            askState?.journal.push({ name, params: p, result: o.result });
            return o.result;
          });
        } else if (m.op === "screenshot") run = this.shoot(session, m.args);
        else run = this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
