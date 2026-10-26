import * as fs from "node:fs";
import * as path from "node:path";
import { LOG_SEGMENT_BYTES, LOG_SEGMENT_MS, SITES_DIR } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";
import type { RequestFile, Row } from "./types.ts";

/**
 * 日志：<dir>/<站点>/log/<段>/ 下，每个窗口一个 timeline.<窗口>.jsonl（追加写，不改已写的行），
 * 每次请求一个请求文件，响应体、HTML 文档、页面快照各一个文件。
 *
 * 分两层：轻量层是时间线和请求文件，重量层是响应体、文档、快照（见 tierOf）。段满了（重量层写满或开了一天）就开新的一段；
 * 淘汰见 retention.ts：先只删重量层的旧文件，再删整段。文件引用一律写成相对站点 log/ 目录的 `<段>/<文件名>`，
 * 所以后出现的相同响应体可以直接指向较早的段里已有的文件。
 *
 * 编号 seq 全局递增（跨站点也不重复），上界按块落盘到 <dir>/.seq：崩溃重启只会留下编号空洞，不会重复。
 * 只有 holder 写这个目录。
 */
export type Tier = "light" | "heavy";

const SEQ_BLOCK = 1000;
const BODY_MEMO_MAX = 20_000;
const SEG_WIDTH = 6;

export const segName = (id: number): string => String(id).padStart(SEG_WIDTH, "0");
export const seqPrefix = (seq: number): string => String(seq).padStart(SEG_WIDTH, "0");

/** 响应体、HTML 文档、页面快照是重量层；时间线和请求文件是轻量层。 */
export function tierOf(name: string): Tier {
  if (/^timeline\..+\.jsonl$/.test(name)) return "light";
  return /\.response\.|\.doc\.html$|\.snap\.json$/.test(name) ? "heavy" : "light";
}

type SegState = { id: number; createdAt: number; heavy: number; used: boolean };
type SiteState = { cur: SegState; light: number; heavy: number; bodies: Map<string, string>; batchId: number };

export type SiteLogOptions = { dir?: string; segmentBytes?: number; segmentMs?: number; now?: () => number };
export type RowQuery = {
  /** 只读这些窗口的时间线；不给就是全部窗口。 */
  wins?: string[];
  /** 只要 seq 大于它的行。 */
  sinceSeq?: number;
  /** 最多返回多少行，取最新的；默认 200。 */
  limit?: number;
};

export class SiteLog {
  readonly dir: string;
  private readonly segmentBytes: number;
  private readonly segmentMs: number;
  private readonly now: () => number;
  private seq = 0;
  private seqHigh = 0;
  private readonly sites = new Map<string, SiteState>();
  private buffer: Map<string, string[]> | null = null;
  private batchSeq = 0;

  constructor(options: SiteLogOptions = {}) {
    this.dir = options.dir ?? SITES_DIR;
    this.segmentBytes = options.segmentBytes ?? LOG_SEGMENT_BYTES;
    this.segmentMs = options.segmentMs ?? LOG_SEGMENT_MS;
    this.now = options.now ?? Date.now;
  }

  // ---- 打开、编号 ----

  /** 建目录，接上上次的编号，把已有站点的占用量扫一遍。 */
  open(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    try { this.seq = this.seqHigh = Math.max(0, Number(fs.readFileSync(this.seqFile(), "utf8").trim()) || 0); } catch { /* 第一次 */ }
    for (const site of this.listSites()) this.state(site);
  }

  private seqFile(): string { return path.join(this.dir, ".seq"); }

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

  // ---- 路径 ----

  siteKey(site: string): string { return siteDirName(site); }
  siteDir(site: string): string { return path.join(this.dir, this.siteKey(site)); }
  logDir(site: string): string { return path.join(this.siteDir(site), "log"); }
  segDir(site: string, id: number): string { return path.join(this.logDir(site), segName(id)); }
  /** 站点 log/ 目录下的相对路径（`<段>/<文件名>`）变成绝对路径。 */
  abs(site: string, rel: string): string { return path.join(this.logDir(site), rel); }

