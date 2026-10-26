// 淘汰：先只删重量层（响应体、文档、快照）的旧文件，时间线、请求文件和受保护的样本留着；轻量层超了才删整段；
// 一个站点超了只动自己；当前段永远不动。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enforce } from "./retention.ts";
import { SiteLog } from "./sitelog.ts";
import type { Row } from "./types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-retention-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const log = new SiteLog({ dir, segmentBytes: 1000 });
log.open();
const row = (win = "user"): Row => ({ seq: log.reserve(), t: Date.now(), win, src: "page", tab: 1, type: "request", method: "GET" });
const big = "x".repeat(1200); // 一个响应体就写满一段

/** 往站点里写 n 个请求（每个一个请求文件加一个 1200 字节的响应体），每个请求单独占一段。返回各请求的相对路径。 */
function fill(site: string, n: number): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  for (let i = 0; i < n; i++) {
    log.batch(() => { // 一批里只在开头看一次要不要换段：响应体、请求文件、时间线行落在同一个段里
      const r = row();
      const body = log.putFile(site, `${String(r.seq).padStart(6, "0")}_GET_x.response.json`, big);
      const file = log.putFile(site, `${String(r.seq).padStart(6, "0")}_GET_x.json`, JSON.stringify({ seq: r.seq }));
      log.append(site, { ...r, file });
      out.push({ file, body });
    });
  }
  return out;
}

const a = fill("a.com", 5); // 段 1 到 5，当前段是 5
const b = fill("b.com", 3); // 比 a.com 小：单站点额度只压 a.com
assert.equal(log.currentSegment("a.com"), 5);
const before = log.usage();

// 重量层：a.com 超了单站点额度。只删 a.com 最旧的段里没受保护的响应体；请求文件、时间线都在；b.com 不动
const changed: string[] = [];
const keep = new Set([a[0]!.body]); // 样本受保护
let r = enforce(log, { protect: (site) => (site === "a.com" ? keep : new Set()), changed: (s) => changed.push(s) }, { totalLight: 1e9, totalHeavy: 1e9, siteLight: 1e9, siteHeavy: before.sites["a.com"]!.heavy - 1 });
assert.equal(r.strippedFiles, 1, "受保护的样本跳过，删的是下一个段里的响应体");
assert.ok(fs.existsSync(log.abs("a.com", a[0]!.body)), "受保护的样本还在");
assert.ok(!fs.existsSync(log.abs("a.com", a[1]!.body)), "最旧的没受保护的响应体被删了");
assert.ok(a.every((x) => fs.existsSync(log.abs("a.com", x.file))), "请求文件一个不少");
assert.equal(log.readRows("a.com", { limit: 100 }).length, 5, "时间线一行不少");
assert.ok(b.every((x) => fs.existsSync(log.abs("b.com", x.body))), "别的站点不动");
assert.deepEqual(changed, ["a.com"]);

// 当前段永远不动：把额度压到 0，也留着当前段的响应体
r = enforce(log, {}, { totalLight: 1e9, totalHeavy: 0, siteLight: 1e9, siteHeavy: 0 });
assert.ok(fs.existsSync(log.abs("a.com", a[4]!.body)) && fs.existsSync(log.abs("b.com", b[2]!.body)), "当前段的响应体还在");
assert.ok(!fs.existsSync(log.abs("b.com", b[0]!.body)), "总量超了，旧的都删了");

// 轻量层：超了才删整段（先删最旧的）
const light = log.usage().sites["a.com"]!.light;
r = enforce(log, {}, { totalLight: 1e9, totalHeavy: 1e9, siteLight: light - 1, siteHeavy: 1e9 });
assert.equal(r.removedSegments, 1);
assert.ok(!fs.existsSync(log.segDir("a.com", 1)), "最旧的整段没了");
assert.ok(fs.existsSync(log.segDir("a.com", 2)));
assert.equal(log.segmentIds("b.com").length, 3, "别的站点不动");

// 总量超了先动占用最多的站点
const small = fill("c.com", 2);
const totalLight = log.usage().light;
r = enforce(log, {}, { totalLight: totalLight - 1, totalHeavy: 1e9, siteLight: 1e9, siteHeavy: 1e9 });
assert.ok(r.removedSegments >= 1);
assert.ok(small.every((x) => fs.existsSync(log.abs("c.com", x.file))), "占用少的站点没被动");

// 占用量和磁盘一致
const fresh = new SiteLog({ dir });
fresh.open();
assert.deepEqual(fresh.usage().sites, log.usage().sites);

console.log("retention.selfcheck ok");
