// 接口聚合：按 phase 统计动作引发 / 加载期 / 其它（只有学习窗口的记录）、样本受保护（路径相对 ~/.tabbot）、action 覆盖标记、重启后读回、不含 token 真值；
// 接口名：同一路径上请求体里的 operationName / action 把不同操作拆开；站点按页面 host。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { endpointOf, normalizeSite, siteOf } from "./digest.ts";
import { EndpointIndex, SAMPLES_PER_ENDPOINT, type ObserveInput } from "./endpoints.ts";
import { RawStore } from "./raw.ts";
import type { Phase, RequestFile, Row } from "./types.ts";

// ---- 站点与接口名 ----
assert.equal(siteOf("https://www.zhihu.com/question/1"), "zhihu.com", "www. 去掉");
assert.equal(siteOf("https://zhuanlan.zhihu.com/p/1"), "zhuanlan.zhihu.com", "同一产品的子域是另一个站点");
assert.equal(siteOf("https://app.example.com/a"), "app.example.com");
assert.notEqual(siteOf("https://app.example.com/a"), siteOf("https://app.example.com/b"), "同一个注册域名下的不同系统不混");
assert.equal(siteOf("https://mail.google.com/"), "mail.google.com");
assert.equal(siteOf("http://localhost:3000/x"), "localhost:3000", "非默认端口带上");
assert.equal(siteOf("chrome://extensions"), "");
assert.equal(normalizeSite("WWW.X.com "), "x.com");
assert.equal(normalizeSite("https://docs.google.com/document/d/1"), "docs.google.com");
assert.deepEqual(endpointOf("https://x.com/i/api/graphql/abc123/FavoriteTweet"), { host: "x.com", name: "graphql FavoriteTweet" });
assert.equal(endpointOf("https://api.example.com/graphql", { operationName: "A" }).name, "/graphql#A", "POST /graphql 按请求体里的 operationName 拆开");
assert.notEqual(endpointOf("https://api.example.com/graphql", { operationName: "A" }).name, endpointOf("https://api.example.com/graphql", { operationName: "B" }).name);
assert.equal(endpointOf("https://gw.example.com/rpc", JSON.stringify({ method: "listUsers", params: [] })).name, "/rpc#listUsers", "JSON-RPC 的 method");
assert.equal(endpointOf("https://gw.example.com/rpc", { method: "POST" }).name, "/rpc", "method 是 HTTP 动词的不当作操作名");
assert.equal(endpointOf("https://a.com/api/users/12345678/posts").name, "/api/users/:id/posts");
assert.equal(endpointOf("https://a.com/api/search", { q: "x" }).name, "/api/search", "没有操作名字段就只用路径");

// ---- 聚合 ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-endpoints-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const dir = path.join(root, "sites");
const SITE = "x.com";
const raw = new RawStore();
raw.put(5, "d:9", { method: "POST", url: "https://x.com/a", headers: { authorization: "Bearer REAL-TOKEN-0123456789abcdef" }, body: null, page: "https://x.com/", t: 1 });
let covered = new Map<string, string>();
const index = new EndpointIndex({ dir, raw, coverage: () => covered, flushMs: 5 });
let seq = 100;
function observe(endpoint: string, phase: Phase, over: { win?: string; status?: number; label?: string; text?: string; body?: unknown; rid?: string; query?: Record<string, string> } = {}): ObserveInput {
  const s = ++seq;
  const method = endpoint.slice(0, endpoint.indexOf(" "));
  const win = over.win ?? "x.com-20261101-120000";
  const rel = `requests/${String(s).padStart(6, "0")}-${method}-x.json`;
  const ref = `learn-windows/${win}/${rel}`, bodyRef = `${ref.slice(0, -5)}.response.json`;
  fs.mkdirSync(path.dirname(path.join(root, ref)), { recursive: true });
  fs.writeFileSync(path.join(root, ref), "{}");
  fs.writeFileSync(path.join(root, bodyRef), "{}");
  const row: Row = { seq: s, t: s * 1000, win, src: "agent", tab: 5, type: "request", requestType: "fetch", method, url: "https://x.com/a", status: over.status ?? 200, endpoint, phase, file: rel };
  const file = { seq: s, win, endpoint, requestType: "fetch", rid: over.rid, method, url: { bareUrl: "https://x.com/a", query: over.query ?? {} }, headers: {}, requestBody: over.body, status: row.status, responseBodyPath: `${rel.slice(0, -5)}.response.json`, startedAt: 0, endedAt: 0 } as RequestFile;
  const input: ObserveInput = { site: SITE, row, file, ref, bodyRef, text: over.text, label: over.label };
  index.observe(input);
  return input;
}

