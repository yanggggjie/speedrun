import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_DIR } from "../utils/constants.ts";
import { formatEvent } from "./format.ts";
import { loadSqlite, openDb } from "./sqlite.ts";
import { dbFile, listDays } from "./store.ts";
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

/** 读事件：从最新一天往前找，够了就停。返回按 seq 从旧到新。 */
export async function readEvents(q: LogQuery = {}): Promise<EventRow[]> {
  const dir = q.dir ?? JOURNAL_DIR;
  const limit = q.limit ?? 50;
  const where = ["seq > ?"];
  const args: (number | string)[] = [q.since ?? 0];
  if (q.tab !== undefined) { where.push("tab = ?"); args.push(q.tab); }
  if (q.src) { where.push("src = ?"); args.push(q.src); }
  if (!q.all) where.push("noise = 0");
  const rows: EventRow[] = [];
  for (const day of listDays(dir).reverse()) {
    const db = await openDb(dbFile(day, dir), { readOnly: true });
    try {
      const part = db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...args, limit - rows.length) as EventRow[];
      rows.push(...part);
    } catch { /* 刚建好还没有表：当成空 */ } finally { db.close(); }
    if (rows.length >= limit) break;
  }
  return rows.reverse();
}

/** 按 seq 取一行（跨天找）。 */
export async function readEventBySeq(seq: number, dir = JOURNAL_DIR): Promise<EventRow | undefined> {
  for (const day of listDays(dir).reverse()) {
    const db = await openDb(dbFile(day, dir), { readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as EventRow | undefined;
      if (row) return row;
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return undefined;
}

export type BodyHit = { row: EventRow; snippet: string };

/**
 * 在存下来的响应体里找一段文字（页面上看到的值），返回是哪个请求返回的。最近几天、最多 limit 个。
 * 响应体是普通文件，这里不依赖外部的 rg。
 */
export async function findInBodies(needle: string, options: { limit?: number; days?: number; dir?: string } = {}): Promise<BodyHit[]> {
  const dir = options.dir ?? JOURNAL_DIR;
  const limit = options.limit ?? 20;
  const hits: BodyHit[] = [];
  for (const day of listDays(dir).slice(-(options.days ?? 7)).reverse()) {
    const bodies = path.join(dir, "bodies", day);
    if (!fs.existsSync(bodies)) continue;
    const found: { name: string; snippet: string }[] = [];
    for (const name of fs.readdirSync(bodies)) {
      const text = fs.readFileSync(path.join(bodies, name), "utf8");
      const at = text.indexOf(needle);
      if (at >= 0) found.push({ name, snippet: text.slice(Math.max(0, at - 30), at + needle.length + 30).replace(/\s+/g, " ") });
    }
    if (found.length === 0) continue;
    const db = await openDb(dbFile(day, dir), { readOnly: true });
    try {
      for (const f of found) {
        const rows = db.prepare("SELECT * FROM events WHERE body = ? AND kind = 'net' ORDER BY seq DESC").all(f.name) as EventRow[];
        for (const row of rows) { hits.push({ row, snippet: f.snippet }); if (hits.length >= limit) return hits; }
      }
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return hits;
}

export async function lastSeq(dir = JOURNAL_DIR): Promise<number> {
  for (const day of listDays(dir).reverse()) {
    const db = await openDb(dbFile(day, dir), { readOnly: true });
    try {
      const row = db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
      if (row.m !== null) return row.m;
    } catch { /* 空库 */ } finally { db.close(); }
  }
  return 0;
}

export const formatRows = (rows: EventRow[]): string => rows.map(formatEvent).join("\n");

/**
 * 只读 SQL：把最近几天的库挂在一起，对外是一个叫 events 的视图。
 * 防写靠 query_only；再限制成单条 SELECT / WITH，挡掉 ATTACH、PRAGMA 之类。
 */
export async function runSql(sql: string, options: { limit?: number; days?: number; dir?: string } = {}): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  const text = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(text) || text.includes(";")) throw new Error("只支持单条 SELECT / WITH 查询");
  if (/\b(attach|detach|pragma|load_extension|vacuum)\b/i.test(text)) throw new Error("查询里不能用 ATTACH / PRAGMA 等语句");
  const dir = options.dir ?? JOURNAL_DIR;
  const days = listDays(dir).slice(-(options.days ?? 7));
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
  try {
    days.forEach((day, i) => db.exec(`ATTACH DATABASE '${dbFile(day, dir).replace(/'/g, "''")}' AS d${i}`));
    const union = days.length ? days.map((_d, i) => `SELECT * FROM d${i}.events`).join(" UNION ALL ") : "SELECT NULL AS seq WHERE 0";
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

export type JournalStatus = { dir: string; days: { day: string; events: number }[]; bytes: number };

export function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(file) : fs.statSync(file).size;
  }
  return total;
}

export async function status(dir = JOURNAL_DIR): Promise<JournalStatus> {
  const days: JournalStatus["days"] = [];
  for (const day of listDays(dir)) {
    const db = await openDb(dbFile(day, dir), { readOnly: true });
    try { days.push({ day, events: (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c }); } catch { days.push({ day, events: 0 }); } finally { db.close(); }
  }
  return { dir, days, bytes: dirSize(dir) };
}

/**
 * 阻塞到有新的人的事件、且静默 idleMs 之后返回新增事件；或超时返回空。
 * 直接轮询日志文件，不经过 holder（holder 没起来也能读历史，起来了就能读到新的）。
 */
export async function waitForHuman(opts: { since: number; tab?: number; idleMs?: number; timeoutMs?: number; pollMs?: number; dir?: string; now?: () => number }): Promise<{ rows: EventRow[]; timedOut: boolean; humanActive: boolean }> {
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 3_000;
  const deadline = now() + (opts.timeoutMs ?? 30_000);
  const poll = opts.pollMs ?? 300;
  let cursor = opts.since;
  const collected: EventRow[] = [];
  let lastHuman = 0;
  while (now() < deadline) {
    const fresh = await readEvents({ since: cursor, tab: opts.tab, limit: 500, all: true, dir: opts.dir });
    if (fresh.length) {
      cursor = fresh[fresh.length - 1]!.seq;
      collected.push(...fresh);
      for (const row of fresh) if (row.src === "human") lastHuman = Math.max(lastHuman, row.ts_last ?? row.ts);
    }
    if (lastHuman && now() - lastHuman >= idleMs) return { rows: collected.filter((r) => !r.noise), timedOut: false, humanActive: false };
    await new Promise((r) => setTimeout(r, poll));
  }
  return { rows: collected.filter((r) => !r.noise), timedOut: true, humanActive: lastHuman > 0 };
}
