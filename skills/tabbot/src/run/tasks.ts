import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMPOSE_KEEP, LIB_DIR, TASK_TIMEOUT_MS } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";

export interface TaskSummary {
  name: string;
  /** task 所在的站点目录名（sites/<站点>/tasks/<名字>.js）。 */
  site: string;
  /** 文件头 `@endpoint 方法 路径`：这份 task 覆盖的接口（一份 task 一个请求）。 */
  endpoints: string[];
  status: string;
  summary: string;
  params: string[];
  /** 文件头 `@timeout <秒>` 声明的上限；未声明时不出现。 */
  timeout?: number;
}

/**
 * 读取文件开头的块注释里的 `@标签 值` 行（支持 `@status: draft` 与 `@status draft`）。
 * 只看第一个块注释：代码里恰好出现 `@status` 之类的文字不会被误读；没有块注释时返回空。
 */
export function headerTags(text: string): Array<[string, string]> {
  const block = /^\s*(?:#![^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!block) return [];
  const tags: Array<[string, string]> = [];
  for (const line of block[1]!.split("\n")) {
    const match = /^\s*\*?\s*@([A-Za-z]+):?\s*(.*?)\s*$/.exec(line);
    if (match) tags.push([match[1]!, match[2]!]);
  }
  return tags;
}

/** 从 task 文件头读取 @summary、@status、@timeout 与 @param，不执行脚本。 */
export function taskSummary(file: string): TaskSummary {
  const tags = headerTags(fs.readFileSync(file, "utf8"));
  const first = (tag: string): string => tags.find(([key]) => key === tag)?.[1] ?? "";
  const timeout = Number(first("timeout"));
  return {
    name: path.basename(file, ".js"),
    site: path.basename(path.dirname(path.dirname(file))),
    endpoints: tags.filter(([key]) => key === "endpoint").map(([, value]) => value.trim().replace(/\s+/g, " ")),
    status: first("status") || "verified",
    summary: first("summary"),
    params: tags.filter(([key]) => key === "param").map(([, value]) => value),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

export interface ParamSpec { name: string; optional: boolean; description: string }

/** 解析文件头的 `@param 名字 说明` 与 `@param 名字? 说明`（带 ? 表示可选）。 */
export function paramSpecs(file: string): ParamSpec[] {
  return taskSummary(file).params.map((value) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*(.*)$/s.exec(value);
    return match ? { name: match[1]!, optional: Boolean(match[2]), description: match[3]! } : { name: value, optional: false, description: "" };
  });
}

/** 把命令行里 `--名字 值` / `--名字=值` 解析成参数表；不接受位置参数。 */
export function parseCliParams(args: string[]): { params: Record<string, string> } | { error: string } {
  const params: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const match = /^--([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(arg);
    if (!match) return { error: `参数要写成 --名字 值，不接受：${arg}` };
    const name = match[1]!;
    if (name in params) return { error: `参数重复：--${name}` };
    if (match[2] !== undefined) { params[name] = match[2]; continue; }
    const value = args[++i];
    if (value === undefined) return { error: `参数 --${name} 缺少值` };
    params[name] = value;
  }
  return { params };
}

/** 对照文件头的 @param 检查：缺必填、传了没声明的参数都返回说明；通过返回 undefined。 */
export function checkParams(file: string, params: Record<string, string>): string | undefined {
  const specs = paramSpecs(file);
  const known = new Set(specs.map((spec) => spec.name));
  const unknown = Object.keys(params).filter((name) => !known.has(name));
  if (unknown.length) return `没有这些参数：${unknown.map((name) => `--${name}`).join("、")}；可用：${specs.map((spec) => `--${spec.name}`).join("、") || "（无）"}`;
  const missing = specs.filter((spec) => !spec.optional && !(spec.name in params));
  if (missing.length) return `缺少必填参数：${missing.map((spec) => `--${spec.name}（${spec.description}）`).join("、")}`;
  return undefined;
}

/** 这个 task 的最长运行时间：文件头声明的 @timeout，否则 TASK_TIMEOUT_MS。 */
export function taskTimeoutMs(file: string): number {
  const declared = taskSummary(file).timeout;
  return declared ? declared * 1000 : TASK_TIMEOUT_MS;
}

/** task 脚本的位置：<sitesDir>/<站点>/tasks/<名字>.js。 */
export function taskFile(tasksDir: string, name: string): string {
  return path.join(tasksDir, `${name}.js`);
}

export function tasksDirOf(sitesDir: string, site: string): string {
  return path.join(sitesDir, siteDirName(site), "tasks");
}

/** 站点目录名（有 tasks/ 的），按字母序；忽略以 . 开头的目录（.compose 等）。 */
function siteDirs(sitesDir: string): string[] {
  if (!fs.existsSync(sitesDir)) return [];
  return fs.readdirSync(sitesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
}

/** 按 task 名在所有站点里找（task 名全局唯一）。 */
export function findTask(sitesDir: string, name: string): { file: string; site: string } | undefined {
  for (const site of siteDirs(sitesDir)) {
    const file = taskFile(tasksDirOf(sitesDir, site), name);
    if (fs.existsSync(file)) return { file, site };
  }
  return undefined;
}

/** 列出 task；给了 site 就只列这个站点的，否则列所有站点的。 */
export function listTasks(sitesDir: string, site?: string): TaskSummary[] {
  const out: TaskSummary[] = [];
  for (const s of site ? [siteDirName(site)] : siteDirs(sitesDir)) {
    const dir = tasksDirOf(sitesDir, s);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) out.push(taskSummary(path.join(dir, f)));
  }
  return out;
}

/** 把一次运行的输入与输出写到 <runDir>/<name>/<时间戳>.json，并删除超出份数的旧记录。 */
export function writeRunHistory(runDir: string, name: string, entry: unknown, keep: number): void {
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let file = path.join(dir, `${stamp}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stamp}_${i}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
}

/** 去掉 saveCompose 写的头（拿存下的文件再跑时，代码原文不变，哈希也不变）。 */
export function stripComposeHead(code: string): string {
  return code.replace(/^\s*\/\/[^\n]*\n\/\*\*\n(?: \* @(?:description|uses|params|ok) [^\n]*\n)+ \*\/\n/, "");
}

/**
 * 存一段跑成功的 compose：~/.tabbot/compose/<代码哈希前 12 位>.js。同样的代码只存一份，再次成功时累加 description（最多 5 句，新的在前）和次数。
 * 头由 TabBot 填：@description、@uses（代码里 task("名字") 调用的）、@params（代码里读的 tabbot.params.名字）、@ok（成功次数和最近时间）；下面是代码原文。
 * 只留最近 keep 个（按修改时间）。
 */
export function saveCompose(dir: string, code: string, description: string, keep = COMPOSE_KEEP, now = Date.now()): { file: string; uses: string[]; params: string[] } {
  const body = stripComposeHead(code).trim();
  const file = path.join(dir, `${createHash("sha256").update(body).digest("hex").slice(0, 12)}.js`);
  const uses = [...new Set([...body.matchAll(/\btask\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)].map((m) => m[1]!))];
  const params = [...new Set([...body.matchAll(/\btabbot\.params\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
  let descriptions: string[] = [], ok = 0;
  try {
    const old = fs.readFileSync(file, "utf8");
    descriptions = [...old.matchAll(/^ \* @description (.+)$/gm)].map((m) => m[1]!);
    ok = Number(/^ \* @ok (\d+)/m.exec(old)?.[1] ?? 0);
  } catch { /* 第一次 */ }
  const text = description.replace(/\s+/g, " ").trim().slice(0, 200);
  descriptions = [text, ...descriptions.filter((d) => d !== text)].slice(0, 5);
  const d = new Date(now), pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; // 本地时间
  const head = [`// ${descriptions[0]}`, "/**", ...descriptions.map((d) => ` * @description ${d}`), ` * @uses ${uses.join(", ") || "（无）"}`, ` * @params ${params.join(", ") || "（无）"}`, ` * @ok ${ok + 1} 次，最近 ${stamp}`, " */"];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${head.join("\n")}\n${body}\n`, { mode: 0o600 });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
  return { file, uses, params };
}

/** 把 src/task-lib 同步到 ~/.tabbot/lib：task 脚本（sites/<站点>/tasks/）从 ../../../lib/index.js 引用 SDK，holder 每次启动都覆盖，保证和代码一致。 */
export function syncTaskLib(libDir = LIB_DIR, from = path.join(import.meta.dirname, "..", "task-lib")): void {
  fs.mkdirSync(path.dirname(libDir), { recursive: true });
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.cpSync(from, libDir, { recursive: true });
}

/** 真跑成功一次就把文件头的 `@status: draft` 改成 verified；已经是 verified 或没有 @status 的不动。 */
export function promoteTask(file: string): boolean {
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(/^(\s*\*?\s*@status:?\s*)draft\b/m, "$1verified");
  if (next === text) return false;
  fs.writeFileSync(file, next, "utf8");
  return true;
}

/**
 * 把 task 标成 blocked：试过、确认这个请求学不会，原因和证据写进文件头 @note。task 文件不存在就建一个只有文件头的。
 * 之后同一件事 rg @status 就能找到，不会再开会话重复探索；run 对 blocked 的 task 直接拒绝。
 */
export function blockTask(file: string, reason: string): void {
  const note = ` * @note 学不会：${reason.replace(/\s+/g, " ").trim()}`;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = /^(\s*(?:#![^\n]*\n\s*)?\/\*\*?)([\s\S]*?)(\*\/)/.exec(text);
  if (!block) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `/**\n * @summary （学不会，见 @note）\n * @status: blocked\n${note}\n */\n${text}`, "utf8");
    return;
  }
  const kept = block[2]!.split("\n").filter((line) => !/^\s*\*?\s*@status:?/.test(line)).join("\n").replace(/\s*$/, "\n");
  fs.writeFileSync(file, `${text.slice(0, block.index)}${block[1]}${kept} * @status: blocked\n${note}\n ${block[3]}${text.slice(block.index + block[0].length)}`, "utf8");
}

/** 这个站点的 task 覆盖的接口：键是 `方法 接口名`（和 endpoints.json 的 key 一致），值是 task 名。 */
export function coveredEndpoints(sitesDir: string, site: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of listTasks(sitesDir, site)) for (const e of r.endpoints) out.set(e, r.name);
  return out;
}

/** 还没验证的草稿（@status: draft）。 */
export function draftTasks(sitesDir: string): TaskSummary[] {
  return listTasks(sitesDir).filter((t) => t.status === "draft");
}
