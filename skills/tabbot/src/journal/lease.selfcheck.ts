// 租约：人一动手立刻撤销、防抖、空闲过期、滚轮只算在场。时间用假时钟，不真等。
import assert from "node:assert/strict";
import { HUMAN_IDLE_MS, LEASE_IDLE_MS, Leases, type LeaseEvent } from "./lease.ts";

let now = 1_000_000;
const leases = new Leases(() => now);
const events: string[] = [];
leases.onEvent = (e: LeaseEvent) => events.push(`${e.tab}:${e.state}${e.by ? `:${e.by}` : ""}`);

// 没有人输入过：直接拿到
assert.deepEqual(leases.acquire(1), { granted: true });
assert.deepEqual(leases.acquire(1), { granted: true, already: true });
assert.equal(leases.has(1), true);
assert.equal(leases.use(1), true);

// 滚轮、滚动只算在场，不撤销
leases.humanInput(1, "wheel");
leases.humanInput(1, "scroll");
assert.equal(leases.has(1), true);
// 点击、按键、输入撤销
leases.humanInput(1, "click");
assert.equal(leases.has(1), false);
assert.equal(leases.use(1), false);

// 防抖：人刚动过，不能马上拿回；静默超过 HUMAN_IDLE_MS 才行
const refused = leases.acquire(1);
assert.equal(refused.granted, false);
assert.equal((refused as { idleMs: number }).idleMs, 0);
now += HUMAN_IDLE_MS + 1;
assert.deepEqual(leases.acquire(1), { granted: true });

// 空闲过期：LEASE_IDLE_MS 没有动作就失效；使用会续期
now += LEASE_IDLE_MS - 1000;
assert.equal(leases.use(1), true);
now += LEASE_IDLE_MS - 1000;
assert.equal(leases.has(1), true);
now += 2000;
assert.equal(leases.has(1), false);

// 交还、标签页关闭；租约按标签页隔离
assert.deepEqual(leases.acquire(2), { granted: true });
assert.equal(leases.has(3), false);
assert.equal(leases.release(2, "做完了"), true);
assert.equal(leases.release(2), false);
leases.acquire(4); leases.closed(4);
assert.equal(leases.has(4), false);
assert.equal(leases.humanIdleMs(4), undefined);

assert.ok(events.includes("1:revoked:click") && events.includes("1:expired") && events.includes("2:released"));

console.log("lease.selfcheck ok");
