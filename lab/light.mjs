// 轻量层实验：Chrome for Testing + lab/ext-light（无 chrome.debugger），同时用 CDP 记录 ground truth 对比。
// 用法：先 `node lab/hub.mjs`（后台），再 `node lab/light.mjs [fixture|sites|all]`
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const DIR = path.dirname(new URL(import.meta.url).pathname), OUT = path.join(DIR, "out"); fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || `${os.homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const DBG = 9444, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = process.argv[2] || "all";

// ---------- fixture servers ----------
const page = (body) => `<!doctype html><meta charset=utf-8><title>fixture</title>${body}`;
const FIX = page(`
<h1>Fixture</h1>
<input id=q placeholder="search"><button id=b-fetch>fetch json</button><button id=b-xhr>xhr</button><button id=b-post>post</button>
<button id=b-stream>stream</button><button id=b-big>big</button><button id=b-bin>binary</button><button id=b-req>Request obj</button>
<button id=b-worker>worker fetch</button><button id=b-beacon>beacon</button><button id=b-spa>spa nav</button><button id=b-late>late dom</button>
<button id=b-redir>redirect</button><button id=b-err>404</button>
<a href="/other">link</a><div id=host></div><iframe id=same src="/frame" width=300 height=80></iframe><iframe id=cross src="http://localhost:8768/frame" width=300 height=80></iframe>
<script>
const $=(i)=>document.getElementById(i);
$("b-fetch").onclick=()=>fetch("/api/json?x=1").then(r=>r.json());
$("b-xhr").onclick=()=>{const x=new XMLHttpRequest();x.open("GET","/api/json?x=2");x.send()};
$("b-post").onclick=()=>fetch("/api/echo",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({a:1,secret:"s3"})});
$("b-stream").onclick=()=>fetch("/api/stream").then(r=>r.text());
$("b-big").onclick=()=>fetch("/api/big").then(r=>r.text());
$("b-bin").onclick=()=>fetch("/api/bin").then(r=>r.arrayBuffer());
$("b-req").onclick=()=>fetch(new Request("/api/json?x=req",{headers:{"x-a":"1"}}));
$("b-worker").onclick=()=>{const w=new Worker("/worker.js");w.onmessage=()=>w.terminate()};
$("b-beacon").onclick=()=>navigator.sendBeacon("/api/echo","ping");
$("b-spa").onclick=()=>{history.pushState({},"","/spa/2");document.title="spa 2";fetch("/api/json?x=spa")};
$("b-late").onclick=()=>setTimeout(()=>{const b=document.createElement("button");b.textContent="late button";document.body.append(b)},300);
$("b-redir").onclick=()=>fetch("/api/redir");
$("b-err").onclick=()=>fetch("/api/nope");
const sr=$("host").attachShadow({mode:"open"});sr.innerHTML="<button id=sb>shadow button</button>";
sr.getElementById("sb").onclick=()=>fetch("/api/json?x=shadow");
fetch("/api/json?x=onload");
</script>`);
const FRAME = page(`<button id=fb>frame btn</button><script>document.getElementById("fb").onclick=()=>fetch("http://127.0.0.1:8767/api/json?x=frame",{mode:"cors"});fetch("http://127.0.0.1:8767/api/json?x=frameload",{mode:"cors"})</script>`);
const mk = (port) => http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  const j = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(o)); };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(FIX); }
  if (u.pathname === "/frame") { res.writeHead(200, { "content-type": "text/html" }); return res.end(FRAME); }
  if (u.pathname === "/other") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page("<h1>other</h1>")); }
  if (u.pathname.startsWith("/spa")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(FIX); }
  if (u.pathname === "/worker.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(`fetch("/api/json?x=worker").then(()=>postMessage(1))`); }
  if (u.pathname === "/api/json") return j({ ok: true, q: Object.fromEntries(u.searchParams), items: Array.from({ length: 5 }, (_, i) => ({ id: i, name: "n" + i })) });
  if (u.pathname === "/api/echo") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => j({ echo: b })); return; }
  if (u.pathname === "/api/stream") { res.writeHead(200, { "content-type": "text/plain", ...cors }); let n = 0; const iv = setInterval(() => { res.write("chunk" + n + "\n"); if (++n === 5) { clearInterval(iv); res.end(); } }, 80); return; }
  if (u.pathname === "/api/big") { res.writeHead(200, { "content-type": "application/json", ...cors }); return res.end(JSON.stringify({ blob: "x".repeat(1_000_000) })); }
  if (u.pathname === "/api/bin") { res.writeHead(200, { "content-type": "application/octet-stream", ...cors }); return res.end(Buffer.alloc(5000, 7)); }
  if (u.pathname === "/api/redir") { res.writeHead(302, { location: "/api/json?x=redirected", ...cors }); return res.end(); }
  res.writeHead(404, { "content-type": "application/json", ...cors }); res.end('{"error":"nope"}');
}).listen(port, "127.0.0.1");
mk(8767); mk(8768);

// ---------- Chrome + CDP ----------
const udd = fs.mkdtempSync(path.join(os.tmpdir(), "tcr-light-"));
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${udd}`, `--remote-debugging-port=${DBG}`, `--load-extension=${path.join(DIR, "ext-light")}`, "--no-first-run", "--no-default-browser-check", "--host-resolver-rules=MAP localhost 127.0.0.1", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
let ver; for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json(); } catch { await sleep(200); } }
if (!ver) throw new Error("chrome did not start");
console.log("browser", ver.Browser);
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let mid = 0; const pend = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const [res, rej] = pend.get(d.id); pend.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } else listeners.forEach((f) => f(d)); };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++mid; pend.set(id, [res, rej]); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const gt = new Map(); // ground truth: sessionId|requestId -> record
const sessions = new Map(); // sessionId -> {type,url}
let bodyJobs = [];
listeners.push((d) => {
  const sid = d.sessionId;
  if (d.method === "Target.attachedToTarget") { const s = d.params.sessionId; sessions.set(s, d.params.targetInfo); setup(s).catch(() => {}); }
  if (!sid) return; const p = d.params, key = sid + "|" + p.requestId;
  if (d.method === "Network.requestWillBeSent") gt.set(key, { sid, targetType: sessions.get(sid)?.type, id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, postData: p.request.postData, t: p.wallTime * 1000 });
  if (d.method === "Network.responseReceived" && gt.has(key)) { const r = gt.get(key); r.status = p.response.status; r.mime = p.response.mimeType; r.sw = p.response.fromServiceWorker; }
  if (d.method === "Network.loadingFinished" && gt.has(key)) { const r = gt.get(key); r.size = p.encodedDataLength; if (["Fetch", "XHR"].includes(r.type)) bodyJobs.push(send("Network.getResponseBody", { requestId: p.requestId }, sid).then((b) => { r.body = b.base64Encoded ? "[b64 " + b.body.length + "]" : b.body; }, (e) => { r.bodyErr = e.message; })); }
  if (d.method === "Network.loadingFailed" && gt.has(key)) gt.get(key).failed = p.errorText;
});
async function setup(sid) {
  await send("Network.enable", {}, sid);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
  await send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
sessions.set(S, { type: "page" }); await setup(S); await send("Page.enable", {}, S);
const ev = async (expression, sid = S) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid)).result?.value;
const goto = async (url) => { await send("Page.navigate", { url }, S); await sleep(1500); };
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e&&e.click();return !!e})()`);
const clickShadow = () => ev(`document.getElementById("host").shadowRoot.getElementById("sb").click()`);
const clickIn = (frameSel, sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(frameSel)}).contentDocument?.querySelector(${JSON.stringify(sel)});e&&e.click();return !!e})()`);
const axCount = async () => { const { nodes } = await send("Accessibility.getFullAXTree", {}, S); const R = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "switch", "slider", "spinbutton", "textarea"]); return nodes.filter((n) => !n.ignored && R.has(n.role?.value)).length; };

