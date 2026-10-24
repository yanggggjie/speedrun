/**
 * Chrome 本机状态检测。连接本身由扩展经 native messaging 建立（见 extension.ts），
 * 这里只负责判断"还缺什么"：Chrome 没装、没运行、扩展未连接。
 */
import { spawnSync } from "node:child_process";
import { HANDSHAKE_GUIDES, type HandshakeStatus } from "../protocol.ts";
import { nativeHostInstalled } from "../native-messaging-host/install.ts";

export class NeedInstallError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-install"]);
    this.name = "NeedInstallError";
  }
}

export class NeedChromeError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-chrome"]);
    this.name = "NeedChromeError";
  }
}

export class NeedExtensionError extends Error {
  constructor() {
    super(HANDSHAKE_GUIDES["need-extension"]);
    this.name = "NeedExtensionError";
  }
}

/** Chrome 进程是否在运行。Chrome 运行但扩展未连接 → need-extension；未运行 → need-chrome。 */
export function chromeRunning(): boolean {
  if (process.platform === "darwin") {
    return spawnSync("pgrep", ["-x", "Google Chrome"]).status === 0;
  }
  if (process.platform === "win32") {
    return spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe"]).stdout?.toString().includes("chrome.exe") ?? false;
  }
  return spawnSync("pgrep", ["-x", "chrome"]).status === 0 || spawnSync("pgrep", ["-x", "google-chrome"]).status === 0;
}

/** 没装 host → need-install；Chrome 没运行 → need-chrome；否则就是扩展没连上 → need-extension。 */
export function missingStatus(): HandshakeStatus {
  if (!nativeHostInstalled()) return "need-install";
  if (!chromeRunning()) return "need-chrome";
  return "need-extension";
}

export function handshakeError(status: HandshakeStatus): Error {
  return status === "need-install" ? new NeedInstallError() : status === "need-chrome" ? new NeedChromeError() : new NeedExtensionError();
}
