// 本机 hub：转发 ctl 命令给扩展（长轮询），收扩展事件，并托管探针页。
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname), OUT = path.join(DIR, "out");
let nextId = 0; const queue = [], waiters = [], results = new Map();
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
http.createServer((req, res) => {
  const body = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") { res.end(); return; }
  if (req.url === "/cmd") { // 扩展长轮询
    const deliver = (c) => res.end(JSON.stringify(c));
    if (queue.length) return deliver(queue.shift());
    const w = deliver; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res.end("null"); } }, 20000); return;
  }
  if (req.url === "/res") return void body().then((b) => { const { id, result } = JSON.parse(b); results.get(id)?.(result); results.delete(id); res.end("ok"); });
  if (req.url === "/ev") return void body().then((b) => { fs.appendFileSync(path.join(OUT, "ext-events.jsonl"), b.split("\n").filter(Boolean).map((l) => l).join("\n") + "\n"); res.end("ok"); });
  if (req.url === "/do") return void body().then((b) => { const cmd = { ...JSON.parse(b), id: ++nextId }; const p = new Promise((r) => { results.set(cmd.id, r); setTimeout(() => r({ error: "timeout (extension not connected?)" }), 120000); }); const w = waiters.shift(); w ? w(cmd) : queue.push(cmd); p.then((r) => res.end(JSON.stringify(r))); });
  res.setHeader("content-type", "text/html"); res.end(fs.readFileSync(path.join(DIR, "probe.html")));
}).listen(8766, "127.0.0.1", () => console.log("hub on 8766"));
