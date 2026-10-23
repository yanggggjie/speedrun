import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ingestor, type HookMsg } from "./ingest.ts";
import { readEvents, runSql, status, waitForHuman, formatRows } from "./query.ts";
import { enforceCap } from "./retention.ts";
import { bodiesDir, dayOf, JournalStore, listDays } from "./store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-journal-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // 自检结束清掉临时目录

const store = new JournalStore(dir);
await store.open();
const ingest = new Ingestor(store);

const T0 = Date.now() - 60_000;
const page = "https://www.zhihu.com/";
const net = (t: number, over: Record<string, unknown>): HookMsg => ({ k: "net", t, tab: 3, frame: 0, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ...over }) as HookMsg;

ingest.handleBatch([
  // 人点击：isTrusted 为 true，之后 2 秒内的请求记为它引发的
  { k: "ev", t: T0, tab: 3, page, type: "click", trusted: true, pressure: 0.5, target: { tag: "button", text: "提交订单", sel: "#go" } } as HookMsg,
  net(T0 + 100, { url: "https://www.zhihu.com/api/order?token=abc123def456ghi789&x=1", method: "POST", body: JSON.stringify({ ok: true, access_token: "SECRETSECRET12345", items: [1, 2] }), size: 60, reqBody: "{\"a\":1}" }),
  // 域名不是 JWT：host 参数、响应体里的主机名要保持原样；真正的 JWT（eyJ 开头）仍然脱敏
  net(T0 + 150, { url: "https://www.zhihu.com/api/dns?host=www.zhihu.com&jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", body: JSON.stringify({ cdn: "static.zhimg.com", t: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r" }), size: 40 }),
  // 重复请求：只计数
  net(T0 + 200, { url: "https://www.zhihu.com/api/v4/me", body: "{\"name\":\"x\"}", size: 12 }),
  net(T0 + 300, { url: "https://www.zhihu.com/api/v4/me", body: "{\"name\":\"x\"}", size: 12 }),
  // 第三方：只留索引，不存响应体
  net(T0 + 400, { url: "https://cdn.other.com/data.json", body: "{\"a\":1}", size: 7 }),
  // 同站埋点：噪声
  net(T0 + 500, { url: "https://datahub.zhihu.com/collector/zlab", method: "POST", status: 200, body: "", size: 0 }),
  // 来源：agent 的鼠标点击带水印；脚本触发的事件是 page
  { k: "ev", t: T0 + 600, tab: 3, page, type: "click", trusted: true, pressure: 0.123, target: { tag: "a", text: "下一页" } } as HookMsg,
  { k: "ev", t: T0 + 700, tab: 3, page, type: "click", trusted: false, target: { tag: "div", sel: "#x" } } as HookMsg,
  { k: "ev", t: T0 + 800, tab: 3, page, type: "input", trusted: true, n: 12, target: { tag: "input", text: "地址", sel: "#addr" } } as HookMsg,
  { k: "ev", t: T0 + 850, tab: 3, page, type: "key", key: "Enter", trusted: true, target: { tag: "input", text: "地址" } } as HookMsg,
  { k: "nav", t: T0 + 900, tab: 3, page, via: "pushState", url: "https://www.zhihu.com/hot?x=1" } as HookMsg,
  { k: "snap", t: T0 + 1000, tab: 3, page, snap: { why: "load", title: "热榜", interactiveVisible: 4, interactiveTotal: 9, items: [] } } as HookMsg,
]);

const all = await readEvents({ dir, all: true, limit: 100 });
assert.equal(all.length, 12); // 重复的 /me 只占一行
const bySeq = (verb: string, src: string) => all.find((r) => r.verb === verb && r.src === src);
const order = all.find((r) => r.url?.includes("/api/order"))!;
assert.equal(order.cause, all[0]!.seq, "请求应记为点击引发的");
assert.ok(/token=⟨secret_\d+:\w+⟩/.test(order.url!) && !order.url!.includes("abc123def456ghi789"), "URL 里的 token 要脱敏，别名保持可读");
const bodyFile = path.join(bodiesDir(dayOf(order.ts), dir), order.body!);
const stored = fs.readFileSync(bodyFile, "utf8");
assert.ok(stored.includes("\"items\"") && !stored.includes("SECRETSECRET12345"), "响应体写盘前脱敏、缩进展开");
assert.match(stored, /\n/, "JSON 要展开成多行，方便 rg");
const dns = all.find((r) => r.url?.includes("/api/dns"))!;
assert.ok(dns.url!.includes("host=www.zhihu.com") && /jwt=⟨secret_\d+:jwt⟩/.test(dns.url!), "域名保持原样，真正的 JWT 脱敏");
const dnsBody = fs.readFileSync(path.join(bodiesDir(dayOf(dns.ts), dir), dns.body!), "utf8");
assert.ok(dnsBody.includes("static.zhimg.com") && !dnsBody.includes("eyJhbGci"));
const me = all.find((r) => r.url?.endsWith("/api/v4/me"))!;
assert.equal(me.dup, 2);
const cdn = all.find((r) => r.url?.includes("cdn.other.com"))!;
assert.equal(cdn.body, null, "第三方不存响应体");
const noisy = all.find((r) => r.url?.includes("datahub"))!;
assert.equal(noisy.noise, 1);
assert.equal(all.filter((r) => r.kind === "input").map((r) => r.src).join(), "human,agent,page,human,human");
assert.ok(bySeq("pushState", "page") && bySeq("load", "page"));

// 默认视图不含噪声；按 src 过滤；since 游标
assert.equal((await readEvents({ dir, limit: 100 })).length, 11);
assert.equal((await readEvents({ dir, src: "agent", limit: 100 })).length, 1);
assert.equal((await readEvents({ dir, since: all[all.length - 1]!.seq, limit: 100 })).length, 0);
const lines = formatRows(await readEvents({ dir, limit: 100 }));
assert.match(lines, /tab3 human click button\[提交订单\]/);
assert.match(lines, /POST \/api\/order\?token=.* 200 .*body:\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\.json.*← #1/);
assert.match(lines, /GET \/api\/v4\/me 200 12B .*×2/);
assert.match(lines, /agent click a\[下一页\]/);
assert.match(lines, /human key Enter input\[地址\]/);
assert.match(lines, /input 输入框|input input\[地址\] 12字/);

// SQL：只读，单条 SELECT，行数上限
const sql = await runSql("SELECT src, COUNT(*) AS n FROM events GROUP BY src ORDER BY src", { dir });
assert.deepEqual(sql.columns, ["src", "n"]);
assert.equal(sql.rows.length, 3);
assert.equal((await runSql("SELECT seq FROM events", { dir, limit: 2 })).truncated, true);
for (const bad of ["DELETE FROM events", "SELECT 1; DROP TABLE events", "SELECT 1 FROM events; SELECT 2", "ATTACH DATABASE 'x' AS y", "PRAGMA query_only=OFF", "WITH a AS (SELECT 1) INSERT INTO events(seq) VALUES(1)"]) {
  await assert.rejects(() => runSql(bad, { dir }), Error, bad);
}

// 新的一天的库：seq 接着往后，SQL 能跨天
const nextDay = T0 + 36 * 3600_000;
const before = store.lastSeq();
ingest.handleBatch([{ k: "ev", t: nextDay, tab: 3, page, type: "click", trusted: true, pressure: 0.5, target: { tag: "a", text: "明天" } } as HookMsg]);
assert.equal(store.lastSeq(), before + 1);
assert.equal(listDays(dir).length, 2);
assert.equal((await runSql("SELECT COUNT(*) AS c FROM events", { dir })).rows[0]![0], 13);

// 重开后 seq 接上
store.close();
const store2 = new JournalStore(dir);
await store2.open();
assert.equal(store2.lastSeq(), before + 1);
store2.close();

// wait：人的操作之后静默够久就返回；一直没有人就超时
const now = Date.now();
const idle = await waitForHuman({ since: 0, idleMs: 1000, timeoutMs: 3000, pollMs: 50, dir, now: () => now + 1e9 });
assert.equal(idle.timedOut, false);
assert.ok(idle.rows.length > 0 && idle.rows.every((r) => !r.noise));
const none = await waitForHuman({ since: before + 1, idleMs: 1000, timeoutMs: 200, pollMs: 50, dir });
assert.deepEqual({ timedOut: none.timedOut, humanActive: none.humanActive, n: none.rows.length }, { timedOut: true, humanActive: false, n: 0 });

// 状态与淘汰：超过上限的 80% 先删旧一天的响应体和快照（索引保留），仍超过再删库；今天的不动
const st = await status(dir);
assert.equal(st.days.length, 2);
const today = dayOf(nextDay);
const oldDay = dayOf(T0);
fs.writeFileSync(path.join(dir, "bodies", oldDay, "pad.bin"), Buffer.alloc(200_000));
const first = enforceCap({ dir, capBytes: 20_000, today });
assert.deepEqual(first.map((e) => e.what), ["files", "db"]);
assert.ok(!fs.existsSync(path.join(dir, "bodies", oldDay)));
assert.deepEqual(listDays(dir), [today]);
assert.deepEqual(enforceCap({ dir, capBytes: 1e12, today }), []);

// 一批事件跨午夜：按天拆进各自的库，不会写错文件
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tc-journal-midnight-"));
process.on("exit", () => fs.rmSync(dir2, { recursive: true, force: true })); // 自检结束清掉临时目录

const store3 = new JournalStore(dir2);
await store3.open();
const midnight = new Date(T0); midnight.setHours(23, 59, 59, 900);
new Ingestor(store3).handleBatch([
  { k: "ev", t: midnight.getTime(), tab: 3, page, type: "click", trusted: true, pressure: 0.5, target: { tag: "a", text: "午夜前" } } as HookMsg,
  { k: "ev", t: midnight.getTime() + 300, tab: 3, page, type: "click", trusted: true, pressure: 0.5, target: { tag: "a", text: "午夜后" } } as HookMsg,
]);
store3.close();
assert.equal(listDays(dir2).length, 2);
assert.deepEqual((await runSql("SELECT target FROM events ORDER BY seq", { dir: dir2 })).rows.map((r) => r[0]), ["a[午夜前]", "a[午夜后]"]);

console.log("store.selfcheck ok");
