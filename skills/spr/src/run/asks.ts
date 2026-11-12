import { randomBytes } from "node:crypto";
import type { Answer, JournalEntry } from "./runner.ts";

/** 可以接着跑的 run：停在 ask 的，或失败了的（failed）。name：run 的 compose；code：ask 停下那一刻的 compose 代码，失败后恢复没有，读当前文件。drafts：之前已经成功的 draft 文件（恢复时不会再执行，最终成功时一起变成 verified）。 */
export type PendingAsk = { t: number; question: string; failed?: boolean; name: string; code?: string; params: Record<string, string>; journal: JournalEntry[]; answers: Answer[]; drafts: string[] };

const ASK_KEEP = 20;
export const ASK_TTL_MS = 30 * 60_000;

/** 恢复记录：只在 daemon 内存里（重启就没了），最多 ASK_KEEP 条、ASK_TTL_MS 过期。 */
export class PendingAsks {
  private readonly map = new Map<string, PendingAsk>();

  /** 存一条，返回恢复编号 AS-…。 */
  add(ask: Omit<PendingAsk, "t">): string {
    const id = `AS-${randomBytes(4).toString("hex")}`;
    this.map.set(id, { ...ask, t: Date.now() });
    while (this.map.size > ASK_KEEP) this.map.delete(this.map.keys().next().value!);
    return id;
  }

  get(id: string): PendingAsk | undefined {
    for (const [k, v] of this.map) if (Date.now() - v.t > ASK_TTL_MS) this.map.delete(k);
    return this.map.get(id);
  }

  delete(id: string): void { this.map.delete(id); }
}
