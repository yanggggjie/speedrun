import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { RUN_BUSY_WAIT_MS, RUN_DIR, RUN_HISTORY_KEEP, RECIPE_DIR } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";
import { RunHost, Session } from "./host.ts";
import { checkParams, recipeFile, recipeSummary, recipeTimeoutMs, promoteRecipe, writeRunHistory } from "./recipes.ts";
import { MAIN_KEY } from "./window.ts";

export type Outcome = { status: "success"; result: unknown; dry?: string[] } | { status: "failure"; error: string; failedRecipe?: string; dry?: string[] };

export type RunnerPaths = { recipeDir: string; runDir: string };
const DEFAULT_PATHS: RunnerPaths = { recipeDir: RECIPE_DIR, runDir: RUN_DIR };
const WORKER = path.join(import.meta.dirname, "worker.ts");
const MAX_LOG_LINES = 50;

export type RunOptions = { key?: string; dry?: boolean };

/** 在 worker 线程里跑 recipe；同一个 kitchen 窗口（key）一次只跑一个，不同 key 可以同时跑。 */
export class RecipeRunner {
  private readonly host: RunHost;
  private readonly paths: RunnerPaths;
  private readonly busy = new Set<string>();
  /** 单个 recipe 的超时（自检里调小）；默认按 recipe 文件头的 @timeout 或 RECIPE_TIMEOUT_MS。 */
  timeoutOverrideMs: number | undefined;

  constructor(host: RunHost, paths: RunnerPaths = DEFAULT_PATHS) { this.host = host; this.paths = paths; }

  private async lock(key: string): Promise<void> {
    const deadline = Date.now() + RUN_BUSY_WAIT_MS;
    while (this.busy.has(key)) {
      if (Date.now() >= deadline) throw new Error("同一个窗口里另一个 recipe 正在运行（等了 30 秒）：稍后重试同一条命令");
      await sleep(200);
    }
    this.busy.add(key);
  }

  /** 运行一个 recipe（serve 命令或 menu 调用）。session 传进来表示嵌套调用，共用页面、不再抢锁。 */
  async runRecipe(name: string, params: Record<string, string>, nested?: Session, opts: RunOptions = {}): Promise<Outcome> {
    const file = recipeFile(this.paths.recipeDir, name);
    if (!fs.existsSync(file)) return { status: "failure", error: `recipe 不存在：${name}（tabbot recipe 列出已有的）` };
    if (nested && recipeSummary(file).status === "draft") return { status: "failure", error: `[${name}] 是草稿（@status: draft），menu 里不允许调用；请先单独 serve 并验证为 verified`, failedRecipe: name };
    const problem = checkParams(file, params);
    if (problem) return { status: "failure", error: `[${name}] ${problem}`, ...(nested ? { failedRecipe: name } : {}) };
    const own = !nested;
    const key = nested?.key ?? opts.key ?? MAIN_KEY;
    if (own) await this.lock(key);
    // 嵌套调用共用页面状态，但 menu 的“只能组合”只约束 menu 自己的代码，不约束被它调用的 recipe
    const session = new Session(key);
    if (nested) { session.tab = nested.tab; session.origin = nested.origin; session.dry = nested.dry; }
    else if (opts.dry) session.dry = true;
    try {
      const out = await this.work(file, params, recipeTimeoutMs(file), session);
      if (out.status === "failure" && nested) out.failedRecipe ??= name;
      if (nested) { nested.tab = session.tab; nested.origin = session.origin; nested.dryLog.push(...session.dryLog); }
      else if (session.dryLog.length) out.dry = [...session.dryLog];
      // 真跑成功一次就晋升为 verified（试运行不算）
      if (out.status === "success" && !session.dry) promoteRecipe(file);
      writeRunHistory(this.paths.runDir, name, { params, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      if (own) { await this.host.end(session); this.busy.delete(key); }
    }
  }

  /** menu：代码只能 recipe(名字, 参数) 组合 recipe，任何页面操作都被 host 拒绝。 */
  async runMenu(code: string, key = MAIN_KEY): Promise<Outcome> {
    await this.lock(key);
    const session = new Session(key);
    session.composeOnly = true;
    const dir = path.join(this.paths.recipeDir, ".menu");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${process.pid}.mjs`);
    fs.writeFileSync(file, [
      `import { tabbot } from ${JSON.stringify(path.join(this.paths.recipeDir, "lib", "index.js"))};`,
      "const recipe = (name, params) => tabbot.recipe(name, params);",
      "await tabbot.run(async () => {",
      code,
      "});",
      "",
    ].join("\n"), "utf8");
    try {
      const out = await this.work(file, {}, 115_000, session);
      writeRunHistory(this.paths.runDir, "menu", { code, output: out }, RUN_HISTORY_KEEP);
      return out;
    } finally {
      fs.rmSync(file, { force: true });
      await this.host.end(session);
      this.busy.delete(key);
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
        if (out.status === "failure" && logs.length) out.error += `\n--- recipe 输出 ---\n${logs.slice(-10).join("\n")}`;
        resolve(out);
      };
      const timer = setTimeout(() => finish({ status: "failure", error: `recipe 超过 ${Math.round(limit / 1000)} 秒未结束，已终止；确实需要更久时，在文件头加 @timeout <秒>` }), limit);
      worker.on("error", (e) => finish({ status: "failure", error: `${e.name}: ${e.message}` }));
      worker.on("exit", () => finish({ status: "failure", error: "recipe 没有返回结果就退出了（有没有调用 tabbot.run？）" }));
      worker.on("message", (m: any) => {
        if (m.type === "done") return finish({ status: "success", result: m.result });
        if (m.type === "fail") return finish({ status: "failure", error: String(m.error).split("\n").slice(0, 8).join("\n") });
        if (m.type === "log") { if (logs.length < MAX_LOG_LINES) logs.push(String(m.text).slice(0, 500)); return; }
        if (m.type !== "call") return;
        const reply = (body: Record<string, unknown>): void => { if (!settled) worker.postMessage({ type: "reply", id: m.id, ...body }); };
        const run = m.op === "recipe"
          ? this.runRecipe(String(m.args.name), Object.fromEntries(Object.entries(m.args.params ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), session).then((o) => { if (o.status !== "success") throw new Error(`[${m.args.name}] ${o.error}`); return o.result; })
          : this.host.op(session, m.op, m.args);
        run.then((result) => reply({ result: result ?? null }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  }
}
