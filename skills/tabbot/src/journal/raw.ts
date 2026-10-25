/**
 * 原始请求：页面里发出的同站请求，带请求头里的 token 真值，只放在 holder 的内存里（绝不落盘），重放时用。
 * 有字节上限，超过就先丢最旧的；holder 重启就没了。
 */
export type RawEntry = { method: string; url: string; headers: Record<string, string>; body: string | null; page: string; t: number; size: number };

export const RAW_MAX_BYTES = 50 * 1024 * 1024;
export const RAW_ITEM_MAX = 64 * 1024;

export class RawStore {
  private readonly map = new Map<string, RawEntry>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = RAW_MAX_BYTES) { this.maxBytes = maxBytes; }

  private key(tab: number, rid: string): string { return `${tab}:${rid}`; }

  /** 单条太大的不存（也就没法重放）。 */
  put(tab: number, rid: string, entry: Omit<RawEntry, "size">): boolean {
    const size = JSON.stringify(entry).length;
    if (size > RAW_ITEM_MAX) return false;
    const key = this.key(tab, rid);
    const old = this.map.get(key);
    if (old) { this.bytes -= old.size; this.map.delete(key); }
    this.map.set(key, { ...entry, size });
    this.bytes += size;
    for (const [k, v] of this.map) { if (this.bytes <= this.maxBytes) break; this.map.delete(k); this.bytes -= v.size; } // Map 按插入顺序，先丢最旧的
    return true;
  }

  get(tab: number, rid: string): RawEntry | undefined { return this.map.get(this.key(tab, rid)); }

  /** 最近一次满足条件的原始请求（从新到旧找）：task 里 inherit 请求头用。 */
  newest(match: (e: RawEntry) => boolean): RawEntry | undefined {
    const all = [...this.map.values()];
    for (let i = all.length - 1; i >= 0; i--) if (match(all[i]!)) return all[i];
    return undefined;
  }

  totalBytes(): number { return this.bytes; }
}
