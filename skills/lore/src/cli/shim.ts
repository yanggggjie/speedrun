import * as fs from "node:fs";
import * as path from "node:path";
import { LORE_HOME } from "../utils/constants.ts";

export const BIN_DIR = path.join(LORE_HOME, "bin");
export const ENTRY = path.join(LORE_HOME, "src", "cli", "lore.ts");

/** 写入 ~/.lore/bin/lore（sh）与 lore.cmd（Windows）。nodePath 写进 shim，不依赖 PATH。 */
export function writeShim(nodePath: string = process.execPath): string[] {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sh = path.join(BIN_DIR, "lore");
  const cmd = path.join(BIN_DIR, "lore.cmd");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${nodePath}" "${ENTRY}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(cmd, `@echo off\r\n"${nodePath}" "${ENTRY}" %*\r\n`);
  return [sh, cmd];
}
