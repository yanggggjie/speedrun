// 淘汰按窗口目录：run 窗口只留最近的；learn 窗口先只删响应体、页面和截图的旧文件，时间线、请求文件和受保护的样本留着；
// 时间线和请求文件超了才删整个旧窗口；开着的 learn 窗口永远不动。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enforce } from "./retention.ts";
import { WindowLog } from "./windowlog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-retention-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const log = new WindowLog({ root });
log.open();
const big = "x".repeat(1200);

/** 一个 learn 窗口：一个请求文件、一个 1200 字节的响应体、一行时间线。 */
function learnWindow(win: string, createdAt: number): { file: string; body: string } {
  log.openWindow(win, "learn", { createdAt });
  const seq = log.reserve();
  const body = log.putFile(win, `requests/${String(seq).padStart(6, "0")}-GET-x.response.json`, big);
  const file = log.putFile(win, `requests/${String(seq).padStart(6, "0")}-GET-x.json`, "{}");
  log.append({ seq, t: createdAt, win, src: "agent", tab: 1, type: "request", method: "GET", file });
  return { file, body };
}

const a = learnWindow("a.com-20261101-100000", 1), b = learnWindow("b.com-20261101-110000", 2), c = learnWindow("c.com-20261101-120000", 3);
const open = new Set(["a.com-20261101-100000"]); // 最旧的那个还开着
const keep = new Set([log.ref("b.com-20261101-110000", b.body)]); // b 的响应体是 endpoint 样本
let changed = 0;
const hooks = { protect: () => keep, isOpen: (w: string) => open.has(w), changed: () => { changed++; } };

// 响应体、页面和截图超了：从最旧的关着的窗口删响应体；开着的、受保护的不动；时间线和请求文件留着
const r1 = enforce(log, hooks, { totalHeavy: 2500, totalLight: 1e9, runKeep: 100 });
assert.ok(fs.existsSync(log.abs("a.com-20261101-100000", a.body)), "开着的 learn 窗口不动");
assert.ok(fs.existsSync(log.abs("b.com-20261101-110000", b.body)), "endpoint 样本受保护");
assert.ok(!fs.existsSync(log.abs("c.com-20261101-120000", c.body)), "关着的窗口的响应体被删");
assert.ok(fs.existsSync(log.abs("c.com-20261101-120000", c.file)) && fs.existsSync(path.join(log.winDir("c.com-20261101-120000"), "timeline.jsonl")), "时间线和请求文件留着");
assert.equal(r1.strippedFiles, 1); assert.equal(changed, 1);

// 时间线和请求文件超了：删最旧的关着的整个窗口（开着的跳过）
enforce(log, hooks, { totalHeavy: 1e9, totalLight: 1, runKeep: 100 });
assert.ok(fs.existsSync(log.winDir("a.com-20261101-100000")), "开着的 learn 窗口不删");
assert.ok(!fs.existsSync(path.join(root, "learn-windows", "b.com-20261101-110000")) && !fs.existsSync(path.join(root, "learn-windows", "c.com-20261101-120000")), "关着的旧窗口整个删掉");

// run 窗口只留最近 runKeep 个
for (let i = 0; i < 4; i++) log.openWindow(`r-2026110${i}-000000`, "run", { createdAt: 10 + i });
enforce(log, hooks, { totalHeavy: 1e9, totalLight: 1e9, runKeep: 2 });
assert.deepEqual(log.listWindows("run"), ["r-20261102-000000", "r-20261103-000000"]);

console.log("retention.selfcheck ok");
