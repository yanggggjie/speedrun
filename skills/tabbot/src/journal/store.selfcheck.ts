// 分段队列：按大小滚动、超过总量整段删除最旧的、seq 跨段和重启都接着编、跨段查询。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findInBodies, lastSeq, readEvents, readEventBySeq, runSql, status } from "./query.ts";
import { bodyPath, JournalStore, listSegs, segDir } from "./store.ts";
import type { NewEvent } from "./types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-store-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // 自检结束清掉临时目录
const ev = (n: number, over: Partial<NewEvent> = {}): NewEvent => ({ ts: 1000 + n, tab: 1, frame: 0, src: "page", kind: "net", verb: "fetch", method: "GET", url: `https://a.com/${n}`, status: 200, ...over });

// 小分段（SQLite 自己每段就占几十 KB，所以用大一点的响应体）：每段 150KB，总量上限 300KB
const store = new JournalStore({ dir, segmentBytes: 150_000, capBytes: 300_000 });
await store.open();
const bodies: string[] = [];
for (let i = 1; i <= 12; i++) {
  store.batch(() => {
    const ref = store.putFile("bodies", `b${i}.json`, JSON.stringify({ n: i, pad: "x".repeat(40_000), word: i === 1 ? "最老的独有文字" : i === 12 ? "最新的独有文字" : "" }));
    bodies.push(ref);
    store.insert(ev(i, { body: ref }));
  });
}
store.close();

// 滚动：一批事件落在同一段；写满就新开一段
const segs = listSegs(dir);
assert.ok(segs.length >= 2, `应该滚动出多段：${segs}`);
assert.equal(segs[segs.length - 1], Math.max(...segs));
// 总量上限：最旧的整段被删了（先进先出），最老的事件没了，最新的还在
assert.ok(segs[0]! > 1, `最旧的分段应该被淘汰：${segs}`);
const rows = await readEvents({ dir, limit: 100 });
assert.equal(rows[rows.length - 1]!.seq, 12);
assert.ok(rows[0]!.seq > 1, "最老的事件被淘汰了");
assert.deepEqual(rows.map((r) => r.seq), rows.map((r) => r.seq).sort((a, b) => a - b), "按 seq 从旧到新");

// seq 在重启之后接着编；跨段的游标有效
const again = new JournalStore({ dir, segmentBytes: 150_000, capBytes: 300_000 });
await again.open();
assert.equal(again.lastSeq(), 12);
const next = again.batch(() => again.insert(ev(13)));
assert.equal(next.seq, 13);
again.close();
assert.equal(await lastSeq(dir), 13);
assert.deepEqual((await readEvents({ dir, since: 11 })).map((r) => r.seq), [12, 13]);
assert.equal((await readEventBySeq(13, dir))?.url, "https://a.com/13");
assert.equal(await readEventBySeq(1, dir), undefined, "被淘汰的拿不到");

// 响应体：行里的引用是 <分段序号>/<文件名>，文件在对应分段的 bodies/ 下；最老的响应体随分段一起没了
const newest = rows[rows.length - 1]!;
assert.match(newest.body!, /^\d{6}\/b12\.json$/);
assert.ok(fs.existsSync(bodyPath(newest.body!, "bodies", dir)));
assert.ok(!fs.existsSync(path.join(segDir(1, dir), "bodies", "b1.json")));
const found = await findInBodies("最新的独有文字", { dir });
assert.equal(found.length, 1); assert.equal(found[0]!.row.seq, 12);
assert.deepEqual(await findInBodies("最老的独有文字", { dir }), []);

// 同名文件（内容哈希相同）只写一次
const dedupe = new JournalStore({ dir: path.join(dir, "d"), segmentBytes: 1e9 });
await dedupe.open();
const r1 = dedupe.putFile("bodies", "same.json", "{}"), r2 = dedupe.putFile("bodies", "same.json", "{}");
assert.equal(r1, r2);
dedupe.close();

// SQL 跨段查询、状态
const sql = await runSql("SELECT COUNT(*) AS c, MIN(seq) AS lo FROM events", { dir });
assert.equal(sql.rows[0]![0], (await status(dir)).events);
await assert.rejects(runSql("DELETE FROM events", { dir }), /只支持单条 SELECT/);
await assert.rejects(runSql("SELECT 1; SELECT 2", { dir }), /只支持单条 SELECT/);
await assert.rejects(runSql("SELECT * FROM events WHERE 1 AND (SELECT 1 FROM pragma_table_info('events')) AND pragma", { dir }), /不能用 ATTACH/);
const st = await status(dir);
assert.equal(st.segments, listSegs(dir).length);
assert.ok(st.bytes > 0);

console.log("store.selfcheck ok");
