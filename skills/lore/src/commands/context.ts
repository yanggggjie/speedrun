import { EXIT, formatErrorStdout } from "../protocol.ts";
import { COMPOSE_DIR } from "../utils/constants.ts";
import type { TabInfo } from "../browser/extension.ts";
import type { RunHost } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";
import type { LearnWindow, LearnWindows } from "../learn/windows.ts";
import type { ActionRunner } from "../run/runner.ts";
import type { EndpointIndex } from "../record/endpoints.ts";
import type { Ingestor } from "../record/ingest.ts";
import type { RawStore } from "../record/raw.ts";
import type { WindowLog } from "../record/windowlog.ts";

/** daemon 提供给命令的能力。命令本身不持有状态。 */
export interface Ctx {
  /** 要经扩展的命令先调它：扩展没连上、没装、Chrome 没运行，抛出对应的握手错误。 */
  ensureExtension(): Promise<void>;
  tabs(): Promise<TabInfo[]>;
  host: RunHost;
  runner: ActionRunner;
  win: AgentWindows;
  learn: LearnWindows;
  ingest: Ingestor;
  raw: RawStore;
  /** 窗口日志；log.dir 是 sites 目录（站点的 endpoints.json、actions/ 在它下面）。 */
  log: WindowLog;
  index: EndpointIndex;
  daemon(): { extension: boolean; pid: number };
  /** compose 存放的目录（不给就是 ~/.lore/compose）。 */
  composeDir?: string;
}

/** 一条命令的输出：按行攒起来；fail、handshake 整个替换成那一种输出。 */
export class Output {
  private readonly lines: string[] = [];
  code: number = EXIT.ok;
  private override: string | undefined;
  line(text: string): void { this.lines.push(text); }
  fail(error: string): void { this.override = formatErrorStdout(error); this.code = EXIT.fail; }
  handshake(stdout: string): void { this.override = stdout; this.code = EXIT.wait; }
  result(): { stdout: string; code: number } { return { stdout: this.override ?? this.lines.join("\n"), code: this.code }; }
}

/** 关键命令都要带 --description：一句话用用户的话说这一步要做什么。lore 把它存进时间线和 endpoints.json，当成 endpoint 的 description。 */
export const DESCRIPTION_HINT = '要带 --description "一句话，用用户的话说这一步要做什么"（如"点开变更单里的 MR"，不是"click 410 421"）；它会存下来，成为这个 endpoint、action、compose 的 description';

export const composeDirOf = (ctx: Pick<Ctx, "composeDir">): string => ctx.composeDir ?? COMPOSE_DIR;
export const idleMin = (w: LearnWindow): number => Math.round((Date.now() - w.lastActive) / 60_000);
export const indent = (text: string): string => text.split("\n").map((l) => `  ${l}`).join("\n");
