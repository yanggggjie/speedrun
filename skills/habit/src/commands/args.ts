/** 一条命令的参数：values 是 habit 自己的参数（可重复，如 --answer），switches 是不带值的开关，params 是交给 action 的 `--名字 值`，rest 是不以 -- 开头的。 */
export type Args = { values: Map<string, string[]>; switches: Set<string>; params: Record<string, string>; rest: string[] };

/** values：认识的带值参数；switches：认识的开关；params 为真时，其余的 `--名字 值` 是 action 参数，否则报错。 */
export type ArgSpec = { values?: string[]; switches?: string[]; params?: boolean };

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析 `--名字 值` 和 `--名字=值`。 */
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
    if (!known && !spec.params) return { error: `不认识的参数 --${name}` };
    if (!known && !PARAM_NAME.test(name)) return { error: `参数要写成 --名字 值（名字只用字母、数字、下划线），不接受：${arg}` };
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return { error: `--${name} 缺少值` };
    if (known) { values.set(name, [...(values.get(name) ?? []), value]); continue; }
    if (name in params) return { error: `参数重复：--${name}` };
    params[name] = value;
  }
  return { values, switches, params, rest };
}

/** 某个参数最后一次给的值。 */
export const valueOf = (a: Args, name: string): string | undefined => a.values.get(name)?.at(-1);

/** `--description` 的值（去掉首尾空白，空的当没给）。 */
export const descriptionOf = (a: Args): string | undefined => valueOf(a, "description")?.trim() || undefined;
