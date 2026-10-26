// 站点日志的存储：编号全局唯一且重启后接着往后、每个窗口一个时间线文件、响应体按内容只存一份、换段后引用仍然有效、占用量和磁盘一致。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SiteLog, tierOf } from "./sitelog.ts";
import type { Row } from "./types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sitelog-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const row = (seq: number, win: string, extra: Partial<Row> = {}): Row => ({ seq, t: 1000 + seq, win, src: "page", tab: 1, type: "action", actionType: "click", ...extra });

// 编号：全局唯一、单调递增（跨站点也不重复）；重启（新的 SiteLog）接着往后，不会重复
const log = new SiteLog({ dir, segmentBytes: 400 });
log.open();
const first = [log.reserve(), log.reserve(), log.reserve()];
assert.deepEqual(first, [1, 2, 3]);
const reopened = new SiteLog({ dir });
reopened.open();
assert.ok(reopened.reserve() > 3, "重启后的编号比之前用过的都大");

// 每个窗口一个时间线文件；一批里的行攒着，批结束时才落盘；读的时候能按窗口取
log.batch(() => {
  log.append("a.com", row(log.reserve(), "user"));
  log.append("a.com", row(log.reserve(), "debug-ab12"));
  log.append("b.com", row(log.reserve(), "user"));
  assert.ok(!fs.existsSync(path.join(log.segDir("a.com", 1), "timeline.user.jsonl")), "批没结束，还没落盘");
});
assert.deepEqual(fs.readdirSync(log.segDir("a.com", 1)).sort(), ["timeline.debug-ab12.jsonl", "timeline.user.jsonl"]);
assert.deepEqual(log.readRows("a.com", { wins: ["user"] }).map((r) => r.win), ["user"]);
assert.deepEqual(log.readRows("a.com").map((r) => r.win).sort(), ["debug-ab12", "user"]);
assert.deepEqual(log.readRows("b.com").map((r) => r.win), ["user"], "站点之间不混");
assert.deepEqual(log.listSites(), ["a.com", "b.com"]);

// 响应体：内容相同的只存一份；那份文件没了再写就重新存
const one = log.putBody("a.com", "000010_GET_x.response.json", "{\"a\":1}", "h1");
const two = log.putBody("a.com", "000011_GET_y.response.json", "{\"a\":1}", "h1");
assert.equal(two, one);
assert.deepEqual(fs.readdirSync(log.segDir("a.com", 1)).filter((n) => n.includes("response")), ["000010_GET_x.response.json"]);
log.removeFile("a.com", one);
const three = log.putBody("a.com", "000012_GET_z.response.json", "{\"a\":1}", "h1");
assert.notEqual(three, one);
assert.ok(fs.existsSync(log.abs("a.com", three)));

// 换段：重量层写满就开新的一段；旧段的引用仍然有效；请求文件按编号跨段找得到
log.putFile("a.com", "000020_GET_old.json", JSON.stringify({ seq: 20 }));
log.putFile("a.com", "000020_GET_old.response.json", "x".repeat(500)); // 重量层超过 400 字节
const rel = log.putFile("a.com", "000021_GET_new.json", JSON.stringify({ seq: 21 }));
assert.equal(log.currentSegment("a.com"), 2);
assert.equal(rel, "000002/000021_GET_new.json");
assert.equal(log.findRequestFile("a.com", 20)?.rel, "000001/000020_GET_old.json", "旧段里的请求文件按编号找得到");
assert.equal(log.readRequestFile("a.com", 21)?.file.seq, 21);
assert.equal(log.findRequestFile("a.com", 999), undefined);
assert.equal(log.currentSegment("b.com"), 1, "换段只影响自己的站点");

// 读：多个段，取最新的 limit 行，按编号从旧到新
for (let i = 0; i < 6; i++) log.append("a.com", row(log.reserve(), "user"));
const tail = log.readRows("a.com", { wins: ["user"], limit: 3 });
assert.equal(tail.length, 3);
assert.deepEqual(tail.map((r) => r.seq), [...tail.map((r) => r.seq)].sort((a, b) => a - b));
assert.ok(log.readRows("a.com", { wins: ["user"], sinceSeq: tail[0]!.seq }).every((r) => r.seq > tail[0]!.seq));

// 占用量：和磁盘上的实际文件一致（轻量层、重量层分开记）
const u = log.usage();
for (const site of log.listSites()) {
  let light = 0, heavy = 0;
  for (const id of log.segmentIds(site)) for (const f of log.segmentFiles(site, id)) { if (tierOf(f.name) === "heavy") heavy += f.size; else light += f.size; }
  assert.deepEqual(u.sites[site], { light, heavy }, site);
}
assert.equal(tierOf("timeline.user.jsonl"), "light");
assert.equal(tierOf("000001_GET_x.json"), "light");
assert.equal(tierOf("000001_GET_x.response.json"), "heavy");
assert.equal(tierOf("000001.doc.html"), "heavy");
assert.equal(tierOf("000001.snap.json"), "heavy");

// 重新打开：占用量从磁盘扫出来，和之前一致
const again = new SiteLog({ dir });
again.open();
assert.deepEqual(again.usage().sites, log.usage().sites);

console.log("sitelog.selfcheck ok");
