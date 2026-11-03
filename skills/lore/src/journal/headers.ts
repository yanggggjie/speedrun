// 请求头和请求体的几条通用规则：哪些头是浏览器自己管的、哪些是每次都变的签名、哪些请求体没法照原样发。

/** 浏览器自己管的请求头：页面脚本设不了（或不该设），发请求时丢掉。 */
export const BROWSER_HEADERS = /^(host|content-length|cookie|origin|referer|user-agent|accept-encoding|accept-language|connection|keep-alive|transfer-encoding|upgrade|sec-.*|proxy-.*)$/i;
/** 录制时对请求体放的占位文字：说明请求体是文件、二进制或没读到，没法照原样发。 */
export const UNREPLAYABLE_BODY = /^\[(FormData|Blob|Binary|Request body not read|object)/;
/** 签名、时间戳、一次性随机数这类每次请求都会变的头或参数：照搬通常会被拒。 */
export const VOLATILE = /(^|[-_])(sign|signature|nonce|bogus|timestamp|zse|ts|t)([-_]|$)|^x-s(-common)?$|^msToken$|^a_bogus$/i;

/** 从原始请求头里去掉浏览器自己管的，变成可以交给 fetch 的头。 */
export function fetchableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (!BROWSER_HEADERS.test(k)) out[k.toLowerCase()] = v;
  return out;
}
