import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { ACTION_TIMEOUT_MS, COMPOSE_DIR, LIB_DIR, SESSION_DIR, SITES_DIR } from "../utils/constants.ts";
import { RunHost, Session, type FailurePage } from "./host.ts";
import { actionSummary, actionTimeoutMs, checkParams, findAction, isComposed, stripComposeHead } from "./actions.ts";

/** 最外层组合里每次 action() 调用的记录，按调用顺序；恢复时前几次直接返回记下的结果，不再执行。 */
export type JournalEntry = { name: string; params: Record<string, string>; result: unknown };
/** 最外层组合的重跑状态：已执行的 action 和 agent 给过的回答（按 ask 的顺序）。 */
export type Replay = { journal: JournalEntry[]; answers: unknown[] };
/** runWindow：这次 run 用的 run 窗口（名字）；drafts：这次真跑成功的草稿（文件路径），由命令层判断晋升。两者只在最外层有。 */
export type Outcome = (
  | { status: "success"; result: unknown; dry?: string[] }
  | { status: "failure"; error: string; failedAction?: string; dry?: string[]; page?: FailurePage; hint?: string }
  | { status: "ask"; question: string; data: unknown; journal: JournalEntry[]; dry?: string[] }
) & { runWindow?: string; drafts?: string[] };

const ASK_DATA_LIMIT = 100 * 1024;

const LOGIN_URL = /(?:^|[/.\-_?=])(login|signin|sign-in|sso|passport|oauth|authorize|auth|cas)(?:[/.\-_?=]|$)|登录/i;
/** 失败时的页面看起来像登录页，或错误里是 401/403：多半是登录失效，不是 action 坏了。 */
export function looksLoggedOut(error: string, url: string | undefined): boolean {
  if (url && LOGIN_URL.test(url)) return true;
  return /\b(401|403)\b|unauthori[sz]ed|未登录|登录/i.test(error);
}

