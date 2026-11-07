import * as fs from "node:fs";
import { actionSummary, findAction, isCompose } from "./actions.ts";

/**
 * 执行前检查：只读文件，不开窗口。读 compose 里的 action("名字", …) 调用：
 * 缺的进 missing（一次报全，带每处调用的参数源码），blocked 的进 blocked，调用了 compose 的进 errors（compose 不调用 compose），
 * 名字不是字面量的进 dynamic（检查不了，照常运行，运行时缺了会报 is not defined）。
 * 别名导入这类写法看不到，runAction 运行时还会再报一次，这里只是提前发现。
 */
export type MissingAction = { name: string; calls: string[] };
export type LinkResult = { missing: MissingAction[]; blocked: Array<{ name: string; note: string }>; errors: string[]; dynamic: string[] };
export type LinkPaths = { actionDir: string; composeDir: string };

/** 一次 action( 调用：name 是字面量名字，没有 name 表示名字是变量或带 ${} 的模板字符串；text 是名字那一段的源码；args 是第二个参数的源码（压成一行，可能截断），没有就是空。 */
export type ActionCall = { name?: string; text: string; args: string };

/** 参数源码最多列这么多字。 */
const ARGS_MAX = 60;

/** 压成一行、去掉结尾的逗号，太长截断。 */
function oneLine(src: string): string {
  const s = src.replace(/\s+/g, " ").trim().replace(/,\s*$/, "").replace(/,\s*([}\]])/g, " $1").replace(/\s+/g, " ").trim();
  return s.length > ARGS_MAX ? `${s.slice(0, ARGS_MAX)}…` : s;
}

/** 跳过字符串、模板字符串和注释，找出 action( 调用；字符串本身留着，调用的第一个参数要读它。 */
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
  /** 从 i 读到这次调用的参数结束：遇到同一层的 , 或 ) 停下，返回停下的位置；跳过字符串、注释和括号嵌套。 */
  const argEnd = (i: number): number => {
    let depth = 0, j = i;
    while (j < n) {
      const c = code[j]!;
      if (c === '"' || c === "'" || c === "`") { j = skipString(j); continue; }
      if (c === "/" && code[j + 1] === "/") { const e = code.indexOf("\n", j); j = e < 0 ? n : e; continue; }
      if (c === "/" && code[j + 1] === "*") { const e = code.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") { if (depth === 0) return j; depth--; }
      else if (c === "," && depth === 0) return j;
      j++;
    }
    return n;
  };
  /** 名字之后：有第二个参数就返回它的源码。 */
  const secondArg = (end: number): string => {
    let j = end;
    while (j < n && /\s/.test(code[j]!)) j++;
    if (code[j] !== ",") return "";
    const stop = argEnd(j + 1);
    return oneLine(code.slice(j + 1, stop));
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
          calls.push({ ...(literal ? { name: inner } : {}), text: code.slice(j, end), args: secondArg(end) });
          i = end;
          continue;
        }
        const stop = argEnd(j);
        calls.push({ text: oneLine(code.slice(j, stop)), args: secondArg(stop) });
        i = j;
        continue;
      }
    }
    i++;
  }
  return calls;
}

/** 一处调用写成 `名字(参数)`。 */
export const callText = (name: string, args: string): string => `${name}(${args})`;

/** 缺的 action 列成一段：`zhihu-search({ q, n })、zhihu-vote({ id }) 等 2 处调用`。 */
export function missingText(missing: MissingAction[]): string {
  return missing.map((m) => {
    const first = m.calls[0] ?? callText(m.name, "");
    return m.calls.length > 1 ? `${first} 等 ${m.calls.length} 处调用` : first;
  }).join("、");
}

export function checkCompose(name: string, paths: LinkPaths): LinkResult {
  const result: LinkResult = { missing: [], blocked: [], errors: [], dynamic: [] };
  const found = findAction(paths.actionDir, name, paths.composeDir);
  if (!found) { result.missing.push({ name, calls: [] }); return result; }
  const top = actionSummary(found.file);
  if (top.status === "blocked") { result.blocked.push({ name, note: top.note }); return result; }
  if (!isCompose(found)) return result;
  for (const call of actionCalls(fs.readFileSync(found.file, "utf8"))) {
    if (call.name === undefined) { if (!result.dynamic.includes(call.text)) result.dynamic.push(call.text); continue; }
    const dep = findAction(paths.actionDir, call.name, paths.composeDir);
    if (!dep) {
      let m = result.missing.find((x) => x.name === call.name);
      if (!m) { m = { name: call.name, calls: [] }; result.missing.push(m); }
      const text = callText(call.name, call.args);
      if (!m.calls.includes(text)) m.calls.push(text);
      continue;
    }
    if (isCompose(dep)) {
      const msg = composeCallError(name, call.name);
      if (!result.errors.includes(msg)) result.errors.push(msg);
      continue;
    }
    const s = actionSummary(dep.file);
    if (s.status === "blocked" && !result.blocked.some((b) => b.name === call.name)) result.blocked.push({ name: call.name, note: s.note });
  }
  return result;
}

/** compose 调用了 compose 的错误文字：执行前检查和运行时用同一句。 */
export const composeCallError = (from: string, to: string): string => `${from} 里调用了 compose ${to}：compose 只能调用 action，共用的数据处理写成纯函数放进 ~/.speedrun/helpers/，compose 里 import`;
