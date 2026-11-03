import * as fs from "node:fs";
import * as path from "node:path";
import { ENDPOINTS_FLUSH_MS, LOG_LIMITS, SITES_DIR } from "../utils/constants.ts";
import { siteDirName } from "../utils/url.ts";
import { shapeOf, variablesOf } from "./digest.ts";
import type { RawStore } from "./raw.ts";
import type { RequestFile, Row } from "./types.ts";

/**
 * endpoints.json：每个站点一个 <站点>/endpoints.json，写入时增量维护（不用每次重读日志）。
 * 只由 learn 窗口的记录累积（run 窗口的日志只给反查用），给 agent 判断"这个站点学过、跑过哪些 endpoint，哪些还没有 action"。不排序、不替 agent 下结论，只给信号：
 * cmdTriggered（动作引发的次数）、onLoad（页面加载期自动发的次数）、idle（轮询等）、lastCause（最近一次是什么动作触发的）。
 * 每个 endpoint 最近几次成功请求登记成样本（文件路径相对 ~/.lore，如 learn-windows/<句柄>/requests/…），样本的请求文件和响应体在日志淘汰时受保护。
 */
export const SAMPLES_PER_ENDPOINT = 5;
const SHAPE_TEXT_MAX = 2 * 1024 * 1024;

export type Sample = { seq: number; file: string; body?: string; t: number; size: number };
/** agent 用 --description 写下的一句 description：引发它的动作、跑覆盖它的 action 时写的。 */
export type Description = { text: string; from: string; t: number };
export const DESCRIPTIONS_PER_ENDPOINT = 5;
export type EndpointStat = {
  key: string; method: string; host: string; name: string;
  count: number; firstSeq: number; lastSeq: number; lastStatus?: number;
  cmdTriggered: number; onLoad: number; idle: number; lastCause?: string;
  descriptions?: Description[];
  /** auth 头的来源（最近一次判断）：头 → "cookie:_xsrf" 这样的来源，或 signed / static / unknown；signed 为真表示带签名头，换参数可能被拒（以 replay、run 的结果为准）。 */
  auth?: Record<string, string>; signed?: boolean;
  variables: string[]; shape?: string; samples: Sample[];
  lastTab?: number; lastRid?: string;
};
export type EndpointJson = Omit<EndpointStat, "samples" | "lastTab" | "lastRid"> & { replayable: boolean; samples: Array<Omit<Sample, "size"> & { available: boolean }>; action: string | null };
export type EndpointsFile = { site: string; updatedAt: number; endpoints: EndpointJson[] };

export type ObserveInput = { site: string; row: Row; file: RequestFile; ref: string; bodyRef?: string; text?: string; label?: string; description?: { text: string; from: string } };
export type IndexOptions = {
  dir?: string;
  raw?: RawStore;
  /** 这个站点的 action 覆盖了哪些 endpoint：键是 `方法 路径`，值是 action 名。 */
  coverage?: (site: string) => Map<string, string>;
  flushMs?: number;
  now?: () => number;
  /** 每个站点样本合计上限（字节）。 */
  sampleBytes?: number;
};

