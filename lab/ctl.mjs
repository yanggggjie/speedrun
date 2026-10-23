import fs from "node:fs";
const token = (() => { try { return fs.readFileSync(new URL("./out/hub-token", import.meta.url), "utf8").trim(); } catch { return ""; } })();
const [op, json] = process.argv.slice(2);
const r = await fetch("http://127.0.0.1:8766/do", { method: "POST", headers: { "x-tcr-token": token }, body: JSON.stringify({ op, ...(json ? JSON.parse(json) : {}) }) });
console.log(await r.text());
