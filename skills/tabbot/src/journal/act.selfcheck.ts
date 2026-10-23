// agent 动作的登记：动作一行（来源 agent）、动作期间页面里的合成事件不重复记、请求指向动作、租约变化写日志。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ingestor, type HookMsg } from "./ingest.ts";
import { formatRows, readEvents } from "./query.ts";
import { JournalStore } from "./store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-act-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true })); // 自检结束清掉临时目录
const store = new JournalStore(dir);
await store.open();
const ingest = new Ingestor(store);
const page = "https://example.com/";
const T = Date.now() - 60_000;
const ev = (t: number, type: string, trusted: boolean, extra: Record<string, unknown> = {}): HookMsg => ({ k: "ev", t, tab: 5, page, type, trusted, target: { tag: "button", text: "提交", sel: "#go" }, ...extra }) as HookMsg;
const net = (t: number, url: string): HookMsg => ({ k: "net", t, tab: 5, page, via: "fetch", method: "POST", url, status: 200, ct: "application/json", body: "{\"ok\":true}", size: 11 }) as HookMsg;

// 租约获取
ingest.recordLease({ tab: 5, state: "acquired", t: T });

// agent 点击：先记一行 agent；页面里 isTrusted 为 false 的 click / input 是这个动作自己产生的，不重复记；请求指向这一行
const act = ingest.beginAct(5, T + 100, "click", "@e12");
ingest.handleBatch([ev(T + 110, "click", false), ev(T + 111, "input", false), net(T + 150, "https://example.com/api/order")]);
ingest.endAct(5, act, T + 400, { target: "button[提交]", detail: { ok: true } });
// 动作结束后的宽限内，晚到的合成事件也不重复记
ingest.handleBatch([ev(T + 700, "change", false)]);
// 宽限之后：页面自己（非 agent）触发的合成事件，仍然记成 page
ingest.handleBatch([ev(T + 3000, "click", false, { target: { tag: "div", text: "页面自己点的", sel: "#x" } })]);
// 真人的输入永远记成 human（动作期间也一样）
const act2 = ingest.beginAct(5, T + 4000, "fill", "@e5", { chars: 5 });
ingest.handleBatch([ev(T + 4010, "click", true, { pressure: 0.5 })]);
ingest.endAct(5, act2, T + 4100, { target: "input[搜索]", size: 5, detail: { ok: false, error: "输入框是禁用或只读的" } });
// 人撤销租约
ingest.recordLease({ tab: 5, state: "revoked", t: T + 4200, reason: "human", by: "key" });
ingest.recordLease({ tab: 5, state: "released", t: T + 5000, reason: "做完了" });

const rows = await readEvents({ dir, all: true, limit: 50 });
const text = formatRows(rows);
assert.deepEqual(rows.map((r) => `${r.src}:${r.kind}:${r.verb}`), [
  "agent:lease:acquired",
  "agent:input:click",
  "page:net:fetch",
  "page:input:click",
  "agent:input:fill",
  "human:input:click",
  "human:lease:revoked",
  "agent:lease:released",
], text);
const click = rows[1]!, order = rows[2]!;
assert.equal(click.target, "button[提交]", "动作做完后补上元素描述");
assert.equal(order.cause, click.seq, "动作引发的请求指向动作那一行");
assert.equal(rows[4]!.size, 5);
assert.match(text, /agent click button\[提交\]/);
assert.match(text, /agent fill input\[搜索\] 5字 ✗ 输入框是禁用或只读的/);
assert.match(text, /human lease revoked \(key\)/);
assert.match(text, /agent lease released \(做完了\)/);
// agent 的 fill 日志里不含输入的内容，只有字数
assert.ok(!JSON.stringify(rows).includes("你好"));

console.log("act.selfcheck ok");
