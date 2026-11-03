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
 * 不用注册域名：example.com 下的 expt、console、logs 是不同的系统，mail.google.com 和 docs.google.com 也是。
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
