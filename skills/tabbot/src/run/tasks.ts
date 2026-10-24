import * as fs from "node:fs";
import * as path from "node:path";
import { TASK_DIR, TASK_TIMEOUT_MS } from "../utils/constants.ts";

export interface TaskSummary {
  name: string;
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

export function taskFile(taskDir: string, name: string): string {
  return path.join(taskDir, `${name}.js`);
}

export function listTasks(taskDir: string): TaskSummary[] {
  if (!fs.existsSync(taskDir)) return [];
  return fs.readdirSync(taskDir).filter((f) => f.endsWith(".js")).sort().map((f) => taskSummary(path.join(taskDir, f)));
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

/** 把 src/task-lib 同步到 ~/.tabbot/task/lib：task 脚本从 ../task/lib/index.js 引用 SDK，holder 每次启动都覆盖，保证和代码一致。 */
export function syncTaskLib(taskDir = TASK_DIR, from = path.join(import.meta.dirname, "..", "task-lib")): void {
  const to = path.join(taskDir, "lib");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}
