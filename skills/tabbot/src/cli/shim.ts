import * as fs from "node:fs";
import * as path from "node:path";
import { TABBOT_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(TABBOT_HOME, "bin");
export const ENTRY = path.join(TABBOT_HOME, "src", "cli", "tabbot.ts");

/** 写入 ~/.tabbot/bin/tabbot（sh）与 tabbot.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "tabbot");
  const cmd = path.join(BIN_DIR, "tabbot.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}
