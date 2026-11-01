// 页面消息怎么变成日志：只录 agent 的窗口（用户窗口的一切不落盘、不进内存）、一个窗口一个目录、站点按页面 host、文件名语义化、来源只看 isTrusted、
// 请求指向引发它的动作并带阶段、每次请求都写一行（响应体按内容去重）、HTML 文档、脱敏、原始请求只进内存、run 窗口的请求不进接口聚合。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EndpointIndex } from "./endpoints.ts";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { RawStore } from "./raw.ts";
import { WindowLog } from "./windowlog.ts";
import type { RequestFile, Row } from "./types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ingest-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // 自检结束清掉临时目录
const log = new WindowLog({ root: dir });
log.open();
const raw = new RawStore();
const index = new EndpointIndex({ dir: log.dir, raw });
const W = "example.com-20261101-120000"; // tab 5、6 在学习窗口里，tab 9 在 run 窗口里，其余是用户自己的窗口
const R = "save-20261101-120500";
log.openWindow(W, "learn");
log.openWindow(R, "run");
const ingest = new Ingestor(log, { aliasKey: "k", raw, index, winOf: (tab) => (tab === 9 ? R : tab === 5 || tab === 6 ? W : "user") });
const page = "https://www.example.com/";
const SITE = "example.com"; // www. 去掉
const T = Date.now() - 600_000;
const SECRET = "sess_9f8e7d6c5b4a39281716";
const ev = (t: number, type: string, trusted: boolean, extra: Record<string, unknown> = {}): PageMsg => ({ k: "ev", t, tab: 5, page, type, trusted, target: { tag: "button", text: "提交", sel: "#go" }, ...extra });
const net = (t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab: 5, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 20, ...over });
const rows = (win: string): Row[] => log.readRows(win, { limit: 1000 });
const reqFile = (r: Row): RequestFile => JSON.parse(fs.readFileSync(log.abs(r.win, r.file!), "utf8")) as RequestFile;

// 0. 用户自己窗口里的一切（tab 3）：不写日志、不存文件、不进原始请求表、不进接口聚合（最关键：用户的浏览不被录）
const USER_SECRET = "user_only_secret_5a4b3c2d1e";
ingest.handleBatch([
  { k: "ev", t: T - 1000, tab: 3, page, type: "click", trusted: true, target: { tag: "button", text: "私人" } },
  { k: "net", t: T - 900, tab: 3, page, via: "fetch", method: "POST", status: 200, ct: "application/json", ms: 5, id: 1, rid: "u:1", url: `https://www.example.com/api/private?t=${USER_SECRET}`, reqHeaders: { authorization: `Bearer ${USER_SECRET}` }, reqBody: "{}", body: "{\"mine\":1}", size: 10 },
  { k: "doc", t: T - 800, tab: 3, page, url: page, html: "<html>用户的页面</html>" },
  { k: "nav", t: T - 700, tab: 3, page, url: page },
  { k: "tab", t: T - 600, tab: 3, ev: "url", url: page },
]);
assert.equal(rows(W).length + rows(R).length, 0, "用户窗口的消息一条都不写");
assert.equal(raw.get(3, "u:1"), undefined, "用户窗口的原始请求不进内存");
assert.equal(index.snapshot(SITE).endpoints.length, 0, "用户窗口的请求不进接口聚合");
assert.ok(!fs.readdirSync(dir, { recursive: true }).some((f) => String(f).includes("private")), "没有任何文件");

