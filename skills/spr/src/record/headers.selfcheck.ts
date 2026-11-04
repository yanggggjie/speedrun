// 发请求时丢掉浏览器自己管的头（cookie 不能被页面脚本带过去），占位请求体认得出来。
import assert from "node:assert/strict";
import { fetchableHeaders, UNREPLAYABLE_BODY } from "./headers.ts";

// 请求头：浏览器自己管的丢掉
assert.deepEqual(fetchableHeaders({ Cookie: "a=b", "User-Agent": "x", "sec-fetch-mode": "cors", Referer: "r", "X-Api": "1", authorization: "Bearer REAL" }), { "x-api": "1", authorization: "Bearer REAL" });

// 占位的请求体
for (const b of ["[FormData]", "[Blob 120]", "[Binary 33]", "[Request body not read]", "[object Object]"]) assert.ok(UNREPLAYABLE_BODY.test(b), b);
assert.ok(!UNREPLAYABLE_BODY.test("{\"a\":1}"));

console.log("headers.selfcheck ok");
