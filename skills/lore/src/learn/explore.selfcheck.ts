// 观察里列什么：要包含 GET，但不能把静态资源、轮询、噪声列进去（折叠成计数）；写请求标 write（只读的 POST 不算写）；
// 依赖链要能认出来（拿凭证 → 提交）；没有响应体要写出原因，agent 才知道转 DOM。
import assert from "node:assert/strict";
import { dependencies, describeRequest, isPeriodic, missingInSequence, shownRequests } from "./explore.ts";
import type { RequestFile, Row } from "../record/types.ts";
import { looksReadOnly } from "../record/digest.ts";

const req = (seq: number, over: Partial<Row>): Row => ({ seq, t: seq, win: "x.com-20261101-120000", src: "agent", tab: 1, type: "request", requestType: "fetch", method: "GET", url: `https://x.com/api/${seq}`, endpoint: `GET /api/${seq}`, phase: "cmd", ...over });
const stats = new Map([["POST /rpc/ReportViewing", { count: 121, idle: 120, cmdTriggered: 0 }], ["GET /api/list", { count: 5, idle: 1, cmdTriggered: 3 }]]);
const rows: Row[] = [
  req(1, { method: "GET", endpoint: "GET /api/list" }),                          // GET 要算
  req(2, { url: "https://x.com/assets/app.js" }),                                  // 静态资源不算
  req(3, { method: "POST", endpoint: "POST /rpc/ReportViewing" }),                // 周期性 endpoint 不算
  req(4, { phase: "idle" }),                                                      // 观察按游标取，idle 的也列
  req(5, { noise: 1 }),                                                            // 噪声不算
  { ...req(7, {}), type: "input" },                                               // 不是请求
  req(8, { method: "POST", endpoint: "POST /rpc/StreamTimeline", phase: "load" }), // 翻页导致的流式请求要算
];
const picked = shownRequests(rows, stats);
assert.deepEqual(picked.shown.map((r) => r.seq), [1, 4, 8]);
assert.deepEqual([picked.noise, picked.periodic, picked.assets], [1, 1, 1], "没列出的折叠成计数");
assert.equal(isPeriodic({ count: 3, idle: 2, cmdTriggered: 0 }), false, "样本太少不当作轮询");
assert.equal(isPeriodic({ count: 50, idle: 40, cmdTriggered: 1 }), true, "偶尔落在动作之后的轮询仍是轮询");
assert.equal(isPeriodic({ count: 30, idle: 15, cmdTriggered: 15 }), false, "一半由动作引发的不是轮询");

