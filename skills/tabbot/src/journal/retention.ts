import { LOG_LIMITS } from "../utils/constants.ts";
import { tierOf, type SiteLog } from "./sitelog.ts";

/**
 * 两层淘汰（额度见 LOG_LIMITS）：
 * 1. 重量层（响应体、文档、快照）超了：从最旧的段开始，只删没受保护的重量层文件；时间线和请求文件原样保留。
 * 2. 轻量层（时间线、请求文件）超了：删最旧的整段。
 * 单个站点超了只动这个站点；总量超了先动占用最多的站点。当前段永远不动。接口样本（受保护的文件）在重量层淘汰时跳过。
 */
export type Limits = { totalLight: number; totalHeavy: number; siteLight: number; siteHeavy: number };
export type RetentionHooks = {
  /** 这个站点受保护的文件（相对 log/ 目录的路径）：每个接口最近几次成功请求的请求文件和响应体。 */
  protect?: (site: string) => ReadonlySet<string>;
  /** 这个站点有文件被删了。 */
  changed?: (site: string) => void;
};
export type RetentionResult = { strippedFiles: number; strippedBytes: number; removedSegments: number };

/** 从最旧的段开始删这个站点没受保护的重量层文件，删到有东西可删的第一个段为止；返回释放的字节数。 */
function stripOldestHeavy(log: SiteLog, site: string, keep: ReadonlySet<string>, result: RetentionResult): number {
  const current = log.currentSegment(site);
  for (const id of log.segmentIds(site)) {
    if (id === current) continue;
    let freed = 0;
    for (const f of log.segmentFiles(site, id)) {
      if (tierOf(f.name) !== "heavy") continue;
      const rel = `${String(id).padStart(6, "0")}/${f.name}`;
      if (keep.has(rel)) continue;
      const n = log.removeFile(site, rel);
      if (n > 0) { freed += n; result.strippedFiles++; }
    }
    if (freed > 0) { result.strippedBytes += freed; return freed; }
  }
  return 0;
}

function removeOldestSegment(log: SiteLog, site: string, result: RetentionResult): number {
  const current = log.currentSegment(site);
  const id = log.segmentIds(site).find((x) => x !== current);
  if (id === undefined) return 0;
  const freed = log.removeSegment(site, id);
  result.removedSegments++;
  return freed.light + freed.heavy;
}

export function enforce(log: SiteLog, hooks: RetentionHooks = {}, limits: Limits = LOG_LIMITS): RetentionResult {
  const result: RetentionResult = { strippedFiles: 0, strippedBytes: 0, removedSegments: 0 };
  const touched = new Set<string>();
  const keepOf = (site: string): ReadonlySet<string> => hooks.protect?.(site) ?? new Set();
  const use = (site: string) => log.usage().sites[site] ?? { light: 0, heavy: 0 };
  const strip = (site: string): number => { const n = stripOldestHeavy(log, site, keepOf(site), result); if (n > 0) touched.add(site); return n; };
  const drop = (site: string): number => { const n = removeOldestSegment(log, site, result); if (n > 0) touched.add(site); return n; };
  const biggest = (pick: (u: { light: number; heavy: number }) => number): string[] =>
    Object.entries(log.usage().sites).sort((a, b) => pick(b[1]) - pick(a[1])).map(([site]) => site);

  // 重量层：单站点，再总量
  for (const site of Object.keys(log.usage().sites)) while (use(site).heavy > limits.siteHeavy && strip(site) > 0);
  while (log.usage().heavy > limits.totalHeavy) { if (!biggest((u) => u.heavy).some((site) => strip(site) > 0)) break; }
  // 轻量层：单站点，再总量
  for (const site of Object.keys(log.usage().sites)) while (use(site).light > limits.siteLight && drop(site) > 0);
  while (log.usage().light > limits.totalLight) { if (!biggest((u) => u.light).some((site) => drop(site) > 0)) break; }

  for (const site of touched) hooks.changed?.(site);
  return result;
}
