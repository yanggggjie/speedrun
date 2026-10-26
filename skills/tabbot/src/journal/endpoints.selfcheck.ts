// 接口聚合：按 phase 统计用户触发 / 加载期 / 其它、样本受保护、task 覆盖标记、重启后读回、不含 token 真值；
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-endpoints-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const SITE = "x.com";
const raw = new RawStore();
raw.put(5, "d:9", { method: "POST", url: "https://x.com/a", headers: { authorization: "Bearer REAL-TOKEN-0123456789abcdef" }, body: null, page: "https://x.com/", t: 1 });
let covered = new Map<string, string>();
const index = new EndpointIndex({ dir, raw, coverage: () => covered, flushMs: 5 });
let seq = 100;
function observe(endpoint: string, phase: Phase, over: { win?: string; status?: number; label?: string; text?: string; body?: unknown; rid?: string; query?: Record<string, string> } = {}): ObserveInput {
  const s = ++seq;
  const method = endpoint.slice(0, endpoint.indexOf(" "));
  const rel = `000001/${String(s).padStart(6, "0")}_${method}_x.json`;
  fs.mkdirSync(path.join(dir, SITE, "log", "000001"), { recursive: true });
  fs.writeFileSync(path.join(dir, SITE, "log", rel), "{}");
  fs.writeFileSync(path.join(dir, SITE, "log", `${rel.slice(0, -5)}.response.json`), "{}");
  const row: Row = { seq: s, t: s * 1000, win: over.win ?? "user", src: "page", tab: 5, type: "request", requestType: "fetch", method, url: "https://x.com/a", status: over.status ?? 200, endpoint, phase, file: rel };
  const file = { seq: s, win: row.win, endpoint, requestType: "fetch", rid: over.rid, method, url: { bareUrl: "https://x.com/a", query: over.query ?? {} }, headers: {}, requestBody: over.body, status: row.status, responseBodyPath: `${rel.slice(0, -5)}.response.json`, startedAt: 0, endedAt: 0 } as RequestFile;
  const input: ObserveInput = { site: SITE, row, file, relFile: rel, text: over.text, label: over.label };
  index.observe(input);
  return input;
}

// 点赞：用户点了 3 次（动作引发）
for (let i = 0; i < 3; i++) observe("POST graphql FavoriteTweet", "action", { label: "user click button[Like]", body: { variables: { tweet_id: "1" } }, text: "{\"data\":{\"favorite_tweet\":\"Done\"}}", rid: "d:9" });
// 时间线：页面加载期发了 2 次、轮询 4 次；agent 的动作引发 1 次
for (let i = 0; i < 2; i++) observe("GET graphql HomeTimeline", "load", { query: { variables: "{\"count\":20,\"cursor\":\"c\"}" }, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
const homeQuery = { variables: "{\"count\":20,\"cursor\":\"c\"}" };
for (let i = 0; i < 4; i++) observe("GET graphql HomeTimeline", "idle", { query: homeQuery, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
observe("GET graphql HomeTimeline", "action", { win: "debug-ab12", label: "agent cmd click x", query: homeQuery, text: "{\"data\":{\"home\":{\"a\":1,\"b\":2}}}" });
// 失败的请求计数，但不当样本
const failed = observe("GET graphql HomeTimeline", "idle", { status: 500, query: homeQuery });
// 重放不算接口的使用情况
const replay = observe("POST graphql FavoriteTweet", "action", { label: "user click button[Like]", body: { variables: { tweet_id: "1" } }, text: "{\"data\":{\"favorite_tweet\":\"Done\"}}", rid: "d:9" });
index.observe({ ...replay, row: { ...replay.row, requestType: "replay" } });

let snap = index.snapshot(SITE);
const like = snap.endpoints.find((e) => e.key === "POST graphql FavoriteTweet")!;
const home = snap.endpoints.find((e) => e.key === "GET graphql HomeTimeline")!;
assert.equal(like.userTriggered, 4, "用户动作引发的次数（含上面多观察的那一次，不含重放）");
assert.equal(like.onLoad, 0);
assert.equal(like.lastCause, "user click button[Like]");
assert.deepEqual(like.variables, ["tweet_id"]);
assert.equal(like.shape, "data.favorite_tweet");
assert.equal(like.replayable, true, "原始请求还在内存里");
assert.equal(home.onLoad, 2); assert.equal(home.idle, 5); assert.equal(home.agentTriggered, 1); assert.equal(home.userTriggered, 0);
assert.equal(home.count, 8);
assert.deepEqual(home.variables, ["variables.count", "variables.cursor"]);
assert.match(home.shape!, /^data\.home\.\{a,b\}$/);
assert.equal(home.replayable, false, "没有原始请求就不能直接重放");
assert.equal(like.task, null);

// 样本：每个接口最近 5 个成功请求，受保护；失败的不是样本
assert.equal(home.samples.length, SAMPLES_PER_ENDPOINT);
assert.ok(home.samples.every((s) => s.available));
const keep = index.protect(SITE);
for (const s of home.samples) assert.ok(keep.has(s.file) && keep.has(s.body!), "样本的请求文件和响应体受保护");
assert.ok(!keep.has(failed.relFile), "失败的请求不受保护");

// task 覆盖：文件头 @endpoint 和接口的 key 一致就算覆盖
covered = new Map([["POST graphql FavoriteTweet", "like-tweet"]]);
snap = index.snapshot(SITE);
assert.equal(snap.endpoints.find((e) => e.key === "POST graphql FavoriteTweet")!.task, "like-tweet");
assert.equal(snap.endpoints.find((e) => e.key === "GET graphql HomeTimeline")!.task, null);

// 文件被淘汰了：样本标为不可用，而不是留一个悬空指针
const gone = home.samples[0]!;
fs.rmSync(path.join(dir, SITE, "log", gone.file));
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
reborn.observe({ ...observe("GET graphql HomeTimeline", "idle"), row: { seq: 999, t: 1, win: "user", src: "page", tab: 5, type: "request", method: "GET", endpoint: "GET graphql HomeTimeline", phase: "idle", status: 200, file: "000001/000999_GET_x.json" } });
assert.equal(reborn.snapshot(SITE).endpoints.find((e) => e.key === "GET graphql HomeTimeline")!.count, 9, "读回后接着计数");

console.log("endpoints.selfcheck ok");
