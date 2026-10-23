// E2：agent 与真人同时操作 25 秒。真值：鼠标=force 水印 0.123；键盘=agent 只打 Q/7；滚轮=agent 用 deltaX=7（仅实验用）。
// 被测方法：对账（事件落在某条 ledger 指令的 [t0-5ms, t1+30ms] 窗口内）。
import fs from "node:fs";
const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const t = list.find((x) => x.type === "page" && x.url.includes(":8765"));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e) => send("Runtime.evaluate", { expression: e, returnByValue: true }).then((r) => r.result?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wall = () => performance.timeOrigin + performance.now();
await ev("window.__h=0;addEventListener('pointerdown',e=>{if(e.pressure!==0.123)__h++},true);addEventListener('keydown',e=>{if(!/[Q7]/.test(e.key))__h++},true);addEventListener('wheel',e=>{if(e.deltaX!==7)__h++},true);__setStatus('E2 就绪：请开始随意点击/打字(别打 Q 和 7)/竖向滚动，25 秒')");
console.error("armed, waiting for first human input...");
while (!(await ev("__h"))) await sleep(50);
const start = wall(); const ledger = []; let cid = 0;
const rect = async (s) => JSON.parse(await ev(`(()=>{const r=document.querySelector('${s}').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`));
const log = async (kind, target, fn) => { const c = ++cid; const t0 = wall(); await fn(); ledger.push({ cmd: c, kind, target, t0, t1: wall() }); };
while (wall() - start < 25000) {
  const r = Math.random();
  if (r < 0.4) { const s = Math.random() < 0.5 ? "#b1" : "#b2"; const { x, y } = await rect(s); await log("cdp.mouse", s, async () => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, force: 0.123 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); }); }
  else if (r < 0.7) { await log("cdp.key", "#t", async () => { for (const k of ["Q", "7"]) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k === "Q" ? "KeyQ" : "Digit7", text: k }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k === "Q" ? "KeyQ" : "Digit7" }); } }); }
  else { const { x, y } = await rect("#s"); await log("cdp.wheel", "#s", () => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 7, deltaY: 30 })); }
  await sleep(150 + Math.random() * 450);
}
await sleep(500);
await ev("__setStatus('E2 完成')");
fs.writeFileSync(new URL("./out/ledger-e2.json", import.meta.url), JSON.stringify({ start, ledger }));
ws.close();
const rows = fs.readFileSync(new URL("./out/events.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.wall >= start);
const kinds = { pointerdown: (e) => e.pressure === 0.123, keydown: (e) => /[Q7]/.test(e.key), wheel: (e) => e.dx === 7 };
const stat = {};
for (const e of rows) {
  const truthAgent = e.type === "pointerdown" ? e.pressure === 0.123 : e.type === "keydown" ? /^[Q7]$/.test(e.key) : e.type === "wheel" ? e.dx === 7 : null;
  if (truthAgent === null) continue;
  const guess = ledger.some((c) => e.wall >= c.t0 - 5 && e.wall <= c.t1 + 30);
  const s = (stat[e.type] ??= { human: 0, agent: 0, humanAsAgent: 0, agentAsHuman: 0 });
  s[truthAgent ? "agent" : "human"]++;
  if (!truthAgent && guess) s.humanAsAgent++;
  if (truthAgent && !guess) s.agentAsHuman++;
}
console.log(JSON.stringify(stat, null, 1)); console.log("agent cmds", ledger.length);
