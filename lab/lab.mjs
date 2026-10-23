// tcr 原型 A 实验台：独立 Chrome（临时 profile）+ 探针页 + CDP 驱动。不依赖扩展。
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "out");
const PORT = 8765, DBG = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cmd = process.argv[2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();

async function cdpPage() {
  const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
  const t = list.find((x) => x.type === "page" && x.url.startsWith(`http://127.0.0.1:${PORT}`));
  if (!t) throw new Error("probe page not found");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => d.error ? rej(new Error(d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

if (cmd === "up") {
  fs.rmSync(path.join(OUT, "events.jsonl"), { force: true });
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/ev") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const recvAt = Date.now();
        for (const e of JSON.parse(b)) fs.appendFileSync(path.join(OUT, "events.jsonl"), JSON.stringify({ ...e, recvAt }) + "\n");
        res.end("ok");
      }); return;
    }
    res.setHeader("content-type", "text/html"); res.end(fs.readFileSync(path.join(DIR, "probe.html")));
  }).listen(PORT, "127.0.0.1");
  const prof = fs.mkdtempSync("/tmp/tcr-lab-");
  spawn(CHROME, [`--user-data-dir=${prof}`, `--remote-debugging-port=${DBG}`, "--no-first-run", "--no-default-browser-check", "--window-position=80,80", "--window-size=900,700", `http://127.0.0.1:${PORT}/`], { stdio: "ignore" });
  console.log("up", prof);
  await new Promise(() => {});
}

if (cmd === "agent") {
  // 对每种 agent 注入方式各做 N 次，写 ledger（含 cmd_id、发送/确认时间、目标坐标）。
  const N = Number(process.argv[3] ?? 5);
  const p = await cdpPage();
  const ledger = []; let cid = 0;
  const rect = async (sel) => (await p.send("Runtime.evaluate", { expression: `(()=>{const r=document.querySelector('${sel}').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`, returnByValue: true })).result.value;
  const log = async (kind, target, fn) => { const c = ++cid; const t0 = wallNow(); await fn(); ledger.push({ cmd: c, kind, target, t0, t1: wallNow() }); await sleep(120); };
  for (let i = 0; i < N; i++) {
    for (const sel of ["#b1", "#b2"]) {
      const { x, y } = JSON.parse(await rect(sel));
      await log("cdp.mouse", sel, async () => {
        await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      });
      await log("dom.click", sel, () => p.send("Runtime.evaluate", { expression: `document.querySelector('${sel}').click()` }));
    }
    const { x, y } = JSON.parse(await rect("#t"));
    await log("cdp.focus", "#t", async () => { await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }); await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); });
    await log("cdp.key", "#t", async () => { for (const ch of "ab") { await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: "Key" + ch.toUpperCase(), text: ch }); await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key" + ch.toUpperCase() }); } });
    await log("cdp.insertText", "#t", () => p.send("Input.insertText", { text: "xy" }));
    const s = JSON.parse(await rect("#s"));
    await log("cdp.wheel", "#s", () => p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: s.x, y: s.y, deltaX: 0, deltaY: 40 }));
    await log("dom.value", "#t", () => p.send("Runtime.evaluate", { expression: `(()=>{const t=document.querySelector('#t');t.value='dom';t.dispatchEvent(new Event('input',{bubbles:true}))})()` }));
  }
  await sleep(600);
  fs.writeFileSync(path.join(OUT, "ledger.json"), JSON.stringify(ledger));
  console.log("ledger", ledger.length);
  p.close();
}

if (cmd === "mark") {
  // 在 events.jsonl 里插一个分隔符，后面的事件归入 label（用于区分 human 阶段）。
  const p = await cdpPage();
  await p.send("Runtime.evaluate", { expression: `__setStatus(${JSON.stringify(process.argv[3] ?? "")})` });
  fs.appendFileSync(path.join(OUT, "marks.jsonl"), JSON.stringify({ label: process.argv[3], at: Date.now() }) + "\n");
  p.close();
}

if (cmd === "ignore") {
  const p = await cdpPage();
  await p.send("Input.setIgnoreInputEvents", { ignore: process.argv[3] === "on" });
  console.log("ignore", process.argv[3]);
  p.close();
}
