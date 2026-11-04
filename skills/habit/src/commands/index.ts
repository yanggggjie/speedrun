/**
 * 命令行的全部命令：habit <argv> 原样发给 daemon，daemon 调 runCommand，返回文本和退出码，CLI 只负责打印。
 * 输出约定见 protocol.ts：第一行 ok / fail / ask，后面是「标题：内容」的几段。
 *
 * 只保留必须由 habit 做的事：控制浏览器（learn / run）、持有不能落盘的原始请求、运维。两种窗口：
 * learn 窗口（habit learn，learn.ts）带持久的句柄，一直保留，learn 都在里面做；run 窗口（habit run，run.ts）每次新开，跑完就关。
 * 读日志不是命令：日志是窗口目录里的文件（learn-windows/<句柄>/、run-windows/<名字>/），action 和 endpoints.json 在 sites/<站点>/，用 rg / node / Python 读，见 SKILL.md。
 */
import * as path from "node:path";
import { USAGE, handshakeStatusFromError, formatHandshakeStdout } from "../protocol.ts";
import { LOG_LIMITS, MB } from "../utils/constants.ts";
import { draftActions } from "../run/actions.ts";
import { Output, composeDirOf, type Ctx } from "./context.ts";
import { learnCommand } from "./learn.ts";
import { runCommand as runRun } from "./run.ts";

export type { Ctx } from "./context.ts";

/** 执行一条命令。argv 是 `habit` 后面的全部参数。 */
export async function runCommand(argv: string[], ctx: Ctx): Promise<{ stdout: string; code: number }> {
  const out = new Output();
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "tabs": await tabsCommand(ctx, out); break;
      case "status": statusCommand(ctx, out); break;
      case "run": await runRun(args, ctx, out); break;
      case "learn": await learnCommand(args, ctx, out); break;
      default: out.fail(USAGE);
    }
  } catch (error) {
    const status = handshakeStatusFromError(error);
    if (status) out.handshake(formatHandshakeStdout(status));
    else out.fail(error instanceof Error ? error.message : String(error));
  }
  return out.result();
}

/** 用户自己的标签页；agent 窗口里的不在这里。 */
async function tabsCommand(ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const tabs = (await ctx.tabs()).filter((t) => !t.habit);
  if (tabs.length === 0) return out.line("ok 没有打开的 http/https 标签页");
  out.line(`ok ${tabs.length} 个标签页`);
  for (const t of tabs) out.line(`  tab${t.tabId} win${t.windowId} ${t.active ? "前台" : "后台"} ${t.url} "${t.title}"`);
}

function statusCommand(ctx: Ctx, out: Output): void {
  const u = ctx.log.usage();
  const mb = (n: number): string => (n / MB).toFixed(1);
  const d = ctx.daemon();
  out.line(`ok daemon 在运行（pid ${d.pid}），扩展${d.extension ? "已连接" : "未连接"}`);
  out.line(`日志：learn 窗口 ${ctx.log.listWindows("learn").length} 个窗口，时间线和请求文件 ${mb(u.learn.light)}MB / ${LOG_LIMITS.totalLight / MB}MB，响应体、页面和截图 ${mb(u.learn.heavy)}MB / ${LOG_LIMITS.totalHeavy / MB}MB；run 窗口日志 ${ctx.log.listWindows("run").length} 个；最新编号 #${ctx.log.lastSeq()}`);
  const drafts = draftActions(ctx.log.dir);
  if (drafts.length) out.line(`还没跑通的 draft（@status draft）：${drafts.map((t) => `${t.name}（${t.site}${t.write ? "，@write" : ""}）`).join("、")}；habit run --action <名字> 真跑成功就变成 verified；带 @write 的等用户真要做这件事时再跑，不用为了变成 verified 去真发`);
  out.line(`learn 窗口：habit learn list`);
  out.line(`目录：learn 窗口 ${path.join(ctx.log.root, "learn-windows")}，run 窗口 ${path.join(ctx.log.root, "run-windows")}，站点目录 ${ctx.log.dir}（每个站点：endpoints.json、actions/），compose ${composeDirOf(ctx)}`);
}
