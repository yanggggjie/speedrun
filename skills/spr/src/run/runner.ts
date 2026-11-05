import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { COMPOSE_DIR, SESSION_DIR, ACTION_DIR } from "../utils/constants.ts";
import { RunHost, Session, type FailurePage } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { PendingAsks } from "./asks.ts";
import { LOGIN_HINT, isLoginUrl } from "../utils/url.ts";
import { actionSummary, actionTimeoutMs, checkParams, coerceParams, findAction, isCompose } from "./actions.ts";

/** 最外层 compose 里每次 action() 调用的记录，按调用顺序；恢复时前几次直接返回记下的结果，不再执行。 */
export type JournalEntry = { name: string; params: Record<string, unknown>; result: unknown };
/** 最外层 compose 的重跑状态：已执行的 action 和 agent 给过的回答（按 ask 的顺序）。 */
export type AskState = { journal: JournalEntry[]; answers: unknown[] };
/** ask 的 code：停下那一刻 compose 文件的内容，恢复时照它重放（中途改了文件也不影响）。runWindow：这次 run 用的 run 窗口（名字）；drafts：这次真跑成功的 draft（文件路径），由命令层判断变成 verified；sent：这次实际发出的非 GET 请求（`POST /api/x ×2`）。三者只在最外层有。 */
export type Outcome = (
  | { status: "success"; result: unknown }
  | { status: "failure"; error: string; failedAction?: string; page?: FailurePage; hint?: string; journal?: JournalEntry[]; answers?: unknown[] }
  | { status: "ask"; question: string; data: unknown; journal: JournalEntry[]; code?: string }
) & { runWindow?: string; drafts?: string[]; sent?: string[]; dialogs?: string[] };

const ASK_DATA_LIMIT = 100 * 1024;

/** 失败时的页面看起来像登录页，或错误里是 401/403：多半是登录失效，不是 action 坏了。 */
export function looksLoggedOut(error: string, url: string | undefined): boolean {
  if (url && isLoginUrl(url)) return true;
  return /\b(401|403)\b|unauthori[sz]ed|未登录|登录/i.test(error);
}

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

/** askState：恢复一次停在 ask 的 compose；code：恢复时用停下那一刻的 compose 代码。 */
export type RunOptions = { askState?: AskState; code?: string };

