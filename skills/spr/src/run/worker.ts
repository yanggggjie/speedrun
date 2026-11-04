import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/** action 的 worker 线程入口：加载 action 文件，调用它的 `export default async () => 结果`，把结果或错误交回 daemon。 */
const { file } = workerData as { file: string };
try {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error("action 文件要写 export default async () => { … return 结果; }");
  const result = await (mod.default as () => unknown)();
  parentPort?.postMessage({ type: "done", result: result === undefined ? null : result });
} catch (e) {
  const err = e as { stack?: string; message?: string } | undefined;
  parentPort?.postMessage({ type: "fail", error: String(err?.stack ?? e), message: String(err?.message ?? e) });
}
