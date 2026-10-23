import fs from "node:fs";
const ctl = async (op, o = {}) => (await (await fetch("http://127.0.0.1:8766/do", { method: "POST", body: JSON.stringify({ op, ...o }) })).json());
const rounds = Number(process.argv[2] ?? 12), out = [];
const kinds = ["点击页面空白处", "按一个字母键", "滚一下滚轮", "只把鼠标移动一下"];
for (let i = 0; i < rounds; i++) {
  const k = kinds[i % kinds.length];
  await ctl("eval", { expr: `__setStatus(${JSON.stringify(`E4 第${i + 1}/${rounds}轮：${k}`)})` });
  const r = await ctl("e4round", { timeoutMs: 20000 });
  out.push({ asked: k, ...r }); console.log(i + 1, k, JSON.stringify(r.timeout ? r : { type: r.human.type, latencyMs: +r.human.latencyMs.toFixed(2), agentRejected: r.agentAfter.rejected }));
  await new Promise((r) => setTimeout(r, 1500));
}
await ctl("eval", { expr: "__setStatus('E4 完成')" });
fs.writeFileSync(new URL("./out/e4.json", import.meta.url), JSON.stringify(out, null, 1));
