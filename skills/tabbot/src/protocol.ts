export const USAGE = "用法：tabbot tabs | log | sql | snapshot | text | wait | status | takeover | release | act | req | replay | daemon restart | doctor [--json]";
export type HandshakeStatus = "need-install" | "need-chrome" | "need-extension";
export type RpcMethod = "ping" | "run";
export type JsonRpcRequest = { jsonrpc: "2.0"; id: string; method: RpcMethod; params?: Record<string, unknown> };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string; result: unknown } | { jsonrpc: "2.0"; id: string; error: JsonRpcError };

export const RPC_ERRORS = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, HANDSHAKE: -32010 } as const;

export const HANDSHAKE_GUIDES: Record<HandshakeStatus, string> = {
  "need-install": "TabBot 还没有安装完成：扩展或 native messaging 注册缺失。",
  "need-chrome": "没检测到正在运行的 Google Chrome。",
  "need-extension": "TabBot 的 Chrome 扩展没有连上。",
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
export function formatHandshakeStdout(status: HandshakeStatus): string {
  return JSON.stringify({ status, guide: HANDSHAKE_GUIDES[status] }, null, 2);
}
/** 所有命令的失败输出：总是带 status，握手类失败另用 formatHandshakeStdout。 */
export function formatErrorStdout(error: string): string {
  return JSON.stringify({ status: "failure", error }, null, 2);
}
