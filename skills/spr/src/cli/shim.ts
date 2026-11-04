import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_HOME } from "../utils/constants.ts";
import { cmdQuote, shQuote } from "../utils/shell.ts";

export const BIN_DIR = path.join(DATA_HOME, "bin");
export const ENTRY = path.join(DATA_HOME, "src", "cli", "spr.ts");

/** 写入 ~/.speedrun/bin/spr（sh）与 spr.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "spr");
  const cmd = path.join(BIN_DIR, "spr.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(ENTRY)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n${cmdQuote(nodePath)} ${cmdQuote(ENTRY)} %*\r\n`);
  return [sh, cmd];
}
