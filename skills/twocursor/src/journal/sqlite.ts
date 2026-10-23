import type { DatabaseSync as Db } from "node:sqlite";

export type { Db };

let loaded: typeof import("node:sqlite") | undefined;

/**
 * node:sqlite 在 Node 24 里还会打印 ExperimentalWarning；CLI 的输出是给 agent 读的，不能带它。
 * 所以不静态 import，第一次用的时候先摘掉默认的 warning 监听再加载。
 */
export async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  if (loaded) return loaded;
  // 警告是异步发出的，不能加载完就把监听器还回去：换成只过滤这一条的监听器，其它警告照常打印。
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
    console.error(`(node) ${warning.name}: ${warning.message}`);
  });
  loaded = await import("node:sqlite");
  return loaded;
}

export async function openDb(file: string, options: { readOnly?: boolean } = {}): Promise<Db> {
  const { DatabaseSync } = await loadSqlite();
  return new DatabaseSync(file, options.readOnly ? { readOnly: true } : {});
}

/** 已经 loadSqlite 过之后的同步版本，写入路径用它（一批事件在一个事务里）。 */
export function openDbSync(file: string, options: { readOnly?: boolean } = {}): Db {
  if (!loaded) throw new Error("sqlite 还没加载");
  return new loaded.DatabaseSync(file, options.readOnly ? { readOnly: true } : {});
}
