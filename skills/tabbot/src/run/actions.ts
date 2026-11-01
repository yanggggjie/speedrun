import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ACTION_TIMEOUT_MS, LIB_DIR, UNNAMED_COMPOSE_KEEP } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";

/**
 * action：TabBot 学出来、起了名字、带参数、跑通过、能被复用的业务动作。两种实现，由文件头区分：
 * - `@endpoint`（可以多行，按发送顺序）：由接口实现（请求实现，或 DOM 兜底的页面实现），用 `tabbot learn` 学出来，文件是一个 ES 模块；
 * - `@compose`：由别的 action 组合，用 `tabbot run --compose` 跑通即存，文件是一段组合代码（只能调用 action，不能碰页面）。
 */

/** action 名：小写字母数字和 -，全局唯一。 */
export const ACTION_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface ActionSummary {
  name: string;
  file: string;
  /** 所在的站点目录名；跨站点的组合（~/.tabbot/compose/ 下）没有站点。 */
  site?: string;
  /** 文件头 `@endpoint 方法 接口名`：由哪些接口实现，按发送顺序。 */
  endpoints: string[];
  /** 文件头 `@compose a, b`：由哪些 action 组合；有它就是组合实现（旧文件的 `@uses` 也算）。 */
  compose: string[];
  /** draft | verified | blocked；没写就是 verified。 */
  status: string;
  summary: string;
  params: string[];
  /** 文件头 `@timeout <秒>` 声明的上限；未声明时不出现。 */
  timeout?: number;
}

/**
 * 读取文件开头的块注释里的 `@标签 值` 行（`@status draft` 与旧写法 `@status: draft` 都认）。
 * 只看第一个块注释：代码里恰好出现 `@status` 之类的文字不会被误读；没有块注释时返回空。组合实现的头前面多一行 `// 描述`。
 */
