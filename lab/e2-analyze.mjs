import fs from "node:fs";
const { start, ledger } = JSON.parse(fs.readFileSync(new URL("./out/ledger-e2.json", import.meta.url)));
const rows = fs.readFileSync(new URL("./out/events.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.wall >= start);
const truth = (e) => e.type === "pointerdown" ? Math.abs(e.pressure - 0.123) < 1e-3 : e.type === "keydown" ? /^[Q7]$/.test(e.key) : e.type === "wheel" ? e.dx === 7 : null;
const durs = ledger.map((c) => c.t1 - c.t0).sort((a, b) => a - b);
console.log("cmd duration ms p50/p95/max:", durs[durs.length >> 1].toFixed(1), durs[Math.floor(durs.length * .95)].toFixed(1), durs.at(-1).toFixed(1));
for (const [pre, post] of [[5, 30], [5, 10], [2, 5]]) {
  const stat = {};
  for (const e of rows) {
    const ta = truth(e); if (ta === null) continue;
    const kindOk = (c) => ({ pointerdown: "cdp.mouse", keydown: "cdp.key", wheel: "cdp.wheel" })[e.type] === c.kind;
    const guess = ledger.some((c) => e.wall >= c.t0 - pre && e.wall <= c.t1 + post && kindOk(c));
    const s = (stat[e.type] ??= { human: 0, agent: 0, "human→agent": 0, "agent→human": 0 });
    s[ta ? "agent" : "human"]++; if (!ta && guess) s["human→agent"]++; if (ta && !guess) s["agent→human"]++;
  }
  console.log(`window [-${pre},+${post}]ms, matched by event kind:`, JSON.stringify(stat));
}
// 鼠标：水印 vs 对账；其它事件里人的 pointermove 数量
const mv = rows.filter((e) => e.type === "pointermove").length;
console.log("pointermove (all human; agent sends none unless asked):", mv);
