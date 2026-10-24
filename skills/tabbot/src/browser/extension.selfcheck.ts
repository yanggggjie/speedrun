import assert from "node:assert/strict";
import { ABI, ExtensionLink, frame, parseFrames } from "./extension.ts";

// 分帧：往返一致；半包不吐消息，拼完整后再吐
{
  const out: Record<string, unknown>[] = [];
  const a = frame({ id: 1, name: "tabs", args: {} });
  const b = frame({ type: "page", k: "ev", 中文: "ok" });
  const all = Buffer.concat([a, b]);
  const rest = parseFrames(all.subarray(0, 5), (m) => out.push(m));
  assert.equal(out.length, 0, "半包不应吐消息");
  const rest2 = parseFrames(Buffer.concat([rest, all.subarray(5)]), (m) => out.push(m));
  assert.equal(rest2.length, 0);
  assert.equal(out.length, 2);
  assert.equal(out[1]?.中文, "ok");
}

// 链路：写出的请求带 id；应答按 id 匹配；推送按 type 交给订阅者
{
  const written: Record<string, unknown>[] = [];
  const link = new ExtensionLink();
  link.attach((m) => written.push(m));
  link.hello({ type: "hello", abi: ABI, chromeVersion: "Chrome/x" });
  assert.equal(link.chromeVersion, "Chrome/x");
  assert.equal(link.compatible(), true);

  const pages: unknown[] = [];
  link.on("page", (m) => pages.push(m));
  link.receive({ type: "page", k: "ev", tab: 7 });
  assert.equal((pages[0] as { tab: number }).tab, 7);

  const listed = link.request("tabs");
  const req = written[written.length - 1]!;
  assert.equal(req.name, "tabs");
  link.receive({ id: req.id, result: { tabs: [{ tabId: 7 }] } });
  assert.equal(((await listed) as { tabs: { tabId: number }[] }).tabs[0]?.tabId, 7);

  const failed = link.request("call", { tabId: 7 });
  link.receive({ id: written[written.length - 1]!.id, error: { message: "boom" } });
  await assert.rejects(failed, /boom/);
}

// ABI 不符（旧版扩展）：握手不抛错，但 compatible 为假，holder 据此提示刷新扩展
{
  const link = new ExtensionLink();
  link.hello({ type: "hello", protocolVersion: 1 });
  assert.equal(link.compatible(), false);
  link.hello({ type: "hello", abi: ABI + 1 });
  assert.equal(link.compatible(), false);
}

// 断开：未完成的请求被拒绝；断开后再发直接失败
{
  const link = new ExtensionLink();
  link.attach(() => {});
  const pending = link.request("tabs");
  link.detach();
  await assert.rejects(pending, /扩展已断开/);
  await assert.rejects(link.request("tabs"), /扩展未连接/);
}

console.log("browser extension selfcheck ok");
