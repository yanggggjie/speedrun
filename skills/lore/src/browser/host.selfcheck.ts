// request 的请求头：只从这次窗口里页面发过的请求抄（别的窗口的不能用）；同一个 endpoint 整组抄；别的 endpoint 只抄值都一样的头，每次都变的不跨 endpoint 抄（抄错了请求会被拒或静默带错头）；窗口关掉就清掉原始请求。
// run 输出的「已发出的非 GET 请求」：GET 不算，其余按 endpoint 计数，不判断有没有副作用（漏了 agent 就不知道自己真发了什么）。用最小的假依赖。
import assert from "node:assert/strict";
import { RunHost, Session } from "./host.ts";
import { RawStore } from "../record/raw.ts";

const raw = new RawStore();
const sent: Array<{ url: string; headers: Record<string, string> }> = [];
const link = {
  request: async (name: string, args: Record<string, unknown>) => {
    if (name === "goto") return { url: String(args.url), title: "t", loaded: true };
    if (name === "call") {
      const req = (args.args as Array<{ url: string; headers: Record<string, string> }>)[0]!;
      if (args.fn === "fetch") sent.push({ url: req.url, headers: req.headers });
      return { v: { ok: true, status: req.url.includes("denied") ? 403 : 200, ct: "application/json", size: 2, text: "{}", ms: 1 } };
    }
    return {};
  },
};
const win = { acquire: async () => 1, release: () => {}, activate: async () => {}, moved: () => {} };
const ingest = {
  beginCmd: () => ({ seq: 1, seg: 1 }), endCmd: () => {}, flush: () => {},
  sanitizer: { url: (u: string) => ({ bareUrl: u.split("?")[0], query: {} }), body: (b: unknown) => b },
};
const host = new RunHost({ link, win, ingest, raw } as never);
const s = new Session("r-20261101-120000");
let n = 0;
const page = (key: string, endpoint: string, url: string, headers: Record<string, string>): void => { raw.put(1, `d:${++n}`, { win: key, doc: "d", endpoint, method: "GET", url, headers: { accept: "*/*", ...headers }, body: null, page: "https://www.example.com/", t: Date.now() }); };
// 别的窗口里有别的 token：不能抄
page("other-20261101-110000", "GET /api/me", "https://api.example.com/api/me", { authorization: "Bearer OTHER" });
// 这次窗口：页面加载时发了 /me 和 /feed，authorization 都一样，x-sign 每次都变
page(s.key, "GET /api/me", "https://api.example.com/api/me", { authorization: "Bearer REAL", "x-sign": "s1", "x-zse-93": "v1", "x-zse-96": "z1" });
page(s.key, "GET /api/feed", "https://api.example.com/api/feed", { authorization: "Bearer REAL", "x-sign": "s2", "x-zse-93": "v1", "x-zse-96": "z2" });
page(s.key, "GET /api/feed", "https://api.example.com/api/feed?p=2", { authorization: "Bearer REAL", "x-sign": "s3", "x-zse-93": "v1", "x-zse-96": "z3" });

await host.op(s, "request", { url: "https://api.example.com/api/feed?p=3" });
assert.equal(sent[0]!.headers.authorization, "Bearer REAL", "同一个 endpoint：整组抄它最近一次的");
assert.equal(sent[0]!.headers["x-sign"], "s3", "同一个 endpoint 的签名也抄（签名和 endpoint 绑定的站点靠这个）");
const other = await host.op(s, "request", { url: "https://api.example.com/api/save", method: "POST", json: { a: 1 } }) as { source: { skipped: string[] } };
assert.equal(sent[1]!.headers.authorization, "Bearer REAL", "别的 endpoint：值都一样的头抄这次窗口里的，不抄别的窗口的");
assert.equal(sent[1]!.headers["x-sign"], undefined, "每次都变的头不跨 endpoint 抄");
assert.equal(sent[1]!.headers["x-zse-93"], undefined, "签名族的另一半（值不变的 x-zse-93）也不抄：只带一半会被拒");
assert.deepEqual(other.source.skipped.sort(), ["x-sign", "x-zse-93", "x-zse-96"]);
await host.op(s, "request", { url: "https://api.example.com/api/y", headers: { authorization: "mine" } });
assert.equal(sent[2]!.headers.authorization, "mine", "action 里显式写的头优先");
await host.op(s, "request", { url: "https://api.example.com/api/denied" });
assert.match(host.takeRejected(s.key) ?? "", /GET \/api\/denied 被拒（403）：抄了 .*authorization.*；没抄 x-sign.*（这次窗口里每次都变.*waitRequest/, "被拒时说清楚抄了什么、没抄什么、下一步");
await host.end(s);
assert.equal(raw.inWindow(s.key).length, 0, "窗口关掉：这个窗口的原始请求清掉");
assert.equal(raw.inWindow("other-20261101-110000").length, 1, "别的窗口的不动");
sent.length = 0;
const fresh = new Session("r-20261101-130000");
await host.op(fresh, "request", { url: "https://api.example.com/api/me" });
assert.equal(sent[0]!.headers.authorization, undefined, "这次窗口里没有请求：只靠 cookie，不用别的窗口的");
const t0 = Date.now();
await host.op(fresh, "request", { url: "https://api.example.com/api/me" });
assert.ok(Date.now() - t0 < 1000, "没打开过页面：不等页面发请求（只靠 cookie 的站点不被拖慢）");

