// 请求头的信号错了，agent 会写错 auth 或白改发法：值怎么变（页面级不变、按 endpoint 不变、每次都变、样本太少）、页面存储里的来源都要分对；只输出类别和来源，不输出值。
import assert from "node:assert/strict";
import { describeHeaders, headerSignals } from "./auth.ts";
import { headerKinds } from "./headers.ts";

// 一个窗口里的同站请求：x-xsrftoken、x-api-version 各请求一样；x-zse-96 同一个 endpoint 也每次不同；x-key 按 endpoint 不同；x-once 只出现一次
const req = (endpoint: string, doc: string, h: Record<string, string>) => ({ endpoint, doc, headers: { accept: "*/*", "content-type": "application/json", cookie: "a=1", ...h } });
const reqs = [
  req("GET /api/me", "d1", { "x-xsrftoken": "xsrf-0123456789", "x-api-version": "3.0", "x-zse-96": "2.0_a", "x-key": "k-me" }),
  req("GET /api/me", "d1", { "x-xsrftoken": "xsrf-0123456789", "x-api-version": "3.0", "x-zse-96": "2.0_b", "x-key": "k-me" }),
  req("GET /api/list", "d1", { "x-xsrftoken": "xsrf-0123456789", "x-api-version": "3.0", "x-zse-96": "2.0_c", "x-key": "k-list", "x-once": "once-1234567" }),
  // 另一次页面加载换了 token：跨加载不比，还是页面级不变
  req("GET /api/list", "d2", { "x-xsrftoken": "xsrf-NEW-9876543210", "x-api-version": "3.0" }),
];
const kinds = headerKinds(reqs);
assert.equal(kinds.get("x-xsrftoken"), "page", "同一次页面加载里都一样：页面级不变（跨加载换了也算）");
assert.equal(kinds.get("x-api-version"), "page");
assert.equal(kinds.get("x-zse-96"), "varies", "同一个 endpoint 也不同：每次都变");
assert.equal(kinds.get("x-key"), "endpoint", "同一个 endpoint 不变、不同 endpoint 不同");
assert.equal(kinds.get("x-once"), "few", "不到 3 次：样本太少");
assert.equal(kinds.has("accept") || kinds.has("content-type") || kinds.has("cookie"), false, "浏览器管的、普通的头不统计");

const snap = {
  cookie: { _xsrf: "xsrf-0123456789", other: "zzz" },
  local: { auth: JSON.stringify({ user: { accessToken: "acc-abcdef123456" } }), plain: "plain-token-777777" },
  session: { csrf: "sess-csrf-888888" },
  meta: { "csrf-token": "meta-csrf-999999" },
};
const headers = {
  "x-xsrftoken": "xsrf-0123456789",
  authorization: "Bearer acc-abcdef123456",
  "x-plain-token": "plain-token-777777",
  "x-csrf": "sess-csrf-888888",
  "x-csrf-token": "meta-csrf-999999",
  "x-zse-96": "2.0_aaaa",
  "content-type": "application/json",
  accept: "*/*",
};
const s = headerSignals(headers, snap, kinds);
assert.deepEqual(Object.fromEntries(Object.entries(s).filter(([, x]) => x.source).map(([h, x]) => [h, x.source])), {
  "x-xsrftoken": "cookie:_xsrf",
  authorization: "Bearer local:auth.user.accessToken",
  "x-plain-token": "local:plain",
  "x-csrf": "session:csrf",
  "x-csrf-token": "meta:csrf-token",
});
assert.deepEqual(s["x-zse-96"], { kind: "varies" });
assert.equal(s["x-xsrftoken"]!.kind, "page");
assert.equal(s.authorization!.kind, "few", "统计里没有的头：样本太少");
assert.equal(s["content-type"], undefined, "普通头不管");
const text = describeHeaders(s);
assert.match(text, /x-xsrftoken 页面级不变 ← cookie _xsrf/); assert.match(text, /authorization 样本太少 ← Bearer localStorage auth\.user\.accessToken/); assert.match(text, /x-zse-96 每次都变/);
for (const v of Object.values(headers)) if (v.length > 6 && !/json|\*/.test(v)) assert.ok(!text.includes(v.replace(/^Bearer /, "")), `说明里没有值：${v}`);
assert.deepEqual(headerSignals({ "x-token": "only-once-123456" }, undefined, new Map()), { "x-token": { kind: "few" } }, "没有快照：只给类别");
console.log("auth.selfcheck ok");