  /** 已有的站点目录名（有日志的才算），按字母序。 */
  listSites(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name).sort();
  }

  segmentIds(site: string): number[] {
    const dir = this.logDir(site);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  }

  segmentFiles(site: string, id: number): Array<{ name: string; size: number }> {
    const dir = this.segDir(site, id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
  }

  // ---- 站点状态 ----

  private state(site: string): SiteState {
    const key = this.siteKey(site);
    let st = this.sites.get(key);
    if (st) return st;
    const ids = this.segmentIds(key);
    const id = ids.length ? ids[ids.length - 1]! : 1;
    let light = 0, heavy = 0, curHeavy = 0, used = false;
    for (const sid of ids) {
      for (const f of this.segmentFiles(key, sid)) {
        if (tierOf(f.name) === "heavy") { heavy += f.size; if (sid === id) curHeavy += f.size; } else light += f.size;
        if (sid === id) used = true;
      }
    }
    let createdAt = this.now();
    try { const s = fs.statSync(this.segDir(key, id)); createdAt = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs; } catch { /* 还没建 */ }
    st = { cur: { id, createdAt, heavy: curHeavy, used }, light, heavy, bodies: new Map(), batchId: -1 };
    this.sites.set(key, st);
    return st;
  }

  /** 一次操作（或一批）里第一次碰到这个站点时，看看当前段要不要换。 */
  private touch(site: string): SiteState {
    const st = this.state(site);
    if (st.batchId !== this.batchSeq) {
      st.batchId = this.batchSeq;
      if (st.cur.used && (st.cur.heavy >= this.segmentBytes || this.now() - st.cur.createdAt >= this.segmentMs)) {
        st.cur = { id: st.cur.id + 1, createdAt: this.now(), heavy: 0, used: false };
      }
    }
    return st;
  }

  /** 当前段（淘汰永远不动它）。 */
  currentSegment(site: string): number { return this.state(site).cur.id; }

  // ---- 写 ----

  /** 一批写入：时间线的行先攒着，批结束时每个文件追加一次。 */
  batch<T>(fn: () => T): T {
    if (this.buffer) return fn();
    this.buffer = new Map();
    this.batchSeq++;
    try { return fn(); } finally {
      const buf = this.buffer;
      this.buffer = null;
      for (const [file, lines] of buf) this.appendLines(file, lines);
    }
  }

  private appendLines(file: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join(""), { mode: 0o600 });
  }

  /** 往 <站点>/log/<当前段>/timeline.<窗口>.jsonl 追加一行（seq 已经用 reserve() 拿好）。 */
  append(site: string, row: Row): void {
    if (!this.buffer) this.batchSeq++;
    const st = this.touch(site);
    const file = path.join(this.segDir(site, st.cur.id), `timeline.${row.win}.jsonl`);
    const line = `${JSON.stringify(row)}\n`;
    st.cur.used = true;
    st.light += Buffer.byteLength(line);
    if (this.buffer) { const lines = this.buffer.get(file); if (lines) lines.push(line); else this.buffer.set(file, [line]); }
    else this.appendLines(file, [line]);
  }

  /** 写一个文件进当前段，返回相对站点 log/ 目录的路径。 */
  putFile(site: string, name: string, content: string): string {
    if (!this.buffer) this.batchSeq++;
    const st = this.touch(site);
    const dir = this.segDir(site, st.cur.id);
    const abs = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    fs.writeFileSync(abs, content, { mode: 0o600 });
    const bytes = Buffer.byteLength(content) - existed;
    st.cur.used = true;
    if (tierOf(name) === "heavy") { st.heavy += bytes; st.cur.heavy += bytes; } else st.light += bytes;
    return `${segName(st.cur.id)}/${name}`;
  }

  /** 响应体、文档：同一站点里内容相同的只存一份，后来的直接指向已有的文件（文件还在才算）。 */
  putBody(site: string, name: string, content: string, hash: string): string {
    const st = this.state(site);
    const known = st.bodies.get(hash);
    if (known && fs.existsSync(this.abs(site, known))) return known;
    const rel = this.putFile(site, name, content);
    st.bodies.set(hash, rel);
    if (st.bodies.size > BODY_MEMO_MAX) st.bodies.delete(st.bodies.keys().next().value as string);
    return rel;
  }

  // ---- 读 ----

  /** 从新到旧读各段的时间线，够了就停；返回按 seq 从旧到新。 */
  readRows(site: string, query: RowQuery = {}): Row[] {
    const limit = query.limit ?? 200;
    const since = query.sinceSeq ?? 0;
    const rows: Row[] = [];
    for (const id of this.segmentIds(site).reverse()) {
      const dir = this.segDir(site, id);
      for (const name of fs.readdirSync(dir)) {
        const m = /^timeline\.(.+)\.jsonl$/.exec(name);
        if (!m || (query.wins && !query.wins.includes(m[1]!))) continue;
        for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
          if (!line) continue;
          let row: Row;
          try { row = JSON.parse(line) as Row; } catch { continue; }
          if (row.seq > since) rows.push(row);
        }
      }
      if (rows.length >= limit) break;
    }
    rows.sort((a, b) => a.seq - b.seq);
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }

  /** 编号对应的请求文件（从新的段往旧的找）。 */
  findRequestFile(site: string, seq: number): { rel: string; abs: string } | undefined {
    const prefix = `${seqPrefix(seq)}_`;
    for (const id of this.segmentIds(site).reverse()) {
      const dir = this.segDir(site, id);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix) && name.endsWith(".json") && !name.endsWith(".response.json")) return { rel: `${segName(id)}/${name}`, abs: path.join(dir, name) };
      }
    }
    return undefined;
  }

  readRequestFile(site: string, seq: number): { file: RequestFile; rel: string } | undefined {
    const found = this.findRequestFile(site, seq);
    if (!found) return undefined;
    try { return { file: JSON.parse(fs.readFileSync(found.abs, "utf8")) as RequestFile, rel: found.rel }; } catch { return undefined; }
  }

  readText(site: string, rel: string): string | undefined {
    try { return fs.readFileSync(this.abs(site, rel), "utf8"); } catch { return undefined; }
  }

  // ---- 占用、淘汰用 ----

  usage(): { light: number; heavy: number; sites: Record<string, { light: number; heavy: number }> } {
    const sites: Record<string, { light: number; heavy: number }> = {};
    let light = 0, heavy = 0;
    for (const [key, st] of this.sites) { sites[key] = { light: st.light, heavy: st.heavy }; light += st.light; heavy += st.heavy; }
    return { light, heavy, sites };
  }

  /** 删一个文件（淘汰重量层用）；返回释放的字节数。 */
  removeFile(site: string, rel: string): number {
    const st = this.state(site);
    const abs = this.abs(site, rel);
    let size = 0;
    try { size = fs.statSync(abs).size; fs.unlinkSync(abs); } catch { return 0; }
    const name = path.basename(rel);
    const seg = Number(rel.split("/")[0]);
    if (tierOf(name) === "heavy") { st.heavy -= size; if (seg === st.cur.id) st.cur.heavy -= size; } else st.light -= size;
    return size;
  }

  /** 删整个段（淘汰轻量层用，当前段不删）；返回删掉的 [轻量层, 重量层] 字节数。 */
  removeSegment(site: string, id: number): { light: number; heavy: number } {
    const st = this.state(site);
    if (id === st.cur.id) return { light: 0, heavy: 0 };
    let light = 0, heavy = 0;
    for (const f of this.segmentFiles(site, id)) { if (tierOf(f.name) === "heavy") heavy += f.size; else light += f.size; }
    fs.rmSync(this.segDir(site, id), { recursive: true, force: true });
    st.light -= light;
    st.heavy -= heavy;
    for (const [hash, rel] of st.bodies) if (Number(rel.split("/")[0]) === id) st.bodies.delete(hash);
    return { light, heavy };
  }

  close(): void {
    if (this.buffer) { const buf = this.buffer; this.buffer = null; for (const [file, lines] of buf) this.appendLines(file, lines); }
  }
}
