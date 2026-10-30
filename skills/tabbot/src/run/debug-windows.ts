import { randomBytes } from "node:crypto";

export const DEBUG_MAX_OPS = 80;
/** 学习会话（debug 窗口）这么久没有任何调试操作就回收（学到一半被中断时不留下窗口）。 */
export const DEBUG_IDLE_MS = 30 * 60_000;

/** 引发请求后的锁定：t 是锁定时刻；task 草稿在这之后被改过才解锁（commands.ts 的 lockReason）。 */
export type DebugLock = { t: number; seqs: number[] };

export type DebugWindow = { id: string; task: string; goal: string; site: string; fix: boolean; ops: number; done: boolean; createdAt: number; lastActive: number; lock?: DebugLock };

/**
 * 学习会话（debug 窗口）的登记表：agent 学一个请求时开一个（tabbot learn），绑定一份 task 名；窗口号同时是 agent 窗口的 key。
 * 执行 task 用的是 run 窗口（key 为 run），不在这里登记，也不能调试：调试只能在学习会话里做，会话有头有尾，产出必须是一份 task。
 * 只在 holder 内存里；holder 重启一切归零。
 */
export class DebugWindows {
  private readonly map = new Map<string, DebugWindow>();

  open(info: { task: string; goal: string; site: string; fix: boolean }): DebugWindow | { error: string } {
    if (!info.site) return { error: "debug 窗口要绑定一个站点（--site）" };
    const dup = [...this.map.values()].find((w) => !w.done && w.task === info.task);
    if (dup) return { error: `task ${info.task} 已经有学习会话 ${dup.id} 在学（同一份 task 只开一个）：接着用它，或 tabbot debug --window ${dup.id} close 放弃` };
    const now = Date.now();
    let id = "";
    do id = `debug-${randomBytes(2).toString("hex")}`; while (this.map.has(id));
    const w: DebugWindow = { id, ...info, ops: 0, done: false, createdAt: now, lastActive: now };
    this.map.set(w.id, w);
    return w;
  }

  /** 一次调试操作：校验窗口并计数。没写窗口号时，只开着一个会话就用它。 */
  use(id: string | undefined): DebugWindow | { error: string } {
    if (!id) {
      const open = this.active();
      if (open.length === 0) return { error: "没有学习会话：调试要先开会话，tabbot learn <task 名> --site <站点> --endpoint \"方法 接口名\"（或 --find \"要的数据或动作\"）学会一个请求" };
      if (open.length > 1) return { error: `开着 ${open.length} 个学习会话（${open.map((w) => w.id).join("、")}）：用 --window <窗口号> 指定` };
      id = open[0]!.id;
    }
    const w = this.map.get(id);
    if (!w) return { error: `${id} 不是学习会话，或已失效（holder 重启过？）：重新 tabbot learn` };
    if (w.done) return { error: `学习会话 ${id} 已经收回（task ${w.task} 已验证或已放弃）` };
    if (w.ops >= DEBUG_MAX_OPS) return { error: `学习会话 ${id} 的调试操作用完了（${DEBUG_MAX_OPS} 次）：需要登录就请用户在 Chrome 里登录；否则 tabbot debug close --blocked "原因和证据"` };
    w.ops++;
    w.lastActive = Date.now();
    return w;
  }

  get(id: string): DebugWindow | undefined { return this.map.get(id); }

  /** 收回：交付、放弃、超时都走这里。 */
  finish(id: string): DebugWindow | undefined {
    const w = this.map.get(id);
    if (w) w.done = true;
    return w;
  }

  active(): DebugWindow[] { return [...this.map.values()].filter((w) => !w.done); }

  /** 空闲太久的 debug 窗口。 */
  idle(now = Date.now(), idleMs = DEBUG_IDLE_MS): DebugWindow[] { return this.active().filter((w) => now - w.lastActive >= idleMs); }
}