// ---------- scenarios ----------
const scenarios = [];
if (["fixture", "all"].includes(which)) scenarios.push({ name: "fixture", url: "http://127.0.0.1:8767/", run: async () => {
  await sleep(1500);
  for (const b of ["b-fetch", "b-xhr", "b-post", "b-stream", "b-big", "b-bin", "b-req", "b-worker", "b-beacon", "b-redir", "b-err", "b-late"]) { await click("#" + b); await sleep(450); }
  await clickShadow(); await sleep(400); await clickIn("#same", "#fb"); await sleep(400);
  await click("#b-spa"); await sleep(1000);
} });
if (["sites", "all"].includes(which)) {
  scenarios.push({ name: "wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", run: async () => {
    await sleep(2000); await ev(`document.querySelector("input[name=search]").focus()`);
    for (const ch of "claude") { await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, S); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, S); await sleep(150); }
    await sleep(2500); } });
  scenarios.push({ name: "github-repo", url: "https://github.com/anthropics/anthropic-sdk-python", run: async () => { await sleep(3000); await ev(`window.scrollBy(0,1500)`); await sleep(1500); await ev(`[...document.querySelectorAll("a")].find(a=>/\\/issues$/.test(a.href))?.click()`); await sleep(4000); } });
  scenarios.push({ name: "npm", url: "https://www.npmjs.com/package/ws", run: async () => { await sleep(4000); await ev(`window.scrollBy(0,800)`); await sleep(1500); } });
  scenarios.push({ name: "hn", url: "https://news.ycombinator.com/", run: async () => { await sleep(2500); await ev(`document.querySelector(".athing .titleline a")?.getAttribute("href")`); } });
  scenarios.push({ name: "reddit", url: "https://www.reddit.com/r/programming/", run: async () => { await sleep(5000); await ev(`window.scrollBy(0,2000)`); await sleep(2500); } });
}

