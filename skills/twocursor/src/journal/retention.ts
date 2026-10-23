import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_CAP_BYTES, JOURNAL_DIR, JOURNAL_THIN_RATIO } from "../utils/constants.ts";
import { dirSize } from "./query.ts";
import { dbFile, listDays } from "./store.ts";

export type Evicted = { day: string; what: "files" | "db" };

/**
 * 控制日志目录大小。超过上限的 80% 先删最旧一天的响应体和快照（索引保留），
 * 还超过上限就连这一天的库一起删，直到够小；今天的永远不删。返回删了什么。
 */
export function enforceCap(options: { dir?: string; capBytes?: number; today: string }): Evicted[] {
  const dir = options.dir ?? JOURNAL_DIR;
  const cap = options.capBytes ?? JOURNAL_CAP_BYTES;
  const evicted: Evicted[] = [];
  const days = listDays(dir).filter((d) => d < options.today);
  // 第一轮：只删响应体和快照
  for (const day of days) {
    if (dirSize(dir) <= cap * JOURNAL_THIN_RATIO) return evicted;
    let removed = false;
    for (const sub of ["bodies", "snapshots"]) {
      const target = path.join(dir, sub, day);
      if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); removed = true; }
    }
    if (removed) evicted.push({ day, what: "files" });
  }
  // 第二轮：还超过上限，删最旧的库
  for (const day of days) {
    if (dirSize(dir) <= cap) break;
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile(day, dir)}${ext}`, { force: true });
    evicted.push({ day, what: "db" });
  }
  return evicted;
}
