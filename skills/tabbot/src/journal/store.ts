import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_DIR } from "../utils/constants.ts";
import { loadSqlite, openDbSync, type Db } from "./sqlite.ts";
import { SCHEMA, type NewEvent } from "./types.ts";

/** 本地日期 YYYY-MM-DD：按天分文件，淘汰一天就是删这一天的文件。 */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const dbFile = (day: string, dir = JOURNAL_DIR): string => path.join(dir, `${day}.db`);
export const bodiesDir = (day: string, dir = JOURNAL_DIR): string => path.join(dir, "bodies", day);
export const snapshotsDir = (day: string, dir = JOURNAL_DIR): string => path.join(dir, "snapshots", day);

/** 有 .db 文件的日期，从旧到新。 */
export function listDays(dir = JOURNAL_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

const INSERT = `INSERT INTO events(seq, ts, tab, frame, src, kind, verb, page, target, url, method, status, size, body, noise, cause, detail)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 日志写入端，只在 holder 里用。一个进程一个实例；CLI 只读，直接开只读连接（见 query.ts）。 */
export class JournalStore {
  readonly dir: string;
  private current: { day: string; db: Db } | null = null;
  private seq = 0;

  constructor(dir = JOURNAL_DIR) { this.dir = dir; }

  /** 加载 sqlite，建目录，从最新一天的库里接上 seq。 */
  async open(): Promise<void> {
    await loadSqlite();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const day of listDays(this.dir).reverse()) {
      const db = openDbSync(dbFile(day, this.dir), { readOnly: true });
      try {
        const row = db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
        if (row.m !== null) { this.seq = row.m; return; }
      } catch { /* 空库或损坏：往前一天找 */ } finally { db.close(); }
    }
  }

  private dbFor(day: string): Db {
    if (this.current?.day === day) return this.current.db;
    this.current?.db.close();
    const db = openDbSync(dbFile(day, this.dir));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec(SCHEMA);
    this.current = { day, db };
    return db;
  }

  /** 一批事件放在一个事务里。 */
  batch<T>(ts: number, fn: () => T): T {
    const db = this.dbFor(dayOf(ts));
    db.exec("BEGIN");
    try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** 返回分到的 seq；seq 在所有天的文件里单调递增。 */
  insert(ev: NewEvent): number {
    const seq = ++this.seq;
    this.dbFor(dayOf(ev.ts)).prepare(INSERT).run(seq, ev.ts, ev.tab, ev.frame, ev.src, ev.kind, ev.verb, ev.page ?? null, ev.target ?? null, ev.url ?? null, ev.method ?? null, ev.status ?? null, ev.size ?? null, ev.body ?? null, ev.noise ?? 0, ev.cause ?? null, ev.detail ?? null);
    return seq;
  }

  /** 同一个请求又出现了一次：计数加一，记下最后出现的时间。 */
  bump(day: string, seq: number, ts: number): void {
    this.dbFor(day).prepare("UPDATE events SET dup = dup + 1, ts_last = ? WHERE seq = ?").run(ts, seq);
  }

  /** 动作做完之后补上元素描述和结果。 */
  update(day: string, seq: number, fields: { target?: string; size?: number; detail?: string }): void {
    this.dbFor(day).prepare("UPDATE events SET target = COALESCE(?, target), size = COALESCE(?, size), detail = COALESCE(?, detail) WHERE seq = ?").run(fields.target ?? null, fields.size ?? null, fields.detail ?? null, seq);
  }

  lastSeq(): number { return this.seq; }

  /** 写文件，已存在就不重写（同一天内按内容去重）。 */
  writeFile(dir: string, name: string, content: string): void {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }

  close(): void { this.current?.db.close(); this.current = null; }
}
