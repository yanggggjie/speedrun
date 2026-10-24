import type { EventRow } from "../journal/types.ts";

type Detail = Record<string, any>;
const parse = (row: EventRow): Detail => { try { return row.detail ? JSON.parse(row.detail) : {}; } catch { return {}; } };
const lit = (v: unknown): string => JSON.stringify(v);

/** 一个网址的代码：没有查询参数就是字符串，有就用 serializeUrl（查询参数里的别名要换成 tabbot.params 或真值）。 */
function urlCode(bareUrl: string, query: Record<string, string> | undefined): string {
  const q = Object.entries(query ?? {});
  if (!q.length) return lit(bareUrl);
  return `serializeUrl({ bareUrl: ${lit(bareUrl)}, query: { ${q.map(([k, v]) => `${lit(k)}: ${lit(v)}`).join(", ")} } })`;
}

/**
 * 从 agent 做过的事（日志里来源 agent 的命令记录和重放）生成 task 草稿。
 * 只翻译，不猜：参数、成功判断都留给写 task 的人（agent）补，草稿里用注释标出。
 */
export function generateTask(name: string, rows: EventRow[], summary = ""): { code: string; steps: number; todo: string[] } {
  const lines: string[] = [];
  const todo: string[] = [];
  let steps = 0;
  const add = (line: string): void => { lines.push(`  ${line}`); steps++; };
  for (const row of rows) {
    const d = parse(row);
    if (d.ok === false) continue; // 失败的尝试不进 task
    if (row.kind === "net" && row.verb === "replay") {
      const base = row.url ?? "";
      add(`// 来自 tabbot replay #${(d.replayOf ?? "?")}；请求头自动继承页面自己的`);
      add(`const r${steps} = await request(page, { method: ${lit(row.method)}, url: ${lit(base)}${d.reqBody ? `, json: ${d.reqBody}` : ""} });`);
      add(`if (!r${steps - 1}.ok) throw new Error("请求失败 " + r${steps - 1}.status);`);
      todo.push("replay 的请求：地址里的别名、要变的字段换成参数，并检查响应里的业务码");
      continue;
    }
    if (row.kind !== "cmd") continue;
    switch (row.verb) {
      case "goto": add(`await goto(page, ${urlCode(d.bareUrl ?? d.url, d.query)});`); break;
      case "request": {
        const body = d.reqBody ? `, json: ${d.reqBody}` : "";
        add(`const res${steps} = await request(page, { method: ${lit(d.method)}, url: ${urlCode(d.bareUrl ?? d.url, d.query)}${body} });`);
        add(`if (!res${steps - 1}.ok) throw new Error("请求失败 " + res${steps - 1}.status);`);
        todo.push("request：要变的字段换成参数，并检查响应里的业务码");
        break;
      }
      case "click": case "fill": case "select": case "check": case "press": case "scroll": {
        const loc = d.loc !== undefined ? lit(d.loc) : undefined;
        if (loc === undefined && d.kind !== "scroll" && d.kind !== "press") { lines.push(`  // ${row.verb} ${d.ref ?? ""}：只有临时引用，没有持久定位；重新 act 一次用 CSS 或 role/name`); todo.push(`${row.verb} 缺持久定位`); break; }
        if (row.verb === "click") add(`await click(page, ${loc});`);
        else if (row.verb === "fill") add(`await fill(page, ${loc}, ${lit(d.text ?? "")});`);
        else if (row.verb === "select") add(`await select(page, ${loc}, ${lit(d.text ?? "")});`);
        else if (row.verb === "check") add(`await check(page, ${loc}, ${d.checked !== false});`);
        else if (row.verb === "press") add(`await press(page, ${lit(d.key)}${loc ? `, ${loc}` : ""});`);
        else add(`await scroll(page, ${lit({ ...(d.to ? { to: d.to } : { dy: d.dy ?? 600 }), ...(d.loc ? { loc: d.loc } : {}) })});`);
        break;
      }
      case "waitFor": add(`await waitFor(page, ${lit(d.loc)});`); break;
      case "eval": lines.push("  // eval：之前在页面里跑过一段代码（见日志），请改成 query 或 request"); todo.push("eval 要改写"); break;
    }
  }
  const header = ["/**", ` * @summary ${summary || "（补一句话：做什么）"}`, " * @status: draft", " * @param example? （补参数；没有参数就删掉这行）", " */"];
  const imports = 'import { tabbot, goto, request, click, fill, select, check, press, scroll, waitFor, text, query, evaluate, sleep, serializeUrl } from "../task/lib/index.js";';
  const code = [...header, imports, "", "await tabbot.run(async ({ page }) => {", ...lines, "  // TODO: 返回用户要的结果；有副作用的操作要先读状态、已满足就返回 already", "  return null;", "});", ""].join("\n");
  void name;
  return { code, steps, todo };
}
