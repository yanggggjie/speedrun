import * as fs from "node:fs";
import * as path from "node:path";
import { getDomain } from "tldts";
import { JOURNAL_SITES_FILE } from "../utils/constants.ts";

/** 把用户输入（域名或网址）变成可注册域名，不合法返回 null。 */
export function normalizeSite(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  let host = text;
  try { host = new URL(text.includes("://") ? text : `https://${text}`).hostname; } catch { return null; }
  return getDomain(host) ?? (host.includes(".") ? host : null);
}

export function readSites(file = JOURNAL_SITES_FILE): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { sites?: unknown };
    return Array.isArray(value.sites) ? value.sites.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}

export function writeSites(sites: string[], file = JOURNAL_SITES_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sites: [...new Set(sites)].sort() }, null, 2), { mode: 0o600 });
}
