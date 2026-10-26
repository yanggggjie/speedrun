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

/** 站点目录：<站点>/{endpoints.json, tasks/, log/<段>/, debug/<窗口号>/}；日志按站点、按段、按窗口分文件，见 journal/sitelog.ts。 */
export const SITES_DIR = path.join(TABBOT_HOME, "sites");
/** task SDK（由 holder 启动时从 src/task-lib 同步）；task 脚本在 sites/<站点>/tasks/ 下，从 ../../../lib/index.js 引用它。 */
export const LIB_DIR = path.join(TABBOT_HOME, "lib");
/** 别名的盐：别名是"盐 + 真值"的哈希，同一个秘密永远是同一个别名（重启 daemon 也是），但不能由别名还原真值。 */
export const ALIAS_SALT_FILE = path.join(TABBOT_HOME, "alias-salt");

/** 日志存储预算（总计 2GB）：轻量层 = 时间线与请求文件，重量层 = 响应体、HTML 文档、页面快照。 */
export const MB = 1024 * 1024;
export const LOG_LIMITS = {
  totalLight: 500 * MB,
  totalHeavy: 1536 * MB,
  siteLight: 150 * MB,
  siteHeavy: 600 * MB,
  /** 每个站点受保护的接口样本合计上限。 */
  siteSamples: 100 * MB,
} as const;
/** 当前段的重量层写满这么多、或开了这么久，就换新的一段。 */
export const LOG_SEGMENT_BYTES = 64 * MB;
export const LOG_SEGMENT_MS = 24 * 60 * 60_000;
/** endpoints.json 脏了之后最多隔这么久写一次。 */
export const ENDPOINTS_FLUSH_MS = 2_000;

/** 每次 task 运行的输入与输出，每个 task 保留最近 RUN_HISTORY_KEEP 份，只用于排查。 */
export const RUN_DIR = path.join(TABBOT_HOME, "run");
export const RUN_HISTORY_KEEP = 20;
/** 整个 task 默认最长运行时间；文件头 `@timeout <秒>` 可改。 */
export const TASK_TIMEOUT_MS = 115_000;
/** task 里单个步骤（goto、request、等元素）的上限。 */
export const STEP_TIMEOUT_MS = 60_000;
/** 另一个 task 在跑时，新的 task 最多等这么久再失败。 */
export const RUN_BUSY_WAIT_MS = 30_000;
/** tabbot agent 窗口里空闲的标签页保留多久再关掉。 */
export const AGENT_TAB_IDLE_MS = 5 * 60_000;
