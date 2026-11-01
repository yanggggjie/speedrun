import { workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/** action 的 worker 线程入口：加载 action 文件，剩下的由 action-lib 里的 tabbot.run 通过 parentPort 和 holder 通信。 */
const { file } = workerData as { file: string };
await import(pathToFileURL(file).href);
