import fs from "node:fs";
const rd = (f) => fs.readFileSync(new URL(`./out/${f}`, import.meta.url), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ev = rd("events.jsonl"), ledger = JSON.parse(fs.readFileSync(new URL("./out/ledger.json", import.meta.url)));
const marks = fs.existsSync(new URL("./out/marks.jsonl", import.meta.url)) ? rd("marks.jsonl") : [];
const ours = ev.filter((e) => e.target !== "HTML" || true);
// 按 ledger 窗口归因：事件 wall 落在 [t0-5, t1+50] 内 → agent
const src = (e) => ledger.find((c) => e.wall >= c.t0 - 5 && e.wall <= c.t1 + 50);
const rows = {};
for (const e of ev) {
  if (!["pointerdown", "mousedown", "click", "keydown", "wheel", "input"].includes(e.type)) continue;
  const c = src(e);
  const k = `${c ? c.kind : "other(human?)"} | ${e.type}`;
  (rows[k] ??= []).push(e);
}
const fmt = (a) => [...new Set(a)].slice(0, 4).join(",");
console.log("source | event  n  trusted  screen-client(x,y)  ptype  pid  pressure  w×h  sc  dy");
for (const [k, a] of Object.entries(rows).sort()) {
  console.log(k.padEnd(28), String(a.length).padStart(3), fmt(a.map((e) => e.trusted)).padEnd(6),
    fmt(a.map((e) => `${e.scx - e.cx - e.win.sx},${e.scy - e.cy - e.win.sy}`)).padEnd(22),
    fmt(a.map((e) => e.ptype)), fmt(a.map((e) => e.pid)), fmt(a.map((e) => e.pressure)), fmt(a.map((e) => `${e.w}x${e.h}`)), fmt(a.map((e) => JSON.stringify(e.sc))), fmt(a.map((e) => e.dy)));
}
const lat = ledger.map((c) => { const first = ev.find((e) => e.wall >= c.t0 - 5); return first ? first.wall - c.t0 : null; }).filter((x) => x != null);
console.log("\nledger cmds:", ledger.length, " page events:", ev.length, " first-event latency after cmd start (ms) p50/max:", lat.sort((a, b) => a - b)[lat.length >> 1]?.toFixed(1), Math.max(...lat).toFixed(1));
console.log("marks:", marks);