export function headerTags(text: string): Array<[string, string]> {
  const block = /^\s*(?:#![^\n]*\n\s*)?(?:\/\/[^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!block) return [];
  const tags: Array<[string, string]> = [];
  for (const line of block[1]!.split("\n")) {
    const match = /^\s*\*?\s*@([A-Za-z]+):?\s*(.*?)\s*$/.exec(line);
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
    compose: tags.filter(([key]) => key === "compose" || key === "uses").flatMap(([, value]) => nameList(value)),
    status: first("status") || "verified",
    summary: first("summary") || first("description"),
    params: tags.filter(([key]) => key === "param").map(([, value]) => value),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

/** 是不是组合实现：文件头有 `@compose`（或旧的 `@uses`）。 */
export const isComposed = (s: Pick<ActionSummary, "compose"> & { file: string }): boolean => s.compose.length > 0 || headerTags(fs.readFileSync(s.file, "utf8")).some(([k]) => k === "compose" || k === "uses");

export interface ParamSpec { name: string; optional: boolean; description: string }

/** 解析文件头的 `@param 名字 说明` 与 `@param 名字? 说明`（带 ? 表示可选）。 */
export function paramSpecs(file: string): ParamSpec[] {
  return actionSummary(file).params.map((value) => {
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

/** 对照文件头的 @param 检查：缺必填、传了没声明的参数都返回说明；通过返回 undefined。组合实现没有 @param，不检查。 */
/** tabbot run 自己用的参数名，action 不能用。 */
const RESERVED_PARAMS = new Set(["answer", "resume"]);

export function checkParams(file: string, params: Record<string, string>): string | undefined {
  const specs = paramSpecs(file);
  const reserved = specs.filter((spec) => RESERVED_PARAMS.has(spec.name));
  if (reserved.length) return `参数名 ${reserved.map((spec) => spec.name).join("、")} 被 tabbot run 占用（--answer、--resume 用于恢复停在 tabbot.ask 的组合）：在 action 文件里换个参数名`;
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

/** 去掉组合实现的头（`// 描述` 加块注释），剩下代码原文；旧的 compose 文件头（@uses）也认。 */
export function stripComposeHead(code: string): string {
  return code.replace(/^\s*\/\/[^\n]*\n\/\*\*\n(?: \* @(?:description|compose|uses|params|ok) [^\n]*\n)+ \*\/\n/, "");
}

/** 组合代码的哈希（去掉头之后）：没起名字的组合用它的前 12 位当名字。 */
export function composeHash(code: string): string {
  return createHash("sha256").update(stripComposeHead(code).trim()).digest("hex").slice(0, 12);
}

/** 组合代码里调用的 action：`action("名字", …)`。 */
export function composeUses(code: string): string[] {
  return [...new Set([...stripComposeHead(code).matchAll(/\baction\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)].map((m) => m[1]!))];
}

/**
 * 组合存在哪：没起名字的按哈希放 globalDir；起了名字的，用到的 action 都在同一个站点就放那个站点的 actions/，否则放 globalDir（跨站点）。
 */
export function composeTarget(opts: { sitesDir: string; globalDir: string; code: string; name?: string }): string {
  if (!opts.name) return path.join(opts.globalDir, `${composeHash(opts.code)}.js`);
  const sites = new Set(composeUses(opts.code).map((u) => findAction(opts.sitesDir, u, opts.globalDir)?.site ?? ""));
  const only = sites.size === 1 ? [...sites][0] : "";
  return path.join(only ? actionsDirOf(opts.sitesDir, only) : opts.globalDir, `${opts.name}.js`);
}

/**
 * 存一段跑成功的组合代码到 file。再次成功时累加 description（最多 5 句，新的在前）和次数；代码换成这次的。
 * 头由 TabBot 填：@description、@compose（代码里 action("名字") 调用的）、@params（代码里读的 tabbot.params.名字）、@ok（成功次数和最近时间）；下面是代码原文。
 */
export function saveComposed(file: string, code: string, description: string, now = Date.now()): { file: string; uses: string[]; params: string[] } {
  const body = stripComposeHead(code).trim();
  const uses = composeUses(body);
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
  const head = [`// ${descriptions[0]}`, "/**", ...descriptions.map((x) => ` * @description ${x}`), ` * @compose ${uses.join(", ") || "（无）"}`, ` * @params ${params.join(", ") || "（无）"}`, ` * @ok ${ok + 1} 次，最近 ${stamp}`, " */"];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.join("\n")}\n${body}\n`, { mode: 0o600 });
  return { file, uses, params };
}

/** 没起名字的组合（哈希命名）只留最近 keep 个（按修改时间）；起了名字的不动。 */
export function pruneUnnamed(globalDir: string, keep = UNNAMED_COMPOSE_KEEP): void {
  if (!fs.existsSync(globalDir)) return;
  const files = fs.readdirSync(globalDir).filter((f) => /^[0-9a-f]{12}\.js$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(globalDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) fs.rmSync(path.join(globalDir, f), { force: true });
}

/** 把 src/action-lib 同步到 ~/.tabbot/lib：action 脚本（sites/<站点>/actions/）从 ../../../lib/index.js 引用 SDK，holder 每次启动都覆盖，保证和代码一致。 */
export function syncActionLib(libDir = LIB_DIR, from = path.join(import.meta.dirname, "..", "action-lib")): void {
  fs.mkdirSync(path.dirname(libDir), { recursive: true });
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.cpSync(from, libDir, { recursive: true });
}

const STATUS_LINE = /^(\s*\*?\s*@status):?\s*(\w+)\b/m;

/** 改文件头的 @status（统一写成 `@status 值`）；没有 @status 行就不动。返回原来的状态。 */
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

/** 这个站点的 action 覆盖的接口：键是 `方法 接口名`（和 endpoints.json 的 key 一致），值是 action 名。多行 @endpoint 每一行都算。 */
export function coveredEndpoints(sitesDir: string, site: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of listActions(sitesDir, site)) for (const e of r.endpoints) out.set(e, r.name);
  return out;
}

/** 还没验证的草稿（@status draft）。 */
export function draftActions(sitesDir: string): ActionSummary[] {
  return listActions(sitesDir).filter((t) => t.status === "draft");
}

/** 这次布局的标记：日志按窗口存（learn-windows/、run-windows/），跨站点的组合在 compose/。写在 sites/.layout 里。 */
export const LAYOUT = "windows-1";

/**
 * 升级到按窗口存日志的布局，只做一次（看 sites/.layout）：旧日志不兼容，直接删掉。
 * - 删 sites/<站点>/log/、sites/<站点>/debug/、sites/.compose，以及 ~/.tabbot/run/（旧的运行历史）、journal.old、task.old；
 * - endpoints.json 保留接口统计和 descriptions（业务知识），清空指向旧日志的 samples；
 * - 删完后既没有接口、也没有 actions/*.js 的站点目录整个删掉（广告、嵌入页面留下的）；
 * - ~/.tabbot/actions/*.js（跨站点的组合）挪进 ~/.tabbot/compose/。
 */
export function upgradeLayout(home: string): boolean {
  const sitesDir = path.join(home, "sites");
  const marker = path.join(sitesDir, ".layout");
  try { if (fs.readFileSync(marker, "utf8").trim() === LAYOUT) return false; } catch { /* 还没升级过 */ }
  for (const old of ["run", "journal.old", "task.old", path.join("sites", ".compose")]) fs.rmSync(path.join(home, old), { recursive: true, force: true });
  for (const site of siteDirs(sitesDir)) {
    const dir = path.join(sitesDir, site);
    for (const sub of ["log", "debug", "journal.old", "task.old"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
    const epFile = path.join(dir, "endpoints.json");
    let endpoints = 0;
    try {
      const data = JSON.parse(fs.readFileSync(epFile, "utf8")) as { endpoints?: Array<Record<string, unknown>> };
      for (const e of data.endpoints ?? []) { e.samples = []; e.replayable = false; }
      endpoints = data.endpoints?.length ?? 0;
      if (endpoints) fs.writeFileSync(epFile, JSON.stringify(data, null, 1), { mode: 0o600 });
    } catch { /* 没有或坏了 */ }
    const actions = actionsDirOf(sitesDir, site);
    const hasActions = fs.existsSync(actions) && fs.readdirSync(actions).some((f) => f.endsWith(".js"));
    if (!endpoints && !hasActions) fs.rmSync(dir, { recursive: true, force: true });
  }
  const oldGlobal = path.join(home, "actions");
  if (fs.existsSync(oldGlobal)) {
    const to = path.join(home, "compose");
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(oldGlobal).filter((x) => x.endsWith(".js"))) {
      const target = path.join(to, f);
      if (!fs.existsSync(target)) fs.renameSync(path.join(oldGlobal, f), target);
    }
    fs.rmSync(oldGlobal, { recursive: true, force: true });
  }
  fs.mkdirSync(sitesDir, { recursive: true });
  fs.writeFileSync(marker, LAYOUT, { mode: 0o600 });
  return true;
}