// 1. 有人在 agent 窗口里真的点了一下（isTrusted 为真）记为 user（isTrusted 为真）是 user；之后 2 秒内开始的请求指向它，阶段是 cmd（命令或真人输入引发）；
//    请求属于发出请求的页面的站点（api.example.com 的请求算在 example.com 里）
ingest.handleBatch([
  ev(T, "click", true),
  net(T + 100, { id: 1, rid: "d:1", url: `https://api.example.com/api/order?access_token=${SECRET}`, method: "POST", reqHeaders: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, reqBody: JSON.stringify({ n: 1, token: SECRET, operationName: "PlaceOrder" }), body: "{\"ok\":true}", size: 11, at: 60_000 }),
]);
const own = rows(W);
assert.deepEqual(own.map((r) => `${r.src}:${r.type}`), ["user:input", "agent:request"], "agent 窗口里页面脚本发的请求记为 agent");
const [click, order] = own as [Row, Row];
assert.equal(order.cause, click.seq, "请求指向引发它的动作");
assert.equal(order.causeDt, 80, "causeDt 是请求开始（完成时间减耗时）与动作之间的毫秒数");
assert.equal(order.phase, "cmd");
assert.equal(order.endpoint, "POST /api/order#PlaceOrder", "请求体里的 operationName 拼进接口名");
assert.equal(order.site, SITE, "站点是页面的 host（去 www.），不是请求地址的 host");
assert.match(order.file!, /^requests\/\d{6}-POST-api-order_PlaceOrder\.json$/, "请求文件名：编号、方法、接口名");

// 2. 脱敏：日志和磁盘上任何文件里都没有真值；原始请求（含真值）只在内存里，重放用
const file = reqFile(order);
assert.match(file.url.query.access_token!, /^⟨secret_[0-9a-f]{12}:\w+⟩$/);
assert.match(file.headers.authorization!, /^⟨secret_/);
assert.equal(file.headers["content-type"], "application/json");
assert.deepEqual(file.requestBody, { n: 1, token: file.requestBody && (file.requestBody as { token: string }).token, operationName: "PlaceOrder" });
assert.match((file.requestBody as { token: string }).token, /^⟨secret_/);
assert.equal(file.rid, "d:1");
assert.equal(file.tab, 5);
for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes(SECRET), `${f.name} 里不该有真值`);
const entry = raw.get(5, "d:1")!;
assert.equal(entry.headers.authorization, `Bearer ${SECRET}`, "内存里是真值");
assert.ok(entry.url.includes(SECRET) && entry.body!.includes(SECRET) && entry.page === page);
assert.equal(ingest.sanitizer.resolve(file.url.query.access_token!), SECRET, "别名能换回真值");

// 3. 每次请求都写一行，响应体按内容只存一份；页面刚加载（at 很小）且期间没有新动作的请求，阶段是 load
ingest.handleBatch([
  net(T + 60_000, { id: 2, rid: "d:2", url: "https://www.example.com/api/list?page=2", body: "{\"items\":[1,2]}", size: 15, at: 100 }),
  net(T + 62_000, { id: 3, rid: "d:3", url: "https://www.example.com/api/list?page=2", body: "{\"items\":[1,2]}", size: 15, at: 2_100 }),
]);
const lists = rows(W).filter((r) => r.endpoint === "GET /api/list");
assert.equal(lists.length, 2, "重复请求也写一行");
assert.equal(reqFile(lists[0]!).responseBodyPath, reqFile(lists[1]!).responseBodyPath, "相同响应体只存一份");
assert.deepEqual(lists.map((r) => r.phase), ["load", "load"]);
ingest.handleBatch([net(T + 200_000, { id: 4, url: "https://www.example.com/api/poll", body: "{}", size: 2, at: 190_000 })]);
assert.equal(rows(W).find((r) => r.endpoint === "GET /api/poll")!.phase, "idle", "既不是加载期也不是动作引发的是 idle");

// 4. 噪声（埋点）标 noise、不进原始请求表、不进接口聚合
ingest.handleBatch([net(T + 7000, { id: 5, rid: "d:5", method: "POST", url: "https://apm.example.com/collector/apm", status: 200, body: "", size: 0 })]);
const noise = rows(W).find((r) => r.url?.includes("collector"))!;
assert.equal(noise.noise, 1);
assert.equal(raw.get(5, "d:5"), undefined);
assert.ok(!index.snapshot(SITE).endpoints.some((e) => e.key.includes("collector")));

