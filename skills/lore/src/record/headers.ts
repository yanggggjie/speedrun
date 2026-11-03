// 请求头和请求体的几条通用规则：哪些头是浏览器自己管的、一个头的值在页面的各次请求里怎么变、哪些请求体没法照原样发。

/** 浏览器自己管的请求头：页面脚本设不了（或不该设），发请求时丢掉。 */
export const BROWSER_HEADERS = /^(host|content-length|cookie|origin|referer|user-agent|accept-encoding|accept-language|connection|keep-alive|transfer-encoding|upgrade|sec-.*|proxy-.*)$/i;
/** 录制时对请求体放的占位文字：说明请求体是文件、二进制或没读到，没法照原样发。 */
export const UNREPLAYABLE_BODY = /^\[(FormData|Blob|Binary|Request body not read|object)/;
/** 普通的内容协商、缓存头：不是鉴权，观察里不提。 */
const ORDINARY = /^(accept|content-type|cache-control|pragma|priority|dnt|range|if-.*)$/i;

/** 从原始请求头里去掉浏览器自己管的，变成可以交给 fetch 的头。 */
export function fetchableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (!BROWSER_HEADERS.test(k)) out[k.toLowerCase()] = v;
  return out;
}

/** 要关心的头：浏览器管的和普通的内容协商、缓存头之外的（鉴权、csrf、签名、自定义头）。 */
export function notableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fetchableHeaders(headers)).filter(([k]) => !ORDINARY.test(k)));
}

/**
 * 一个头的值在页面的各次请求里怎么变：page 同一次页面加载里所有带它的请求都是同一个值（token、xsrf、固定值）；
 * endpoint 同一个 endpoint 里不变、不同 endpoint 不一样；varies 同一个 endpoint 的各次请求也不同（签名、nonce、时间戳、trace id）；few 出现不到 3 次，还看不出来。
 */
export type HeaderKind = "page" | "endpoint" | "varies" | "few";
export const HEADER_KIND_TEXT: Record<HeaderKind, string> = { page: "页面级不变", endpoint: "按 endpoint 不变", varies: "每次都变", few: "样本太少" };
const MIN_SAMPLES = 3;

/**
 * 按头名统计一组请求（一个窗口里的同站请求）的值怎么变。在内存里比较真值，结果只有类别。
 * doc 是页面加载的编号（rid 的前半段）：token 跨页面加载可能换，只在同一次加载里比。
 */
type Seen = { doc: string; endpoint: string; value: string };

export function headerKinds(reqs: Array<{ endpoint: string; doc: string; headers: Record<string, string> }>): Map<string, HeaderKind> {
  const seen = new Map<string, Seen[]>();
  for (const r of reqs) for (const [k, value] of Object.entries(notableHeaders(r.headers))) {
    const list = seen.get(k) ?? [];
    list.push({ doc: r.doc, endpoint: r.endpoint, value });
    seen.set(k, list);
  }
  /** 按 group 分组后，有没有哪一组里出现了不止一个值。 */
  const differs = (list: Seen[], group: (x: Seen) => string): boolean => {
    const values = new Map<string, Set<string>>();
    for (const x of list) values.set(group(x), (values.get(group(x)) ?? new Set()).add(x.value));
    return [...values.values()].some((set) => set.size > 1);
  };
  const out = new Map<string, HeaderKind>();
  for (const [k, list] of seen) {
    if (list.length < MIN_SAMPLES) out.set(k, "few");
    else if (differs(list, (x) => `${x.doc}\n${x.endpoint}`)) out.set(k, "varies");
    else if (differs(list, (x) => x.doc)) out.set(k, "endpoint");
    else out.set(k, "page");
  }
  return out;
}

/** 页面加载的编号：rid 是「加载编号:请求序号」（page/recorder.js）。 */
export const docOf = (rid: string): string => rid.split(":")[0] ?? rid;
