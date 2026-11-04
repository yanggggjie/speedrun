import * as fs from "node:fs";
import * as path from "node:path";
import { HABIT_HOME } from "../utils/constants.ts";
import type { Row } from "./types.ts";

/**
 * 日志按窗口存：一个窗口一个目录，learn 窗口在 <root>/learn-windows/<句柄>/，run 窗口在 <root>/run-windows/<名字>/。
 * 每个目录里：meta.json、timeline.jsonl（这个窗口发生的一切，跨站点，每行带 site，追加写，不改已写的行）、
 * requests/（请求文件和响应体）、pages/（页面 HTML、快照）、screenshots/（截图）。文件名以 6 位编号开头，后面是语义（方法、endpoint 名、页面路径）。
 *
 * 文件引用分两种：窗口内的相对路径（`requests/001203-GET-api-v4-search_v3.json`，时间线和请求文件里用），
 * 和相对 root 的路径（`learn-windows/<句柄>/requests/…`，endpoints.json 的样本用，脱离窗口也能找到）。
 *
 * 分两层：时间线和请求文件是 meta、时间线和请求文件，响应体、页面和截图是响应体、页面、截图（见 tierOf）。淘汰见 retention.ts。
 * 站点目录（endpoints.json、actions/）按站点放在 <root>/sites/<站点>/，不在这里。
 * 编号 seq 全局递增，上界按块落盘到 <root>/sites/.seq：崩溃重启只会留下编号空洞，不会重复。只有 daemon 写这些目录。
 */
export type Tier = "light" | "heavy";
export type WinKind = "learn" | "run";
export type WindowMeta = { id: string; kind: WinKind; createdAt: number } & Record<string, unknown>;
export type WindowUsage = { kind: WinKind; light: number; heavy: number; createdAt: number };

const SEQ_BLOCK = 1000;
const BODY_MEMO_MAX = 5_000;
const KIND_DIR: Record<WinKind, string> = { learn: "learn-windows", run: "run-windows" };

export const seqPrefix = (seq: number): string => String(seq).padStart(6, "0");

const pad = (n: number): string => String(n).padStart(2, "0");
/** 窗口名里的时间：本地时间 20261101-130245。 */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 响应体、页面、截图是响应体、页面和截图；meta、时间线、请求文件是时间线和请求文件。参数是窗口内的相对路径。 */
export function tierOf(rel: string): Tier {
  return /\.response\.|^pages\/|^screenshots\//.test(rel) ? "heavy" : "light";
}

export type WindowLogOptions = { root?: string; now?: () => number };
export type RowQuery = {
  /** 只要 seq 大于它的行。 */
  sinceSeq?: number;
  /** 最多返回多少行，取最新的；默认 500。 */
  limit?: number;
};

export class WindowLog {
  readonly root: string;
  /** 站点目录：<root>/sites（各站点的 endpoints.json、actions/）。 */
  readonly dir: string;
  private readonly now: () => number;
  private seq = 0;
  private seqHigh = 0;
  private readonly wins = new Map<string, WindowUsage>();
  private readonly bodies = new Map<string, Map<string, string>>();
  private buffer: Map<string, string[]> | null = null;

  constructor(options: WindowLogOptions = {}) {
    this.root = options.root ?? HABIT_HOME;
    this.dir = path.join(this.root, "sites");
    this.now = options.now ?? Date.now;
  }

  // ---- 打开、编号 ----

  /** 建目录，接上上次的编号，把已有窗口的占用量扫一遍。 */
  open(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** 只读地扫一遍已有的窗口（doctor 用：不建目录）。 */
  load(): void {
    try { this.seq = this.seqHigh = Math.max(0, Number(fs.readFileSync(this.seqFile(), "utf8").trim()) || 0); } catch { /* 第一次 */ }
    for (const kind of ["learn", "run"] as const) {
      const base = path.join(this.root, KIND_DIR[kind]);
      if (!fs.existsSync(base)) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) this.scan(e.name, kind);
    }
  }

  private seqFile(): string { return path.join(this.dir, ".seq"); }