const file = (over: Partial<RequestFile>): RequestFile => ({ seq: 8, win: "x.com-20261101-120000", endpoint: "", requestType: "fetch", method: "POST", url: { bareUrl: "", query: {} }, headers: {}, startedAt: 0, endedAt: 1, ...over });
const none = describeRequest(rows[6]!, file({ responseHeaders: { "content-type": "application/connect+proto" }, bodyOmitted: "no-body" }), { write: true });
assert.equal(none.readable, false);
assert.match(none.line, /^write #8 POST \/rpc\/StreamTimeline → .*connect\+proto，无响应体（no-body）/);
const ok = describeRequest({ ...rows[0]!, file: "requests/000001-GET-api-list.json" }, file({ responseHeaders: { "content-type": "application/json; charset=utf-8" }, responseBodyPath: "requests/000001-GET-api-list.response.json" }), { write: false, other: "api.x.com", known: "列出条目" });
assert.equal(ok.readable, true); assert.match(ok.line, /^      #1 GET \/api\/list（api\.x\.com） → .*application\/json，有响应体，requests\/000001-GET-api-list\.json（以前：列出条目）$/);

// 依赖：后一个请求带出去的值（长度 ≥ 6）等于前一个响应里的值
const files: Record<number, RequestFile> = {
  31: file({ seq: 31, method: "GET", responseBodyPath: "r31" }),
  32: file({ seq: 32, url: { bareUrl: "", query: { sig: "abc" } }, requestBody: { token: "tok_998877", text: "[赞]" }, responseBodyPath: "r32" }),
  33: file({ seq: 33, requestBody: { id: "zzzzzzzz" } }),
};
const bodies: Record<string, string> = { r31: JSON.stringify({ data: { token: "tok_998877", n: 1 } }), r32: "{}" };
const deps = dependencies([req(31, {}), req(32, {}), req(33, {})], (q) => files[q], (f) => (f.responseBodyPath ? bodies[f.responseBodyPath] : undefined));
assert.deepEqual(deps, [{ from: 31, to: 32, field: "data.token" }], "短值（abc）和对不上的值不算依赖");
// 日志里 token 是别名，只有内存里的原始请求能对上
const aliased: Record<number, RequestFile> = { ...files, 32: file({ seq: 32, requestBody: { token: "⟨secret_ab12:str⟩" }, tab: 1, rid: "r:32" }) };
assert.deepEqual(dependencies([req(31, {}), req(32, {})], (q) => aliased[q], (f) => (f.responseBodyPath ? bodies[f.responseBodyPath] : undefined)), [], "响应里是原文、请求里是别名：只看日志对不上");
const aliasedBodies: Record<string, string> = { r31: JSON.stringify({ data: { token: "⟨secret_ab12:str⟩" } }) };
assert.deepEqual(dependencies([req(31, {}), req(32, {})], (q) => aliased[q], (f) => (f.responseBodyPath ? aliasedBodies[f.responseBodyPath] : undefined)), [{ from: 31, to: 32, field: "data.token" }], "两边都是同一个别名：对上");
assert.deepEqual(dependencies([req(31, {}), req(32, {})], (q) => aliased[q], (f) => (f.responseBodyPath ? bodies[f.responseBodyPath] : undefined), (f) => (f.rid === "r:32" ? { url: "https://x.com/api/save", body: JSON.stringify({ token: "tok_998877" }) } : undefined)), [{ from: 31, to: 32, field: "data.token" }], "用原始请求对上");

// 多行 @endpoint：按顺序都要出现，中间可以夹别的
assert.equal(missingInSequence(["GET /token", "POST /submit"], ["GET /x", "GET /token", "GET /y", "POST /submit"]), undefined);
assert.equal(missingInSequence(["GET /token", "POST /submit"], ["POST /submit", "GET /token"]), "POST /submit", "顺序反了算缺");
// 只读的非 GET 请求不算写（不标 write）；判断不出来就算写
assert.equal(looksReadOnly("POST", "https://x.com/graphql", { query: "query Search { a }" }), true);
assert.equal(looksReadOnly("POST", "https://x.com/graphql", JSON.stringify({ query: "mutation Like { a }" })), false);
assert.equal(looksReadOnly("POST", "https://x.com/graphql", [{ query: "{ a }" }, { query: "mutation M { b }" }]), false, "批量里有一个 mutation 就是写");
assert.equal(looksReadOnly("POST", "https://x.com/i/api/graphql/abc/SearchTimeline", { operationName: "SearchTimeline" }), true);
assert.equal(looksReadOnly("POST", "https://x.com/i/api/graphql/abc/CreateTweet", { operationName: "CreateTweet" }), false);
assert.equal(looksReadOnly("POST", "https://a.com/cgi/cms/getAllChangeOrders", { path: "x" }), true);
assert.equal(looksReadOnly("POST", "https://a.com/api/comment", { text: "x" }), false);
assert.equal(looksReadOnly("POST", "https://a.com/api/settings", { theme: "x" }), false, "settings 不是 set 开头的读");
assert.equal(looksReadOnly("DELETE", "https://a.com/api/listing/1"), false, "listing 不是 list 动词");
assert.equal(looksReadOnly("GET", "https://a.com/api/x"), true);
console.log("explore.selfcheck ok");
