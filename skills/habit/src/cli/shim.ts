import * as fs from "node:fs";
import * as path from "node:path";
import { HABIT_HOME } from "../utils/constants.ts";
import { cmdQuote, shQuote } from "../utils/shell.ts";

export const BIN_DIR = path.join(HABIT_HOME, "bin");
export const ENTRY = path.join(HABIT_HOME, "src", "cli", "habit.ts");

/** 写入 ~/.habit/bin/habit（sh）与 habit.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "habit");
  const cmd = path.join(BIN_DIR, "habit.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(ENTRY)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n${cmdQuote(nodePath)} ${cmdQuote(ENTRY)} %*\r\n`);
  return [sh, cmd];
}
