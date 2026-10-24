import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR, JOURNAL_SEGMENT_BYTES } from "../utils/constants.ts";
import { loadSqlite, openDbSync, type Db } from "./sqlite.ts";
import { SCHEMA, type NewEvent } from "./types.ts";

/**
 * 日志是一串分段：<dir>/seg-000001/{events.db, bodies/, snapshots/}。
 * 只往最新一段写；写满 segmentBytes 就新开一段，新开时检查总量，超过 capBytes 就整段删除最旧的分段（先进先出，和时间无关）。
 * 只有 holder 读写日志目录。
 */
const SEG = /^seg-(\d{6})$/;
const ROW_BYTES = 400;

export const segName = (id: number): string => `seg-${String(id).padStart(6, "0")}`;
export const segDir = (id: number, dir = JOURNAL_DIR): string => path.join(dir, segName(id));
export const dbFile = (id: number, dir = JOURNAL_DIR): string => path.join(segDir(id, dir), "events.db");

/** 现有分段的序号，从旧到新。 */
export function listSegs(dir = JOURNAL_DIR): number[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => SEG.exec(f)?.[1]).filter((x): x is string => x !== undefined).map(Number).sort((a, b) => a - b);
}

/** 行里的 body 字段是 `<序号>/<文件名>`（如 000003/9f2c.json）：响应体和 HTML 文档在 bodies/ 下，快照在 snapshots/ 下。 */
export function bodyPath(ref: string, sub: "bodies" | "snapshots" = "bodies", dir = JOURNAL_DIR): string {
  const [seg, name] = ref.split("/");
  return path.join(dir, `seg-${seg}`, sub, name!);
}

export function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(file) : fs.statSync(file).size;
  }
  return total;
}

const INSERT = `INSERT INTO events(seq, ts, tab, frame, src, kind, verb, page, target, url, method, status, size, body, noise, cause, detail)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export type StoreOptions = { dir?: string; segmentBytes?: number; capBytes?: number };

export class JournalStore {
  readonly dir: string;
  private readonly segmentBytes: number;
  private readonly capBytes: number;
  private current: { id: number; db: Db; bytes: number } | null = null;
  private seq = 0;

  constructor(options: StoreOptions = {}) {
    this.dir = options.dir ?? JOURNAL_DIR;
    this.segmentBytes = options.segmentBytes ?? JOURNAL_SEGMENT_BYTES;
    this.capBytes = options.capBytes ?? JOURNAL_CAP_BYTES;
  }

  /** 加载 sqlite，建目录，从最新的非空分段接上 seq。 */
  async open(): Promise<void> {
    await loadSqlite();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const id of listSegs(this.dir).reverse()) {
      const db = openDbSync(dbFile(id, this.dir), { readOnly: true });
      try {
        const row = db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
        if (row.m !== null) { this.seq = row.m; return; }
      } catch { /* 空库或损坏：往前一段找 */ } finally { db.close(); }
    }
  }

  /** 当前分段的序号（没有就先建）。 */
  segId(): number { return this.writable().id; }

  private writable(): { id: number; db: Db; bytes: number } {
    if (this.current) return this.current;
    const ids = listSegs(this.dir);
    const id = ids.length ? ids[ids.length - 1]! : 1;
    return this.openSeg(id);
  }

  private openSeg(id: number): { id: number; db: Db; bytes: number } {
    fs.mkdirSync(segDir(id, this.dir), { recursive: true });
    const db = openDbSync(dbFile(id, this.dir));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec(SCHEMA);
    this.current = { id, db, bytes: dirSize(segDir(id, this.dir)) };
    return this.current;
  }

  /** 当前分段写满了就新开一段，并按总量删除最旧的分段。只在事务之外调用，同一批事件落在同一段里。 */
  private rollover(): void {
    const cur = this.writable();
    if (cur.bytes < this.segmentBytes) return;
    cur.db.close();
    this.current = null;
    this.openSeg(cur.id + 1);
    this.enforceCap();
  }

  /** 超过总量上限就删最旧的分段，直到不超；当前分段永远不删。返回删掉的序号。 */
  enforceCap(): number[] {
    const removed: number[] = [];
    const ids = listSegs(this.dir);
    let total = dirSize(this.dir);
    for (const id of ids.slice(0, -1)) {
      if (total <= this.capBytes) break;
      const size = dirSize(segDir(id, this.dir));
      fs.rmSync(segDir(id, this.dir), { recursive: true, force: true });
      total -= size;
      removed.push(id);
    }
    return removed;
  }

  /** 一批事件放在一个事务里。 */
  batch<T>(fn: () => T): T {
    this.rollover();
    const { db } = this.writable();
    db.exec("BEGIN");
    try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** 返回分到的 seq 和所在分段；seq 在所有分段里单调递增。 */
  insert(ev: NewEvent): { seq: number; seg: number } {
    const cur = this.writable();
    const seq = ++this.seq;
    cur.db.prepare(INSERT).run(seq, ev.ts, ev.tab, ev.frame, ev.src, ev.kind, ev.verb, ev.page ?? null, ev.target ?? null, ev.url ?? null, ev.method ?? null, ev.status ?? null, ev.size ?? null, ev.body ?? null, ev.noise ?? 0, ev.cause ?? null, ev.detail ?? null);
    cur.bytes += ROW_BYTES + (ev.detail?.length ?? 0);
    return { seq, seg: cur.id };
  }

  private dbOf(seg: number): { db: Db; temp: boolean } | undefined {
    if (this.current?.id === seg) return { db: this.current.db, temp: false };
    if (!fs.existsSync(dbFile(seg, this.dir))) return undefined; // 这一段已经被淘汰了
    return { db: openDbSync(dbFile(seg, this.dir)), temp: true };
  }

  /** 同一个请求又出现了一次：计数加一，记下最后出现的时间。 */
  bump(ref: { seq: number; seg: number }, ts: number): void {
    const target = this.dbOf(ref.seg);
    if (!target) return;
    try { target.db.prepare("UPDATE events SET dup = dup + 1, ts_last = ? WHERE seq = ?").run(ts, ref.seq); } finally { if (target.temp) target.db.close(); }
  }

  /** 动作做完之后补上元素描述和结果。 */
  update(ref: { seq: number; seg: number }, fields: { target?: string; size?: number; detail?: string }): void {
    const target = this.dbOf(ref.seg);
    if (!target) return;
    try { target.db.prepare("UPDATE events SET target = COALESCE(?, target), size = COALESCE(?, size), detail = COALESCE(?, detail) WHERE seq = ?").run(fields.target ?? null, fields.size ?? null, fields.detail ?? null, ref.seq); } finally { if (target.temp) target.db.close(); }
  }

  lastSeq(): number { return this.seq; }

  /** 写进当前分段；同名文件已存在（内容哈希相同）就不重写。返回行里要存的引用 `<序号>/<文件名>`。 */
  putFile(sub: "bodies" | "snapshots", name: string, content: string): string {
    const cur = this.writable();
    const dir = path.join(segDir(cur.id, this.dir), sub);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o600 });
      cur.bytes += Buffer.byteLength(content);
    }
    return `${String(cur.id).padStart(6, "0")}/${name}`;
  }

  close(): void { this.current?.db.close(); this.current = null; }
}
