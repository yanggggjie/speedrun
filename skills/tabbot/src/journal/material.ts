import * as fs from "node:fs";
import * as path from "node:path";
import type { EndpointIndex } from "./endpoints.ts";
import type { SiteLog } from "./sitelog.ts";
import type { RequestFile, Row } from "./types.ts";

/**
 * 交接材料：派 subagent（delegate）时从站点日志里导出的一份冻结的"录制材料"，格式和日志一样（timeline.<窗口>.jsonl、请求文件、响应体），
 * 可以直接用 rg / node / Python 读。原则：
 * - 只含一个站点；
 * - 行和文件逐字复制（硬链接，不行就复制），不改写、不汇总；
 * - 按窗口分文件；仍开着的其他 debug 窗口（它们正在试错）整个排除，已收回的 debug 窗口和 user、run 照常包含；
 * - 以目标接口的样本为锚点（样本、触发它的动作、同一标签页前一分钟的行），不是固定时间窗；再加用户窗口最近一段时间的行；
 * - manifest.json 写明包含和排除了什么、有哪些缺口，不假装完整。
 */
export const LOOKBACK_MS = 30 * 60_000;
export const BEFORE_MS = 60_000;
export const MAX_SAMPLES = 20;
export const MAX_ROWS = 500;
export const MAX_FILES = 1000;
const CHAIN_DEPTH = 5;
const MATERIAL_NOTES = [
  "timeline.<窗口>.jsonl 的行与日志里的完全相同；doc、snap 两类行没有导出（页面文档和快照太大）。",
  "请求文件对所有导出的请求都有；响应体只导出锚点请求的（目标接口的样本，或没指定接口时的非 GET 请求），其余请求文件里的 responseBodyPath 指向的文件不在这里。",
  "文件引用都是 <段>/<文件名>，相对本目录。",
];

export type MaterialOptions = {
  site: string;
  /** 导出到哪个目录（会先清空）。 */
  dir: string;
  /** 目标接口，`方法 接口名`；不给就取用户窗口最近的非 GET 请求。 */
  endpoint?: string;
  /** 仍开着的 debug 窗口（它们的行不导出）。 */
  excludeWins?: Iterable<string>;
  now?: number;
  lookbackMs?: number;
  maxRows?: number;
};

export type Manifest = {
  site: string;
  createdAt: number;
  endpoint?: string;
  fromSeq: number;
  toSeq: number;
  windows: { included: string[]; excluded: string[] };
  counts: { rows: number; requests: number; requestFiles: number; responseBodies: number; anchors: number };
  notes: string[];
  warnings: string[];
};

const isOk = (status: number | undefined): boolean => typeof status === "number" && status >= 200 && status < 300;

function place(from: string, to: string): boolean {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { force: true });
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
    return true;
  } catch { return false; }
}

