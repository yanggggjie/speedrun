export const USAGE = "用法：lore learn new --url <链接|tab 号> --description \"…\" | learn <句柄> <工具> … | learn list | learn close <句柄> | run --action <名> | run --compose <名> | run --compose-code '代码' | run --resume <编号> --answer '<json>' | tabs | status | daemon restart | doctor [--json]；日志在 ~/.lore/learn-windows/、run-windows/，action 和 endpoints.json 在 ~/.lore/sites/<站点>/，见 SKILL.md";
export type HandshakeStatus = "need-install" | "need-chrome" | "need-extension";
export type RpcMethod = "ping" | "run";
export type JsonRpcRequest = { jsonrpc: "2.0"; id: string; method: RpcMethod; params?: Record<string, unknown> };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string; result: unknown } | { jsonrpc: "2.0"; id: string; error: JsonRpcError };

export const RPC_ERRORS = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, HANDSHAKE: -32010 } as const;

export const HANDSHAKE_GUIDES: Record<HandshakeStatus, string> = {
  "need-install": "lore 还没有安装完成：扩展或 native messaging 注册缺失。",
  "need-chrome": "没检测到正在运行的 Google Chrome。",
  "need-extension": "lore 的 Chrome 扩展没有连上。",
};

export function isHandshakeStatus(status: string): status is HandshakeStatus {
  return status in HANDSHAKE_GUIDES;
}
export function handshakeStatusFromError(error: unknown): HandshakeStatus | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "NeedInstallError") return "need-install";
  if (error.name === "NeedChromeError") return "need-chrome";
  if (error.name === "NeedExtensionError") return "need-extension";
  return null;
}
/**
 * 所有命令的输出约定：第一行是结论，以 ok、fail、ask 开头；后面是「标题：内容」的几段（多行的内容缩进两格）。
 * 退出码：ok 是 0，fail 是 1，ask 和 need-* 是 2（要 agent 判断或要用户做一件事，不算失败）。
 */
export const EXIT = { ok: 0, fail: 1, wait: 2 } as const;
export function formatHandshakeStdout(status: HandshakeStatus): string {
  return `fail ${status}：${HANDSHAKE_GUIDES[status]}`;
}
export function formatErrorStdout(error: string): string {
  return `fail ${error}`;
}
