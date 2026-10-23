const [op, json] = process.argv.slice(2);
const r = await fetch("http://127.0.0.1:8766/do", { method: "POST", body: JSON.stringify({ op, ...(json ? JSON.parse(json) : {}) }) });
console.log(await r.text());