// 点赞：在学习窗口里点了 3 次（动作引发）
for (let i = 0; i < 3; i++) observe("POST graphql FavoriteTweet", "cmd", { label: "agent cmd click button[Like]", body: { variables: { tweet_id: "1" } }, text: "{\"data\":{\"favorite_tweet\":\"Done\"}}", rid: "d:9" });
// 时间线：页面加载期发了 2 次、轮询 4 次；agent 的动作引发 1 次
for (let i = 0; i < 2; i++) observe("GET graphql HomeTimeline", "load", { query: { variables: "{\"count\":20,\"cursor\":\"c\"}" }, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
const homeQuery = { variables: "{\"count\":20,\"cursor\":\"c\"}" };
for (let i = 0; i < 4; i++) observe("GET graphql HomeTimeline", "idle", { query: homeQuery, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
observe("GET graphql HomeTimeline", "cmd", { label: "agent cmd click x", query: homeQuery, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
// 失败的请求计数，但不当样本
const failed = observe("GET graphql HomeTimeline", "idle", { status: 500, query: homeQuery });
// 重放不算接口的使用情况
const replay = observe("POST graphql FavoriteTweet", "cmd", { label: "agent cmd click button[Like]", body: { variables: { tweet_id: "1" } }, text: "{\"data\":{\"favorite_tweet\":\"Done\"}}", rid: "d:9" });
index.observe({ ...replay, row: { ...replay.row, requestType: "replay" } });

let snap = index.snapshot(SITE);
const like = snap.endpoints.find((e) => e.key === "POST graphql FavoriteTweet")!;
const home = snap.endpoints.find((e) => e.key === "GET graphql HomeTimeline")!;
assert.equal(like.cmdTriggered, 4, "动作引发的次数（含上面多观察的那一次，不含重放）");
assert.equal(like.onLoad, 0);
assert.equal(like.lastCause, "agent cmd click button[Like]");
assert.deepEqual(like.variables, ["tweet_id"]);
assert.equal(like.shape, "data.favorite_tweet");
assert.equal(like.replayable, true, "原始请求还在内存里");
assert.equal(home.onLoad, 2); assert.equal(home.idle, 5); assert.equal(home.cmdTriggered, 1);
assert.equal(home.count, 8);
assert.deepEqual(home.variables, ["variables.count", "variables.cursor"]);
assert.match(home.shape!, /^data\.home\.\{a,b\}$/);
assert.equal(home.replayable, false, "没有原始请求就不能直接重放");
assert.equal(like.action, null);

// 样本：每个接口最近 5 个成功请求，受保护；失败的不是样本
assert.equal(home.samples.length, SAMPLES_PER_ENDPOINT);
assert.ok(home.samples.every((s) => s.available));
const keep = index.protect();
for (const s of home.samples) assert.ok(keep.has(s.file) && keep.has(s.body!), "样本的请求文件和响应体受保护");
assert.ok(!keep.has(failed.ref), "失败的请求不受保护");

// action 覆盖：文件头 @endpoint 和接口的 key 一致就算覆盖
covered = new Map([["POST graphql FavoriteTweet", "like-tweet"]]);
snap = index.snapshot(SITE);
assert.equal(snap.endpoints.find((e) => e.key === "POST graphql FavoriteTweet")!.action, "like-tweet");
assert.equal(snap.endpoints.find((e) => e.key === "GET graphql HomeTimeline")!.action, null);

// 文件被淘汰了：样本标为不可用，而不是留一个悬空指针
const gone = home.samples[0]!;
fs.rmSync(path.join(root, gone.file));
assert.equal(index.snapshot(SITE).endpoints.find((e) => e.key === "GET graphql HomeTimeline")!.samples.find((s) => s.seq === gone.seq)!.available, false);

// 写盘与重启读回（原子写）；文件里没有 token 真值
index.flush();
const file = path.join(dir, SITE, "endpoints.json");
assert.ok(fs.existsSync(file) && !fs.readdirSync(path.join(dir, SITE)).some((n) => n.endsWith(".tmp")));
assert.ok(!fs.readFileSync(file, "utf8").includes("REAL-TOKEN"));
const reborn = new EndpointIndex({ dir, coverage: () => covered });
const back = reborn.snapshot(SITE).endpoints.find((e) => e.key === "GET graphql HomeTimeline")!;
assert.equal(back.count, 8);
assert.equal(back.samples.length, SAMPLES_PER_ENDPOINT);
assert.equal(back.replayable, false);
reborn.observe({ ...observe("GET graphql HomeTimeline", "idle"), row: { seq: 999, t: 1, win: "x.com-20261101-120000", src: "agent", tab: 5, type: "request", method: "GET", endpoint: "GET graphql HomeTimeline", phase: "idle", status: 200, file: "requests/000999-GET-x.json" } });
assert.equal(reborn.snapshot(SITE).endpoints.find((e) => e.key === "GET graphql HomeTimeline")!.count, 9, "读回后接着计数");
// description：动作带的一句业务含义，只收成功的请求，同一句只留一份，最多 5 句（新的在前）；describe 只记到已有的接口
const descIndex = new EndpointIndex({ dir: path.join(dir, "d"), coverage: () => new Map() });
const obsD = (status: number, text: string, phase: Phase = "cmd") => {
  const base = observe("GET /api/item", phase, { status });
  descIndex.observe({ ...base, row: { ...base.row, status }, description: { text, from: "click" } });
};
obsD(500, "失败的不收");
for (let i = 0; i < 7; i++) obsD(200, `第 ${i} 句`);
obsD(200, "第 6 句");
obsD(200, "轮询不收", "idle");
const item = descIndex.snapshot(SITE).endpoints.find((e) => e.key === "GET /api/item")!;
assert.deepEqual(item.descriptions!.map((d) => d.text), ["第 6 句", "第 5 句", "第 4 句", "第 3 句", "第 2 句"]);
assert.equal(item.descriptions![0]!.from, "click");
assert.equal(descIndex.describe(SITE, "GET /api/item", { text: "查一个条目", from: "run" }), true);
assert.equal(descIndex.snapshot(SITE).endpoints.find((e) => e.key === "GET /api/item")!.descriptions![0]!.from, "run");
assert.equal(descIndex.describe(SITE, "GET /api/nope", { text: "x", from: "run" }), false, "没有的接口不记");

console.log("endpoints.selfcheck ok");
