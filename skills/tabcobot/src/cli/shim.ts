import * as fs from "node:fs";
import * as path from "node:path";
import { TABCOBOT_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(TABCOBOT_HOME, "bin");
export const ENTRY = path.join(TABCOBOT_HOME, "src", "cli", "tabcobot.ts");

/** 写入 ~/.tabcobot/bin/tabcobot（sh）与 tabcobot.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "tabcobot");
  const cmd = path.join(BIN_DIR, "tabcobot.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}
