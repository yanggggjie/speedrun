import * as fs from "node:fs";
import { actionSummary, findAction, isCompose } from "./actions.ts";

/**
 * 执行前检查：只读文件，不开窗口。从 compose 出发递归看 action("名字", …) 调用：
 * 缺的文件进 missing（一次报全），blocked 的进 blocked，非字面量的名字和循环调用进 errors。
 * 别名导入这类写法看不到，runAction 运行时还会再报一次，这里只是提前发现。
 */
export type LinkResult = { missing: string[]; blocked: Array<{ name: string; note: string }>; errors: string[] };
export type LinkPaths = { actionDir: string; composeDir: string };

/** 一次 action( 调用：name 是字面量名字，没有 name 表示名字是变量或带 ${} 的模板字符串。 */
export type ActionCall = { name?: string; text: string };

/** 跳过字符串、模板字符串和注释，把代码以外的内容换成空格；字符串本身留着，调用的第一个参数要读它。 */
export function actionCalls(code: string): ActionCall[] {
  const calls: ActionCall[] = [];
  const n = code.length;
  /** 从 i 处的引号读到结尾，返回结束位置。 */
  const skipString = (i: number): number => {
    const q = code[i]!;
    let j = i + 1;
    while (j < n && code[j] !== q) {
      if (code[j] === "\\") j++;
      else if (q === "`" && code[j] === "$" && code[j + 1] === "{") j = skipTemplateExpr(j + 2) - 1;
      j++;
    }
    return j + 1;
  };
  /** 从 ${ 之后读到配对的 }，返回 } 之后的位置；里面可能还有字符串。 */
  const skipTemplateExpr = (i: number): number => {
    let depth = 1, j = i;
    while (j < n && depth > 0) {
      const c = code[j]!;
      if (c === '"' || c === "'" || c === "`") { j = skipString(j); continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") { i = skipString(i); continue; }
    if (c === "a" && code.startsWith("action", i) && !/[\w$.]/.test(code[i - 1] ?? "")) {
      let j = i + 6;
      while (j < n && /\s/.test(code[j]!)) j++;
      if (code[j] === "(") {
        j++;
        while (j < n && /\s/.test(code[j]!)) j++;
        const q = code[j];
        if (q === '"' || q === "'" || q === "`") {
          const end = skipString(j);
          const inner = code.slice(j + 1, end - 1);
          const literal = q !== "`" || !inner.includes("${");
          calls.push({ ...(literal ? { name: inner } : {}), text: code.slice(j, end) });
          i = end;
          continue;
        }
        const stop = code.slice(j).search(/[,)]/);
        calls.push({ text: code.slice(j, stop < 0 ? n : j + stop).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return calls;
}

export function checkCompose(name: string, paths: LinkPaths): LinkResult {
  const result: LinkResult = { missing: [], blocked: [], errors: [] };
  const done = new Set<string>();
  const add = <T>(list: T[], item: T): void => { if (!list.includes(item)) list.push(item); };
  const visit = (current: string, stack: string[]): void => {
    if (stack.includes(current)) { add(result.errors, `循环调用：${[...stack.slice(stack.indexOf(current)), current].join(" → ")}`); return; }
    if (done.has(current)) return;
    done.add(current);
    const found = findAction(paths.actionDir, current, paths.composeDir);
    if (!found) { add(result.missing, current); return; }
    const summary = actionSummary(found.file);
    if (summary.status === "blocked") { result.blocked.push({ name: current, note: summary.note }); return; }
    if (!isCompose(found)) return;
    for (const call of actionCalls(fs.readFileSync(found.file, "utf8"))) {
      if (call.name === undefined) add(result.errors, `${current} 里 action() 的名字要写成字面量，收到：${call.text}`);
      else visit(call.name, [...stack, current]);
    }
  };
  visit(name, []);
  return result;
}
