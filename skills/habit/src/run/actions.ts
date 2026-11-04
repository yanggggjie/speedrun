import * as fs from "node:fs";
import * as path from "node:path";
import { ACTION_TIMEOUT_MS, HELPERS_DIR, LIB_DIR } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";

/**
 * 两种文件，都是 ES 模块（`export default async () => 结果`），文件头写法一样，由放在哪里区分：
 * - action：`~/.habit/sites/<站点>/actions/<名>.js`，学出来的业务动作，发请求或 DOM 兜底的页面操作（`@endpoint` 可以多行，按发送顺序）；
 * - compose：`~/.habit/compose/<名>.js`，agent 自己写的、用 action 串成的流程，只能 `action("名字", 参数)` 调用 action，不能碰页面。
 * 两者都一直保留，名字全局唯一，`habit run <名>` 跑。
 */

/** action 名：小写字母数字和 -，全局唯一。 */
export const ACTION_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface ActionSummary {
  name: string;
  file: string;
  /** 所在的站点目录名；compose（~/.habit/compose/ 下）没有站点。 */
  site?: string;
  /** 文件头 `@endpoint 方法 路径`：由哪些 endpoint 实现，按发送顺序。 */
  endpoints: string[];
  /** draft | verified | blocked；没写就是 verified。 */
  status: string;
  summary: string;
  params: string[];
  /** 文件头 `@write`：这个 action 会改东西（点赞、提交、删除……），agent 写的。只是提示：找 action 时、status 里看得到，run 不拦。 */
  write: boolean;
  /** 文件头 `@timeout <秒>` 声明的上限；未声明时不出现。 */
  timeout?: number;
}

/**
 * 读取文件开头的块注释里的 `@标签 值` 行。
 * 只看第一个块注释：代码里恰好出现 `@status` 之类的文字不会被误读；没有块注释时返回空。
 */
export function headerTags(text: string): Array<[string, string]> {
  const block = /^\s*(?:#![^\n]*\n\s*)?(?:\/\/[^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!block) return [];
  const tags: Array<[string, string]> = [];
  for (const line of block[1]!.split("\n")) {
    const match = /^\s*\*?\s*@([A-Za-z]+)\s*(.*?)\s*$/.exec(line);
    if (match) tags.push([match[1]!, match[2]!]);
  }
  return tags;
}

/** 从文件头读取 action 的摘要，不执行脚本。 */
export function actionSummary(file: string, site?: string): ActionSummary {
  const tags = headerTags(fs.readFileSync(file, "utf8"));
  const first = (tag: string): string => tags.find(([key]) => key === tag)?.[1] ?? "";
  const timeout = Number(first("timeout"));
  return {
    name: path.basename(file, ".js"),
    file,
    ...(site ? { site } : {}),
    endpoints: tags.filter(([key]) => key === "endpoint").map(([, value]) => value.trim().replace(/\s+/g, " ")),
    status: first("status") || "verified",
    summary: first("summary") || first("description"),
    params: tags.filter(([key]) => key === "param").map(([, value]) => value),
    write: tags.some(([key]) => key === "write"),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

/** findAction 找到的是不是 compose：compose 放在 ~/.habit/compose/，没有站点。 */
export const isCompose = (found: { site?: string }): boolean => found.site === undefined;

export type ParamType = "string" | "number" | "boolean" | "json";
export interface ParamSpec { name: string; optional: boolean; type: ParamType; description: string }

/** 解析文件头的 `@param 名字 说明`：名字后面可以带 `?`（可选）和 `:类型`（number、boolean、json，不写是字符串），如 `@param offset?:number 从第几条开始`。 */
export function paramSpecs(file: string): ParamSpec[] {
  return actionSummary(file).params.map((value) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?(?::(string|number|boolean|json))?(\?)?\s*(.*)$/s.exec(value);
    return match ? { name: match[1]!, optional: Boolean(match[2] || match[4]), type: (match[3] ?? "string") as ParamType, description: match[5]! } : { name: value, optional: false, type: "string", description: "" };
  });
}

/** 按 @param 的类型转换参数（命令行传进来的都是字符串，compose 里 action() 传的可能已经是数字、对象）；转不了返回说明。 */
export function coerceParams(file: string, params: Record<string, unknown>): { params: Record<string, unknown> } | { error: string } {
  const types = new Map(paramSpecs(file).map((spec) => [spec.name, spec.type]));
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(params)) {
    const type = types.get(name) ?? "string";
    if (type === "string") { out[name] = typeof v === "string" ? v : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v); continue; }
    if (type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) return { error: `参数 --${name} 要是数字（@param ${name}:number），收到 ${JSON.stringify(v)}` };
      out[name] = n;
      continue;
    }
    if (type === "boolean") {
      const b = typeof v === "boolean" ? v : /^(true|1|yes)$/i.test(String(v)) ? true : /^(false|0|no)$/i.test(String(v)) ? false : undefined;
      if (b === undefined) return { error: `参数 --${name} 要是 true 或 false（@param ${name}:boolean），收到 ${JSON.stringify(v)}` };
      out[name] = b;
      continue;
    }
    if (typeof v !== "string") { out[name] = v; continue; }
    try { out[name] = JSON.parse(v); } catch { return { error: `参数 --${name} 要是 JSON（@param ${name}:json），收到 ${v.slice(0, 80)}` }; }
  }
  return { params: out };
}

