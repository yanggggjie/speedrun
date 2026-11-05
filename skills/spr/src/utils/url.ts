import { getDomain } from "tldts";

export type ParsedUrl = {
  /** origin + pathname, no `?` or `#` */
  bareUrl: string;
  /** decoded query values */
  query: Record<string, string>;
};

/** Parse http(s) URL; query values stored decoded. */
export function parseUrl(raw: string): ParsedUrl {
  try {
    const u = new URL(raw);
    const query: Record<string, string> = {};
    for (const [key, value] of u.searchParams) query[key] = value;
    return { bareUrl: `${u.origin}${u.pathname}`, query };
  } catch {
    return { bareUrl: raw, query: {} };
  }
}

/** Registrable domain (eTLD+1); falls back to hostname. */
export function registrableDomain(u: ParsedUrl): string {
  try {
    const host = new URL(u.bareUrl).hostname;
    return getDomain(host) ?? host;
  } catch {
    return "";
  }
}

export function isSameSite(a: ParsedUrl, b: ParsedUrl): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== "" && da === db;
}

/**
 * 站点：页面的 host（非默认端口带上），小写，去掉前导 www.；不是 http(s) 网址返回空串。
 * 不用注册域名：example.com 下的 a、b、c 可以是不同的系统，mail.google.com 和 docs.google.com 也是。
 */
export function siteOfUrl(raw: string | undefined): string {
  try {
    const u = new URL(raw ?? "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
}

/** 站点对应的目录名：只留字母数字和 ._-，其余（冒号、斜杠等）换成下划线。 */
export function siteDirName(site: string): string {
  return site.replace(/[^a-z0-9._-]/gi, "_");
}

const LOGIN_URL = /(?:^|[/.\-_?=])(login|signin|sign-in|sso|passport|oauth|authorize|auth|cas)(?:[/.\-_?=]|$)|登录/i;
/** 地址看起来像登录页（login、sso、passport……）。 */
export const isLoginUrl = (url: string): boolean => LOGIN_URL.test(url);

/** 遇到登录失效时给 agent 的提醒：先看页面，点一下能登录的自己点，要账号密码、扫码、验证码的请用户登录。 */
export const LOGIN_HINT = "点一下就能登录的（快速登录、使用此账号继续）自己点，点前点后各 find / read_page 确认；要账号密码、二维码、验证码的停下来请用户在 Chrome 里登录，登录后重跑同一条命令。不要因此重新 debug、不要改 action";
