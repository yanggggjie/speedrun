import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { RUN_BUSY_WAIT_MS, RUN_DIR, RUN_HISTORY_KEEP, TASK_DIR } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";
import { RunHost, Session } from "./host.ts";
import { checkParams, taskFile, taskSummary, taskTimeoutMs, writeRunHistory } from "./tasks.ts";

export type Outcome = { status: "success"; result: unknown } | { status: "failure"; error: string; failedTask?: string };

export type RunnerPaths = { taskDir: string; runDir: string };
const DEFAULT_PATHS: RunnerPaths = { taskDir: TASK_DIR, runDir: RUN_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

/** 在 worker 线程里跑 task，一次只跑一个；task 里的每个页面操作都经 RunHost 在 tabbot run 窗口里执行。 */
export class TaskRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private busy = false;
  /** 单个 task 的超时（自检里调小）；默认按 task 文件头的 @timeout 或 TASK_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: RunnerPaths = DEFAULT_PATHS) { this.host = host; this.paths = paths; }

  private async lock(): Promise<void> {
    const deadline = Date.now() + RUN_BUSY_WAIT_MS;
    while (this.busy) {
      if (Date.now() >= deadline) throw new Error("另一个 task 正在运行（等了 30 秒）：稍后重试同一条命令");
      await sleep(200);
    }
    this.busy = true;
  }

  /** 运行一个 task（命令行或组合代码调用）。session 传进来表示嵌套调用，共用页面、不再抢锁。 */
  async runTask(name: string, params: Record<string, string>, nested?: Session): Promise<Outcome> {
    const file = taskFile(this.paths.taskDir, name);
    if (!fs.existsSync(file)) return { status: "failure", error: `task 不存在：${name}（tabbot task 列出已有的）` };
    if (nested && taskSummary(file).status === "draft") return { status: "failure", error: `[${name}] 是草稿（@status: draft），组合中不允许调用；请先单独运行并验证为 verified`, failedTask: name };
    const problem = checkParams(file, params);
    if (problem) return { status: "failure", error: `[${name}] ${problem}`, ...(nested ? { failedTask: name } : {}) };
    const own = !nested;
    if (own) await this.lock();
    const session = nested ?? new Session();
    try {
      const out = await this.work(file, params, taskTimeoutMs(file), session);
      if (out.status === "failure" && nested) out.failedTask ??= name;
      writeRunHistory(this.paths.runDir, name, { params, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      if (own) { await this.host.end(session); this.busy = false; }
    }
  }

  /** 组合：代码在 async 函数里跑，能用整个 SDK 和 task(name, 参数)；return 的值是 result。 */
  async runEval(code: string): Promise<Outcome> {
    await this.lock();
    const session = new Session();
    const dir = path.join(this.paths.taskDir, ".compose");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${process.pid}.mjs`);
    fs.writeFileSync(file, [
      `import * as S from ${JSON.stringify(path.join(this.paths.taskDir, "lib", "index.js"))};`,
      "const { tabbot, goto, request, click, fill, select, check, press, scroll, waitFor, text, snapshot, query, evaluate, sleep, serializeUrl } = S;",
      "const task = (name, params) => tabbot.task(name, params);",
      "await tabbot.run(async ({ page }) => {",
      code,
      "});",
      "",
    ].join("\n"), "utf8");
    try {
      const out = await this.work(file, {}, 115_000, session);
      writeRunHistory(this.paths.runDir, "compose", { code, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      fs.rmSync(file, { force: true });
      await this.host.end(session);
      this.busy = false;
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
