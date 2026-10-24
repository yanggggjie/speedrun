import assert from "node:assert/strict";
import { RawStore, RAW_ITEM_MAX } from "./raw.ts";

const entry = (n: number, pad = 0) => ({ method: "GET", url: `https://a.com/${n}`, headers: { authorization: "Bearer REAL" }, body: "x".repeat(pad) || null, page: "https://a.com/", t: n });

const store = new RawStore(2_000);
assert.equal(store.put(1, "d:1", entry(1)), true);
assert.equal(store.get(1, "d:1")!.headers.authorization, "Bearer REAL");
assert.equal(store.get(2, "d:1"), undefined, "按标签页隔离");

// 单条太大不存
assert.equal(store.put(1, "d:big", entry(2, RAW_ITEM_MAX + 1)), false);

// 超过总上限先丢最旧的
for (let i = 2; i <= 30; i++) store.put(1, `d:${i}`, entry(i, 200));
assert.ok(store.totalBytes() <= 2_000);
assert.equal(store.get(1, "d:1"), undefined, "最旧的被丢了");
assert.ok(store.get(1, "d:30"), "最新的还在");

// 同一个键覆盖，不重复计数
const before = store.totalBytes();
store.put(1, "d:30", entry(30, 200));
assert.equal(store.totalBytes(), before);

console.log("raw.selfcheck ok");
