/**
 * lore 唯一命令入口：由 ~/.lore/bin/lore shim 调用：node ~/.lore/src/cli/lore.ts "$@"
 * 这里没有命令逻辑：参数原样交给 daemon（commands/index.ts），打印它返回的文本，用它返回的退出码。
 * 只有 doctor 和 daemon restart 留在这里，因为它们要诊断或重启一个可能已经不在的 daemon。
 */
import { restartDaemon, runOnDaemon } from "./session.ts";
import { handleDoctor } from "./doctor.ts";
import { USAGE, formatErrorStdout } from "../protocol.ts";
import { assertNode24 } from "../utils/node.ts";

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fail(error: string): void {
  console.log(formatErrorStdout(error));
  process.exitCode = 1;
}

/** lore daemon restart：按 pid 重启 daemon。换完代码后让新 daemon 生效用。 */
async function daemonRestart(): Promise<void> {
  const result = await restartDaemon();
  if (result.action === "none") return print("ok 没有运行中的 daemon，不用重启");
  if (result.action === "failed") return fail("已让旧 daemon 退出，但新 daemon 还没连上；稍等，或在 chrome://extensions 刷新 lore");
  print(result.action === "restarted" ? "ok daemon 已重启" : "ok 旧 daemon 已退出，扩展重连时会启动新的");
}

async function main(argv: string[]): Promise<void> {
  assertNode24();
  const [cmd, sub] = argv;
  if (!cmd) return fail(USAGE);
  if (cmd === "doctor") return handleDoctor(argv.includes("--json"));
  if (cmd === "daemon") return sub === "restart" ? daemonRestart() : fail(USAGE);
  const { stdout, code } = await runOnDaemon(argv);
  console.log(stdout);
  process.exitCode = code;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
