// 日志侧的重放：别名稳定（重启也不变、不能还原）、从日志里的一行还原请求的样子、挑同源标签页、响应摘要
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ingestor, type HookMsg } from "./ingest.ts";
import { findInBodies, readEvents, readEventBySeq } from "./query.ts";
import { pickReplayTab, sameOrigin, summarizeBody, templateFromRow } from "./replay.ts";
import { JournalStore } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-replay-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true })); // 自检结束清掉临时目录
const page = "https://www.example.com/";
const T = Date.now() - 60_000;
const net = (t: number, over: Record<string, unknown>): HookMsg => ({ k: "net", t, tab: 9, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ...over }) as HookMsg;
const SECRET = "sess_9f8e7d6c5b4a39281716";

// 别名：同一个密钥 + 同一个真值 = 同一个别名，重启（新的 Ingestor）也一样；密钥不同别名不同；别名里没有真值
async function ingestWith(dir: string, key: string | undefined, msgs: HookMsg[]) {
  const store = new JournalStore(dir); await store.open();
  new Ingestor(store, { aliasKey: key }).handleBatch(msgs);
  store.close();
  return readEvents({ dir, all: true, limit: 50 });
}
const req = (id: number) => net(T + id, { id, rid: `d1:${id}`, url: `https://www.example.com/api/me?session_token=${SECRET}&x=1`, body: "{\"ok\":true}", size: 11 });
const a1 = await ingestWith(path.join(root, "a1"), "salt-1", [req(1)]);
const a2 = await ingestWith(path.join(root, "a2"), "salt-1", [req(1)]);
const b1 = await ingestWith(path.join(root, "b1"), "salt-2", [req(1)]);
const alias = (rows: typeof a1) => /session_token=(⟨secret_[0-9a-f]{8}:\w+⟩)/.exec(rows[0]!.url!)?.[1];
assert.ok(alias(a1), a1[0]!.url!);
assert.equal(alias(a1), alias(a2), "同一个密钥、同一个真值，重启之后别名不变");
assert.notEqual(alias(a1), alias(b1), "密钥不同，别名不同（拿到日志也没法对照别的机器）");
assert.ok(!JSON.stringify(a1).includes(SECRET), "日志里没有真值");

// 日志里一个请求的样子：rid 记下来了；请求头里扩展抹掉的是 [redacted]；请求体里的秘密是别名
const dir = path.join(root, "main");
const rows = await ingestWith(dir, "k", [
  net(T + 10, { id: 2, rid: "d1:2", method: "POST", url: "https://www.example.com/api/search?q=a", reqHeaders: { "content-type": "application/json", authorization: "[redacted]", "x-api-version": "3.0", "x-zse-96": "2.0_abc" }, reqBody: JSON.stringify({ page: 1, access_token: SECRET }), body: "{\"items\":[{\"title\":\"独一无二的标题\"}]}", size: 40 }),
  net(T + 20, { id: 3, rid: "d1:3", method: "POST", url: "https://www.example.com/api/upload", reqBody: "[FormData]", body: "{}", size: 2 }),
  net(T + 30, { id: 4, rid: "d1:4", method: "GET", url: "https://www.example.com/api/list?page=1", body: "{\"n\":1}", size: 7 }),
  net(T + 40, { id: 5, method: "GET", url: "https://www.example.com/api/old", body: "{}", size: 2 }), // 旧版录的，没有 rid
  net(T + 50, { id: 6, rid: "d1:6", method: "POST", url: "https://www.example.com/api/big", reqBody: "x".repeat(9000), body: "{}", size: 2 }),
]);
const post = rows[0]!;
assert.equal(JSON.parse(post.detail!).rid, "d1:2");
const tpl = templateFromRow(post);
assert.ok("template" in tpl, JSON.stringify(tpl));
assert.equal(tpl.template.method, "POST");
assert.equal(tpl.template.headers.authorization, "[redacted]", "显示的是 [redacted]，真值在浏览器里");
assert.match(tpl.template.body!, /⟨secret_[0-9a-f]{8}:\w+⟩/);
assert.ok(!JSON.stringify(tpl).includes(SECRET));
assert.ok(tpl.warnings.some((w) => /签名|时间戳/.test(w)) && tpl.warnings.some((w) => /POST/.test(w) && /--yes/.test(w)), "x-zse-96 是签名头；POST 有副作用要 --yes：" + tpl.warnings.join("|"));
const get = templateFromRow(rows[2]!); assert.ok("template" in get && get.warnings.length === 0, "普通 GET 没有警告");
assert.match((templateFromRow(rows[1]!) as { error: string }).error, /文件、二进制或表单/);
const big = templateFromRow(rows[4]!); assert.ok("template" in big, "日志里没存全不影响重放（原始内容在浏览器里）"); assert.match(big.template.body!, /已省略/);
const badJson = (await ingestWith(path.join(root, "bj"), "k", [net(T + 60, { id: 7, rid: "d1:7", method: "POST", url: "https://www.example.com/api/x", reqBody: "{\"a\": \"" + SECRET, body: "{}", size: 2 })]))[0]!;
assert.ok(!JSON.stringify(badJson).includes(SECRET), "不完整的 JSON 不存内容，更不会泄露");
const notNet = { ...rows[0]!, kind: "input", verb: "click" } as typeof post; assert.match((templateFromRow(notNet) as { error: string }).error, /不是一个请求/);
const noise = { ...rows[0]!, noise: 1 } as typeof post; assert.match((templateFromRow(noise) as { error: string }).error, /埋点/);
const rep = { ...rows[0]!, verb: "replay" } as typeof post; assert.match((templateFromRow(rep) as { error: string }).error, /本身就是一次重放/);

// 按 seq 取一行、在响应体里找页面上看到的值
assert.equal((await readEventBySeq(post.seq, dir))?.url, post.url);
assert.equal(await readEventBySeq(999999, dir), undefined);
const found = await findInBodies("独一无二的标题", { dir });
assert.equal(found.length, 1); assert.equal(found[0]!.row.seq, post.seq); assert.match(found[0]!.snippet, /独一无二的标题/);
assert.deepEqual(await findInBodies("根本不存在的文字", { dir }), []);

// 挑同源标签页：前台的优先；子域名、协议、端口不同都不算同源
const tabs = [{ tabId: 1, active: false, url: "https://www.example.com/a" }, { tabId: 2, active: true, url: "https://www.example.com/b" }, { tabId: 3, active: true, url: "https://api.example.com/" }, { tabId: 4, active: true, url: "http://www.example.com/" }];
assert.equal(pickReplayTab(tabs, "https://www.example.com/api/x"), 2);
assert.equal(pickReplayTab(tabs.filter((t) => t.tabId !== 2), "https://www.example.com/api/x"), 1);
assert.equal(pickReplayTab(tabs, "https://other.com/x"), undefined);
assert.ok(sameOrigin("https://a.com/x", "https://a.com/y") && !sameOrigin("https://a.com", "https://a.com:8443") && !sameOrigin("https://a.com", "http://a.com"));

// 响应摘要
assert.match(summarizeBody("{\"a\":1,\"b\":2}", "application/json"), /JSON 对象，字段：a, b/);
assert.match(summarizeBody("[{\"id\":1,\"name\":\"x\"},{\"id\":2}]", "application/json"), /JSON 数组，2 项，每项的字段：id, name/);
assert.match(summarizeBody("<html></html>", "text/html"), /HTML，13 字符/);
assert.equal(summarizeBody("", "text/plain"), "（空）");

console.log("replay.selfcheck ok");
