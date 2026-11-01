// 布局升级坏了会静默丢东西：旧日志要删掉，但 endpoints.json 的业务知识、学出来的 action、跨站点的组合一个都不能丢，组合挪进 compose/ 后按名字照样找得到；
// 升级只做一次（再启动不会清掉新样本）。组合放哪由用到的 action 决定。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeTarget, findAction, upgradeLayout } from "./actions.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-actions-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const sitesDir = path.join(home, "sites"), composeDir = path.join(home, "compose");
const write = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
write("sites/a.com/actions/list.js", "/**\n * @status verified\n * @endpoint GET /list\n */\n");
write("sites/a.com/log/000001/timeline.run.jsonl", "{}\n");
write("sites/a.com/debug/debug-ab12/material/manifest.json", "{}");
write("sites/a.com/endpoints.json", JSON.stringify({ site: "a.com", endpoints: [{ key: "GET /list", descriptions: [{ text: "列出条目", from: "run", t: 1 }], samples: [{ seq: 1, file: "000001/000001_GET_x.json" }], replayable: true }] }));
write("sites/b.com/endpoints.json", JSON.stringify({ site: "b.com", endpoints: [{ key: "GET /detail", samples: [] }] }));
write("sites/b.com/actions/detail.js", "/**\n * @endpoint GET /detail\n */\n");
write("sites/ads.example.net/log/000001/timeline.run.jsonl", "{}\n"); // 广告、嵌入页面：只有日志
write("actions/both.js", "// 跨站点\n/**\n * @compose list, detail\n */\nreturn 1;\n");
write("run/list/x.json", "{}");

assert.equal(upgradeLayout(home), true);
assert.ok(!fs.existsSync(path.join(sitesDir, "a.com", "log")) && !fs.existsSync(path.join(sitesDir, "a.com", "debug")) && !fs.existsSync(path.join(home, "run")), "旧日志、旧运行历史删掉");
assert.ok(!fs.existsSync(path.join(sitesDir, "ads.example.net")), "只剩日志的站点目录整个删掉");
const ep = JSON.parse(fs.readFileSync(path.join(sitesDir, "a.com", "endpoints.json"), "utf8")) as { endpoints: Array<{ descriptions: unknown[]; samples: unknown[]; replayable: boolean }> };
assert.equal(ep.endpoints[0]!.descriptions.length, 1, "业务知识留着");
assert.deepEqual(ep.endpoints[0]!.samples, [], "指向旧日志的样本清空"); assert.equal(ep.endpoints[0]!.replayable, false);
assert.equal(findAction(sitesDir, "list", composeDir)?.site, "a.com", "学出来的 action 照样找得到");
assert.equal(findAction(sitesDir, "both", composeDir)?.file, path.join(composeDir, "both.js"), "跨站点的组合挪进 compose/，按名字找得到");
assert.ok(!fs.existsSync(path.join(home, "actions")));

// 只做一次：再启动不动新的样本
write("sites/a.com/endpoints.json", JSON.stringify({ site: "a.com", endpoints: [{ key: "GET /list", samples: [{ seq: 9, file: "learn-windows/w/requests/000009-GET-list.json" }] }] }));
assert.equal(upgradeLayout(home), false);
assert.equal((JSON.parse(fs.readFileSync(path.join(sitesDir, "a.com", "endpoints.json"), "utf8")) as { endpoints: Array<{ samples: unknown[] }> }).endpoints[0]!.samples.length, 1);

// 组合放哪：用到的 action 都在一个站点就放那个站点；跨站点放 compose/；没名字按哈希
assert.equal(composeTarget({ sitesDir, globalDir: composeDir, code: 'await action("list")', name: "only-a" }), path.join(sitesDir, "a.com", "actions", "only-a.js"));
assert.equal(composeTarget({ sitesDir, globalDir: composeDir, code: 'await action("list"); await action("detail")', name: "both" }), path.join(composeDir, "both.js"));
assert.match(composeTarget({ sitesDir, globalDir: composeDir, code: "return 1" }), /compose\/[0-9a-f]{12}\.js$/);
console.log("actions.selfcheck ok");