/** habit run 自己用的参数名，action 和 compose 不能用。 */
const RESERVED_PARAMS = new Set(["description", "help"]);

/** 对照文件头的 @param 检查：缺必填、传了没声明的参数都返回说明；通过返回 undefined。action 和 compose 一样。 */
export function checkParams(file: string, params: Record<string, unknown>): string | undefined {
  const specs = paramSpecs(file);
  const reserved = specs.filter((spec) => RESERVED_PARAMS.has(spec.name));
  if (reserved.length) return `参数名 ${reserved.map((spec) => spec.name).join("、")} 被 habit run 占用：在 action 文件里换个参数名`;
  const known = new Set(specs.map((spec) => spec.name));
  const unknown = Object.keys(params).filter((name) => !known.has(name));
  if (unknown.length) return `没有这些参数：${unknown.map((name) => `--${name}`).join("、")}；可用：${specs.map((spec) => `--${spec.name}`).join("、") || "（无）"}`;
  const missing = specs.filter((spec) => !spec.optional && !(spec.name in params));
  if (missing.length) return `缺少必填参数：${missing.map((spec) => `--${spec.name}（${spec.description}）`).join("、")}`;
  return undefined;
}

/** 这个 action 的最长运行时间：文件头声明的 @timeout，否则 ACTION_TIMEOUT_MS。 */
export function actionTimeoutMs(file: string): number {
  const declared = actionSummary(file).timeout;
  return declared ? declared * 1000 : ACTION_TIMEOUT_MS;
}

export function actionsDirOf(sitesDir: string, site: string): string {
  return path.join(sitesDir, siteDirName(site), "actions");
}

/** 站点目录名，按字母序；忽略以 . 开头的目录。 */
function siteDirs(sitesDir: string): string[] {
  if (!fs.existsSync(sitesDir)) return [];
  return fs.readdirSync(sitesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
}

/** 按名字找 action 或 compose（名字全局唯一）：先找各站点的 actions/，再找 compose 的目录 globalDir。 */
export function findAction(sitesDir: string, name: string, globalDir?: string): { file: string; site?: string } | undefined {
  if (!ACTION_NAME.test(name)) return undefined;
  for (const site of siteDirs(sitesDir)) {
    const file = path.join(actionsDirOf(sitesDir, site), `${name}.js`);
    if (fs.existsSync(file)) return { file, site };
  }
  const file = globalDir ? path.join(globalDir, `${name}.js`) : undefined;
  return file && fs.existsSync(file) ? { file } : undefined;
}

/** 列出 action；给了 site 就只列这个站点的，否则列所有站点的（再加 globalDir 里跨站点的）。 */
export function listActions(sitesDir: string, site?: string, globalDir?: string): ActionSummary[] {
  const out: ActionSummary[] = [];
  const read = (dir: string, s?: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) out.push(actionSummary(path.join(dir, f), s));
  };
  for (const s of site ? [siteDirName(site)] : siteDirs(sitesDir)) read(actionsDirOf(sitesDir, s), s);
  if (!site && globalDir) read(globalDir);
  return out;
}

/**
 * 把 src/action-lib 同步到 ~/.habit/lib：action 脚本（sites/<站点>/actions/）从 ../../../lib/index.js 引用 SDK，daemon 每次启动都整个覆盖，保证 SDK 和 daemon 是同一个版本。
 * agent 自己的函数在 ~/.habit/helpers/，这里只在它不存在时建好目录，从不覆盖、不删除。
 */
export function syncActionLib(libDir = LIB_DIR, from = path.join(import.meta.dirname, "..", "action-lib")): void {
  fs.mkdirSync(path.dirname(libDir), { recursive: true });
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.cpSync(from, libDir, { recursive: true });
  if (libDir === LIB_DIR) fs.mkdirSync(HELPERS_DIR, { recursive: true });
}

const STATUS_LINE = /^(\s*\*?\s*@status)\s+(\w+)\b/m;

/** 改文件头的 @status；没有 @status 行就不动。返回原来的状态。 */
function setStatus(file: string, from: string[], to: string): string | undefined {
  const text = fs.readFileSync(file, "utf8");
  const m = STATUS_LINE.exec(text);
  if (!m || !from.includes(m[2]!)) return undefined;
  fs.writeFileSync(file, text.replace(STATUS_LINE, `$1 ${to}`), "utf8");
  return m[2];
}

/** 真跑成功一次就把文件头的 draft 改成 verified；已经是 verified 或没有 @status 的不动。 */
export function promoteAction(file: string): boolean {
  return setStatus(file, ["draft"], "verified") !== undefined;
}

/** 这个站点的 action 覆盖的 endpoint：键是 `方法 路径`（和 endpoints.json 的 key 一致），值是 action 名。多行 @endpoint 每一行都算。 */
export function coveredEndpoints(sitesDir: string, site: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of listActions(sitesDir, site)) for (const e of r.endpoints) out.set(e, r.name);
  return out;
}

/** 还没验证的 draft（@status draft）。 */
export function draftActions(sitesDir: string, composeDir?: string): ActionSummary[] {
  return listActions(sitesDir, undefined, composeDir).filter((t) => t.status === "draft");
}

