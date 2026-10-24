import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/** 本机数据根目录（写死，无 env 覆盖）。 */
export const TABBOT_HOME = path.join(os.homedir(), ".tabbot");
export const SESSION_DIR = path.join(TABBOT_HOME, "session");
/** posix 用文件 socket；win32 用 named pipe（不是 fs 文件）。 */
export const SESSION_SOCK_IS_FILE = process.platform !== "win32";
export const SESSION_SOCK = SESSION_SOCK_IS_FILE
  ? path.join(SESSION_DIR, "sock")
  : `\\\\.\\pipe\\tabbot-${createHash("sha256").update(os.homedir()).digest("hex").slice(0, 12)}`;
/** relay 与 daemon 之间的扩展通道；win32 用独立 named pipe。 */
export const SESSION_EXT_SOCK = SESSION_SOCK_IS_FILE ? path.join(SESSION_DIR, "ext.sock") : `${SESSION_SOCK}-ext`;
export const SESSION_LOG = path.join(SESSION_DIR, "log.jsonl");
export const SESSION_LOG_MAX_BYTES = 20 * 1024 * 1024;

/** 等 holder 起来、扩展连上的最长时间。 */
export const HOLDER_READY_MS = 8_000;
/** 没有扩展连接、也没有命令请求超过这么久，holder 退出。 */
export const HOLDER_IDLE_EXIT_MS = 10 * 60_000;
/** holder 等扩展回包的上限。 */
export const EXTENSION_COMMAND_TIMEOUT_MS = 60_000;

/** 日志：一串分段目录 seg-<序号>/，每段含 events.db、bodies/、snapshots/；整体是按大小滚动的先进先出队列。 */
export const JOURNAL_DIR = path.join(TABBOT_HOME, "journal");
/** 当前分段写满这么多字节就新开一段。 */
export const JOURNAL_SEGMENT_BYTES = 50 * 1024 * 1024;
/** 日志目录总大小上限；新开分段时检查，超过就整段删除最旧的分段。 */
export const JOURNAL_CAP_BYTES = 500 * 1024 * 1024;

/** 别名的盐：别名是"盐 + 真值"的哈希，同一个秘密永远是同一个别名（重启 daemon 也是），但不能由别名还原真值。 */
export const JOURNAL_ALIAS_SALT_FILE = path.join(JOURNAL_DIR, "alias-salt");
