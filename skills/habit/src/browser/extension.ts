/**
 * 扩展通道：daemon 经 relay（Chrome 拉起的 native messaging host，只转发字节）与 habit Chrome 扩展说话。
 * 帧：4 字节小端长度前缀 + UTF-8 JSON。
 *
 * daemon → 扩展：{ id, name, args }   name：call / tabs / goto / history / openTab / closeTab / closeGroup / closeAllGroups / idleGroup / screenshot / input / evaluate / reload，见 chrome-extension/background.js
 * 扩展 → daemon：{ id, result|error }（应答）| { type: "hello" | "page", ... }（推送：握手、页面消息、标签页的地址变化、新开和关闭）
 *
 * 只支持一个扩展连接、一个 daemon。
 */
import { EXTENSION_COMMAND_TIMEOUT_MS } from "../utils/constants.ts";

/** 扩展 ABI 版本：daemon 和扩展之间的操作集合（call、tabs、goto、openTab、screenshot 等）。只有改 ABI 才加一，用户才需要刷新扩展。 */
export const ABI = 15;
/** 从这个 ABI 起扩展支持 reload（从磁盘重新加载自己）：daemon 发现扩展旧了就自动让它重新加载，不用用户去 chrome://extensions 点。 */
export const RELOADABLE_ABI = 13;

/** 扩展 tabs 操作返回的一个标签页；habit 为真表示它在 habit 的标签组里（groupId 是 -1 表示不在任何组里）。 */
export type TabInfo = { tabId: number; windowId: number; groupId: number; habit?: boolean; active: boolean; url: string; title: string; status: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ExtensionLink {
  chromeVersion = "";
  private write: (message: Record<string, unknown>) => void = () => { throw new Error("扩展未连接"); };
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (msg: Record<string, unknown>) => void>();

  /** 让扩展执行一个操作。 */
  request(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`扩展命令超时 ${EXTENSION_COMMAND_TIMEOUT_MS}ms：${name}`));
      }, EXTENSION_COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, name, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /** 订阅扩展推来的某类消息（`type` 字段）。 */
  on(type: string, handler: (msg: Record<string, unknown>) => void): void {
    this.handlers.set(type, handler);
  }

  /** 收到扩展消息：应答匹配 pending，推送交给订阅者。 */
  receive(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(String((msg.error as { message?: string }).message ?? msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    try { this.handlers.get(String(msg.type))?.(msg); } catch { /* 单个订阅者出错不影响链路 */ }
  }

  abi: number | undefined;
  /** 扩展报来的 build（setup.js 写进扩展的版本）；空的是从仓库直接加载的开发版。 */
  build = "";

  /** 扩展握手：记下 ABI 版本、build 和能力。版本不符不抛错（扩展还连着，需要让 daemon 能告诉用户去刷新，或让它自己重新加载）。 */
  hello(msg: Record<string, unknown>): void {
    this.chromeVersion = String(msg.chromeVersion ?? "");
    this.abi = typeof msg.abi === "number" ? msg.abi : undefined;
    this.build = typeof msg.build === "string" ? msg.build : "";
  }

  compatible(): boolean { return this.abi === ABI; }

  /** 扩展跑的不是磁盘上这一版（ABI 不同，或 build 和 daemon 的不同），并且它会自己重新加载。 */
  outdated(diskBuild: string): boolean {
    if ((this.abi ?? 0) < RELOADABLE_ABI) return false;
    return !this.compatible() || (diskBuild !== "" && this.build !== "" && this.build !== diskBuild);
  }

  /** 扩展链路接上（relay 发来 hello 之后）。 */
  attach(write: (message: Record<string, unknown>) => void): void {
    this.write = write;
  }

  /** 扩展断开：未完成的请求立即失败，但对象保留，等下一次 attach。 */
  detach(): void {
    this.write = () => { throw new Error("扩展未连接"); };
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error("扩展已断开"));
    }
  }
}

export function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 增量解析 native messaging 帧，返回剩余未完成的 buffer。 */
export function parseFrames(buffer: Buffer, onMessage: (msg: Record<string, unknown>) => void): Buffer {
  let rest = buffer;
  while (rest.length >= 4) {
    const len = rest.readUInt32LE(0);
    if (rest.length < 4 + len) break;
    const body = rest.subarray(4, 4 + len).toString("utf8");
    rest = rest.subarray(4 + len);
    onMessage(JSON.parse(body) as Record<string, unknown>);
  }
  return rest;
}