/** 在 worker 线程里跑 action。每次 run 有自己的 run 窗口，不同的 run 可以同时跑。 */
export class ActionRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly windows: RunWindows;
  /** 可以接着跑的 run 的恢复记录。 */
  readonly asks = new PendingAsks();
  /** 正在后台关的 run 窗口：结果先返回，daemon 退出前等它们关完（drain）。 */
  private readonly closing = new Set<Promise<void>>();
  /** 单个 action 的超时（自检里调小）；默认按文件头的 @timeout 或 ACTION_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: Partial<RunnerPaths> = {}, windows: RunWindows = NO_WINDOWS) { this.host = host; this.paths = { ...DEFAULT_PATHS, ...paths }; this.windows = windows; }

  /** 按名字运行一个 action 或 compose（spr run，或 compose 里的 action() 调用）。nested 传进来表示嵌套调用，共用这次 run 的窗口和页面。draft 也能跑。 */
  async runAction(name: string, params: Record<string, unknown>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const found = findAction(this.paths.actionDir, name, this.paths.composeDir);
    const tag = nested ? { failedAction: name } : {};
    if (!found) return { status: "failure", error: `${name} is not defined（action 在 ${this.paths.actionDir}/<站点>/，compose 在 ${this.paths.composeDir}/）`, ...tag };
    const file = found.file;
    const summary = actionSummary(file);
    if (summary.status === "blocked") return { status: "failure", error: `[${name}] 是写不出来的 action（@status blocked，原因见 ${file} 的 @note）：不要再 debug，向用户说明卡在哪；有新证据才把 @status 改回 draft、在 @note 写明为什么，回 debug 窗口修`, ...tag };
    const composed = isCompose(found);
    const problem = checkParams(file, params);
    if (problem) return { status: "failure", error: `[${name}] ${problem}`, ...tag };
    const typed = coerceParams(file, params);
    if ("error" in typed) return { status: "failure", error: `[${name}] ${typed.error}`, ...tag };
    params = typed.params;
    const key = nested?.key ?? this.windows.open(name, { action: name, params });
    // 嵌套调用共用页面状态；compose 的"只能调用 action"只约束 compose 自己的代码，不约束被它调用的 action
    const session = new Session(key);
    session.composeOnly = composed;
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.fresh = nested.fresh; }
    else this.host.watchSent(key);
    try {
      // 只有最外层的 compose 能 ask 和恢复：嵌套调用的 compose 不带重跑状态
      const state = composed && !nested ? (opts.askState ?? { journal: [], answers: [] }) : undefined;
      const code = composed ? (nested ? undefined : opts.code) ?? fs.readFileSync(file, "utf8") : undefined;
      const out: Outcome = code !== undefined
        ? await this.execCompose(file, code, params, actionTimeoutMs(file), session, state)
        : await this.work(file, params, actionTimeoutMs(file), session);
      if (out.status === "ask") out.code = code;
      if (out.status === "failure" && nested) out.failedAction ??= name;
      if (out.status === "failure" && state) { out.journal = state.journal; out.answers = state.answers; }
      if (out.status === "failure" && !nested) {
        const page = await this.host.failureShot(session, this.windows.failureFile(key));
        if (page) out.page = page;
        if (looksLoggedOut(out.error, page?.url)) out.hint = `像是登录失效：用读图片的方式看 page.screenshot。要点登录的，用 spr debug ${name} navigate <这个页面> 打开 debug 窗口去点；${LOGIN_HINT}。`;
        else if (page?.screenshot) out.hint = "看 page.screenshot 判断页面停在了哪；页面正常但 action 失败，才是 action 坏了。";
      }
      if (out.status === "failure" && !nested) this.addRejected(out, key);
      if (out.status === "success" && summary.status === "draft") session.draftsOk.push(file);
      if (nested) { nested.tab = session.tab; nested.origin = session.origin; nested.fresh = session.fresh; nested.draftsOk.push(...session.draftsOk); }
      else { out.runWindow = key; out.drafts = [...session.draftsOk]; out.sent = this.host.takeSent(key); out.dialogs = this.host.takeDialogs(key); }
      return out;
    } finally {
      if (!nested) { this.host.takeSent(key); await this.host.end(session); this.closeLater(key); }
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
  private async execCompose(file: string, code: string, params: Record<string, unknown>, timeoutMs: number, session: Session, askState?: AskState): Promise<Outcome> {
    const tmp = path.join(path.dirname(file), `.run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    fs.writeFileSync(tmp, code, "utf8");
    try {
      return await this.work(tmp, params, timeoutMs, session, askState);
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
  private work(file: string, params: Record<string, unknown>, timeoutMs: number, session: Session, askState?: AskState): Promise<Outcome> {
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    return new Promise((resolve) => {
      const logs: string[] = [];
      const worker = new Worker(WORKER, { workerData: { file, params }, env: {} });
      let settled = false;
      let calls = 0, asks = 0;
      let failedAction: string | undefined;
      const finish = (out: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (out.status === "failure" && failedAction) out.failedAction ??= failedAction;
        if (out.status === "failure" && logs.length) out.error += `\n--- action 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", error: `action 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>` }), limit);
      worker.on("error", (e) => finish({ status: "failure", error: `${e.name}: ${e.message}` }));
      worker.on("exit", () => finish({ status: "failure", error: "action 没有返回结果就退出了" }));
      worker.on("message", (m: any) => {
        if (m.type === "done") return finish({ status: "success", result: m.result });
        if (m.type === "fail") return finish({ status: "failure", error: String(m.error).split("\n").slice(0, 8).join("\n") });
        if (m.type === "log") { if (logs.length < MAX_LOG_LINES) logs.push(String(m.text).slice(0, 500)); return; }
        if (m.type !== "call") return;
        const reply = (body: Record<string, unknown>): void => { if (!settled) worker.postMessage({ type: "reply", id: m.id, ...body }); };
        if (m.op === "ask") {
          if (!askState) return reply({ error: "ask 只能用在 spr run 直接跑的那个 compose 里：被它调用的 compose 和 action 里不能用" });
          const i = asks++;
          if (i < askState.answers.length) return reply({ result: askState.answers[i] ?? null });
          const size = JSON.stringify(m.args.data ?? null).length;
          if (size > ASK_DATA_LIMIT) return finish({ status: "failure", error: `ask 交回的数据有 ${Math.round(size / 1024)}KB，超过 ${ASK_DATA_LIMIT / 1024}KB：先在 compose 代码里裁剪，只留判断要用的字段` });
          return finish({ status: "ask", question: String(m.args.question ?? ""), data: m.args.data ?? null, journal: askState.journal });
        }
        let run: Promise<unknown>;
        if (m.op === "action") {
          if (!session.composeOnly) return reply({ error: "action 里不能调用别的 action：要串起几个 action，写成 compose（~/.speedrun/compose/<名>.js，再 spr run <名>）" });
          const name = String(m.args.name);
          const p = Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
          const i = calls++;
          const prev = askState?.journal[i];
          if (prev) {
            if (prev.name !== name || JSON.stringify(prev.params) !== JSON.stringify(p)) {
              return finish({ status: "failure", error: `compose 这次调用的 action 和上次不同（第 ${i + 1} 次：上次 ${prev.name} ${JSON.stringify(prev.params)}，这次 ${name} ${JSON.stringify(p)}）：compose 里不要用时间、随机数决定调什么；重新 run 一次` });
            }
            return reply({ result: prev.result ?? null });
          }
          run = this.runAction(name, p, session).then((o) => {
            if (o.status === "failure") failedAction = o.failedAction ?? name;
            if (o.status !== "success") throw new Error(`[${name}] ${o.status === "failure" ? o.error : "被调用的 action 不能 ask"}`);
            if (askState) askState.journal[i] = { name, params: p, result: o.result };
            return o.result;
          });
        } else if (m.op === "screenshot") run = this.shoot(session, m.args);
        else run = this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
