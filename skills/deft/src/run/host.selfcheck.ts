// request 的 inherit：内存里没有可继承的头时，自动打开站点首页让页面自己发请求，只试一次；有了就直接抄。
// 试运行打印给 agent 的内容要脱敏（token 不能出现在输出里）。用最小的假依赖。
import assert from "node:assert/strict";
import { RunHost, Session } from "./host.ts";
import { RawStore } from "../journal/raw.ts";
import { Sanitizer } from "../journal/sanitize.ts";

const raw = new RawStore();
const sent: Array<{ url: string; headers: Record<string, string> }> = [];
const gotos: string[] = [];
const link = {
  request: async (name: string, args: Record<string, unknown>) => {
    if (name === "goto") {
      gotos.push(String(args.url));
      // 页面加载时自己发了个带身份头的请求，录制端把它放进了内存
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

const real = new Sanitizer("k");
const dryHost = new RunHost({ link, win, ingest: { ...ingest, sanitizer: real }, raw } as never);
const d = new Session("r-20261101-120001");
d.dry = true;
await dryHost.op(d, "request", { url: "https://api.example.com/v1/save?access_token=tok_SECRET_1", method: "POST", json: { token: "tok_SECRET_2", text: "hi" } });
assert.equal(sent.length, 2, "试运行不真发写请求");
assert.ok(!d.dryLog.join("").includes("tok_SECRET"), `打印给 agent 的试运行内容已脱敏：${d.dryLog.join("")}`);
assert.match(d.dryLog[0]!, /"text":"hi"/);
await dryHost.op(d, "request", { url: "https://api.example.com/v1/list", method: "POST", json: { page: 1 }, readOnly: true });
assert.equal(sent.length, 3, "试运行里标了 readOnly 的查询 POST 照常发");
assert.equal(d.dryLog.length, 1);

// waitRequest：只拿登记之后、本窗口里方法和接口对得上的那一个；别的窗口、别的接口、登记之前的都不算（拿错了会静默返回错误的数据）
let emit: (r: Record<string, unknown>) => void = () => {};
const wHost = new RunHost({ link, win, ingest: { ...ingest, onRequest: (fn: typeof emit) => { emit = fn; return () => {}; } }, raw } as never);
const w = new Session("w-20261102-120000");
const req = (win: string, method: string, url: string, body: string) => ({ seq: 1, win, tab: 1, method, url, endpoint: `${method} ${new URL(url).pathname}`, status: 200, body });
emit(req(w.key, "POST", "https://a.com/api/list", "登记之前的"));
const { id } = await wHost.op(w, "waitStart", { endpoint: "POST /api/list" }) as { id: number };
emit(req("other-window", "POST", "https://a.com/api/list", "别的窗口的"));
emit(req(w.key, "GET", "https://a.com/api/list", "方法不对"));
emit(req(w.key, "POST", "https://a.com/api/other", "接口不对"));
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
