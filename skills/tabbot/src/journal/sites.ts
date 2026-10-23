import * as fs from "node:fs";
import * as path from "node:path";
import { JOURNAL_SITES_FILE } from "../utils/constants.ts";

/**
 * 录制范围。默认录所有 http / https 站点（mode "all"），但内置排除一批敏感站点（银行、支付、密码管理、登录、网页邮箱）；
 * 用户可以再排除（exclude），也可以把内置排除的重新打开（allow）。mode "only" 是只录点名的这几个站点。
 * 域名匹配：host 等于它，或以 ".它" 结尾（含子域名）。
 */
export type SitesConfig = { mode: "all" | "only"; only: string[]; exclude: string[]; allow: string[] };

export const BUILTIN_EXCLUDE: readonly string[] = [
  // 支付与银行
  "alipay.com", "paypal.com", "stripe.com", "pay.weixin.qq.com", "unionpay.com",
  "boc.cn", "icbc.com.cn", "ccb.com", "abchina.com", "cmbchina.com",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "hsbc.com",
  // 密码管理与统一登录
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com",
  "accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "id.apple.com",
  // 网页邮箱
  "mail.google.com", "outlook.live.com", "outlook.office.com", "mail.qq.com", "mail.163.com", "mail.126.com",
  "mail.yahoo.com", "proton.me", "protonmail.com",
];

/** 把用户输入（域名或网址）变成 host（小写，去掉开头的 www.），不合法返回 null。不折叠到注册域名：accounts.google.com 不能变成 google.com。 */
export function normalizeHost(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  let host: string;
  try { host = new URL(text.includes("://") ? text : `https://${text}`).hostname; } catch { return null; }
  host = host.replace(/^www\./, "");
  return host.includes(".") || host === "localhost" ? host : null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const uniq = (list: string[]): string[] => [...new Set(list)].sort();

/** 读配置。没有文件，或是旧版的 { sites: [...] }（只录点名站点），都按默认的"录所有站点"处理。 */
export function readConfig(file = JOURNAL_SITES_FILE): SitesConfig {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SitesConfig>;
    if (v.mode === "all" || v.mode === "only") return { mode: v.mode, only: strings(v.only), exclude: strings(v.exclude), allow: strings(v.allow) };
  } catch { /* 没有文件或损坏：用默认 */ }
  return { mode: "all", only: [], exclude: [], allow: [] };
}

export function writeConfig(config: SitesConfig, file = JOURNAL_SITES_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean: SitesConfig = { mode: config.mode, only: uniq(config.only), exclude: uniq(config.exclude), allow: uniq(config.allow) };
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

/** "all" 模式下实际排除的域名：内置的加用户排除的，去掉用户重新打开的。"only" 模式不用排除。 */
export function effectiveExclude(config: SitesConfig): string[] {
  if (config.mode !== "all") return [];
  return uniq([...BUILTIN_EXCLUDE, ...config.exclude]).filter((d) => !config.allow.includes(d));
}

/** 下发给扩展的内容。 */
export function extensionConfig(config: SitesConfig): { mode: "all" | "only"; sites: string[]; exclude: string[] } {
  return { mode: config.mode, sites: config.mode === "only" ? config.only : [], exclude: effectiveExclude(config) };
}

/** 一句话说明当前的录制范围。 */
export function describeConfig(config: SitesConfig): string {
  if (config.mode === "only") return config.only.length ? `只录 ${config.only.length} 个站点：${config.only.join(", ")}` : "只录点名的站点，但还没有点名任何站点（不录任何东西）";
  const user = config.exclude.length ? `，你另外排除了 ${config.exclude.join(", ")}` : "";
  const reopened = config.allow.length ? `，并重新打开了 ${config.allow.join(", ")}` : "";
  return `录制所有 http/https 站点，内置排除 ${BUILTIN_EXCLUDE.length} 个敏感站点（银行、支付、密码管理、登录、网页邮箱）${user}${reopened}`;
}
