// request 的 inherit：内存里没有可继承的头时，自动打开站点首页让页面自己发请求，只试一次；有了就直接抄。
// 试运行打印给 agent 的内容要脱敏（token 不能出现在输出里），原文只留给 verify --dry 比对。用最小的假依赖。
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
console.log("host selfcheck ok");
