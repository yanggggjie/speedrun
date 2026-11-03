/**
 * 原始请求：agent 窗口里页面发出的同站请求，带请求头里的 token 真值，只放在 daemon 的内存里（绝不落盘）。
 * 按窗口存：request() 只从这次窗口里页面发过的请求抄头，观察只看这个窗口的；窗口关掉（learn close、run 结束）就清掉这个窗口的。
 * 有字节上限，超过就先丢最旧的；daemon 重启就没了。
 */
/** doc：页面加载的编号（rid 的前半段，同一次加载的请求相同）。 */
export type RawEntry = { win: string; doc: string; endpoint: string; method: string; url: string; headers: Record<string, string>; body: string | null; page: string; t: number; size: number };

export const RAW_MAX_BYTES = 50 * 1024 * 1024;
export const RAW_ITEM_MAX = 64 * 1024;

export class RawStore {
  private readonly map = new Map<string, RawEntry>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = RAW_MAX_BYTES) { this.maxBytes = maxBytes; }

  private key(win: string, tab: number, rid: string): string { return `${win}\n${tab}:${rid}`; }

  /** 单条太大的不存（也就没法抄它的请求头）。 */
  put(tab: number, rid: string, entry: Omit<RawEntry, "size">): boolean {
    const size = JSON.stringify(entry).length;
    if (size > RAW_ITEM_MAX) return false;
    const key = this.key(entry.win, tab, rid);
    const old = this.map.get(key);
    if (old) { this.bytes -= old.size; this.map.delete(key); }
    this.map.set(key, { ...entry, size });
    this.bytes += size;
    for (const [k, v] of this.map) { if (this.bytes <= this.maxBytes) break; this.map.delete(k); this.bytes -= v.size; } // Map 按插入顺序，先丢最旧的
    return true;
  }

  get(win: string, tab: number, rid: string): RawEntry | undefined { return this.map.get(this.key(win, tab, rid)); }

  /** 这个窗口的全部原始请求，从旧到新。 */
  inWindow(win: string): RawEntry[] { return [...this.map.values()].filter((e) => e.win === win); }

  /** 窗口关掉：清掉这个窗口的。 */
  dropWindow(win: string): void {
    for (const [k, v] of this.map) if (v.win === win) { this.map.delete(k); this.bytes -= v.size; }
  }

  totalBytes(): number { return this.bytes; }
}