export function exportMaterial(log: SiteLog, index: EndpointIndex | undefined, opts: MaterialOptions): Manifest {
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackMs ?? LOOKBACK_MS;
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const excluded = new Set(opts.excludeWins ?? []);
  fs.rmSync(opts.dir, { recursive: true, force: true });
  fs.mkdirSync(opts.dir, { recursive: true });

  // 有哪些窗口留下过记录
  const present = new Set<string>();
  for (const id of log.segmentIds(opts.site)) for (const f of log.segmentFiles(opts.site, id)) { const m = /^timeline\.(.+)\.jsonl$/.exec(f.name); if (m) present.add(m[1]!); }
  const included = [...present].filter((w) => !excluded.has(w)).sort();
  const all = log.readRows(opts.site, { wins: included, limit: 50_000 });
  const bySeq = new Map(all.map((r) => [r.seq, r]));

  // 锚点：目标接口最近的成功请求；没指定接口就取用户窗口最近一段时间里动作引发的非 GET 请求
  const anchors: Row[] = opts.endpoint
    ? all.filter((r) => r.type === "request" && r.endpoint === opts.endpoint && r.requestType !== "replay" && isOk(r.status)).slice(-MAX_SAMPLES)
    : all.filter((r) => r.type === "request" && r.win === "user" && !r.noise && r.phase === "action" && r.method !== "GET" && r.t >= now - lookback).slice(-50);

  const keep = new Set<number>();
  const addChain = (row: Row): void => {
    let cur: Row | undefined = row;
    for (let i = 0; cur && i < CHAIN_DEPTH; i++) { keep.add(cur.seq); cur = cur.cause === undefined ? undefined : bySeq.get(cur.cause); }
  };
  for (const a of anchors) {
    addChain(a);
    for (const r of all) if (r.tab === a.tab && r.win === a.win && r.t >= a.t - BEFORE_MS && r.t <= a.t) keep.add(r.seq);
  }
  for (const r of all) if (r.win === "user" && r.t >= now - lookback) keep.add(r.seq);

  const exportable = (r: Row): boolean => r.type !== "doc" && r.type !== "snap";
  let chosen = all.filter((r) => keep.has(r.seq) && exportable(r));
  const anchorSeqs = new Set(anchors.map((a) => a.seq));
  if (chosen.length > maxRows) {
    // 超了：锚点和它们的因果链先保住，其余留最新的
    const must = new Set<number>(); for (const a of anchors) { let cur: Row | undefined = a; for (let i = 0; cur && i < CHAIN_DEPTH; i++) { must.add(cur.seq); cur = cur.cause === undefined ? undefined : bySeq.get(cur.cause); } }
    const rest = chosen.filter((r) => !must.has(r.seq));
    const room = Math.max(0, maxRows - chosen.filter((r) => must.has(r.seq)).length);
    const tail = new Set(rest.slice(Math.max(0, rest.length - room)).map((r) => r.seq));
    chosen = chosen.filter((r) => must.has(r.seq) || tail.has(r.seq));
  }

  // 时间线：按窗口分文件，行逐字复制
  const byWin = new Map<string, Row[]>();
  for (const r of chosen) { const list = byWin.get(r.win); if (list) list.push(r); else byWin.set(r.win, [r]); }
  for (const [win, rows] of byWin) fs.writeFileSync(path.join(opts.dir, `timeline.${win}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });

  // 请求文件（所有导出的请求）与响应体（只给锚点）
  let requestFiles = 0, responseBodies = 0, missing = 0, truncated = 0, files = 0;
  for (const r of chosen) {
    if (r.type !== "request" || !r.file || files >= MAX_FILES) continue;
    const src = log.abs(opts.site, r.file);
    if (!place(src, path.join(opts.dir, r.file))) { missing++; continue; }
    requestFiles++; files++;
    let rf: RequestFile | undefined;
    try { rf = JSON.parse(fs.readFileSync(src, "utf8")) as RequestFile; } catch { /* 读不了就不看 */ }
    if (rf?.truncated) truncated++;
    if (rf?.responseBodyPath && anchorSeqs.has(r.seq) && files < MAX_FILES) {
      if (place(log.abs(opts.site, rf.responseBodyPath), path.join(opts.dir, rf.responseBodyPath))) { responseBodies++; files++; }
      else missing++;
    }
  }

  // 缺口
  const warnings: string[] = [];
  if (all.length === 0) warnings.push("这个站点还没有任何记录（用户没在 Chrome 里访问过，或日志已被清理）：需要 subagent 自己 debug open 加 act 去触发");
  const fromSeq = chosen.length ? chosen[0]!.seq : 0, toSeq = chosen.length ? chosen[chosen.length - 1]!.seq : 0;
  const lo = chosen.length ? Math.min(...chosen.map((r) => r.t)) : 0, hi = chosen.length ? Math.max(...chosen.map((r) => r.t)) : 0;
  const bg = all.filter((r) => r.type === "bg" && r.t >= lo && r.t <= hi).reduce((n, r) => n + (r.count ?? 0), 0);
  if (bg > 0) warnings.push(`后台标签页在此期间有 ${bg} 个请求只有计数，没有内容（bg 行）`);
  if (truncated > 0) warnings.push(`${truncated} 个响应被截断（truncated），见请求文件`);
  if (missing > 0) warnings.push(`${missing} 个文件已被日志淘汰，没能导出`);
  if (opts.endpoint) {
    if (anchors.length === 0) warnings.push(`没有找到目标接口 ${opts.endpoint} 的成功请求样本`);
    else if (anchors.length < 3) warnings.push(`目标接口只有 ${anchors.length} 个样本`);
    const stat = index?.snapshot(opts.site).endpoints.find((e) => e.key === opts.endpoint);
    if (stat && !stat.replayable) warnings.push("目标接口最近一次请求的原始内容已不在内存（holder 重启过，或页面之后没再发过）：replayable 为 false，需要 subagent 自己 debug open 加 act 触发一次再重放");
  } else if (anchors.length === 0) warnings.push("用户窗口最近没有动作引发的非 GET 请求");

  const manifest: Manifest = {
    site: opts.site, createdAt: now, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), fromSeq, toSeq,
    windows: { included: [...byWin.keys()].sort(), excluded: [...excluded].filter((w) => present.has(w)).sort() },
    counts: { rows: chosen.length, requests: chosen.filter((r) => r.type === "request").length, requestFiles, responseBodies, anchors: anchors.length },
    notes: MATERIAL_NOTES, warnings,
  };
  fs.writeFileSync(path.join(opts.dir, "manifest.json"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
  return manifest;
}
