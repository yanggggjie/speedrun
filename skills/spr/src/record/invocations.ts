import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { INVOCATIONS_LOG, INVOCATIONS_MAX_BYTES } from "../utils/constants.ts";
import { dropOldestKeepNewest } from "../utils/logger.ts";

/**
 * 调用记录：每条 spr 命令（run、resume、debug……，包括还没开窗口就失败的、被取消的）结束时追加一行 JSON。
 * 给 agent 的输出为了省上下文会裁剪，这里留完整的事实：用 jq / rg 查，细节在 window 指向的窗口目录里。
 * 窗口目录会被淘汰，这里的行不跟着删，只按文件大小丢掉最旧的。
 *
 * 一行的字段：id、ts（开始时间）、ms（耗时）、cmd、name、cwd（调用方所在目录）、exit（退出码）、status（ok / fail / ask / wait / usage / cancelled）、
 * head（输出第一行），以及命令补充的字段（run：window、params、error、result、calls、sent、resumedFrom）。
 */
export class InvocationLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private writes = 0;
  constructor(file = INVOCATIONS_LOG, maxBytes = INVOCATIONS_MAX_BYTES) { this.file = file; this.maxBytes = maxBytes; }

  static newId(): string { return `iv-${randomBytes(4).toString("hex")}`; }

  write(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (++this.writes % 100 === 0) dropOldestKeepNewest(this.file, this.maxBytes);
    } catch { /* 记录写不了不影响命令本身 */ }
  }
}
