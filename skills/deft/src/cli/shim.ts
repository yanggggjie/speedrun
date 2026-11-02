import * as fs from "node:fs";
import * as path from "node:path";
import { DEFT_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(DEFT_HOME, "bin");
export const ENTRY = path.join(DEFT_HOME, "src", "cli", "deft.ts");

/** 写入 ~/.deft/bin/deft（sh）与 deft.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "deft");
  const cmd = path.join(BIN_DIR, "deft.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}
