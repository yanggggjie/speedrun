// request 的 inherit：内存里没有可继承的头时，自动打开站点首页让页面自己发请求，只试一次；有了就直接抄。用最小的假依赖。
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
const s = new Session();

await host.op(s, "request", { url: "https://api.example.com/v1/x" });
assert.deepEqual(gotos, ["https://api.example.com/"], "内存里没有可继承的头：先打开首页");
assert.equal(sent[0]!.headers.authorization, "Bearer REAL", "抄到了页面自己发的 authorization");
assert.equal(sent[0]!.headers["x-csrf-token"], "c1");
await host.op(s, "request", { url: "https://api.example.com/v1/y", headers: { "x-csrf-token": "mine" } });
assert.equal(gotos.length, 1, "有了就直接抄，不再打开首页");
assert.equal(sent[1]!.headers["x-csrf-token"], "mine", "task 里显式写的头优先");
console.log("host selfcheck ok");
