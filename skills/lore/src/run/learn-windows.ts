import { siteDirName } from "../utils/url.ts";
import type { WindowLog } from "../journal/windowlog.ts";

/** 一个 learn 窗口最多这么多次页面操作（防止失控地翻页面）。 */
export const LEARN_MAX_OPS = 200;
/** learn 窗口这么久没有任何操作就关掉 Chrome 窗口（句柄和目录保留，再操作时从上次的 URL 重开）。 */
export const LEARN_IDLE_MS = 30 * 60_000;

/**
 * 一个 learn 窗口：一个窗口里可以学多个 action，不绑定 action。
 * id 是句柄（<站点>-<年月日>-<时分秒>），持久：信息存在 learn-windows/<句柄>/meta.json，daemon 重启后照样能用。
 * url、title 是最近一次看到的页面（重开时回到这里）；cursor 是观察的游标（这个编号之前的都观察过了）；open 是这个 daemon 里 Chrome 窗口开着。
 */
export type LearnWindow = { id: string; site: string; description: string; url: string; title: string; cursor: number; ops: number; open: boolean; createdAt: number; lastActive: number };

const pad = (n: number): string => String(n).padStart(2, "0");
/** 句柄里的时间：本地时间 20261101-130245。 */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
/** 句柄的样子：站点目录名加 8 位日期加 6 位时间（可能带 -2 这样的重名后缀）。 */
export const HANDLE = /^[A-Za-z0-9._-]+-\d{8}-\d{6}(?:-\d+)?$/;

export class LearnWindows {
  private readonly log: WindowLog;
  private readonly map = new Map<string, LearnWindow>();

  constructor(log: WindowLog) { this.log = log; }

  /** 开一个新的 learn 窗口（登记、建目录、写 meta）。 */
  create(info: { site: string; description: string; url: string }, now = Date.now()): LearnWindow {
    const base = `${siteDirName(info.site)}-${stamp(now)}`;
    let id = base;
    for (let i = 2; this.map.has(id) || this.log.kindOf(id); i++) id = `${base}-${i}`;
    const w: LearnWindow = { id, ...info, title: "", cursor: this.log.lastSeq(), ops: 0, open: false, createdAt: now, lastActive: now };
    this.map.set(id, w);
    this.log.openWindow(id, "learn", w);
    return w;
  }

  /** 按句柄找：内存里没有就从 meta.json 读回（daemon 重启过，Chrome 窗口当作已关）。 */
  get(id: string): LearnWindow | undefined {
    const known = this.map.get(id);
    if (known) return known;
    if (this.log.kindOf(id) !== "learn") return undefined;
    const m = this.log.readMeta(id) as Partial<LearnWindow> | undefined;
    if (!m) return undefined;
    const w: LearnWindow = { id, site: String(m.site ?? ""), description: String(m.description ?? ""), url: String(m.url ?? ""), title: String(m.title ?? ""), cursor: Number(m.cursor ?? 0), ops: Number(m.ops ?? 0), open: false, createdAt: Number(m.createdAt ?? 0), lastActive: Number(m.lastActive ?? 0) };
    this.map.set(id, w);
    return w;
  }

  save(w: LearnWindow): void {
    const old = this.log.readMeta(w.id);
    this.log.writeMeta(w.id, { ...(old ?? {}), ...w, kind: "learn" });
  }

  /** 一次页面操作：计数（超过上限拒绝）。 */
  use(id: string): LearnWindow | { error: string } {
    const w = this.get(id);
    if (!w) return { error: `没有 learn 窗口 ${id}：lore learn list 列出有哪些，或 lore learn new --url <链接|tab 号> --description "…" 开一个` };
    if (w.ops >= LEARN_MAX_OPS) return { error: `learn 窗口 ${id} 的页面操作用完了（${LEARN_MAX_OPS} 次）：卡在登录页：点一下能登录的自己点，要账号密码、二维码的请用户登录；学不会的 action 在文件头写 @status blocked 和 @note` };
    w.ops++;
    w.lastActive = Date.now();
    return w;
  }

  /** 这个 daemon 里 Chrome 窗口开着的。 */
  opened(): LearnWindow[] { return [...this.map.values()].filter((w) => w.open); }

  /** 开着但空闲太久的。 */
  idle(now = Date.now(), idleMs = LEARN_IDLE_MS): LearnWindow[] { return this.opened().filter((w) => now - w.lastActive >= idleMs); }

  /** 所有 learn 窗口（磁盘上的），新的在前。 */
  list(): LearnWindow[] {
    return this.log.listWindows("learn").reverse().map((id) => this.get(id)).filter((w): w is LearnWindow => !!w);
  }
}
