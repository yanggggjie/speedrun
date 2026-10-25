import { workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/** recipe 的 worker 线程入口：加载 recipe 文件，剩下的由 recipe-lib 里的 tabbot.run 通过 parentPort 和 holder 通信。 */
const { file } = workerData as { file: string };
await import(pathToFileURL(file).href);
