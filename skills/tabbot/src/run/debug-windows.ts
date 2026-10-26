import { randomBytes } from "node:crypto";

export const DEBUG_MAX_OPS = 80;
/** debug 窗口这么久没有任何调试操作就回收（subagent 失败、被中断时不留下窗口）。 */
export const DEBUG_IDLE_MS = 30 * 60_000;

export type DebugWindow = { id: string; task: string; goal: string; site: string; fix: boolean; ops: number; done: boolean; createdAt: number; lastActive: number };

/**
 * debug 窗口的登记表：主 agent 派 subagent 时开一个，绑定一份 task 名；窗口号同时是 agent 窗口的 key。
 * 主 agent 自己长期持有的是 run 窗口（key 为 run），不在这里登记，也不能调试。
 * 只在 holder 内存里；holder 重启一切归零。
 */
export class DebugWindows {
  private readonly map = new Map<string, DebugWindow>();

  open(info: { task: string; goal: string; site: string; fix: boolean }): DebugWindow | { error: string } {
    if (!info.site) return { error: "debug 窗口要绑定一个站点（--site）" };
    const dup = [...this.map.values()].find((w) => !w.done && w.task === info.task);
    if (dup) return { error: `task ${info.task} 已经有 debug 窗口 ${dup.id} 在调试（同一件事只派一个 subagent）：等它回报，或让它 tabbot debug --window ${dup.id} close 放弃` };
    const now = Date.now();
    let id = "";
    do id = `debug-${randomBytes(2).toString("hex")}`; while (this.map.has(id));
    const w: DebugWindow = { id, ...info, ops: 0, done: false, createdAt: now, lastActive: now };
    this.map.set(w.id, w);
    return w;
  }

  /** 一次调试操作：校验窗口并计数。 */
  use(id: string | undefined): DebugWindow | { error: string } {
    if (!id) return { error: "调试由 subagent 做：主 agent 没有调试权限（run 窗口只执行 task）。缺 task 就 tabbot delegate <task 名> --goal \"…\" 派一个 subagent，把输出的 brief 交给 subagent" };
    const w = this.map.get(id);
    if (!w) return { error: `${id} 不是 debug 窗口，或已失效（holder 重启过？）：回报现状，由主 agent 重新派` };
    if (w.done) return { error: `debug 窗口 ${id} 已经收回（task ${w.task} 已交付或已放弃）：现在写回报` };
    if (w.ops >= DEBUG_MAX_OPS) return { error: `debug 窗口 ${id} 的调试操作用完了（${DEBUG_MAX_OPS} 次）：回报当前进展，由主 agent 决定是否续派` };
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
