// auth 来源分错了，action 会静默带错头：cookie、localStorage（含 Bearer 前缀和 JSON 字段）、sessionStorage、meta、签名、不变的值都要分对；只输出来源，不输出值。
import assert from "node:assert/strict";
import { authSpecs, classifyAuth, describeAuth } from "./auth.ts";

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
  "x-request-id": "rid-1",
  "x-api-version": "3.0.91",
  "content-type": "application/json",
  accept: "*/*",
};
const history = { "x-request-id": ["rid-2"], "x-api-version": ["3.0.91", "3.0.91"] };
const s = classifyAuth(headers, snap, history);
assert.deepEqual(authSpecs(s), {
  "x-xsrftoken": "cookie:_xsrf",
  authorization: "Bearer local:auth.user.accessToken",
  "x-plain-token": "local:plain",
  "x-csrf": "session:csrf",
  "x-csrf-token": "meta:csrf-token",
});
assert.equal(s["x-zse-96"]!.kind, "signed", "名字像签名");
assert.equal(s["x-request-id"]!.kind, "signed", "各次请求都不同");
assert.equal(s["x-api-version"]!.kind, "static", "各次请求都一样");
assert.equal(s["content-type"], undefined, "普通头不管");
const text = describeAuth(s);
assert.match(text, /x-xsrftoken ← cookie _xsrf/); assert.match(text, /authorization ← Bearer localStorage auth\.user\.accessToken/);
for (const v of Object.values(headers)) if (v.length > 6 && !/json|\*/.test(v)) assert.ok(!text.includes(v.replace(/^Bearer /, "")), `说明里没有值：${v}`);
assert.equal(classifyAuth({ "x-token": "only-once-123456" }, undefined)["x-token"]!.kind, "unknown", "没有快照也没有别的请求：来源不明");
console.log("auth.selfcheck ok");
