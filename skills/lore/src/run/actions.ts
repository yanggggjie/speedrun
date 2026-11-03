import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ACTION_TIMEOUT_MS, HELPERS_DIR, LIB_DIR, UNNAMED_COMPOSE_KEEP, UNNAMED_COMPOSE_MAX_AGE_MS } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";

/**
 * 两种文件，由文件头区分：
 * - action（`@endpoint`，可以多行，按发送顺序）：学出来的业务动作，发请求或 DOM 兜底的页面操作，用 `lore learn` 学出来，文件是一个 ES 模块；
 * - compose（`@compose`）：用 action 串成的流程，`lore run --compose-code` 跑通即按代码哈希存进 ~/.lore/compose/，文件是一段 compose 代码（只能调用 action，不能碰页面）。
 */

/** action 名：小写字母数字和 -，全局唯一。 */
export const ACTION_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface ActionSummary {
  name: string;
  file: string;
  /** 所在的站点目录名；跨站点的 compose（~/.lore/compose/ 下）没有站点。 */
  site?: string;
  /** 文件头 `@endpoint 方法 路径`：由哪些 endpoint 实现，按发送顺序。 */
  endpoints: string[];
  /** 文件头 `@compose a, b`：由哪些 action compose；有它就是 compose。 */
  compose: string[];
  /** draft | verified | blocked；没写就是 verified。 */
  status: string;
  summary: string;
  params: string[];
  /** 文件头 `@write`：这个 action 会发 write 请求（点赞、提交、删除……）。只是提示：找 action 时、status 里看得到，run 不拦。 */
  write: boolean;
  /** 文件头 `@start <url>`：run 时先打开这个页面再执行（run 窗口每次从空白开始）。 */
  start?: string;
  /** 文件头 `@timeout <秒>` 声明的上限；未声明时不出现。 */
  timeout?: number;
}

/**
 * 读取文件开头的块注释里的 `@标签 值` 行。
 * 只看第一个块注释：代码里恰好出现 `@status` 之类的文字不会被误读；没有块注释时返回空。compose 的头前面多一行 `// 描述`。
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

const nameList = (value: string): string[] => value.split(/[,，\s]+/).filter((n) => ACTION_NAME.test(n));

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
    compose: tags.filter(([key]) => key === "compose").flatMap(([, value]) => nameList(value)),
    status: first("status") || "verified",
    summary: first("summary") || first("description"),
    params: tags.filter(([key]) => key === "param").map(([, value]) => value),
    write: tags.some(([key]) => key === "write"),
    ...(first("start").trim() ? { start: first("start").trim() } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

/** 是不是 compose：文件头有 `@compose`。 */
export const isComposed = (s: Pick<ActionSummary, "compose"> & { file: string }): boolean => s.compose.length > 0 || headerTags(fs.readFileSync(s.file, "utf8")).some(([k]) => k === "compose");

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

/** 对照文件头的 @param 检查：缺必填、传了没声明的参数都返回说明；通过返回 undefined。compose 没有 @param，不检查。 */
/** lore run 自己用的参数名，action 不能用。 */
const RESERVED_PARAMS = new Set(["answer", "resume", "action", "compose", "name", "timeout"]);

