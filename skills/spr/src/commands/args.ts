/** 一条命令的参数：values 是 speedrun 自己的参数（可重复，如 --answer），switches 是不带值的开关，params 是交给 action 的 `--名字 值`，rest 是不以 -- 开头的。 */
export type Args = { values: Map<string, string[]>; switches: Set<string>; params: Record<string, string>; rest: string[] };

/** values：认识的带值参数；switches：认识的开关；params 为真时，其余的 `--名字 值` 是 action 参数，否则报错。 */
export type ArgSpec = { values?: string[]; switches?: string[]; params?: boolean };

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析 `--名字 值` 和 `--名字=值`。值不能以 `--` 开头（多半是漏写了上一个参数的值）；确实要以 `--` 开头时写成 `--名字=值`。 */
export function parseArgs(args: string[], spec: ArgSpec): Args | { error: string } {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const params: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (spec.switches?.includes(name)) {
      if (eq >= 0) return { error: `--${name} 是开关，不带值` };
      switches.add(name);
      continue;
    }
    const known = spec.values?.includes(name) ?? false;
    if (!known && !spec.params) return { error: `不认识的参数 --${name}${didYouMean(name, [...(spec.values ?? []), ...(spec.switches ?? [])])}；可用：${[...(spec.values ?? []), ...(spec.switches ?? [])].map((n) => `--${n}`).join("、") || "（无）"}` };
    if (!known && !PARAM_NAME.test(name)) return { error: `参数要写成 --名字 值（名字只用字母、数字、下划线），不接受：${arg}` };
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return { error: `--${name} 缺少值` };
    if (eq < 0 && value.startsWith("--")) return { error: `--${name} 缺少值：后面紧跟的是 ${value}；值确实以 -- 开头时写成 --${name}=${value}` };
    if (known) { values.set(name, [...(values.get(name) ?? []), value]); continue; }
    if (name in params) return { error: `参数重复：--${name}` };
    params[name] = value;
  }
  return { values, switches, params, rest };
}

/** 拼错的参数名：编辑距离不超过 2 的，给「是不是想写」。 */
function didYouMean(name: string, known: string[]): string {
  const near = known.filter((k) => distance(k, name) <= 2).sort((a, b) => distance(a, name) - distance(b, name))[0];
  return near ? `（是不是想写 --${near}？）` : "";
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/** 某个参数最后一次给的值。 */
export const valueOf = (a: Args, name: string): string | undefined => a.values.get(name)?.at(-1);

