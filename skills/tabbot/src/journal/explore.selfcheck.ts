// 一步动作之后看什么：引发的请求要包含 GET，但不能把静态资源、轮询、噪声算进去，否则锁定会误触发；没有响应体要写出原因，agent 才知道转 DOM。
import assert from "node:assert/strict";
import { causedRequests, describeRequest, isPeriodic, stepLine } from "./explore.ts";
import type { RequestFile, Row } from "./types.ts";

const req = (seq: number, over: Partial<Row>): Row => ({ seq, t: seq, win: "debug-1", src: "agent", tab: 1, type: "request", requestType: "fetch", method: "GET", url: `https://x.com/api/${seq}`, endpoint: `GET /api/${seq}`, phase: "action", ...over });
const stats = new Map([["POST /rpc/ReportViewing", { count: 121, idle: 120, actionTriggered: 0 }], ["GET /api/list", { count: 5, idle: 1, actionTriggered: 3 }]]);
const rows: Row[] = [
  req(1, { method: "GET", endpoint: "GET /api/list" }),                          // GET 要算
  req(2, { url: "https://x.com/assets/app.js" }),                                  // 静态资源不算
  req(3, { method: "POST", endpoint: "POST /rpc/ReportViewing" }),                // 周期性接口不算
  req(4, { phase: "idle" }),                                                      // idle 不算
  req(5, { noise: 1 }),                                                            // 噪声不算
  req(6, { requestType: "replay" }),                                               // 重放不算
  { ...req(7, {}), type: "action" },                                               // 不是请求
  req(8, { method: "POST", endpoint: "POST /rpc/StreamTimeline", phase: "load" }), // 翻页导致的流式请求要算
];
assert.deepEqual(causedRequests(rows, stats).map((r) => r.seq), [1, 8]);
assert.equal(isPeriodic({ count: 3, idle: 2, actionTriggered: 0 }), false, "样本太少不当作轮询");
assert.equal(isPeriodic({ count: 50, idle: 40, actionTriggered: 1 }), true, "偶尔落在动作之后的轮询仍是轮询");
assert.equal(isPeriodic({ count: 30, idle: 15, actionTriggered: 15 }), false, "一半由动作引发的不是轮询");

const file = (over: Partial<RequestFile>): RequestFile => ({ seq: 8, win: "debug-1", endpoint: "", requestType: "fetch", method: "POST", url: { bareUrl: "", query: {} }, headers: {}, startedAt: 0, endedAt: 1, ...over });
const none = describeRequest(rows[7]!, file({ responseHeaders: { "content-type": "application/connect+proto" }, bodyOmitted: "no-body" }), "/log/8.json");
assert.equal(none.readable, false);
assert.match(none.line, /connect\+proto，无响应体（no-body）/);
const ok = describeRequest(rows[0]!, file({ responseHeaders: { "content-type": "application/json; charset=utf-8" }, responseBodyPath: "000001/1.response.json" }), "/log/1.json");
assert.equal(ok.readable, true); assert.match(ok.line, /application\/json，有响应体/);

assert.equal(stepLine({ kind: "click" }, { role: "button", name: "提交" }), 'await click(page, {"role":"button","name":"提交"});');
assert.equal(stepLine({ kind: "scroll", dy: -600 }, undefined), 'await scroll(page, {"dy":-600});');
assert.equal(stepLine({ kind: "scroll", to: "bottom" }, undefined), 'await scroll(page, {"to":"bottom"});');
assert.equal(stepLine({ kind: "key", key: "Enter" }, undefined), 'await press(page, "Enter");');
console.log("explore.selfcheck ok");
