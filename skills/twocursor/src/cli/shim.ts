import * as fs from "node:fs";
import * as path from "node:path";
import { TWOCURSOR_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(TWOCURSOR_HOME, "bin");
export const ENTRY = path.join(TWOCURSOR_HOME, "src", "cli", "twocursor.ts");

/** 写入 ~/.twocursor/bin/twocursor（sh）与 twocursor.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "twocursor");
  const cmd = path.join(BIN_DIR, "twocursor.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}