/** sitesDir：各站点的 actions/ 在它下面；composeDir：跨站点和没起名字的组合；libDir：SDK；tmpDir：组合代码的临时包装文件。 */
export type RunnerPaths = { sitesDir: string; composeDir: string; libDir: string; tmpDir: string };
const DEFAULT_PATHS: RunnerPaths = { sitesDir: SITES_DIR, composeDir: COMPOSE_DIR, libDir: LIB_DIR, tmpDir: SESSION_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

/**
 * run 窗口的开和关：每次 run 新开一个（open 返回窗口名，也是 agent 窗口的 key 和日志目录名），跑完关掉浏览器窗口（日志目录留着）。
 * failureFile：失败截图存在哪（不含扩展名）。holder 里接到 AgentWindows 和 WindowLog；自检里用假的。
 */
export type RunWindows = { open(label: string, meta: Record<string, unknown>): string; close(key: string): Promise<void>; failureFile(key: string): string };
const NO_WINDOWS: RunWindows = { open: (label) => label, close: async () => {}, failureFile: (key) => path.join(SESSION_DIR, `${key}-failure`) };

/** dry：非 GET 的请求不真发；replay：恢复一次停在 ask 的组合。 */
export type RunOptions = { dry?: boolean; replay?: Replay };

/** 在 worker 线程里跑 action。每次 run 有自己的 run 窗口，不同的 run 可以同时跑。 */
export class ActionRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly windows: RunWindows;
  /** 单个 action 的超时（自检里调小）；默认按文件头的 @timeout 或 ACTION_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: Partial<RunnerPaths> = {}, windows: RunWindows = NO_WINDOWS) { this.host = host; this.paths = { ...DEFAULT_PATHS, ...paths }; this.windows = windows; }

  /** 按名字运行一个 action（run，或组合代码里的 action() 调用）。nested 传进来表示嵌套调用，共用这次 run 的窗口和页面。草稿也能跑。 */
  async runAction(name: string, params: Record<string, string>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const found = findAction(this.paths.sitesDir, name, this.paths.composeDir);
    const tag = nested ? { failedAction: name } : {};
    if (!found) return { status: "failure", error: `action 不存在：${name}（action 在 ${this.paths.sitesDir}/<站点>/actions/ 和 ${this.paths.composeDir}/ 下，ls 看有哪些）`, ...tag };
    const file = found.file;
    const summary = actionSummary(file);
    if (summary.status === "blocked") return { status: "failure", error: `[${name}] 是学不会的记录（@status blocked，原因见 ${file} 的 @note）：不要再探索，向用户说明卡在哪；有新证据才把 @status 改回 draft、在 @note 写明为什么，回学习窗口修`, ...tag };
    const composed = isComposed({ ...summary, file });
    if (!composed) {
      const problem = checkParams(file, params);
      if (problem) return { status: "failure", error: `[${name}] ${problem}`, ...tag };
    }
    const key = nested?.key ?? this.windows.open(name, { action: name, params });
    // 嵌套调用共用页面状态；组合的"只能调用 action"只约束组合自己的代码，不约束被它调用的 action
    const session = new Session(key);
    session.composeOnly = composed;
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.dry = nested.dry; }
    else if (opts.dry) session.dry = true;
    try {
      // 只有最外层的组合能 ask：嵌套调用的组合不带重跑状态
      const out: Outcome = composed
        ? await this.execCompose(stripComposeHead(fs.readFileSync(file, "utf8")), params, actionTimeoutMs(file), session, nested ? undefined : (opts.replay ?? { journal: [], answers: [] }))
        : await this.work(file, params, actionTimeoutMs(file), session);
      if (out.status === "failure" && nested) out.failedAction ??= name;
      if (out.status === "failure" && !nested && !composed) {
        const page = await this.host.failureShot(session, this.windows.failureFile(key));
        if (page) out.page = page;
        if (looksLoggedOut(out.error, page?.url)) out.hint = "像是登录失效：用读图片的方式看 page.screenshot；确认是登录页就请用户在 Chrome 里登录后重跑同一条命令，不要重新学习、不要改 action。";
        else if (page?.screenshot) out.hint = "看 page.screenshot 判断页面停在了哪；页面正常但 action 失败，才是 action 坏了。";
      }
      if (out.status === "success" && !session.dry && !composed && summary.status === "draft") session.draftsOk.push(file);
      if (nested) { nested.tab = session.tab; nested.origin = session.origin; nested.dryLog.push(...session.dryLog); nested.draftsOk.push(...session.draftsOk); }
      else { if (session.dryLog.length) out.dry = [...session.dryLog]; out.runWindow = key; out.drafts = [...session.draftsOk]; }
      return out;
    } finally {
      if (!nested) { await this.host.end(session); await this.windows.close(key); }
    }
  }

  /** run --compose：一段组合代码，只能 action(名字, 参数) 调用 action，任何页面操作都被 host 拒绝。label 是 run 窗口的名字前缀（组合的名字，没有就是 compose）。 */
  async runCompose(code: string, timeoutMs = ACTION_TIMEOUT_MS, params: Record<string, string> = {}, dry = false, replay: Replay = { journal: [], answers: [] }, label = "compose"): Promise<Outcome> {
    const key = this.windows.open(label, { compose: label, params });
    const session = new Session(key);
    session.composeOnly = true;
    session.dry = dry;
    try {
      const out = await this.execCompose(code, params, timeoutMs, session, replay);
      if (session.dryLog.length) out.dry = [...session.dryLog];
      out.runWindow = key;
      out.drafts = [...session.draftsOk];
      return out;
    } finally {
      await this.host.end(session);
      await this.windows.close(key);
    }
  }

  /** 把组合代码包成一个模块（注入 action()）在 worker 里跑。 */
  private async execCompose(code: string, params: Record<string, string>, timeoutMs: number, session: Session, replay?: Replay): Promise<Outcome> {
    fs.mkdirSync(this.paths.tmpDir, { recursive: true });
    const file = path.join(this.paths.tmpDir, `compose-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    fs.writeFileSync(file, [
      `import { tabbot } from ${JSON.stringify(path.join(this.paths.libDir, "index.js"))};`,
      "const action = (name, params) => tabbot.action(name, params);",
      "await tabbot.run(async () => {",
      code,
      "});",
      "",
    ].join("\n"), "utf8");
    try {
      return await this.work(file, params, timeoutMs, session, replay);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /**
   * replay 只有最外层组合才有：每次 action() 按调用顺序记进 journal；恢复时从头重跑代码，
   * 前面记下的 action() 直接返回记录的结果（不重复发写请求），第 i 次 ask 返回第 i 个回答，没有回答就停下交给 agent。
   */
  private work(file: string, params: Record<string, string>, timeoutMs: number, session: Session, replay?: Replay): Promise<Outcome> {
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    return new Promise((resolve) => {
      const logs: string[] = [];
      const worker = new Worker(WORKER, { workerData: { file, params }, env: {} });
      let settled = false;
      let calls = 0, asks = 0;
      const finish = (out: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (out.status === "failure" && logs.length) out.error += `\n--- action 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", error: `action 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>` }), limit);
      worker.on("error", (e) => finish({ status: "failure", error: `${e.name}: ${e.message}` }));
      worker.on("exit", () => finish({ status: "failure", error: "action 没有返回结果就退出了（有没有调用 tabbot.run？）" }));
      worker.on("message", (m: any) => {
        if (m.type === "done") return finish({ status: "success", result: m.result });
        if (m.type === "fail") return finish({ status: "failure", error: String(m.error).split("\n").slice(0, 8).join("\n") });
        if (m.type === "log") { if (logs.length < MAX_LOG_LINES) logs.push(String(m.text).slice(0, 500)); return; }
        if (m.type !== "call") return;
        const reply = (body: Record<string, unknown>): void => { if (!settled) worker.postMessage({ type: "reply", id: m.id, ...body }); };
        if (m.op === "ask") {
          if (!replay) return reply({ error: "tabbot.ask 只能用在最外层的组合代码里（run --compose，或 run <名> 直接执行的组合）：被调用的组合和学出来的 action 里不能用" });
          const i = asks++;
          if (i < replay.answers.length) return reply({ result: replay.answers[i] ?? null });
          const size = JSON.stringify(m.args.data ?? null).length;
          if (size > ASK_DATA_LIMIT) return finish({ status: "failure", error: `tabbot.ask 交回的数据有 ${Math.round(size / 1024)}KB，超过 ${ASK_DATA_LIMIT / 1024}KB：先在组合代码里裁剪，只留判断要用的字段` });
          return finish({ status: "ask", question: String(m.args.question ?? ""), data: m.args.data ?? null, journal: replay.journal });
        }
        let run: Promise<unknown>;
        if (m.op === "action") {
          const name = String(m.args.name);
          const p = Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
          const i = calls++;
          const prev = replay?.journal[i];
          if (prev) {
            if (prev.name !== name || JSON.stringify(prev.params) !== JSON.stringify(p)) {
              return finish({ status: "failure", error: `组合代码这次调用的 action 和上次不同（第 ${i + 1} 次：上次 ${prev.name} ${JSON.stringify(prev.params)}，这次 ${name} ${JSON.stringify(p)}）：组合里不要用时间、随机数决定调什么；重新 run 一次` });
            }
            return reply({ result: prev.result ?? null });
          }
          run = this.runAction(name, p, session).then((o) => {
            if (o.status !== "success") throw new Error(`[${name}] ${o.status === "failure" ? o.error : "被调用的 action 不能 ask"}`);
            if (replay) replay.journal[i] = { name, params: p, result: o.result };
            return o.result;
          });
        } else run = this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
