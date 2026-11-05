/**
 * 页面函数：页面自己的 JS 接口（在线表格的 SpreadsheetApp 这类）。它们不是网络请求，录制和 DOM 都看不到。
 * learn 窗口自动做快照落盘：窗口里 page-api/，站点累积 sites/<站点>/page-api.json（只由 learn 窗口写，agent 用 rg 读）。
 * 只记名字、类型和结构，不记值；快照只读属性描述，不调用 getter。trace 临时包住 agent 指定的函数，记真实调用。
 * scanPage、traceStart、traceEnd 是放进页面执行的函数（host.peek），不能用外面的变量。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { siteDirName } from "../utils/url.ts";

export type ApiObject = { path: string; kind: string; methods: string[]; props: string[]; getters: string[]; hidden: number };
export type PageScan = { url: string; objects: ApiObject[]; canvas: boolean; scripts: string; error?: string };
export type TraceCall = { path: string; args: unknown[]; returns?: unknown; threw?: string; t: number };
export type TraceResult = { calls: TraceCall[]; dropped: number; found: boolean };
type SiteApi = { site: string; updatedAt: number; version: string; objects: Record<string, Omit<ApiObject, "path"> & { seenAt: number }>; calls: Record<string, { count: number; args: string[]; returns?: string; seenAt: number }>; usedBy: Record<string, string[]> };

/** 站点文件最多留多少个对象：先丢最久没见到的。 */
const SITE_OBJECTS_MAX = 2000;
/** 这些名字多半是上报、日志和通用库，不当线索（快照里还在）。 */
const TELEMETRY = /log|report|monitor|track|analytic|sentry|netcheck|darkmode|dcr|tdw|cube|performance|config$|^(_|echarts|mermaid|prism|hotkeys|moment|dayjs|lodash|axios|aegis|ucharts|superplayerexport|reflect)$/i;
/** 线索最多列几个对象。 */
const CLUES_MAX = 3;

/** 在页面里执行：列出页面自己的全局对象和方法。opts.path 给了就从这个对象开始（路径上的属性可以是 getter：这是 agent 明确要看的）。 */
export function scanPage(opts: { path?: string }): PageScan {
  const MAX_ROOTS = 80, MAX_DEPTH = opts.path ? 2 : 3, MAX_OBJECTS = 800, MAX_PER_ROOT = 40, MAX_NAMES = 150;
  const VENDOR = /^(__|_[a-zA-Z]|webpack|jQuery$|\$|React|Zone$|Raven$|regeneratorRuntime$|core$|i18n$)/;
  const isNative = (f: unknown): boolean => { try { return /\[native code\]/.test(Function.prototype.toString.call(f)); } catch { return true; } };
  const descOf = (o: object, k: string): PropertyDescriptor | undefined => {
    let p: object | null = o;
    for (let i = 0; p && i < 5; i++) { const d = Object.getOwnPropertyDescriptor(p, k); if (d) return d; p = Object.getPrototypeOf(p); }
    return undefined;
  };
  const namesOf = (o: object): string[] => {
    const n = new Set<string>();
    let p: object | null = o;
    for (let i = 0; p && p !== Object.prototype && p !== Function.prototype && i < 4; i++) { for (const k of Object.getOwnPropertyNames(p)) n.add(k); p = Object.getPrototypeOf(p); }
    for (const k of ["constructor", "prototype", "length", "name", "arguments", "caller"]) n.delete(k);
    return [...n];
  };
  const skip = (v: unknown): boolean => v === window || Array.isArray(v) || v instanceof Node || v instanceof Map || v instanceof Set || v instanceof Promise;
  const seen = new Set<unknown>();
  const objects: ApiObject[] = [];
  let budget = MAX_PER_ROOT; // 每个顶层对象单独限额：一个大对象不能占满，把别的对象挤掉
  // 广度优先：限额用完时留下的是靠近顶层的对象
  const visit = (at: string, o: object, depth: number, queue: Array<[string, object, number]>): void => {
    if (seen.has(o) || objects.length >= MAX_OBJECTS || budget <= 0 || skip(o)) return;
    budget--;
    seen.add(o);
    const rec: ApiObject = { path: at, kind: typeof o === "function" ? "function" : "object", methods: [], props: [], getters: [], hidden: 0 };
    const children: Array<[string, object]> = [];
    try {
      for (const k of namesOf(o)) {
        if (k.startsWith("_")) { rec.hidden++; continue; }
        const d = descOf(o, k);
        if (!d) continue;
        if (d.get || d.set) { if (rec.getters.length < MAX_NAMES) rec.getters.push(k); continue; }
        const v = d.value;
        if (typeof v === "function") {
          if (!isNative(v) && rec.methods.length < MAX_NAMES) rec.methods.push(`${k}/${v.length}`);
        } else if (v && typeof v === "object") {
          if (rec.props.length < MAX_NAMES) rec.props.push(k);
          children.push([k, v]);
        } else if (rec.props.length < MAX_NAMES) rec.props.push(`${k}:${typeof v}`);
      }
    } catch { /* 代理对象之类读不了：留下已有的 */ }
    objects.push(rec);
    if (depth < MAX_DEPTH) for (const [k, v] of children) queue.push([`${at}.${k}`, v, depth + 1]);
  };
  const walk = (at: string, o: object): void => {
    const queue: Array<[string, object, number]> = [[at, o, 0]];
    for (let i = 0; i < queue.length; i++) visit(queue[i]![0], queue[i]![1], queue[i]![2], queue);
  };
  let error: string | undefined;
  if (opts.path) {
    let cur: any = window;
    try { for (const seg of opts.path.split(".")) cur = cur?.[seg]; } catch { cur = undefined; }
    budget = MAX_OBJECTS;
    if (cur && (typeof cur === "object" || typeof cur === "function")) walk(opts.path, cur);
    else error = `页面上没有对象 ${opts.path}`;
  } else {
    const roots: Array<[string, object]> = [];
    for (const k of Object.getOwnPropertyNames(window)) {
      if (VENDOR.test(k)) continue;
      const d = Object.getOwnPropertyDescriptor(window, k);
      if (!d || d.get || d.set) continue; // 浏览器自带的多是访问器
      const v = d.value;
      if (!v || (typeof v !== "object" && typeof v !== "function") || (typeof v === "function" && isNative(v)) || skip(v)) continue;
      roots.push([k, v]);
    }
    // 名字像应用入口的优先，其余按方法和属性多少：快照有限额，重要的对象先进
    const size = (o: object): number => { try { return namesOf(o).length; } catch { return 0; } };
    const rank = ([k, v]: [string, object]): number => (/App|Api|Sheet|Doc|Editor|Store|Model|Workbook|Board|Canvas/.test(k) ? 1000 : 0) + Math.min(size(v), 500);
    for (const [k, v] of roots.sort((a, b) => rank(b) - rank(a)).slice(0, MAX_ROOTS)) { budget = MAX_PER_ROOT; walk(k, v); }
  }
  const area = innerWidth * innerHeight || 1;
  const canvas = [...document.querySelectorAll("canvas")].some((c) => { const r = c.getBoundingClientRect(); return (r.width * r.height) / area >= 0.35; });
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 40).join("\n");
  return { url: location.href, objects, canvas, scripts, ...(error ? { error } : {}) };
}

