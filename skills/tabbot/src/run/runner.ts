import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { LIB_DIR, RUN_BUSY_WAIT_MS, RUN_DIR, RUN_HISTORY_KEEP, SITES_DIR } from "../utils/constants.ts";
import { RunHost, Session } from "./host.ts";
import { checkParams, findTask, taskSummary, taskTimeoutMs, promoteTask, writeRunHistory } from "./tasks.ts";
import { MAIN_KEY } from "./window.ts";

export type Outcome = { status: "success"; result: unknown; dry?: string[] } | { status: "failure"; error: string; failedTask?: string; dry?: string[] };

/** sitesDir：各站点的 tasks/ 在它下面；libDir：task SDK；runDir：运行历史。 */
export type RunnerPaths = { sitesDir: string; libDir: string; runDir: string };
const DEFAULT_PATHS: RunnerPaths = { sitesDir: SITES_DIR, libDir: LIB_DIR, runDir: RUN_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

export type RunOptions = { key?: string; dry?: boolean };

/** 在 worker 线程里跑 task；同一个 agent 窗口（key）一次只跑一个，不同 key 可以同时跑。 */
export class TaskRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly busy = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  /** 单个 task 的超时（自检里调小）；默认按 task 文件头的 @timeout 或 TASK_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: RunnerPaths = DEFAULT_PATHS) { this.host = host; this.paths = paths; }

  private async lock(key: string): Promise<void> {
    if (!this.busy.has(key)) { this.busy.add(key); return; }
    // 排队等前一个结束时被唤醒（不轮询），最多等 RUN_BUSY_WAIT_MS
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(key) ?? [];
      this.waiters.set(key, queue);
      const entry = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(new Error("同一个窗口里另一个 task 正在运行（等了 30 秒）：稍后重试同一条命令")); }, RUN_BUSY_WAIT_MS);
      queue.push(entry);
    });
  }

  private unlock(key: string): void {
    const next = this.waiters.get(key)?.shift();
    if (next) next(); // 锁直接交给下一个，busy 保持
    else this.busy.delete(key);
  }

  /** 运行一个 task（run 命令或 compose 调用）。session 传进来表示嵌套调用，共用页面、不再抢锁。 */
  async runTask(name: string, params: Record<string, string>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const found = findTask(this.paths.sitesDir, name);
    if (!found) return { status: "failure", error: `task 不存在：${name}（task 都在 ${this.paths.sitesDir}/<站点>/tasks/ 下，ls 看有哪些）` };
    const file = found.file;
    if (nested && taskSummary(file).status === "draft") return { status: "failure", error: `[${name}] 是草稿（@status: draft），compose 里不允许调用；请先单独 run 并验证为 verified`, failedTask: name };
    const problem = checkParams(file, params);
    if (problem) return { status: "failure", error: `[${name}] ${problem}`, ...(nested ? { failedTask: name } : {}) };
    const own = !nested;
    const key = nested?.key ?? opts.key ?? MAIN_KEY;
    if (own) await this.lock(key);
    // 嵌套调用共用页面状态，但 compose 的“只能组合”只约束 compose 自己的代码，不约束被它调用的 task
    const session = new Session(key);
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.dry = nested.dry; }
    else if (opts.dry) session.dry = true;
    try {
      const out = await this.work(file, params, taskTimeoutMs(file), session);
      if (out.status === "failure" && nested) out.failedTask ??= name;
      if (nested) { nested.tab = session.tab; nested.origin = session.origin; nested.dryLog.push(...session.dryLog); }
      else if (session.dryLog.length) out.dry = [...session.dryLog];
      // 真跑成功一次就晋升为 verified（试运行不算）
      if (out.status === "success" && !session.dry) promoteTask(file);
      writeRunHistory(this.paths.runDir, name, { params, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      if (own) { await this.host.end(session); this.unlock(key); }
    }
  }

  /** compose：代码只能 task(名字, 参数) 组合 task，任何页面操作都被 host 拒绝。 */
  async runCompose(code: string, key = MAIN_KEY, timeoutMs = 115_000): Promise<Outcome> {
    await this.lock(key);
    const session = new Session(key);
    session.composeOnly = true;
    const dir = path.join(this.paths.sitesDir, ".compose");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${process.pid}.mjs`);
    fs.writeFileSync(file, [
      `import { tabbot } from ${JSON.stringify(path.join(this.paths.libDir, "index.js"))};`,
      "const task = (name, params) => tabbot.task(name, params);",
      "await tabbot.run(async () => {",
      code,
      "});",
      "",
    ].join("\n"), "utf8");
    try {
      const out = await this.work(file, {}, timeoutMs, session);
      writeRunHistory(this.paths.runDir, "compose", { code, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      fs.rmSync(file, { force: true });
      await this.host.end(session);
      this.unlock(key);
    }
  }

  private work(file: string, params: Record<string, string>, timeoutMs: number, session: Session): Promise<Outcome> {
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    return new Promise((resolve) => {
      const logs: string[] = [];
      const worker = new Worker(WORKER, { workerData: { file, params }, env: {} });
      let settled = false;
      const finish = (out: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (out.status === "failure" && logs.length) out.error += `\n--- task 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", error: `task 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>` }), limit);
      worker.on("error", (e) => finish({ status: "failure", error: `${e.name}: ${e.message}` }));
      worker.on("exit", () => finish({ status: "failure", error: "task 没有返回结果就退出了（有没有调用 tabbot.run？）" }));
      worker.on("message", (m: any) => {
        if (m.type === "done") return finish({ status: "success", result: m.result });
        if (m.type === "fail") return finish({ status: "failure", error: String(m.error).split("\n").slice(0, 8).join("\n") });
        if (m.type === "log") { if (logs.length < MAX_LOG_LINES) logs.push(String(m.text).slice(0, 500)); return; }
        if (m.type !== "call") return;
        const reply = (body: Record<string, unknown>): void => { if (!settled) worker.postMessage({ type: "reply", id: m.id, ...body }); };
        const run = m.op === "task"
          ? this.runTask(String(m.args.name), Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), session).then((o) => { if (o.status !== "success") throw new Error(`[${m.args.name}] ${o.error}`); return o.result; })
          : this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