const s2 = new Session("r-20261101-140000");
host.watchSent(s2.key);
await host.op(s2, "request", { url: "https://api.example.com/v1/listItems", method: "POST", json: { page: 1 } });
await host.op(s2, "request", { url: "https://api.example.com/v1/save", method: "POST", json: { text: "hi" } });
await host.op(s2, "request", { url: "https://api.example.com/v1/save", method: "POST", json: { text: "again" } });
await host.op(s2, "request", { url: "https://api.example.com/v1/z" });
assert.deepEqual(host.takeSent(s2.key), ["POST /v1/listItems ×1", "POST /v1/save ×2"], "只看方法：查询用的 POST 也列，GET 不列");
assert.deepEqual(host.takeSent(s2.key), [], "取过就停止统计");

// quiet：页面安静、记录都到了就立刻返回；到不齐也不超过上限（每步之后都等它，卡住就拖慢每一步）
let arrive = true;
const qHost = new RunHost({ link: { request: async (name: string, args: Record<string, unknown>) => (name === "call" && args.fn === "quiet" ? { v: { settled: true, waitedMs: 5, d: "doc", n: 4 } } : {}) }, win, ingest: { ...ingest, waitDelivered: (_t: number, _d: string, _n: number, ms: number) => new Promise((r) => (arrive ? r(true) : setTimeout(() => r(false), ms))) }, raw } as never);
const q = new Session("q-20261101-120000"); q.tab = 1;
let t1 = Date.now();
assert.equal((await qHost.quiet(q, 2000)).settled, true); assert.ok(Date.now() - t1 < 500, "到齐了立刻返回");
arrive = false; t1 = Date.now();
assert.equal((await qHost.quiet(q, 300)).settled, false); assert.ok(Date.now() - t1 < 1000, "到不齐不超过上限");

// waitRequest：只拿登记之后、本窗口里方法和 endpoint 对得上的那一个；别的窗口、别的 endpoint、登记之前的都不算（拿错了会静默返回错误的数据）
let emit: (r: Record<string, unknown>) => void = () => {};
const wHost = new RunHost({ link, win, ingest: { ...ingest, onRequest: (fn: typeof emit) => { emit = fn; return () => {}; } }, raw } as never);
const w = new Session("w-20261102-120000");
const req = (win: string, method: string, url: string, body: string) => ({ seq: 1, win, tab: 1, method, url, endpoint: `${method} ${new URL(url).pathname}`, status: 200, body });
emit(req(w.key, "POST", "https://a.com/api/list", "登记之前的"));
const { id } = await wHost.op(w, "waitStart", { endpoint: "POST /api/list" }) as { id: number };
emit(req("other-window", "POST", "https://a.com/api/list", "别的窗口的"));
emit(req(w.key, "GET", "https://a.com/api/list", "方法不对"));
emit(req(w.key, "POST", "https://a.com/api/other", "endpoint 不对"));
emit(req(w.key, "POST", "https://a.com/api/list?x=1", "要的这个"));
emit(req(w.key, "POST", "https://a.com/api/list", "之后的"));
assert.equal((await wHost.op(w, "waitEnd", { id }) as { text: string }).text, "要的这个");
const { id: id2 } = await wHost.op(w, "waitStart", { endpoint: "GET /api/items/:id" }) as { id: number };
emit(req(w.key, "GET", "https://a.com/api/items/42", "带 id 的"));
assert.equal((await wHost.op(w, "waitEnd", { id: id2 }) as { text: string }).text, "带 id 的", ":id 匹配一段");
const { id: id3 } = await wHost.op(w, "waitStart", { endpoint: "POST /api/none" }) as { id: number };
emit(req(w.key, "POST", "https://a.com/api/x", ""));
await assert.rejects(wHost.op(w, "waitEnd", { id: id3, timeout: 50 }), /没等到 POST \/api\/none.*POST \/api\/x/, "超时报错并列出实际发出的请求");
console.log("host selfcheck ok");
