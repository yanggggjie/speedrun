// 页面消息怎么变成日志：来源只看 isTrusted、agent 命令记录、请求指向引发它的动作、HTML 文档、脱敏、原始请求只进内存。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { formatRows, readEvents } from "./query.ts";
import { RawStore } from "./raw.ts";
import { bodyPath, JournalStore } from "./store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ingest-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // 自检结束清掉临时目录
const store = new JournalStore({ dir });
await store.open();
const raw = new RawStore();
const ingest = new Ingestor(store, { aliasKey: "k", raw });
const page = "https://www.example.com/";
const T = Date.now() - 60_000;
const SECRET = "sess_9f8e7d6c5b4a39281716";
const ev = (t: number, type: string, trusted: boolean, extra: Record<string, unknown> = {}): PageMsg => ({ k: "ev", t, tab: 5, page, type, trusted, target: { tag: "button", text: "提交", sel: "#go" }, ...extra });
const net = (t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab: 5, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ...over });

ingest.recordLease({ tab: 5, state: "acquired", t: T });
// agent 命令：先写一行命令记录；它产生的 DOM 事件（isTrusted 为假）照常记录，来源是 page，不被吞掉
const cmd = ingest.beginCmd(5, T + 100, "click", "@e12");
ingest.handleBatch([
  ev(T + 110, "click", false),
  net(T + 150, { id: 1, rid: "d:1", url: `https://www.example.com/api/order?access_token=${SECRET}`, method: "POST", reqHeaders: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, reqBody: JSON.stringify({ n: 1, token: SECRET }), body: "{\"ok\":true}", size: 11 }),
]);
ingest.endCmd(cmd, { target: "button[提交]", detail: { ok: true } });
// 真人的输入（isTrusted 为真）是 human；人的点击之后 2 秒内的请求指向它
ingest.handleBatch([ev(T + 3000, "click", true), net(T + 3100, { id: 2, rid: "d:2", url: "https://www.example.com/api/list?page=2", body: "{\"items\":[1,2]}", size: 15 })]);
// 被租约拒绝的命令也有一行
ingest.endCmd(ingest.beginCmd(5, T + 4000, "fill", "@e5", { chars: 5 }), { detail: { ok: false, rejected: "no-lease" } });
ingest.recordLease({ tab: 5, state: "revoked", t: T + 4200, reason: "human", by: "key" });
// 主文档渲染后的 HTML，原样存
ingest.handleBatch([{ k: "doc", t: T + 5000, tab: 5, page, url: "https://www.example.com/a?x=1", html: "<!doctype html>\n<html><body>独一无二的页面文字<script>window.__S={\"a\":1}</script></body></html>" }]);

const rows = await readEvents({ dir, all: true, limit: 50 });
const text = formatRows(rows);
assert.deepEqual(rows.map((r) => `${r.src}:${r.kind}:${r.verb}`), [
  "agent:lease:acquired", "agent:cmd:click", "page:input:click", "page:net:fetch", "human:input:click", "page:net:fetch", "agent:cmd:fill", "human:lease:revoked", "page:doc:html",
], text);
const [, click, , order, human, list, fill, , doc] = rows;
assert.equal(click!.target, "button[提交]", "命令做完后补上元素描述");
assert.equal(order!.cause, click!.seq, "命令引发的请求指向命令那一行");
assert.equal(list!.cause, human!.seq, "人的点击引发的请求指向人的事件");
assert.match(text, /cmd click button\[提交\]/);
assert.match(text, /access_token=⟨secret_[0-9a-f]{12}:\w+⟩/, "显示时别名保持原样，可以直接写进 --set");
assert.match(text, /cmd fill @e5/);
assert.equal(JSON.parse(fill!.detail!).rejected, "no-lease");
assert.match(text, /human lease revoked \(key\)/);

// HTML 文档原样存（包括内联脚本），能按行里的引用找到文件
assert.equal(doc!.url, "https://www.example.com/a?x=1");
assert.ok(fs.readFileSync(bodyPath(doc!.body!, "bodies", dir), "utf8").includes("独一无二的页面文字"));
assert.match(text, /doc \/a\?x=1/);

// 脱敏：日志里没有真值；原始请求（含真值）只在内存里，重放用
assert.ok(!JSON.stringify(rows).includes(SECRET), "日志里没有真值");
assert.match(order!.url!, /access_token=⟨secret_[0-9a-f]{12}:\w+⟩/);
const detail = JSON.parse(order!.detail!);
assert.equal(detail.rid, "d:1");
assert.match(detail.reqHeaders.authorization, /^⟨secret_/);
assert.equal(detail.reqHeaders["content-type"], "application/json");
assert.ok(!JSON.stringify(fs.readdirSync(dir, { recursive: true })).includes(SECRET));
const entry = raw.get(5, "d:1")!;
assert.equal(entry.headers.authorization, `Bearer ${SECRET}`, "内存里是真值");
assert.ok(entry.url.includes(SECRET) && entry.body!.includes(SECRET) && entry.page === page);
assert.equal(ingest.sanitizer.resolve(order!.url!.match(/⟨[^⟩]+⟩/)![0]), SECRET, "别名能换回真值");

// 同一个请求再次出现只计数；噪声（埋点）默认隐藏、不进原始请求表
ingest.handleBatch([net(T + 6000, { id: 3, rid: "d:3", url: "https://www.example.com/api/list?page=2", body: "{\"items\":[1,2]}", size: 15 })]);
const dup = (await readEvents({ dir, all: true, limit: 50 })).find((r) => r.seq === list!.seq)!;
assert.equal(dup.dup, 2);
ingest.handleBatch([net(T + 7000, { id: 4, rid: "d:4", method: "POST", url: "https://apm.example.com/collector/apm", status: 200, body: "", size: 0 })]);
assert.equal(raw.get(5, "d:4"), undefined);
assert.ok(!(await readEvents({ dir, limit: 50 })).some((r) => r.url?.includes("collector")), "噪声默认不显示");
assert.ok((await readEvents({ dir, all: true, limit: 50 })).some((r) => r.noise === 1));

// 排队：push 攒一小会儿再一批写进去
ingest.push(ev(T + 8000, "key", true, { key: "Enter" }));
ingest.flush();
assert.equal((await readEvents({ dir, limit: 1 }))[0]!.verb, "key");

console.log("ingest.selfcheck ok");
