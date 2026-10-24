// 重放的纯函数：--set 应用到原始请求上（查询参数、请求头、JSON 或表单请求体），请求头的处理
import assert from "node:assert/strict";
import { applySets, isSafeMethod, replayHeaders, UNREPLAYABLE_BODY, type RawRequest } from "./replay-core.ts";

const base = (): RawRequest => ({ method: "POST", url: "https://example.com/api/list?page=1&q=a", headers: { "content-type": "application/json", authorization: "Bearer REAL" }, body: JSON.stringify({ filter: { page: 1, tags: ["x"], on: true }, items: [{ id: 5 }], note: "hi" }) });
const ok = (sets: string[], t: RawRequest = base()): RawRequest => { const r = applySets(t, sets); assert.ok("template" in r, "error" in r ? r.error : ""); return (r as { template: RawRequest }).template; };
const bad = (sets: string[], t: RawRequest = base()): string => { const r = applySets(t, sets); assert.ok("error" in r, "应该报错"); return (r as { error: string }).error; };

// 查询参数：改已有的、加新的；别名之外的特殊字符会被编码
let t = ok(["page=2", "q=你好 世界", "sort=new"]);
const u = new URL(t.url);
assert.equal(u.searchParams.get("page"), "2"); assert.equal(u.searchParams.get("q"), "你好 世界"); assert.equal(u.searchParams.get("sort"), "new");

// 请求头：改、加、删（值为空）
t = ok(["header.x-trace=abc", "header.Authorization=Bearer OTHER"]);
assert.equal(t.headers["x-trace"], "abc"); assert.equal(t.headers.authorization, "Bearer OTHER", "名字不分大小写");
assert.equal(ok(["header.authorization="]).headers.authorization, undefined);

// JSON 请求体：路径、数组下标、按已有类型转换（数字、布尔、数组/对象按 JSON）
t = ok(["body.filter.page=2", "body.filter.on=false", "body.items.0.id=7", "body.filter.tags=[\"a\",\"b\"]", "body.note=改了", "body.extra.deep=1"]);
const body = JSON.parse(t.body!);
assert.deepEqual(body.filter, { page: 2, tags: ["a", "b"], on: false });
assert.equal(body.items[0].id, 7); assert.equal(body.note, "改了"); assert.deepEqual(body.extra, { deep: "1" }, "新字段是字符串");
// 表单请求体
t = ok(["body.page=3"], { method: "POST", url: "https://e.com/x", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "page=1&q=a" });
assert.equal(new URLSearchParams(t.body!).get("page"), "3"); assert.equal(new URLSearchParams(t.body!).get("q"), "a");
// 整个请求体换掉
assert.equal(ok(["body={\"a\":1}"]).body, "{\"a\":1}");
// 原来的请求不被修改
const orig = base(); ok(["page=9", "body.filter.page=9", "header.x=1"], orig); assert.equal(orig.url, base().url); assert.equal(orig.body, base().body);

// 错误：写法不对、没有请求体、请求体不是 JSON、路径穿过非对象
assert.match(bad(["page"]), /名字=值/);
assert.match(bad(["body.a=1"], { method: "GET", url: "https://e.com/", headers: {}, body: null }), /没有请求体/);
assert.match(bad(["body.a=1"], { method: "POST", url: "https://e.com/", headers: {}, body: "不是json" }), /不是 JSON/);
assert.match(bad(["body.note.x=1"]), /不是对象/);
assert.match(bad(["header.="]), /请求头的名字/);

// 请求头：浏览器自己管的丢掉
assert.deepEqual(replayHeaders({ Cookie: "a=b", "User-Agent": "x", "sec-fetch-mode": "cors", Referer: "r", "X-Api": "1", authorization: "Bearer REAL" }), { "x-api": "1", authorization: "Bearer REAL" });

// 方法与占位的请求体
assert.ok(isSafeMethod("GET") && isSafeMethod("HEAD") && !isSafeMethod("POST") && !isSafeMethod("DELETE"));
for (const b of ["[FormData]", "[Blob 120]", "[Binary 33]", "[Request body not read]", "[object Object]"]) assert.ok(UNREPLAYABLE_BODY.test(b), b);
assert.ok(!UNREPLAYABLE_BODY.test("{\"a\":1}"));

console.log("replay-core selfcheck ok");
