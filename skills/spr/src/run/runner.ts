import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { ACTION_DIR, ACTION_TIMEOUT_MS, HELPERS_DIR, SESSION_DIR } from "../utils/constants.ts";
import { RunHost, Session, type FailurePage, type RunOps, type RunPerf } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { LOGIN_HINT, isLoginUrl } from "../utils/url.ts";
import { actionSummary, actionTimeoutMs, checkParams, coerceParams, findAction } from "./actions.ts";

/**
 * 失败的类别，只放 speedrun 确定知道的：not-defined 名字找不到；blocked 依赖写不出来；param 参数不对；
 * usage 写法不对（嵌套超过 2 层、run -e 直接操作页面）；timeout 超过时间上限；cancelled 调用 spr 的进程退出了；
 * action-throw 脚本自己抛的错；internal speedrun 自己的错。
 */
export type ErrorCode = "not-defined" | "blocked" | "param" | "usage" | "timeout" | "cancelled" | "action-throw" | "internal";

/** 每次嵌套 action() 调用：名字、耗时、结果。 */
export type CallRecord = { name: string; ms: number; status: "success" | "failure" };

/**
 * runWindow：这次 run 用的 run 窗口（名字）；drafts：这次真跑成功的 draft（文件路径），由命令层变成 verified；
 * sent：脚本经 request() 主动发出的非 GET 请求；pageSent：页面加载或交互自发触发的非 GET 请求。只在最外层有。
 */
export type Outcome = (
  | { status: "success"; result: unknown }
  | { status: "failure"; error: string; code?: ErrorCode; at?: string; stack?: string; failedAction?: string; page?: FailurePage; hint?: string }
) & {
  runWindow?: string;
  drafts?: string[];
  sent?: string[];
  pageSent?: string[];
  dialogs?: string[];
  calls?: CallRecord[];
  perf?: RunPerf;
  ops?: RunOps;
};

/** action 之间允许最多两层调用（A → B），禁止 B 再调 C 或自递归。 */
const MAX_ACTION_DEPTH = 2;

