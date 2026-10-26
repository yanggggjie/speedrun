// 交接材料：只含一个站点、逐字复制、按窗口分文件、排除仍开着的其他 debug 窗口、以目标接口的样本为锚点（不是固定时间窗）、
// manifest 写明缺口。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EndpointIndex } from "./endpoints.ts";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { exportMaterial, type Manifest } from "./material.ts";
import { RawStore } from "./raw.ts";
import { SiteLog } from "./sitelog.ts";
import type { Row } from "./types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-material-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const WINS: Record<number, string> = { 9: "run", 11: "debug-aaaa", 12: "debug-bbbb" };
const log = new SiteLog({ dir });
log.open();
const raw = new RawStore();
const index = new EndpointIndex({ dir, raw });
const ingest = new Ingestor(log, { aliasKey: "k", raw, index, winOf: (tab) => WINS[tab] ?? "user" });
const T = 1_700_000_000_000;
const page = "https://www.x.com/home";
const net = (tab: number, t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 10, ...over }) as PageMsg;
const click = (tab: number, t: number, trusted = true): PageMsg => ({ k: "ev", t, tab, page, type: "click", trusted, target: { tag: "button", text: "Like", sel: "#like" } });

// 两个小时前，用户点了 3 次赞（同一个接口），中间还有一个别的请求；之后什么都没做
for (let i = 0; i < 3; i++) {
  const t = T + i * 60_000;
  ingest.handleBatch([click(5, t), net(5, t + 100, { id: i, rid: `d:${i}`, method: "POST", url: "https://x.com/api/like", reqBody: JSON.stringify({ tweet_id: String(i) }), body: `{"ok":${i}}`, size: 8 })]);
}
ingest.handleBatch([
  net(5, T + 200, { id: 20, rid: "d:20", url: "https://x.com/api/other", body: "{\"o\":1}", size: 7 }),
  { k: "doc", t: T + 300, tab: 5, page, url: page, html: "<html>doc</html>" },
  { k: "snap", t: T + 400, tab: 5, page, snap: { title: "t", interactiveVisible: 1, interactiveTotal: 1 } },
  { k: "bg", t: T + 500, tab: 5, page, n: 41 },
  // 另一个站点：材料里不能有
  net(7, T + 600, { id: 30, url: "https://y.com/api/secret-site", body: "{}", size: 2, page: "https://y.com/" }),
]);
// run 窗口、已收回的 debug 窗口（历史）、仍开着的 debug 窗口（正在试错，要排除）
ingest.handleBatch([
  net(9, T + 700, { id: 1, rid: "r:1", method: "POST", url: "https://x.com/api/like", reqBody: "{\"tweet_id\":\"9\"}", body: "{\"ok\":9}", size: 8 }),
  net(11, T + 800, { id: 1, rid: "q:1", method: "POST", url: "https://x.com/api/like", reqBody: "{\"tweet_id\":\"7\"}", body: "{\"ok\":7}", size: 8 }),
  net(12, T + 900, { id: 1, rid: "p:1", method: "POST", url: "https://x.com/api/like", reqBody: "{\"tweet_id\":\"MARK-ACTIVE\"}", body: "{\"ok\":\"MARK-ACTIVE\"}", size: 8 }),
]);
ingest.flush();
index.flush();
const SITE = "x.com";
const now = T + 2 * 3_600_000;
const read = (m: string, name: string): string => fs.readFileSync(path.join(m, name), "utf8");
const listAll = (m: string): string[] => fs.readdirSync(m, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

// 1. 以目标接口的样本为锚点：用户操作是 2 小时前的，30 分钟时间窗里什么都没有，材料里仍然有样本和触发它们的动作
const out = path.join(dir, "out1");
const m: Manifest = exportMaterial(log, index, { site: SITE, dir: out, endpoint: "POST /api/like", excludeWins: ["debug-bbbb"], now });
assert.equal(m.counts.anchors, 5, "锚点是目标接口的成功请求：用户 3 次、run 1 次、已收回的 debug 1 次，不含仍开着的 debug-bbbb");
const userRows = read(out, "timeline.user.jsonl").trim().split("\n").map((l) => JSON.parse(l) as Row);
assert.equal(userRows.filter((r) => r.type === "action").length, 3, "触发样本的用户动作在材料里（因果链）");
assert.equal(userRows.filter((r) => r.endpoint === "POST /api/like").length, 3);

// 2. 按窗口分文件；仍开着的其他 debug 窗口整个排除；已收回的 debug 窗口和 run 是历史，包含
assert.deepEqual(m.windows, { included: ["debug-aaaa", "run", "user"], excluded: ["debug-bbbb"] });
assert.ok(!fs.existsSync(path.join(out, "timeline.debug-bbbb.jsonl")));
for (const f of listAll(out)) assert.ok(!fs.readFileSync(f, "utf8").includes("MARK-ACTIVE"), `${f} 里不该有仍开着的 debug 窗口的内容`);

// 3. 只含一个站点；doc、snap 不导出；行逐字复制
for (const f of listAll(out)) assert.ok(!fs.readFileSync(f, "utf8").includes("secret-site"), "别的站点不能混进来");
assert.ok(!userRows.some((r) => r.type === "doc" || r.type === "snap"));
const original = log.readRows(SITE, { wins: ["user"], limit: 1000 });
for (const r of userRows) assert.equal(JSON.stringify(r), JSON.stringify(original.find((o) => o.seq === r.seq)), "行和日志里的完全相同");

// 4. 请求文件都有；响应体只给锚点的；文件引用是相对本目录的 <段>/<文件名>，指向的文件在
const likeRow = userRows.find((r) => r.endpoint === "POST /api/like")!;
assert.ok(fs.existsSync(path.join(out, likeRow.file!)));
const rf = JSON.parse(read(out, likeRow.file!)) as { responseBodyPath: string };
assert.ok(fs.existsSync(path.join(out, rf.responseBodyPath)), "锚点的响应体在");
assert.equal(m.counts.responseBodies, 5);
const other = original.find((r) => r.endpoint === "GET /api/other")!;
assert.equal(userRows.some((r) => r.seq === other.seq), true, "窗口里 30 分钟时间窗外的请求也在（它在锚点前一分钟内）");
const otherBody = (JSON.parse(fs.readFileSync(log.abs(SITE, other.file!), "utf8")) as { responseBodyPath: string }).responseBodyPath;
assert.ok(!fs.existsSync(path.join(out, otherBody)), "非锚点的响应体不导出");

// 5. 缺口写在 manifest 里，不假装完整
assert.ok(m.warnings.some((w) => /41 个请求只有计数/.test(w)), m.warnings.join("|"));
assert.ok(m.notes.length > 0);
assert.deepEqual(JSON.parse(read(out, "manifest.json")), m);

// 6. 原始请求已不在内存（重启后）：manifest 提示要自己触发一次
const cold = new EndpointIndex({ dir, raw: new RawStore() });
const mc = exportMaterial(log, cold, { site: SITE, dir: path.join(dir, "out2"), endpoint: "POST /api/like", now });
assert.ok(mc.warnings.some((w) => /replayable 为 false/.test(w)), mc.warnings.join("|"));
assert.ok(!m.warnings.some((w) => /replayable 为 false/.test(w)), "原始请求还在内存里就不提示");

// 7. 没指定接口：取用户窗口最近动作引发的非 GET 请求；最近没有就说明
const none = exportMaterial(log, index, { site: SITE, dir: path.join(dir, "out3"), now });
assert.ok(none.warnings.some((w) => /最近没有动作引发的非 GET/.test(w)));
const recent = exportMaterial(log, index, { site: SITE, dir: path.join(dir, "out4"), now: T + 3 * 60_000 });
assert.ok(recent.counts.anchors >= 3, "用户窗口最近的非 GET 请求");

// 8. 目标接口根本没有样本 / 站点从没有记录：说明，不报错
const missing = exportMaterial(log, index, { site: SITE, dir: path.join(dir, "out5"), endpoint: "POST /api/nope", now });
assert.ok(missing.warnings.some((w) => /没有找到目标接口/.test(w)));
const cold2 = exportMaterial(log, index, { site: "z.com", dir: path.join(dir, "out6"), endpoint: "POST /x", now });
assert.ok(cold2.warnings.some((w) => /还没有任何记录/.test(w)));
assert.deepEqual(cold2.counts, { rows: 0, requests: 0, requestFiles: 0, responseBodies: 0, anchors: 0 });

console.log("material.selfcheck ok");
