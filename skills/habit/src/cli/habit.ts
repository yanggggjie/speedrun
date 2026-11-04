/**
 * habit 唯一命令入口：由 ~/.habit/bin/habit shim 调用：node ~/.habit/src/cli/habit.ts "$@"
 * 这里没有命令逻辑：参数原样交给 daemon（commands/index.ts），打印它返回的文本，用它返回的退出码。
 * 只有 doctor 和 daemon restart 留在这里，因为它们要诊断或重启一个可能已经不在的 daemon。
 */
import { runOnDaemon, stopDaemon } from "../session/client.ts";
import { handleDoctor } from "./doctor.ts";
import { EXIT, USAGE, formatErrorStdout } from "../protocol.ts";
import { assertNode24 } from "../utils/node.ts";

function print(text: string): void {
  console.log(text);
}

function fail(error: string, code: number = EXIT.fail): void {
  console.log(formatErrorStdout(error));
  process.exitCode = code;
}

/** habit daemon restart：让 daemon 退出（换完代码后让新代码生效用）。不等新的起来：下一条命令或扩展重连时会拉起新的。 */
async function daemonRestart(): Promise<void> {
  const result = await stopDaemon();
  if (result === "none") return print("ok 没有运行中的 daemon，不用重启");
  if (result === "timeout") return fail("daemon 10 秒内没有退出：看 ~/.habit/session/log.jsonl");
  print("ok 旧 daemon 已退出；下一条命令或扩展重连时会启动新的");
}

async function main(argv: string[]): Promise<void> {
  assertNode24();
  const [cmd, sub] = argv;
  if (!cmd) return fail(USAGE, EXIT.usage);
  if (cmd === "doctor") return handleDoctor(argv.includes("--json"));
  if (cmd === "daemon") return sub === "restart" && argv.length === 2 ? daemonRestart() : fail(`用法：habit daemon restart`, EXIT.usage);
  const { stdout, code } = await runOnDaemon(argv);
  console.log(stdout);
  process.exitCode = code;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