/** 在页面里执行：包住这些函数，seconds 秒后自动恢复。参数和返回值只留能序列化的一份（限深度和长度），不调用 getter。 */
export function traceStart(paths: string[], seconds: number): { wrapped: string[]; failed: string[] } {
  const w = window as any;
  const T = (w.__sprTrace ??= { calls: [], dropped: 0, undo: [], timer: 0 });
  const MAX_CALLS = 200;
  const copy = (v: any, depth: number, seen: Set<unknown>): unknown => {
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (v === undefined) return "[undefined]";
    if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
    if (typeof v === "function") return "[函数]";
    if (typeof v !== "object") return `[${typeof v}]`;
    if (v instanceof Node) return "[元素]";
    if (seen.has(v)) return "[循环引用]";
    if (depth <= 0) return `[${v.constructor?.name ?? "对象"}]`;
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => copy(x, depth - 1, seen));
    const out: Record<string, unknown> = {};
    const ctor = v.constructor?.name;
    if (ctor && ctor !== "Object") out.__class = ctor;
    for (const k of Object.keys(v).slice(0, 30)) { const d = Object.getOwnPropertyDescriptor(v, k); out[k] = d && "value" in d ? copy(d.value, depth - 1, seen) : "[getter]"; }
    return out;
  };
  const wrapped: string[] = [], failed: string[] = [];
  for (const at of paths) {
    try {
      const segs = at.split("."), name = segs.pop()!;
      let parent: any = window;
      for (const seg of segs) parent = parent?.[seg];
      const orig = parent?.[name];
      if (typeof orig !== "function") { failed.push(`${at}：不是函数`); continue; }
      const own = Object.prototype.hasOwnProperty.call(parent, name);
      const fn = function (this: unknown, ...args: unknown[]): unknown {
        const rec: any = { path: at, args: [], t: Date.now() };
        if (T.calls.length < MAX_CALLS) { try { rec.args = args.map((a) => copy(a, 4, new Set())); } catch { /* 记录失败不影响页面 */ } T.calls.push(rec); } else T.dropped++;
        try {
          const r = orig.apply(this, args);
          try { rec.returns = r && typeof r.then === "function" ? "[Promise]" : copy(r, 2, new Set()); } catch { /* 同上 */ }
          return r;
        } catch (e) { rec.threw = String(e).slice(0, 200); throw e; }
      };
      parent[name] = fn;
      if (parent[name] !== fn) { failed.push(`${at}：改不了（只读）`); continue; }
      T.undo.push(() => { if (own) parent[name] = orig; else delete parent[name]; });
      wrapped.push(at);
    } catch (e) { failed.push(`${at}：${String(e).slice(0, 120)}`); }
  }
  clearTimeout(T.timer);
  T.restore = () => { for (const u of T.undo.splice(0).reverse()) { try { u(); } catch { /* 页面已经改过这个属性 */ } } };
  T.timer = setTimeout(T.restore, seconds * 1000);
  return { wrapped, failed };
}

