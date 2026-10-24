import { workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/** task 的 worker 线程入口：加载 task 文件，剩下的由 task-lib 里的 tabbot.run 通过 parentPort 和 holder 通信。 */
const { file } = workerData as { file: string };
await import(pathToFileURL(file).href);