export class EndpointIndex {
  private readonly dir: string;
  private readonly root: string;
  private readonly raw: RawStore | undefined;
  private readonly coverage: (site: string) => Map<string, string>;
  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly sampleBytes: number;
  private readonly sites = new Map<string, Map<string, EndpointStat>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: IndexOptions = {}) {
    this.dir = options.dir ?? SITES_DIR;
    this.root = path.dirname(this.dir);
    this.raw = options.raw;
    this.coverage = options.coverage ?? (() => new Map());
    this.flushMs = options.flushMs ?? ENDPOINTS_FLUSH_MS;
    this.now = options.now ?? Date.now;
    this.sampleBytes = options.sampleBytes ?? LOG_LIMITS.siteSamples;
  }

  file(site: string): string { return path.join(this.dir, siteDirName(site), "endpoints.json"); }

  private logFile(ref: string): string { return path.join(this.root, ref); }

  private load(site: string): Map<string, EndpointStat> {
    const key = siteDirName(site);
    let map = this.sites.get(key);
    if (map) return map;
    map = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.file(site), "utf8")) as EndpointsFile;
      for (const e of data.endpoints ?? []) {
        const { replayable: _r, action: _a, samples, ...rest } = e;
        map.set(e.key, { ...rest, samples: (samples ?? []).map((s) => ({ seq: s.seq, file: s.file, body: s.body, t: s.t, size: this.sizeOf(s.file, s.body) })) });
      }
    } catch { /* 第一次，或文件坏了：从空开始 */ }
    this.sites.set(key, map);
    return map;
  }

  private sizeOf(...refs: Array<string | undefined>): number {
    let n = 0;
    for (const ref of refs) if (ref) { try { n += fs.statSync(this.logFile(ref)).size; } catch { /* 已经不在 */ } }
    return n;
  }

  /** 写完一个请求之后通知：更新这个 endpoint 的计数、阶段、变量、响应结构、样本。 */
  observe(input: ObserveInput): void {
    const { site, row, file, ref } = input;
    if (!row.endpoint) return;
    const map = this.load(site);
    let e = map.get(row.endpoint);
    if (!e) {
      let host = "";
      try { host = new URL(file.url.bareUrl).hostname; } catch { /* 地址不合法 */ }
      const sp = row.endpoint.indexOf(" ");
      e = { key: row.endpoint, method: row.endpoint.slice(0, sp), host, name: row.endpoint.slice(sp + 1), count: 0, firstSeq: row.seq, lastSeq: row.seq, cmdTriggered: 0, onLoad: 0, idle: 0, variables: [], samples: [] };
      map.set(row.endpoint, e);
    }
    e.count++;
    e.firstSeq = Math.min(e.firstSeq, row.seq);
    if (row.seq >= e.lastSeq) {
      e.lastSeq = row.seq;
      e.lastStatus = row.status;
      e.variables = variablesOf(file);
      e.lastTab = row.tab;
      e.lastRid = file.rid;
    }
    if (row.phase === "load") e.onLoad++;
    else if (row.phase === "cmd") { e.cmdTriggered++; if (input.label) e.lastCause = input.label; }
    else e.idle++;
    if (typeof row.status === "number" && row.status >= 200 && row.status < 300) {
      if (input.text !== undefined && input.text.length <= SHAPE_TEXT_MAX && row.seq >= e.lastSeq) {
        try { e.shape = shapeOf(JSON.parse(input.text)); } catch { /* 不是 JSON */ }
      }
      if (input.description && (row.phase === "cmd" || row.phase === "load")) addDescription(e, { ...input.description, t: row.t });
      e.samples.push({ seq: row.seq, file: ref, body: input.bodyRef, t: row.t, size: this.sizeOf(ref, input.bodyRef) });
      if (e.samples.length > SAMPLES_PER_ENDPOINT) e.samples.shift();
      this.trimSamples(map);
    }
    this.touch(site);
  }

  /** 记一句 description 到已有的 endpoint 上（run 成功时用）；endpoint 还不在聚合里就不记。返回记没记上。 */
  describe(site: string, key: string, d: { text: string; from: string; t?: number }): boolean {
    const e = this.load(site).get(key);
    if (!e || !d.text.trim()) return false;
    addDescription(e, { text: d.text, from: d.from, t: d.t ?? this.now() });
    this.touch(site);
    return true;
  }

  /** 记下 auth 头的来源（观察里判断出的）；endpoint 还不在聚合里就不记。 */
  setAuth(site: string, key: string, auth: Record<string, string>, signed: boolean): boolean {
    const e = this.load(site).get(key);
    if (!e) return false;
    e.auth = auth;
    e.signed = signed;
    this.touch(site);
    return true;
  }

  /** 样本合计超过额度时，从最旧的样本开始放弃保护（放弃的文件之后可被正常淘汰）。 */
  private trimSamples(map: Map<string, EndpointStat>): void {
    const all = [...map.values()].flatMap((e) => e.samples.map((s) => ({ e, s })));
    let total = all.reduce((n, x) => n + x.s.size, 0);
    if (total <= this.sampleBytes) return;
    all.sort((a, b) => a.s.t - b.s.t);
    for (const { e, s } of all) {
      if (total <= this.sampleBytes) break;
      if (e.samples.length <= 1) continue; // 每个 endpoint 至少留最新的一个
      e.samples = e.samples.filter((x) => x !== s);
      total -= s.size;
    }
  }

  /** 日志淘汰时用：所有站点受保护的文件（请求文件和响应体），相对 ~/.lore。 */
  protect(): Set<string> {
    const keep = new Set<string>();
    let sites: string[] = [];
    try { sites = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { /* 还没有 */ }
    for (const site of new Set([...sites, ...this.sites.keys()])) for (const e of this.load(site).values()) for (const s of e.samples) { keep.add(s.file); if (s.body) keep.add(s.body); }
    return keep;
  }

  /** 有日志被淘汰：所有加载过的站点稍后重写（样本的 available 会变）。 */
  touchAll(): void { for (const site of this.sites.keys()) this.touch(site); }

  /** 站点的聚合有变化（或有文件被淘汰了）：稍后写 endpoints.json。 */
  touch(site: string): void {
    this.dirty.add(site);
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  snapshot(site: string): EndpointsFile {
    const covered = this.coverage(site);
    const endpoints: EndpointJson[] = [...this.load(site).values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((e) => {
      const { samples, lastTab, lastRid, ...rest } = e;
      return {
        ...rest,
        replayable: !!(this.raw && lastRid && lastTab !== undefined && this.raw.get(lastTab, lastRid)),
        samples: samples.map((s) => ({ seq: s.seq, file: s.file, ...(s.body ? { body: s.body } : {}), t: s.t, available: fs.existsSync(this.logFile(s.file)) })),
        action: covered.get(e.key) ?? null,
      };
    });
    return { site, updatedAt: this.now(), endpoints };
  }

  /** 把有变化的站点写盘（原子写：临时文件加 rename）。 */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const site of [...this.dirty]) {
      this.dirty.delete(site);
      try {
        const file = this.file(site);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.snapshot(site), null, 1), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { /* 下一次再写 */ }
    }
  }
}

/** 同一句只留一份（新的在前），最多 DESCRIPTIONS_PER_ENDPOINT 句。 */
function addDescription(e: EndpointStat, d: Description): void {
  const text = d.text.trim().slice(0, 200);
  if (!text) return;
  e.descriptions = [{ ...d, text }, ...(e.descriptions ?? []).filter((x) => x.text !== text)].slice(0, DESCRIPTIONS_PER_ENDPOINT);
}
