import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionLink } from "../browser/extension.ts";
import type { PageMsg } from "./ingest.ts";

const PAGE_DIR = path.join(import.meta.dirname, "..", "page");

export type PageScript = { id: string; code: string; world: "MAIN" | "USER_SCRIPT" };

/**
 * 页面脚本：源码在 src/page/。MAIN world 的三个（共用、录制、执行）拼成一份下发，保证按顺序执行；
 * bridge.js 跑在 USER_SCRIPT world，把页面消息转给扩展。扩展包里不放任何页面脚本。
 */
export function loadPageScripts(dir = PAGE_DIR): PageScript[] {
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
  return [
    { id: "tabbot-page", code: ["common.js", "recorder.js", "executor.js"].map(read).join("\n;\n"), world: "MAIN" },
    { id: "tabbot-bridge", code: read("bridge.js"), world: "USER_SCRIPT" },
  ];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; tab: number; onNavigate: "ok" | "fail"; navTimer?: ReturnType<typeof setTimeout> };

/** 在页面里执行代码并拿回结果：结果由页面脚本自己经 bridge 发回来（`k: "res"`），不依赖扩展返回的执行结果。 */
export class PageHost {
  private readonly link: ExtensionLink;
  private readonly pending = new Map<string, Pending>();

  constructor(link: ExtensionLink) { this.link = link; }

  /** 扩展连上之后调用：下发并注册页面脚本，已打开的页面补注入。 */
  async install(scripts = loadPageScripts()): Promise<void> {
    await this.link.request("register", { scripts });
  }

  /** 在标签页里计算表达式（可以是 Promise），返回结果。 */
  call(tab: number, expr: string, options: { timeoutMs?: number; onNavigate?: "ok" | "fail" } = {}): Promise<unknown> {
    const uid = randomUUID();
    const ms = options.timeoutMs ?? 30_000;
    const code = `(()=>{const u=${JSON.stringify(uid)};const send=(m)=>window.postMessage({__tcrl:1,k:"res",u,t:Date.now(),...m},"*");`
      + `if(!window.__tcr||!window.__tcr.exec){send({ok:false,error:"页面里没有 TabBot 的脚本（刷新这个页面后再试）"});return;}`
      + `Promise.resolve().then(()=>(${expr})).then((v)=>send({ok:true,v}),(e)=>send({ok:false,error:String((e&&e.message)||e)}));})()`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(uid); reject(new Error(`页面没有在 ${Math.round(ms / 1000)} 秒内回应（页面脚本没装上，或页面卡住了；刷新这个页面后再试）`)); }, ms);
      this.pending.set(uid, { resolve, reject, timer, tab, onNavigate: options.onNavigate ?? "fail" });
      this.link.request("exec", { tabId: tab, code }).catch((error: unknown) => {
        if (this.pending.delete(uid)) { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  }

  /** 页面消息：是执行结果就消化掉并返回 true。 */
  onMessage(msg: PageMsg): boolean {
    if (msg.k !== "res") return false;
    const entry = this.pending.get(String(msg.u));
    if (!entry) return true;
    this.pending.delete(String(msg.u));
    clearTimeout(entry.timer);
    clearTimeout(entry.navTimer);
    if (msg.ok === false) entry.reject(new Error(String(msg.error ?? "页面里执行失败")));
    else entry.resolve(msg.v);
    return true;
  }

  /** 标签页跳转或关闭：页面里等待中的脚本被打断了，结果发不回来。动作类的算成功（navigated），其它的算失败。 */
  onTabEvent(tab: number, ev: string): void {
    for (const [uid, entry] of this.pending) {
      if (entry.tab !== tab) continue;
      if (ev === "closed") { this.fail(uid, entry, "标签页已关闭"); continue; }
      if (entry.navTimer) continue;
      // 跳转之前页面可能已经把结果发出来了，稍等一下再下结论
      entry.navTimer = setTimeout(() => {
        if (entry.onNavigate === "ok") { this.pending.delete(uid); clearTimeout(entry.timer); entry.resolve({ ok: true, navigated: true }); }
        else this.fail(uid, entry, "页面跳转了，结果没有发回来");
      }, 1500);
    }
  }

  private fail(uid: string, entry: Pending, message: string): void {
    this.pending.delete(uid);
    clearTimeout(entry.timer);
    clearTimeout(entry.navTimer);
    entry.reject(new Error(message));
  }
}