  private scan(win: string, kind: WinKind): void {
    const dir = path.join(this.root, KIND_DIR[kind], win);
    let light = 0, heavy = 0;
    for (const f of walk(dir)) { if (tierOf(f.rel) === "heavy") heavy += f.size; else light += f.size; }
    let createdAt = 0;
    try { createdAt = Number((JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as WindowMeta).createdAt) || 0; } catch { /* 没有 meta */ }
    if (!createdAt) { try { createdAt = fs.statSync(dir).mtimeMs; } catch { createdAt = this.now(); } }
    this.wins.set(win, { kind, light, heavy, createdAt });
  }

  /** 预留下一个编号：cmd 在开始时就要拿到编号（它引发的请求会指向它），行在结束时才写。 */
  reserve(): number {
    if (this.seq >= this.seqHigh) {
      this.seqHigh = this.seq + SEQ_BLOCK;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.seqFile(), String(this.seqHigh), { mode: 0o600 });
    }
    return ++this.seq;
  }

  lastSeq(): number { return this.seq; }

  // ---- 窗口 ----

  /** 登记一个窗口（建目录、写 meta）。同名已存在时合并 meta（learn 窗口重新打开）。 */
  openWindow(win: string, kind: WinKind, meta: Record<string, unknown> = {}): void {
    const dir = path.join(this.root, KIND_DIR[kind], win);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!this.wins.has(win)) this.scan(win, kind);
    const old = this.readMeta(win);
    this.writeMeta(win, { ...(old ?? { id: win, kind, createdAt: this.now() }), ...meta, id: win, kind });
  }

  /** `<前缀>-<时间>` 形式的新窗口名：同一秒重名加 -2、-3。 */
  freshName(prefix: string, now = this.now()): string {
    const base = `${prefix}-${stamp(now)}`;
    let name = base;
    for (let i = 2; this.kindOf(name); i++) name = `${base}-${i}`;
    return name;
  }

  kindOf(win: string): WinKind | undefined {
    const known = this.wins.get(win)?.kind;
    if (known) return known;
    for (const kind of ["learn", "run"] as const) if (fs.existsSync(path.join(this.root, KIND_DIR[kind], win, "meta.json"))) { this.scan(win, kind); return kind; }
    return undefined;
  }

  /** 窗口目录的绝对路径；没登记过的窗口算 learn 窗口。 */
  winDir(win: string): string { return path.join(this.root, KIND_DIR[this.kindOf(win) ?? "learn"], win); }

  readMeta(win: string): WindowMeta | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.winDir(win), "meta.json"), "utf8")) as WindowMeta; } catch { return undefined; }
  }

  writeMeta(win: string, meta: WindowMeta): void {
    const file = path.join(this.winDir(win), "meta.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** 某一种窗口，按创建时间从旧到新。 */
  /** t 之后开的 run 窗口的 meta（learn close 时看这个窗口学到的有没有用 habit run 交付过）。 */
  runsSince(t: number): WindowMeta[] {
    return this.listWindows("run").map((w) => this.readMeta(w)).filter((m): m is WindowMeta => !!m && Number(m.createdAt) >= t);
  }

  listWindows(kind: WinKind): string[] {
    return [...this.wins].filter(([, u]) => u.kind === kind).sort((a, b) => a[1].createdAt - b[1].createdAt).map(([win]) => win);
  }

  // ---- 路径 ----

  /** 窗口内的相对路径 → 相对 root 的路径。 */
  ref(win: string, rel: string): string { return path.posix.join(KIND_DIR[this.kindOf(win) ?? "learn"], win, rel); }
  /** 窗口内的相对路径 → 绝对路径。 */
  abs(win: string, rel: string): string { return path.join(this.winDir(win), rel); }
  /** 相对 root 的路径 → 绝对路径。 */
  absRef(ref: string): string { return path.join(this.root, ref); }

  // ---- 写 ----

  /** 一批写入：时间线的行先攒着，批结束时每个文件追加一次。 */
  batch<T>(fn: () => T): T {
    if (this.buffer) return fn();
    this.buffer = new Map();
    try { return fn(); } finally {
      const buf = this.buffer;
      this.buffer = null;
      for (const [file, lines] of buf) appendLines(file, lines);
    }
  }

  /** 往 <窗口>/timeline.jsonl 追加一行（seq 已经用 reserve() 拿好）。 */
  append(row: Row): void {
    const file = path.join(this.winDir(row.win), "timeline.jsonl");
    const line = `${JSON.stringify(row)}\n`;
    const u = this.wins.get(row.win);
    if (u) u.light += Buffer.byteLength(line);
    if (this.buffer) { const lines = this.buffer.get(file); if (lines) lines.push(line); else this.buffer.set(file, [line]); }
    else appendLines(file, [line]);
  }

  /** 写一个文件进窗口目录，返回窗口内的相对路径。 */
  putFile(win: string, rel: string, content: string | Buffer): string {
    const abs = this.abs(win, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    fs.writeFileSync(abs, content, { mode: 0o600 });
    const bytes = (typeof content === "string" ? Buffer.byteLength(content) : content.length) - existed;
    const u = this.wins.get(win);
    if (u) { if (tierOf(rel) === "heavy") u.heavy += bytes; else u.light += bytes; }
    return rel;
  }

  /** 响应体、页面：同一个窗口里内容相同的只存一份，后来的直接指向已有的文件（文件还在才算）。 */
  putBody(win: string, rel: string, content: string, hash: string): string {
    let memo = this.bodies.get(win);
    if (!memo) { memo = new Map(); this.bodies.set(win, memo); }
    const known = memo.get(hash);
    if (known && fs.existsSync(this.abs(win, known))) return known;
    this.putFile(win, rel, content);
    memo.set(hash, rel);
    if (memo.size > BODY_MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return rel;
  }

  // ---- 读 ----

  /** 一个窗口的时间线；返回按 seq 从旧到新，最多 limit 行（取最新的）。 */
  readRows(win: string, query: RowQuery = {}): Row[] {
    const limit = query.limit ?? 500;
    const since = query.sinceSeq ?? 0;
    let text = "";
    try { text = fs.readFileSync(path.join(this.winDir(win), "timeline.jsonl"), "utf8"); } catch { return []; }
    const rows: Row[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const row = JSON.parse(line) as Row; if (row.seq > since) rows.push(row); } catch { /* 坏行跳过 */ }
    }
    rows.sort((a, b) => a.seq - b.seq);
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }

  /** 读窗口里的一个文件（窗口内的相对路径）。 */
  readText(win: string, rel: string): string | undefined {
    try { return fs.readFileSync(this.abs(win, rel), "utf8"); } catch { return undefined; }
  }

  // ---- 占用、淘汰用 ----

  usage(): { learn: { light: number; heavy: number }; run: { light: number; heavy: number }; windows: Record<string, WindowUsage> } {
    const total = { learn: { light: 0, heavy: 0 }, run: { light: 0, heavy: 0 } };
    for (const u of this.wins.values()) { total[u.kind].light += u.light; total[u.kind].heavy += u.heavy; }
    return { ...total, windows: Object.fromEntries(this.wins) };
  }

  /** 窗口里的文件（窗口内的相对路径）。 */
  windowFiles(win: string): Array<{ rel: string; size: number }> { return walk(this.winDir(win)); }

  /** 删窗口里的一个文件（淘汰响应体、页面和截图用）；返回释放的字节数。 */
  removeFile(win: string, rel: string): number {
    const abs = this.abs(win, rel);
    let size = 0;
    try { size = fs.statSync(abs).size; fs.unlinkSync(abs); } catch { return 0; }
    const u = this.wins.get(win);
    if (u) { if (tierOf(rel) === "heavy") u.heavy -= size; else u.light -= size; }
    return size;
  }

  /** 删整个窗口目录；返回删掉的字节数。 */
  removeWindow(win: string): number {
    const u = this.wins.get(win);
    if (!u) return 0;
    fs.rmSync(this.winDir(win), { recursive: true, force: true });
    this.wins.delete(win);
    this.bodies.delete(win);
    return u.light + u.heavy;
  }

  close(): void {
    if (this.buffer) { const buf = this.buffer; this.buffer = null; for (const [file, lines] of buf) appendLines(file, lines); }
  }
}

function appendLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join(""), { mode: 0o600 });
}

/** 目录下所有文件（相对路径用 /）。 */
function walk(dir: string, prefix = ""): Array<{ rel: string; size: number }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: Array<{ rel: string; size: number }> = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else { try { out.push({ rel, size: fs.statSync(path.join(dir, e.name)).size }); } catch { /* 刚被删 */ } }
  }
  return out;
}