fs.rmSync(path.join(OUT, "ext-events.jsonl"), { force: true });
const report = [];
for (const sc of scenarios) {
  console.log("\n=== scenario", sc.name); gt.clear(); bodyJobs = [];
  const mark = Date.now(); await goto(sc.url);
  try { await sc.run(); } catch (e) { console.log("run err", e.message); }
  await sleep(1500); await Promise.allSettled(bodyJobs);
  const ax = await axCount().catch(() => -1); const finalSnap = await ev(`JSON.stringify(window.__tcrSnap?.("final"))`).then((s) => s && JSON.parse(s));
  await sleep(1000); // 等扩展 flush
  const lines = fs.existsSync(path.join(OUT, "ext-events.jsonl")) ? fs.readFileSync(path.join(OUT, "ext-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.t >= mark - 50 && x.t <= Date.now()) : [];
  report.push(analyze(sc.name, [...gt.values()], lines, ax, finalSnap));
}
function norm(u) { try { const x = new URL(u); x.hash = ""; return x.href; } catch { return u; } }
function analyze(name, truth, lines, ax, finalSnap) {
  const net = lines.filter((l) => l.k === "net"), wr = lines.filter((l) => l.k === "wr" && l.tab >= 0), snaps = lines.filter((l) => l.k === "snap"), evs = lines.filter((l) => l.k === "ev");
  const dataReq = truth.filter((r) => ["Fetch", "XHR", "Ping"].includes(r.type) && !r.url.startsWith("data:"));
  const pool = net.map((n) => ({ ...n, used: false })); const rows = [];
  for (const r of dataReq) {
    const m = pool.find((n) => !n.used && n.method === r.method && (norm(n.url) === norm(r.url)) && n.top !== undefined);
    if (m) m.used = true;
    const row = { url: r.url.replace(/^https?:\/\//, "").slice(0, 70), method: r.method, type: r.type, target: r.targetType, cdpStatus: r.status, seen: !!m };
    if (m) { row.lightStatus = m.status; row.bodyMatch = r.body == null ? (m.body == null ? "both-none" : "light-only") : m.body == null ? (m.bodyKind || m.bodyErr || "missing") : m.body === r.body ? "exact" : (m.truncated && r.body.startsWith(m.body) ? "prefix(trunc)" : "DIFF"); row.reqBody = m.reqBody ? "yes" : (r.postData ? "MISSING" : "-"); }
    rows.push(row);
  }
  const extra = pool.filter((n) => !n.used).map((n) => `${n.via} ${n.method} ${n.url.slice(0, 60)}`);
  const lastTop = [...snaps].reverse().find((s) => s.top);
  const rep = {
    name, cdpDataRequests: dataReq.length, lightSeen: rows.filter((r) => r.seen).length, missed: rows.filter((r) => !r.seen).map((r) => `${r.method} ${r.url} [${r.type}/${r.target}]`), extraInLight: extra,
    bodyMatch: rows.reduce((a, r) => (r.bodyMatch && (a[r.bodyMatch] = (a[r.bodyMatch] || 0) + 1), a), {}),
    cdpAllRequests: truth.length, webRequestSeen: wr.length, cdpTypes: count(truth, "type"), wrTypes: count(wr, "type"),
    snapshots: snaps.length, snapBytes: snaps.map((s) => s.bytes), userEvents: evs.length,
    domTopSnapshot: lastTop && { visible: lastTop.interactiveVisible, total: lastTop.interactiveTotal, shownItems: lastTop.items.length, textChars: lastTop.textChars, bytes: lastTop.bytes }, axInteractive: ax, finalSnapVisible: finalSnap?.interactiveVisible,
    rows,
  };
  console.log(JSON.stringify({ ...rep, rows: undefined }, null, 1)); console.table(rows);
  return rep;
}
function count(a, k) { return a.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {}); }
fs.writeFileSync(path.join(OUT, "light-report.json"), JSON.stringify(report, null, 1));
console.log("\nreport -> lab/out/light-report.json"); chrome.kill(); process.exit(0);
