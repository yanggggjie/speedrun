import * as fs from "node:fs";
import { JOURNAL_DIR } from "../utils/constants.ts";
import { formatEvent } from "./format.ts";
import { loadSqlite, openDb } from "./sqlite.ts";
import { bodyPath, dbFile, dirSize, listSegs } from "./store.ts";
import type { EventRow, Src } from "./types.ts";

export type LogQuery = {
  /** 只要 seq 大于它的事件（游标）。 */
  since?: number;
  tab?: number;
  src?: Src;
  /** 包含噪声（埋点、广告）；默认不含。 */
  all?: boolean;
  /** 最多返回多少条，取最新的；默认 50。 */
  limit?: number;
  dir?: string;
};

/** 读事件：从最新一段往前找，够了就停。返回按 seq 从旧到新。 */
export async function readEvents(q: LogQuery = {}): Promise<EventRow[]> {
  const dir = q.dir ?? JOURNAL_DIR;
  const limit = q.limit ?? 50;
  const where = ["seq > ?"];
  const args: (number | string)[] = [q.since ?? 0];
  if (q.tab !== undefined) { where.push("tab = ?"); args.push(q.tab); }
  if (q.src) { where.push("src = ?"); args.push(q.src); }
  if (!q.all) where.push("noise = 0");
  const rows: EventRow[] = [];
  for (const id of listSegs(dir).reverse()) {
    const db = await openDb(dbFile(id, dir), { readOnly: true });
    try {
      const part = db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...args, limit - rows.length) as EventRow[];
      rows.push(...part);
    } catch { /* 刚建好还没有表：当成空 */ } finally { db.close(); }
    if (rows.length >= limit) break;
  }
  return rows.reverse();
}

/** 按 seq 取一行（跨段找）。 */
export async function readEventBySeq(seq: number, dir = JOURNAL_DIR): Promise<EventRow | undefined> {
  for (const id of listSegs(dir).reverse()) {
    const db = await openDb(dbFile(id, dir), { readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as EventRow | undefined;
      if (row) return row;
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return undefined;
}

export type BodyHit = { row: EventRow; snippet: string };

/** 在存下来的响应体和 HTML 文档里找一段文字（页面上看到的值），返回是哪个请求（或哪个文档）里有。从最新的分段往前，最多 limit 个。 */
export async function findInBodies(needle: string, options: { limit?: number; dir?: string } = {}): Promise<BodyHit[]> {
  const dir = options.dir ?? JOURNAL_DIR;
  const limit = options.limit ?? 20;
  const hits: BodyHit[] = [];
  for (const id of listSegs(dir).reverse()) {
    const db = await openDb(dbFile(id, dir), { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM events WHERE kind IN ('net', 'doc') AND body IS NOT NULL ORDER BY seq DESC").all() as EventRow[];
      for (const row of rows) {
        let text: string;
        try { text = fs.readFileSync(bodyPath(row.body!, "bodies", dir), "utf8"); } catch { continue; }
        const at = text.indexOf(needle);
        if (at < 0) continue;
        hits.push({ row, snippet: text.slice(Math.max(0, at - 30), at + needle.length + 30).replace(/\s+/g, " ") });
        if (hits.length >= limit) return hits;
      }
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return hits;
}

export async function lastSeq(dir = JOURNAL_DIR): Promise<number> {
  for (const id of listSegs(dir).reverse()) {
    const db = await openDb(dbFile(id, dir), { readOnly: true });
    try {
      const row = db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
      if (row.m !== null) return row.m;
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return 0;
}

export const formatRows = (rows: EventRow[]): string => rows.map(formatEvent).join("\n");

/** SQLite 默认一个连接最多挂 10 个库。 */
const MAX_ATTACHED = 10;

/**
 * 只读 SQL：把最新的几段挂在一起，对外是一个叫 events 的视图。
 * 防写靠 query_only；再限制成单条 SELECT / WITH，挡掉 ATTACH、PRAGMA 之类。
 */
export async function runSql(sql: string, options: { limit?: number; dir?: string } = {}): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  const text = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(text) || text.includes(";")) throw new Error("只支持单条 SELECT / WITH 查询");
  if (/\b(attach|detach|pragma|load_extension|vacuum)\b/i.test(text)) throw new Error("查询里不能用 ATTACH / PRAGMA 等语句");
  const dir = options.dir ?? JOURNAL_DIR;
  const segs = listSegs(dir).slice(-MAX_ATTACHED);
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
  try {
    segs.forEach((id, i) => db.exec(`ATTACH DATABASE '${dbFile(id, dir).replace(/'/g, "''")}' AS d${i}`));
    const union = segs.length ? segs.map((_d, i) => `SELECT * FROM d${i}.events`).join(" UNION ALL ") : "SELECT NULL AS seq WHERE 0";
    db.exec(`CREATE TEMP VIEW events AS ${union}`);
    db.exec("PRAGMA query_only = ON");
    const stmt = db.prepare(text);
    const limit = options.limit ?? 200;
    const rows: unknown[][] = [];
    let columns: string[] = [];
    let truncated = false;
    for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length === 0) columns = Object.keys(row);
      if (rows.length >= limit) { truncated = true; break; }
      rows.push(columns.map((c) => row[c]));
    }
    return { columns, rows, truncated };
  } finally { db.close(); }
}

export type JournalStatus = { dir: string; segments: number; events: number; bytes: number };

export async function status(dir = JOURNAL_DIR): Promise<JournalStatus> {
  let events = 0;
  const segs = listSegs(dir);
  for (const id of segs) {
    const db = await openDb(dbFile(id, dir), { readOnly: true });
    try { events += (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c; } catch { /* 空库 */ } finally { db.close(); }
  }
  return { dir, segments: segs.length, events, bytes: dirSize(dir) };
}