// 5. agent 窗口（tab 9）：命令先预留编号，行在做完时写；它引发的请求指向命令；页面脚本触发的一切记为 agent，写在 run 窗口自己的文件里
const cmd = ingest.beginCmd(9, T + 300_000, "click", "@e12", undefined, SITE);
ingest.handleBatch([
  { k: "ev", t: T + 300_010, tab: 9, page, type: "click", trusted: false, target: { tag: "button" } },
  { k: "net", t: T + 300_100, tab: 9, page, via: "fetch", method: "POST", status: 200, ct: "application/json", ms: 30, id: 1, rid: "d:1", url: "https://www.example.com/api/save", body: "{}", size: 2 },
]);
ingest.endCmd(cmd, { target: "button[提交]", detail: { ok: true } });
ingest.endCmd(ingest.beginCmd(9, T + 301_000, "fill", "@e5", { chars: 5 }, SITE), { detail: { ok: false, error: "元素不在页面上" } });
const agent = rows(R);
assert.deepEqual(agent.map((r) => `${r.src}:${r.type}:${r.kind ?? r.requestType}`), ["agent:cmd:click", "agent:input:click", "agent:request:fetch", "agent:cmd:fill"], "按编号：命令先预留编号，它引发的页面事件和请求在后");
const saved = agent.find((r) => r.endpoint === "POST /api/save")!;
assert.equal(saved.cause, cmd.seq, "命令引发的请求指向命令那一行");
assert.equal(saved.win, R);
assert.ok(!index.snapshot(SITE).endpoints.some((e) => e.key === "POST /api/save"), "run 窗口的请求不进接口聚合（只给反查用）");
const cmdRow = agent.find((r) => r.type === "cmd" && r.kind === "click")!;
assert.equal(cmdRow.seq, cmd.seq);
assert.equal(cmdRow.target, "button[提交]", "命令做完后补上元素描述");
assert.equal(agent.find((r) => r.kind === "fill")!.ok, false);
assert.equal(agent.find((r) => r.kind === "fill")!.error, "元素不在页面上");
assert.ok(rows(W).every((r) => r.win === W), "学习窗口的时间线里没有 run 窗口的行");
assert.ok(fs.existsSync(path.join(dir, "run-windows", R, "timeline.jsonl")) && fs.existsSync(path.join(dir, "learn-windows", W, "timeline.jsonl")), "每个窗口一个目录");

// 6. 主文档渲染后的 HTML 原样存（包括内联脚本）
ingest.handleBatch([{ k: "doc", t: T + 5000, tab: 5, page, url: "https://www.example.com/a?x=1", html: "<!doctype html>\n<html><body>独一无二的页面文字<script>window.__S={\"a\":1}</script></body></html>" }]);
const doc = rows(W).find((r) => r.type === "doc")!;
assert.equal(doc.url, "https://www.example.com/a");
assert.match(doc.file!, /^pages\/\d{6}-doc-a\.html$/);
assert.ok(fs.readFileSync(log.abs(W, doc.file!), "utf8").includes("独一无二的页面文字"));

// 7. 排队：push 攒一小会儿再一批写进去
ingest.push(ev(T + 8000, "key", true, { key: "Enter" }));
ingest.flush();
assert.equal(rows(W).at(-1)!.kind, "key");

// 8. 点链接在 agent 窗口里新开了标签页（tab 6，没有自己的命令）：它几秒后加载出来的请求算那一下点击引发的，带上 description
const opener = ingest.beginCmd(5, T + 400_000, "click", "(410,421)", { description: "点开 MR 573" }, SITE);
ingest.endCmd(opener, { detail: { description: "点开 MR 573", ok: true } });
ingest.handleBatch([{ k: "net", t: T + 403_500, tab: 6, page: "https://git.example.org/mr/573", via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 50, id: 9, rid: "n:9", url: "https://git.example.org/api/mr/573", body: "{}", size: 2, at: 300 }]);
const mr = rows(W).find((r) => r.type === "request" && r.site === "git.example.org")!;
assert.equal(mr.cause, opener.seq, "新标签页的请求指向打开它的那一下点击");
assert.equal(index.snapshot("git.example.org").endpoints[0]!.descriptions?.[0]?.text, "点开 MR 573");


console.log("ingest.selfcheck ok");