export function checkParams(file: string, params: Record<string, unknown>): string | undefined {
  const specs = paramSpecs(file);
  const reserved = specs.filter((spec) => RESERVED_PARAMS.has(spec.name));
  if (reserved.length) return `参数名 ${reserved.map((spec) => spec.name).join("、")} 被 lore run 占用：在 action 文件里换个参数名`;
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

/** 按名字找 action（名字全局唯一）：先找各站点的 actions/，再找跨站点的 globalDir。 */
export function findAction(sitesDir: string, name: string, globalDir?: string): { file: string; site?: string } | undefined {
  if (!ACTION_NAME.test(name)) return undefined;
  for (const site of siteDirs(sitesDir)) {
    const file = path.join(actionsDirOf(sitesDir, site), `${name}.js`);
    if (fs.existsSync(file)) return { file, site };
  }
  const file = globalDir ? path.join(globalDir, `${name}.js`) : undefined;
  return file && fs.existsSync(file) ? { file } : undefined;
}

/**
 * --compose 后面的名字：完整的哈希，或哈希的唯一前缀（至少 4 位）。
 * 前缀对上多个、或不到 4 位时返回说明（不到 4 位时列出以它开头的）。
 */
export function resolveCompose(globalDir: string, name: string): { name: string } | { error: string } | undefined {
  if (fs.existsSync(path.join(globalDir, `${name}.js`))) return { name };
  if (!/^[0-9a-f]{1,11}$/.test(name) || !fs.existsSync(globalDir)) return undefined;
  const hits = fs.readdirSync(globalDir).filter((f) => /^[0-9a-f]{12}\.js$/.test(f) && f.startsWith(name)).map((f) => f.slice(0, -3));
  if (name.length < 4) return { error: `--compose 的哈希至少写 4 位${hits.length ? `；以 ${name} 开头的有：${hits.join("、")}` : ""}` };
  if (hits.length === 1) return { name: hits[0]! };
  return hits.length ? { error: `--compose ${name} 对上了好几个：${hits.join("、")}；多写几位` } : undefined;
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

/** 去掉 compose 的头（`// 描述` 加块注释），剩下代码原文。 */
export function stripComposeHead(code: string): string {
  return code.replace(/^\s*\/\/[^\n]*\n\/\*\*\n(?: \* @(?:description|compose|params|ok) [^\n]*\n)+ \*\/\n/, "");
}

/** compose 代码的哈希（去掉头之后）：第一次存时用它的前 12 位当名字，之后改文件内容名字不变。 */
export function composeHash(code: string): string {
  return createHash("sha256").update(stripComposeHead(code).trim()).digest("hex").slice(0, 12);
}

/** compose 代码里调用的 action：`action("名字", …)`。 */
export function composeUses(code: string): string[] {
  return [...new Set([...stripComposeHead(code).matchAll(/\baction\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)].map((m) => m[1]!))];
}

/** 一段跑通的 compose 代码存在哪：按代码哈希放 globalDir（~/.lore/compose/）。 */
export function composeTarget(globalDir: string, code: string): string {
  return path.join(globalDir, `${composeHash(code)}.js`);
}

/**
 * 存一段跑成功的 compose 代码到 file。再次成功时累加 description（最多 5 句，新的在前）和次数；代码换成这次的。
 * 头由 lore 填：@description、@compose（代码里 action("名字") 调用的）、@params（代码里读的 lore.params.名字）、@ok（成功次数和最近时间）；下面是代码原文。
 */
export function saveComposed(file: string, code: string, description: string, now = Date.now()): { file: string; uses: string[]; params: string[] } {
  const body = stripComposeHead(code).trim();
  const uses = composeUses(body);
  const params = [...new Set([...body.matchAll(/\blore\.params\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
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
  const head = [`// ${descriptions[0]}`, "/**", ...descriptions.map((x) => ` * @description ${x}`), ` * @compose ${uses.join(", ") || "（无）"}`, ` * @params ${params.join(", ") || "（无）"}`, ` * @ok ${ok + 1} 次，最近 ${stamp}`, " */"];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.join("\n")}\n${body}\n`, { mode: 0o600 });
  return { file, uses, params };
}

/**
 * 哈希命名的 compose 的淘汰：@ok 成功次数 ≥2 的（被复用过）永远保留，也不占名额；
 * 只跑过一次的，超过 maxAgeMs 删掉，剩下的按修改时间只留最近 keep 个。
 */
export function pruneUnnamed(globalDir: string, keep = UNNAMED_COMPOSE_KEEP, maxAgeMs = UNNAMED_COMPOSE_MAX_AGE_MS, now = Date.now()): void {
  if (!fs.existsSync(globalDir)) return;
  const once = fs.readdirSync(globalDir).filter((f) => /^[0-9a-f]{12}\.js$/.test(f)).map((f) => {
    const file = path.join(globalDir, f);
    const ok = Number(/^ \* @ok (\d+)/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? 0);
    return { file, ok, t: fs.statSync(file).mtimeMs };
  }).filter((x) => x.ok < 2).sort((a, b) => b.t - a.t);
  once.forEach(({ file, t }, i) => { if (i >= keep || now - t > maxAgeMs) fs.rmSync(file, { force: true }); });
}

/**
 * 把 src/action-lib 同步到 ~/.lore/lib：action 脚本（sites/<站点>/actions/）从 ../../../lib/index.js 引用 SDK，daemon 每次启动都整个覆盖，保证 SDK 和 daemon 是同一个版本。
 * agent 自己的函数在 ~/.lore/helpers/，这里只在它不存在时建好目录，从不覆盖、不删除。
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
export function draftActions(sitesDir: string): ActionSummary[] {
  return listActions(sitesDir).filter((t) => t.status === "draft");
}

