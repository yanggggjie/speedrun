import { createHmac } from "node:crypto";
import { parseUrl, type ParsedUrl } from "../utils/url.ts";

/** 秘密的名字：加了边界，author、design 这类不会误伤。用在请求头名、查询参数名、JSON 的 key 上。 */
// 连写的名字也算：x-xsrftoken、csrftoken、accesstoken、authtoken（xsrf / csrf 出现在任何位置，或以 token 结尾）
const SECRET_NAME = /(^|[^a-z])(token|secret|password|passwd|pwd|csrf|xsrf|jwt|auth|authorization|api[-_]?key|access[-_]?key|session[-_]?id|cookie)([^a-z]|$)|xsrf|csrf|[a-z]token$/i;
/** 严格的 JWT：头部是 base64 的 `{"`，总是以 eyJ 开头，不会把 www.example.com 这样的域名当成 JWT。 */
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const ALIAS = /⟨(secret_[0-9a-f]{12}):\w+⟩/g;
const ALIAS_LIMIT = 20_000;

function shape(value: string): string {
  if (JWT.test(value)) return "jwt";
  if (UUID.test(value)) return "uuid";
  if (value.length >= 8 && HEX.test(value)) return "hex";
  if (/^\d+$/.test(value)) return "numeric";
  if (value.length >= 16 && BASE64URL.test(value)) return "base64url";
  if (/^[\p{L}\p{N}\s._:/-]+$/u.test(value)) return "text";
  return "opaque";
}

/**
 * 脱敏：把秘密换成别名 `⟨secret_a3f9c1e2d4b7:jwt⟩`。别名是"盐 + 真值"的 HMAC：同一个秘密永远是同一个别名（重启 daemon 也不变），
 * 不能由别名还原真值。真值只记在内存里的对照表（不落盘），`resolve` 用它把别名换回真值；daemon 重启后对照表是空的。
 */
export class Sanitizer {
  private readonly aliasKey: string;
  private readonly table = new Map<string, string>();

  constructor(aliasKey: string) { this.aliasKey = aliasKey; }

  private redact(raw: string): string {
    const alias = `secret_${createHmac("sha256", this.aliasKey).update(raw).digest("hex").slice(0, 12)}`;
    if (!this.table.has(alias)) {
      this.table.set(alias, raw);
      if (this.table.size > ALIAS_LIMIT) this.table.delete(this.table.keys().next().value as string);
    }
    return `⟨${alias}:${shape(raw)}⟩`;
  }

  /** 把文本里的别名换回真值；有别名不在对照表里（daemon 重启过）就报错。 */
  resolve(text: string): string {
    return text.replace(ALIAS, (whole, alias: string) => {
      const raw = this.table.get(alias);
      if (raw === undefined) throw new Error(`别名 ${whole} 已失效：真值只在 daemon 内存里，daemon 重启后就没了。在页面上再触发一次，重新取这个请求`);
      return raw;
    });
  }

  url(urlText: string): ParsedUrl {
    const parsed = parseUrl(urlText);
    for (const [name, value] of Object.entries(parsed.query)) {
      if (SECRET_NAME.test(name) || JWT.test(value)) parsed.query[name] = this.redact(value);
    }
    return parsed;
  }

  headers(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, raw] of Object.entries(headers)) {
      out[name] = SECRET_NAME.test(name) || JWT.test(raw) ? this.redact(raw) : raw;
    }
    return out;
  }

  /** JSON 逐层走，key 像秘密或值是 JWT 的换成别名；parseForm 为真时顶层的表单编码文本先拆成对象。正文里的自由文本不扫描。 */
  body(input: unknown, parseForm = false): unknown {
    const walk = (value: unknown, key = "", depth = 0): unknown => {
      if (depth > 20 || value == null) return value;
      if (typeof value === "string") {
        if (SECRET_NAME.test(key) || JWT.test(value)) return this.redact(value);
        if (depth === 0 && parseForm && value.includes("=")) {
          const obj: Record<string, string> = {};
          let count = 0;
          for (const [name, child] of new URLSearchParams(value)) {
            count++;
            obj[name] = SECRET_NAME.test(name) || JWT.test(child) ? this.redact(child) : child;
          }
          if (count > 0) return obj;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map((child) => walk(child, "", depth + 1));
      if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, walk(child, name, depth + 1)]));
      }
      return SECRET_NAME.test(key) ? this.redact(String(value)) : value;
    };
    return walk(input);
  }
}