export type RunnerPaths = { actionDir: string };
const DEFAULT_PATHS: RunnerPaths = { actionDir: ACTION_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

/**
 * run 窗口的开和关：每次 run 新开一个（open 返回窗口名，也是 agent 窗口的 key 和日志目录名），跑完关掉浏览器窗口（日志目录留着）。
 */
export type RunWindows = { open(label: string, meta: Record<string, unknown>): string; close(key: string): Promise<void>; failureFile(key: string): string; shotFile(key: string): string };
const NO_WINDOWS: RunWindows = { open: (label) => label, close: async () => {}, failureFile: (key) => path.join(SESSION_DIR, `${key}-failure`), shotFile: (key) => path.join(SESSION_DIR, `${key}-${Date.now()}`) };

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

export type RunOptions = { depth?: number; chain?: string[]; signal?: AbortSignal };

/** 一次 run（含嵌套调用的 action）共用的记录：完整 stack、每次 action() 调用、最先失败的类别、取消信号。 */
type Trace = { stacks: string[]; calls: CallRecord[]; code?: ErrorCode; signal?: AbortSignal };

/** 用户写的文件：action、helpers。报错里只留这些文件的 stack 帧，speedrun 自己的完整存进 error.txt。 */
const USER_DIRS = [ACTION_DIR, HELPERS_DIR].map((d) => `${d}${path.sep}`);
const isUserFrame = (line: string, dirs: string[]): boolean => /^\s*at /.test(line) && dirs.some((d) => line.includes(d));

/** 报错原文 → 给 agent 看的：错误信息加用户文件的帧；at：第一个用户文件的位置（file:line）。 */
export function trimError(message: string, stack: string, dirs = USER_DIRS): { text: string; at?: string } {
  const frames = stack.split("\n").filter((l) => isUserFrame(l, dirs) && !message.includes(l.trim())).map((l) => l.trim());
  const first = [...message.split("\n"), ...frames].find((l) => isUserFrame(l, dirs));
  const m = first?.match(/(?:file:\/\/)?(\/[^\s()]+?):(\d+):\d+\)?$/);
  return { text: [message, ...frames].join("\n"), ...(m ? { at: `${m[1]}:${m[2]}` } : {}) };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;

/**
 * 把 spr run -e '<js>' 的内联代码包成 worker 可加载的 ES 模块：
 * - 顶层 import 语句保留在模块最前；自动注入未声明的 action、sleep；
 * - 单表达式（没写 return）自动 return，多语句块按原样执行。
 */
export function wrapInlineCode(raw: string): string {
  const trimmed = raw.trim();
  if (/\bexport\s+default\b/.test(trimmed)) return trimmed;
  const imports: string[] = [];
  const restLines: string[] = [];
  let inImports = true;
  for (const line of trimmed.split("\n")) {
    if (inImports && /^\s*(?:import\s+.+|\/\/.*)?$/.test(line)) imports.push(line);
    else { inImports = false; restLines.push(line); }
  }
  const body = restLines.join("\n").trim();
  const hasAction = imports.some((l) => /\baction\b/.test(l));
  const hasSleep = imports.some((l) => /\bsleep\b/.test(l));
  const inject: string[] = [];
  if (!hasAction) inject.push("action");
  if (!hasSleep) inject.push("sleep");
  const header = [...(inject.length ? [`import { ${inject.join(", ")} } from "spr";`] : []), ...imports].join("\n");
  if (body && !/\breturn\b/.test(body)) {
    try {
      new AsyncFunction("action", "sleep", `return (\n${body}\n);`);
      return `${header}\nexport default async () => (\n${body}\n);\n`;
    } catch { /* 按语句块包 */ }
  }
  return `${header}\nexport default async () => {\n${body}\n};\n`;
}

/** 在 worker 线程里跑 action 或 spr run -e 内联组合。每次 run 有自己的 run 窗口，不同的 run 可以同时跑。 */
export class ActionRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly windows: RunWindows;
  private readonly traces = new Map<string, Trace>();
  /** 正在后台关的 run 窗口：结果先返回，daemon 退出前等它们关完（drain）。 */
  private readonly closing = new Set<Promise<void>>();
  /** 单个 action 的超时（自检里调小）；默认按文件头的 @timeout 或 ACTION_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: Partial<RunnerPaths> = {}, windows: RunWindows = NO_WINDOWS) {
    this.host = host;
    this.paths = { ...DEFAULT_PATHS, ...paths };
    this.windows = windows;
  }

  /** 按名字运行 action；嵌套调用（nested 传进来）共用这次 run 的窗口和已打开的页面，最多嵌套 MAX_ACTION_DEPTH 层。 */
  async runAction(name: string, params: Record<string, unknown>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const depth = opts.depth ?? 1;
    const chain = [...(opts.chain ?? []), name];
    const earlyFail = (code: ErrorCode, error: string): Outcome => {
      if (nested) {
        const tr = this.traces.get(nested.key);
        if (tr) tr.code ??= code;
      }
      return { status: "failure", code, error, ...(nested ? { failedAction: name } : {}) };
    };
    if (depth > MAX_ACTION_DEPTH) {
      return earlyFail("usage", `action 嵌套调用最多 ${MAX_ACTION_DEPTH} 层（${chain.join(" → ")}）：把公共纯函数放进 ~/.speedrun/helpers/，或在顶层用 spr run -e 组合`);
    }
    if (opts.chain?.includes(name)) {
      return earlyFail("usage", `action 不能递归调用自己（${chain.join(" → ")}）`);
    }
    const found = findAction(this.paths.actionDir, name);
    if (!found) return earlyFail("not-defined", `${name} is not defined（action 在 ${this.paths.actionDir}/<站点>/<名字>.js）`);
    const file = found.file;
    const summary = actionSummary(file, found.site);
    if (summary.status === "blocked") {
      return earlyFail("blocked", `[${name}] 是写不出来的 action（@status blocked，原因见 ${file} 的 @note）：不要再 debug，向用户说明卡在哪；有新证据才把 @status 改回 draft、在 @note 写明为什么`);
    }
    const problem = checkParams(file, params);
    if (problem) return earlyFail("param", `[${name}] ${problem}`);
    const typed = coerceParams(file, params);
    if ("error" in typed) return earlyFail("param", `[${name}] ${typed.error}`);
    params = typed.params;
    const key = nested?.key ?? this.windows.open(name, { action: name, params });
    if (!nested) this.traces.set(key, { stacks: [], calls: [], ...(opts.signal ? { signal: opts.signal } : {}) });
    const trace = this.traces.get(key)!;
    const session = new Session(key);
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.fresh = nested.fresh; }
    else this.host.watchSent(key);
    try {
      const out = await this.work(file, params, actionTimeoutMs(file), session, depth, chain);
      if (out.status === "failure" && nested) { out.failedAction ??= name; trace.code ??= out.code; }
      if (out.status === "failure" && !nested) await this.decorateFailure(out, session, key, name, trace);
      if (out.status === "success" && summary.status === "draft") session.draftsOk.push(file);
      if (nested) {
        nested.tab = session.tab; nested.origin = session.origin; nested.fresh = session.fresh;
        nested.draftsOk.push(...session.draftsOk);
      } else {
        this.attachWindowSummary(out, key, session, trace);
      }
      return out;
    } finally {
      if (!nested) await this.cleanupOuter(key, session);
    }
  }

  /** 免落盘运行一段内联组合代码（spr run -e '<js>'）：共用一个 run 窗口，只能调 action() 和 sleep()。 */
  async runInline(code: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Outcome> {
    const key = this.windows.open("inline", { action: "-e", mode: "inline" });
    this.traces.set(key, { stacks: [], calls: [], ...(opts.signal ? { signal: opts.signal } : {}) });
    const trace = this.traces.get(key)!;
    const session = new Session(key);
    session.inlineOnly = true;
    this.host.watchSent(key);
    const rootDir = path.dirname(this.paths.actionDir);
    fs.mkdirSync(rootDir, { recursive: true });
    const tmp = path.join(rootDir, `.inline-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    fs.writeFileSync(tmp, wrapInlineCode(code), "utf8");
    try {
      const out = await this.work(tmp, {}, opts.timeoutMs ?? ACTION_TIMEOUT_MS, session, 0, []);
      if (out.status === "failure") {
        out.error = out.error.split(tmp).join("<spr run -e>");
        if (out.at) out.at = out.at.split(tmp).join("<spr run -e>");
        if (out.error.includes("不能直接操作页面或发 request")) out.code = "usage";
        trace.stacks = trace.stacks.map((t) => t.split(tmp).join("<spr run -e>"));
        await this.decorateFailure(out, session, key, "-e", trace);
      }
      this.attachWindowSummary(out, key, session, trace);
      return out;
    } finally {
      fs.rmSync(tmp, { force: true });
      await this.cleanupOuter(key, session);
    }
  }

  private async decorateFailure(out: Extract<Outcome, { status: "failure" }>, session: Session, key: string, label: string, trace: Trace): Promise<void> {
    if (out.failedAction && trace.code) out.code = trace.code;
    out.code ??= "internal";
    if (trace.stacks.length) out.stack = trace.stacks.join("\n\n");
    const page = await this.host.failureShot(session, this.windows.failureFile(key));
    if (page) out.page = page;
    if (page?.url && isLoginUrl(page.url)) {
      const debugName = out.failedAction ?? (label === "-e" ? "explore" : label);
      out.hint = `页面地址命中登录页规则（login、sso、passport 这类）：${page.url}。如果是登录失效：${LOGIN_HINT}；要点登录的，用 spr debug ${debugName} navigate <这个页面> 去点`;
    }
    this.addRejected(out, key);
  }

  private attachWindowSummary(out: Outcome, key: string, session: Session, trace: Trace): void {
    out.runWindow = key;
    out.drafts = [...new Set(session.draftsOk)];
    out.sent = this.host.takeSent(key);
    const pageSent = this.host.takePageSent?.(key) ?? [];
    if (pageSent.length) out.pageSent = pageSent;
    out.dialogs = this.host.takeDialogs(key);
    const st = this.host.takeStats?.(key);
    if (st) { out.perf = st.perf; out.ops = st.ops; }
    if (trace.calls.length) out.calls = trace.calls;
  }

  private async cleanupOuter(key: string, session: Session): Promise<void> {
    this.traces.delete(key);
    this.host.takeSent(key);
    this.host.takePageSent?.(key);
    this.host.takeStats?.(key);
    await this.host.end(session);
    this.closeLater(key);
  }

  private closeLater(key: string): void {
    const p: Promise<void> = this.windows.close(key).catch(() => {}).finally(() => { this.closing.delete(p); });
    this.closing.add(p);
  }

  async drain(): Promise<void> { await Promise.all([...this.closing]); }

  private addRejected(out: Outcome, key: string): void {
    const why = this.host.takeRejected(key);
    if (why && out.status === "failure") out.hint = out.hint ? `${why}\n${out.hint}` : why;
  }

  private shoot(session: Session, args: Record<string, unknown>): Promise<{ file: string; w: number; h: number; vw: number; vh: number }> {
    return (this.host.op(session, "screenshot", args) as Promise<{ data: string; mime: string; w: number; h: number; vw: number; vh: number }>).then((r) => {
      const file = `${this.windows.shotFile(session.key)}.${r.mime.includes("png") ? "png" : "jpg"}`;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"), { mode: 0o600 });
      return { file, w: r.w, h: r.h, vw: r.vw, vh: r.vh };
    });
  }

  private work(file: string, params: Record<string, unknown>, timeoutMs: number, session: Session, depth: number, chain: string[]): Promise<Outcome> {
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    const trace = this.traces.get(session.key);
    const userDirs = [this.paths.actionDir, HELPERS_DIR].map((d) => `${d}${path.sep}`);
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
        if (out.status === "failure" && logs.length) out.error += `\n--- action 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", code: "timeout", error: `action 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>（或 spr run -e --timeout <秒>），超过 2 分钟的放到后台跑` }), limit);
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
        let run: Promise<unknown>;
        if (m.op === "action") {
          const name = String(m.args.name);
          const p = Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
          const t0 = Date.now();
          run = this.runAction(name, p, session, { depth: depth + 1, chain }).then((o) => {
            trace?.calls.push({ name, ms: Date.now() - t0, status: o.status === "success" ? "success" : "failure" });
            if (o.status === "failure") {
              failedAction = o.failedAction ?? name;
              throw new Error(o.error.startsWith(`[${name}]`) ? o.error : `[${name}] ${o.error}`);
            }
            return o.result;
          });
        } else if (m.op === "screenshot") run = this.shoot(session, m.args);
        else run = this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
