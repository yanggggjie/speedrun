/** 租约：agent 能不能在某个标签页上动手（只管写，读不受影响）。状态在 holder 里；人一动手就撤销。 */

/** 真人输入之后这段时间内不能获取租约。 */
export const HUMAN_IDLE_MS = 1500;
/** 租约超过这么久没有动作就失效，避免忘了交还。 */
export const LEASE_IDLE_MS = 10 * 60_000;

export type LeaseEvent = { tab: number; state: "acquired" | "released" | "revoked" | "expired"; reason?: string; by?: string; t: number };

export class Leases {
  private readonly leases = new Map<number, { since: number; used: number }>();
  private readonly humanAt = new Map<number, number>();
  private readonly now: () => number;
  /** 租约变化时调用（holder 把它写进日志）。 */
  onEvent: (event: LeaseEvent) => void = () => {};

  constructor(now: () => number = Date.now) { this.now = now; }

  private emit(tab: number, state: LeaseEvent["state"], extra: { reason?: string; by?: string } = {}): void {
    this.onEvent({ tab, state, t: this.now(), ...extra });
  }

  /** 真人输入：撤销租约；滚轮、滚动只当"人在场"，不撤销（agent 用元素引用定位，滚动不会让目标失效）。 */
  humanInput(tab: number, kind: string): void {
    this.humanAt.set(tab, this.now());
    if (kind === "wheel" || kind === "scroll") return;
    if (this.leases.delete(tab)) this.emit(tab, "revoked", { reason: "human", by: kind });
  }

  /** 人最近一次输入到现在多久；没有输入过返回 undefined。 */
  humanIdleMs(tab: number): number | undefined {
    const at = this.humanAt.get(tab);
    return at === undefined ? undefined : this.now() - at;
  }

  acquire(tab: number): { granted: true; already?: boolean } | { granted: false; reason: "human-active"; idleMs: number } {
    if (this.has(tab)) return { granted: true, already: true };
    const idle = this.humanIdleMs(tab) ?? Number.POSITIVE_INFINITY;
    if (idle < HUMAN_IDLE_MS) return { granted: false, reason: "human-active", idleMs: idle };
    this.leases.set(tab, { since: this.now(), used: this.now() });
    this.emit(tab, "acquired");
    return { granted: true };
  }

  release(tab: number, reason?: string): boolean {
    const had = this.leases.delete(tab);
    if (had) this.emit(tab, "released", { reason: reason?.slice(0, 200) ?? "" });
    return had;
  }

  /** 有没有持有租约（不记一次使用）。 */
  has(tab: number): boolean {
    const held = this.leases.get(tab);
    if (held && this.now() - held.used > LEASE_IDLE_MS) { this.leases.delete(tab); this.emit(tab, "expired", { reason: "idle" }); return false; }
    return held !== undefined;
  }

  /** 动手之前调用：持有租约就记一次使用并返回 true。 */
  use(tab: number): boolean {
    if (!this.has(tab)) return false;
    this.leases.get(tab)!.used = this.now();
    return true;
  }

  /** 标签页关了。 */
  closed(tab: number): void {
    this.leases.delete(tab);
    this.humanAt.delete(tab);
  }
}
