import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/** action 的 worker 线程入口：加载 action 文件，调用它的 `export default async (参数) => 结果`，把结果或错误交回 daemon。 */
const { file, params } = workerData as { file: string; params: Record<string, unknown> };
try {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error("文件要写 export default async ({ 参数 }) => { … return 结果; }");
  const result = await (mod.default as (p: Record<string, unknown>) => unknown)(params);
  parentPort?.postMessage({ type: "done", result: result === undefined ? null : result });
} catch (e) {
  const err = e as { stack?: string; message?: string } | undefined;
  parentPort?.postMessage({ type: "fail", error: String(err?.stack ?? e), message: String(err?.message ?? e) });
}
