import { LOG_LIMITS, RUN_WINDOWS_KEEP } from "../utils/constants.ts";
import { tierOf, type WindowLog } from "./windowlog.ts";

/**
 * 按窗口目录淘汰：
 * 1. run 窗口只留最近 RUN_WINDOWS_KEEP 个，更旧的整个删掉。
 * 2. 学习窗口的重量层（响应体、页面、截图）超了：从最旧的窗口开始，只删没受保护的重量层文件；时间线和请求文件原样保留。
 * 3. 学习窗口的轻量层超了：删最旧的整个窗口目录。
 * 开着的学习窗口永远不动；接口样本（受保护的文件，相对 root 的路径）在重量层淘汰时跳过。
 */
export type Limits = { totalLight: number; totalHeavy: number; runKeep: number };
export type RetentionHooks = {
  /** 受保护的文件（相对 root 的路径）：每个接口最近几次成功请求的请求文件和响应体。 */
  protect?: () => ReadonlySet<string>;
  /** 学习窗口还开着（Chrome 窗口在用）：不动它。 */
  isOpen?: (win: string) => boolean;
  /** 有文件被删了（样本可能不在了）。 */
  changed?: () => void;
};
export type RetentionResult = { strippedFiles: number; strippedBytes: number; removedWindows: number };

const DEFAULT_LIMITS: Limits = { totalLight: LOG_LIMITS.totalLight, totalHeavy: LOG_LIMITS.totalHeavy, runKeep: RUN_WINDOWS_KEEP };

export function enforce(log: WindowLog, hooks: RetentionHooks = {}, limits: Limits = DEFAULT_LIMITS): RetentionResult {
  const result: RetentionResult = { strippedFiles: 0, strippedBytes: 0, removedWindows: 0 };
  const isOpen = hooks.isOpen ?? (() => false);

  const runs = log.listWindows("run");
  for (const win of runs.slice(0, Math.max(0, runs.length - limits.runKeep))) { log.removeWindow(win); result.removedWindows++; }

  const closed = (): string[] => log.listWindows("learn").filter((w) => !isOpen(w));
  if (log.usage().learn.heavy > limits.totalHeavy) {
    const keep = hooks.protect?.() ?? new Set<string>();
    for (const win of closed()) {
      if (log.usage().learn.heavy <= limits.totalHeavy) break;
      for (const f of log.windowFiles(win)) {
        if (tierOf(f.rel) !== "heavy" || keep.has(log.ref(win, f.rel))) continue;
        const n = log.removeFile(win, f.rel);
        if (n > 0) { result.strippedFiles++; result.strippedBytes += n; }
      }
    }
  }
  for (const win of closed()) {
    if (log.usage().learn.light <= limits.totalLight) break;
    log.removeWindow(win);
    result.removedWindows++;
  }
  if (result.strippedFiles || result.removedWindows) hooks.changed?.();
  return result;
}
