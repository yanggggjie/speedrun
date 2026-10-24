import { getDomain } from "tldts";

export type TabBotUrl = {
  /** origin + pathname, no `?` or `#` */
  bareUrl: string;
  /** decoded query values */
  query: Record<string, string>;
};

/** Parse http(s) URL; query values stored decoded. */
export function parseUrl(raw: string): TabBotUrl {
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
export function registrableDomain(u: TabBotUrl): string {
  try {
    const host = new URL(u.bareUrl).hostname;
    return getDomain(host) ?? host;
  } catch {
    return "";
  }
}

export function isSameSite(a: TabBotUrl, b: TabBotUrl): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== "" && da === db;
}
