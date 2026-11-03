// request 的 inherit：内存里没有可继承的头时，自动打开站点首页让页面自己发请求，只试一次；有了就直接抄。
// run 输出的「已发出的 write 请求」：查询用的 POST 不算，写请求按 endpoint 计数（漏了 agent 就不知道自己真发了什么）。用最小的假依赖。
import assert from "node:assert/strict";
import { RunHost, Session } from "./host.ts";
import { RawStore } from "../journal/raw.ts";

const raw = new RawStore();
const sent: Array<{ url: string; headers: Record<string, string> }> = [];
const gotos: string[] = [];
const link = {
  request: async (name: string, args: Record<string, unknown>) => {
    if (name === "goto") {
      gotos.push(String(args.url));
      // 页面加载时自己发了个带 auth 头的请求，录制端把它放进了内存
      raw.put(1, `r${gotos.length}`, { method: "GET", url: "https://api.example.com/me", headers: { authorization: "Bearer REAL", "x-csrf-token": "c1", accept: "*/*" }, body: null, page: "https://api.example.com/", t: Date.now() });
      return { url: String(args.url), title: "t", loaded: true };
    }
    if (name === "call") {
      const req = (args.args as Array<{ url: string; headers: Record<string, string> }>)[0]!;
      if (args.fn === "replay") sent.push({ url: req.url, headers: req.headers });
      return { v: { ok: true, status: 200, ct: "application/json", size: 2, text: "{}", ms: 1 } };
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

await host.op(s, "request", { url: "https://api.example.com/v1/x" });
assert.deepEqual(gotos, ["https://api.example.com/"], "内存里没有可继承的头：先打开首页");
assert.equal(sent[0]!.headers.authorization, "Bearer REAL", "抄到了页面自己发的 authorization");
assert.equal(sent[0]!.headers["x-csrf-token"], "c1");
await host.op(s, "request", { url: "https://api.example.com/v1/y", headers: { "x-csrf-token": "mine" } });
assert.equal(gotos.length, 1, "有了就直接抄，不再打开首页");
assert.equal(sent[1]!.headers["x-csrf-token"], "mine", "action 里显式写的头优先");

host.watchWrites(s.key);
await host.op(s, "request", { url: "https://api.example.com/v1/listItems", method: "POST", json: { page: 1 } });
await host.op(s, "request", { url: "https://api.example.com/v1/save", method: "POST", json: { text: "hi" } });
await host.op(s, "request", { url: "https://api.example.com/v1/save", method: "POST", json: { text: "again" } });
await host.op(s, "request", { url: "https://api.example.com/v1/z" });
assert.deepEqual(host.takeWrites(s.key), ["POST /v1/save ×2"], "查询用的 POST 和 GET 不算 write");
assert.deepEqual(host.takeWrites(s.key), [], "取过就停止统计");

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
