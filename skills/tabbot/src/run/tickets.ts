import { randomBytes } from "node:crypto";

export const TICKET_MAX_OPS = 80;
export const TICKET_MAX_PER_SITE = 2;

export type Ticket = { id: string; task: string; goal: string; site: string; fix: boolean; ops: number; done: boolean; createdAt: number };

/**
 * 票据：Chef 派 Cook 时发的“小票”。绑定一份 task 名、一个 agent 窗口（key 就是票据号）。
 * 只在 holder 内存里；holder 重启后失效（Cook 的调试随之停下，由 Chef 重新派）。
 */
export class Tickets {
  private readonly map = new Map<string, Ticket>();

  issue(info: { task: string; goal: string; site: string; fix: boolean }): Ticket | { error: string } {
    const active = [...this.map.values()].filter((t) => !t.done && info.site && t.site === info.site);
    if (active.length >= TICKET_MAX_PER_SITE) return { error: `${info.site} 已经有 ${active.length} 个 Cook 在忙（同一站点最多 ${TICKET_MAX_PER_SITE} 个同时），等它们交了再派` };
    const t: Ticket = { id: `t-${randomBytes(4).toString("hex")}`, ...info, ops: 0, done: false, createdAt: Date.now() };
    this.map.set(t.id, t);
    return t;
  }

  /** 一次调试操作：校验票据并计数。 */
  use(id: string | undefined): Ticket | { error: string } {
    if (!id) return { error: "调试由 Cook 做：Chef 没有调试权限。缺 task 就 tabbot learn <task 名> --goal \"…\" 派一个 Cook，把输出的 brief 交给 subagent" };
    const t = this.map.get(id);
    if (!t) return { error: `票据 ${id} 不存在或已失效（holder 重启过？）：回报现状，由 Chef 重新派` };
    if (t.done) return { error: `票据 ${id} 的 task ${t.task} 已经交付，不再需要调试：现在写回报` };
    if (t.ops >= TICKET_MAX_OPS) return { error: `票据 ${id} 的调试操作用完了（${TICKET_MAX_OPS} 次）：回报当前进展，由 Chef 决定是否续派` };
    t.ops++;
    return t;
  }

  get(id: string): Ticket | undefined { return this.map.get(id); }

  /** 票据对应的 task 跑通了。 */
  finish(id: string): Ticket | undefined {
    const t = this.map.get(id);
    if (t) t.done = true;
    return t;
  }
}