/** 在页面里执行：恢复原函数，取走记录。found 为假：页面跳转过，记录和包裹都没了。 */
export function traceEnd(): TraceResult {
  const T = (window as any).__sprTrace;
  if (!T) return { calls: [], dropped: 0, found: false };
  clearTimeout(T.timer);
  T.restore?.();
  delete (window as any).__sprTrace;
  return { calls: T.calls, dropped: T.dropped, found: true };
}

/** 一个值的结构：`{row:number,text:string}`、`[number]`。只有类型，不带值，进站点文件。 */
export function shapeOf(v: unknown, depth = 3): string {
  if (Array.isArray(v)) return v.length ? `[${shapeOf(v[0], depth - 1)}]` : "[]";
  if (v && typeof v === "object") {
    if (depth <= 0) return "{…}";
    return `{${Object.entries(v).slice(0, 12).map(([k, x]) => `${k}:${shapeOf(x, depth - 1)}`).join(",")}}`;
  }
  if (typeof v === "string" && /^\[.*\]$/.test(v)) return v;
  return v === null ? "null" : typeof v;
}

/** 线索：方法最多的几个顶层对象（把它下面的方法算在一起）。 */
export function clues(objects: ApiObject[]): string[] {
  const total = new Map<string, number>();
  for (const o of objects) { const root = o.path.split(".")[0]!; if (!TELEMETRY.test(root)) total.set(root, (total.get(root) ?? 0) + o.methods.length); }
  return [...total].filter(([, n]) => n >= 8).sort((a, b) => b[1] - a[1]).slice(0, CLUES_MAX).map(([k]) => k);
}

const fileOf = (sitesDir: string, site: string): string => path.join(sitesDir, siteDirName(site), "page-api.json");

function load(file: string, site: string): SiteApi {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as SiteApi; } catch { return { site, updatedAt: 0, version: "", objects: {}, calls: {}, usedBy: {} }; }
}

/** 用过这些顶层对象的 action：看 actions/ 里的文件有没有提到它的名字。 */
function usedBy(sitesDir: string, site: string, roots: string[]): Record<string, string[]> {
  const dir = path.join(sitesDir, siteDirName(site), "actions");
  const out: Record<string, string[]> = {};
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")); } catch { return out; }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const r of roots) if (text.includes(r)) (out[r] ??= []).push(f.slice(0, -3));
  }
  return out;
}

function save(file: string, api: SiteApi, sitesDir: string, now: number): void {
  const entries = Object.entries(api.objects);
  if (entries.length > SITE_OBJECTS_MAX) api.objects = Object.fromEntries(entries.sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, SITE_OBJECTS_MAX));
  api.updatedAt = now;
  api.usedBy = usedBy(sitesDir, api.site, [...new Set(Object.keys(api.objects).map((p) => p.split(".")[0]!))]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(api, null, 1)}\n`, { mode: 0o600 });
}

/** 把一次快照并进站点文件，返回站点文件路径。 */
export function mergeScan(sitesDir: string, site: string, scan: PageScan, now = Date.now()): string {
  const file = fileOf(sitesDir, site);
  const api = load(file, site);
  api.version = createHash("sha256").update(scan.scripts).digest("hex").slice(0, 12);
  for (const { path: at, ...rest } of scan.objects) api.objects[at] = { ...rest, seenAt: now };
  save(file, api, sitesDir, now);
  return file;
}

/** 把 trace 的结果按函数汇总进站点文件（只有结构），返回每个函数的摘要。 */
export function mergeCalls(sitesDir: string, site: string, calls: TraceCall[], now = Date.now()): Array<{ path: string; count: number; args: string[] }> {
  const by = new Map<string, TraceCall[]>();
  for (const c of calls) (by.get(c.path) ?? by.set(c.path, []).get(c.path)!).push(c);
  const file = fileOf(sitesDir, site);
  const api = load(file, site);
  const out = [...by].map(([at, list]) => {
    const args = (list[0]!.args as unknown[]).map((a) => shapeOf(a));
    const old = api.calls[at];
    api.calls[at] = { count: (old?.count ?? 0) + list.length, args, ...(list[0]!.returns !== undefined ? { returns: shapeOf(list[0]!.returns) } : {}), seenAt: now };
    return { path: at, count: list.length, args };
  });
  if (out.length) save(file, api, sitesDir, now);
  return out;
}
