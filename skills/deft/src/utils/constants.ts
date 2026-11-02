import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/** 本机数据根目录（写死，无 env 覆盖）。 */
export const DEFT_HOME = path.join(os.homedir(), ".deft");
export const SESSION_DIR = path.join(DEFT_HOME, "session");
/** posix 用文件 socket；win32 用 named pipe（不是 fs 文件）。 */
export const SESSION_SOCK_IS_FILE = process.platform !== "win32";
export const SESSION_SOCK = SESSION_SOCK_IS_FILE
  ? path.join(SESSION_DIR, "sock")
  : `\\\\.\\pipe\\deft-${createHash("sha256").update(os.homedir()).digest("hex").slice(0, 12)}`;
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

/** 站点目录：<站点>/{endpoints.json, actions/}，只放知识；日志按窗口放在 learn-windows/、run-windows/，见 journal/windowlog.ts。 */
export const SITES_DIR = path.join(DEFT_HOME, "sites");
/** run 窗口目录只留最近这么多个。 */
export const RUN_WINDOWS_KEEP = 100;
/** action 的 SDK（由 holder 启动时从 src/action-lib 同步）；action 脚本在 sites/<站点>/actions/ 下，从 ../../../lib/index.js 引用它。 */
export const LIB_DIR = path.join(DEFT_HOME, "lib");
/** 别名的盐：别名是"盐 + 真值"的哈希，同一个秘密永远是同一个别名（重启 daemon 也是），但不能由别名还原真值。 */
export const ALIAS_SALT_FILE = path.join(DEFT_HOME, "alias-salt");

/** 学习窗口日志的存储预算（总计 2GB）：轻量层 = meta、时间线与请求文件，重量层 = 响应体、页面、截图。 */
export const MB = 1024 * 1024;
export const LOG_LIMITS = {
  totalLight: 500 * MB,
  totalHeavy: 1536 * MB,
  /** 每个站点受保护的接口样本合计上限。 */
  siteSamples: 100 * MB,
} as const;
/** endpoints.json 脏了之后最多隔这么久写一次。 */
export const ENDPOINTS_FLUSH_MS = 2_000;

/** 跨站点的组合实现（起了名字的），以及没起名字的组合（按代码哈希命名）。只用到一个站点的组合放在那个站点的 actions/ 下。 */
export const COMPOSE_DIR = path.join(DEFT_HOME, "compose");
/** 没起名字的组合（哈希命名）最多留这么多个；起了名字的不删。 */
export const UNNAMED_COMPOSE_KEEP = 200;
/** 整个 action 默认最长运行时间；文件头 `@timeout <秒>` 可改。 */
export const ACTION_TIMEOUT_MS = 115_000;
/** action 里单个步骤（goto、request、等元素）的上限。 */
export const STEP_TIMEOUT_MS = 60_000;
/** 学习窗口里空闲的标签页保留多久再关掉。只录 agent 窗口，请求头只能从这些页面继承，留久一点少重开。 */
export const AGENT_TAB_IDLE_MS = 30 * 60_000;
