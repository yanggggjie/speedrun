// 别名稳定（重启也不变、不能还原），请求文件里没有秘密的真值
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { WindowLog } from "./windowlog.ts";
import type { RequestFile } from "./types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lore-alias-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true })); // 自检结束清掉临时目录
const page = "https://www.example.com/";
const T = Date.now() - 60_000;
const net = (t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab: 9, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 5, ...over }) as PageMsg;
const SECRET = "sess_9f8e7d6c5b4a39281716";

/** 用一个新的日志目录和 Ingestor 写入这些消息，返回写出的请求文件（按编号）。 */
function ingestWith(dir: string, key: string | undefined, msgs: PageMsg[]): RequestFile[] {
  const log = new WindowLog({ root: dir });
  log.open();
  log.openWindow("w-20261101-120000", "run");
  new Ingestor(log, { aliasKey: key, winOf: () => "w-20261101-120000" }).handleBatch(msgs);
  log.close();
  return log.readRows("w-20261101-120000", { limit: 100 }).filter((r) => r.type === "request").map((r) => JSON.parse(fs.readFileSync(log.abs(r.win, r.file!), "utf8")) as RequestFile);
}

// 别名：同一个密钥 + 同一个真值 = 同一个别名，重启（新的 Ingestor）也一样；密钥不同别名不同；别名里没有真值
const req = (id: number) => net(T + id, { id, rid: `d:${id}`, url: `https://www.example.com/api/me?session_token=${SECRET}&x=1`, body: "{\"ok\":true}", size: 11 });
const a1 = ingestWith(path.join(root, "a1"), "salt-1", [req(1)]);
const a2 = ingestWith(path.join(root, "a2"), "salt-1", [req(1)]);
const b1 = ingestWith(path.join(root, "b1"), "salt-2", [req(1)]);
const alias = (files: RequestFile[]) => files[0]!.url.query.session_token;
assert.match(alias(a1)!, /^⟨secret_[0-9a-f]{12}:\w+⟩$/);
assert.equal(alias(a1), alias(a2), "同一个密钥、同一个真值，重启之后别名不变");
assert.notEqual(alias(a1), alias(b1), "密钥不同，别名不同（拿到日志也没法对照别的机器）");
assert.ok(!JSON.stringify(a1).includes(SECRET), "请求文件里没有真值");

// 请求文件的样子：rid 记下来了；请求头里扩展抹掉的是 [redacted]；请求体里的秘密是别名
const files = ingestWith(path.join(root, "main"), "k", [
  net(T + 10, { id: 2, rid: "d:2", method: "POST", url: "https://www.example.com/api/search?q=a", reqHeaders: { "content-type": "application/json", authorization: "[redacted]", "x-api-version": "3.0", "x-zse-96": "2.0_abc" }, reqBody: JSON.stringify({ page: 1, access_token: SECRET }), body: "{\"items\":[{\"title\":\"独一无二的标题\"}]}", size: 40 }),
  net(T + 20, { id: 3, rid: "d:3", method: "POST", url: "https://www.example.com/api/upload", reqBody: "[FormData]", body: "{}", size: 2 }),
  net(T + 30, { id: 4, rid: "d:4", method: "GET", url: "https://www.example.com/api/list?page=1", body: "{\"n\":1}", size: 7 }),
  net(T + 50, { id: 6, rid: "d:6", method: "POST", url: "https://www.example.com/api/big", reqBody: "x".repeat(70_000), body: "{}", size: 2 }),
]);
const [post] = files as [RequestFile];
assert.equal(post.rid, "d:2");
assert.match(JSON.stringify(post.requestBody), /⟨secret_[0-9a-f]{12}:\w+⟩/, "请求体里的秘密是别名");
assert.ok(!JSON.stringify(files).includes(SECRET), "请求文件里没有真值");
const badJson = ingestWith(path.join(root, "bj"), "k", [net(T + 60, { id: 7, rid: "d:7", method: "POST", url: "https://www.example.com/api/x", reqBody: "{\"a\": \"" + SECRET, body: "{}", size: 2 })])[0]!;
assert.ok(!JSON.stringify(badJson).includes(SECRET), "不完整的 JSON 不存内容，更不会泄露");
console.log("alias.selfcheck ok");
