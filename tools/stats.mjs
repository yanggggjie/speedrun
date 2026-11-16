#!/usr/bin/env node
// speedrun 调用与沉淀指标统计脚本：
//   node tools/stats.mjs [--days 7] [--home ~/.speedrun]
//
// 基于 ~/.speedrun/session/invocations.jsonl、debug-windows/<id>/meta.json 与 action/<site>/<name>.js 计算四大指标：
//   1. 前台任务 turns（按 caller.session + 15 分钟空闲切分任务段，同轮并行命令合并为 1 turn，排除 distiller 后台验证）
//   2. debug 窗口沉淀漏斗（打开窗口 → 发出沉淀提示 → distiller 接单 / 产出带 @from 的 action → verified 比例）
//   3. action 含参率、跨任务段复用率、以及同站已有 action 却开 debug 的比例
//   4. 前台 run 首跑通过率、错误分布、分段耗时（openMs/navMs/reqMs/domMs）、request vs DOM 比例
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const days = Number(argVal("--days", "7"));
const dataHome = argVal("--home", path.join(os.homedir(), ".speedrun"));
const sinceMs = Date.now() - days * 86400_000;
const EPISODE_GAP_MS = 15 * 60_000;
const PARALLEL_GAP_MS = 350;

const invFile = path.join(dataHome, "session", "invocations.jsonl");
const rows = fs.existsSync(invFile)
  ? fs.readFileSync(invFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => (r.ts ?? 0) >= sinceMs)
  : [];

const actionRoot = path.join(dataHome, "action");
const actions = [];
if (fs.existsSync(actionRoot)) {
  for (const site of fs.readdirSync(actionRoot)) {
    const dir = path.join(actionRoot, site);
    if (!fs.statSync(dir).isDirectory() || site.startsWith(".")) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(dir, f), "utf8");
      const block = (/\/\*\*?([\s\S]*?)\*\//.exec(code)?.[1] ?? "");
      const status = (/@status\s+(\w+)/.exec(block)?.[1] ?? "verified");
      const fromWindow = (/@from\s+(\S+)/.exec(block)?.[1] ?? "");
      const hasParam = /@param\b/.test(block);
      const isWrite = /@write\b/.test(block);
      actions.push({ site, name: f.slice(0, -3), status, fromWindow, hasParam, isWrite });
    }
  }
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}% (${n}/${d})` : "—");
const pQuantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

// 1. 按会话 + 空闲间隔切分前台任务段并计算 turns
const mainRows = rows.filter((r) => r.caller?.role !== "distiller");
const bySession = new Map();
for (const r of mainRows) {
  const key = r.caller?.session ?? `cwd:${r.cwd ?? "unknown"}`;
  if (!bySession.has(key)) bySession.set(key, []);
  bySession.get(key).push(r);
}

const episodes = [];
for (const [sessionKey, list] of bySession) {
  list.sort((a, b) => a.ts - b.ts);
  let ep = null;
  for (const r of list) {
    if (!ep || r.ts - ep.endTs > EPISODE_GAP_MS) {
      ep = { sessionKey, host: r.caller?.host ?? "unknown", startTs: r.ts, endTs: r.ts + (r.ms ?? 0), rows: [r], turns: 1, lastBatchEnd: r.ts + (r.ms ?? 0) };
      episodes.push(ep);
    } else {
      // 同一轮并行发出的多条命令（启动时间早于上一条结束，或间隔极短）合并算 1 个 turn
      if (r.ts > ep.lastBatchEnd && r.ts - ep.rows.at(-1).ts > PARALLEL_GAP_MS) {
        ep.turns++;
      }
      ep.lastBatchEnd = Math.max(ep.lastBatchEnd, r.ts + (r.ms ?? 0));
      ep.endTs = Math.max(ep.endTs, r.ts + (r.ms ?? 0));
      ep.rows.push(r);
    }
  }
}

const reuseEps = episodes.filter((e) => e.rows.some((r) => r.cmd === "run") && !e.rows.some((r) => r.cmd === "debug"));
const exploreEps = episodes.filter((e) => e.rows.some((r) => r.cmd === "debug"));
const turnsSummary = (eps) => {
  const t = eps.map((e) => e.turns).sort((a, b) => a - b);
  return t.length ? `共 ${t.length} 段，p50=${pQuantile(t, 0.5)} turns，p90=${pQuantile(t, 0.9)} turns，max=${t.at(-1)} turns` : "无";
};

// 2. 沉淀漏斗
const debugRows = rows.filter((r) => r.cmd === "debug" && r.window);
const windowsPrompted = new Set(debugRows.filter((r) => r.promptedDistill).map((r) => r.window));
const allDebugWins = new Set(debugRows.map((r) => r.window));
const distillerWins = new Set(rows.filter((r) => r.caller?.role === "distiller" && r.caller?.fromWindow).map((r) => r.caller.fromWindow));
const actionByFrom = new Map();
for (const a of actions) {
  if (a.fromWindow) {
    if (!actionByFrom.has(a.fromWindow)) actionByFrom.set(a.fromWindow, []);
    actionByFrom.get(a.fromWindow).push(a);
  }
}
const unprecipitated = [...windowsPrompted].filter((w) => !actionByFrom.has(w));

// 3. 含参率与跨任务段复用率
const actionEpUse = new Map();
episodes.forEach((ep, idx) => {
  for (const r of ep.rows) {
    if (r.cmd !== "run") continue;
    if (r.mode !== "inline" && r.name && r.name !== "-e") {
      if (!actionEpUse.has(r.name)) actionEpUse.set(r.name, new Set());
      actionEpUse.get(r.name).add(idx);
    }
    for (const c of r.calls ?? []) {
      if (!actionEpUse.has(c.name)) actionEpUse.set(c.name, new Set());
      actionEpUse.get(c.name).add(idx);
    }
  }
});
const usedActions = [...actionEpUse.entries()];
const reusedActions = usedActions.filter(([, s]) => s.size >= 2);
const debugOpens = mainRows.filter((r) => r.cmd === "debug" && r.tool === "navigate" && typeof r.siteActions === "number");
const debugWithExisting = debugOpens.filter((r) => r.siteActions > 0);

// 4. 前台 run 首跑通过率、分段耗时与错误统计
const mainRuns = mainRows.filter((r) => r.cmd === "run");
const okRuns = mainRuns.filter((r) => r.status === "ok");
const okMs = okRuns.map((r) => r.ms ?? 0).sort((a, b) => a - b);
const errCounts = {};
for (const r of mainRuns.filter((x) => x.status !== "ok")) {
  const k = r.error?.code ?? `status:${r.status}`;
  errCounts[k] = (errCounts[k] ?? 0) + 1;
}
const perfTotals = { openMs: 0, navMs: 0, reqMs: 0, domMs: 0, count: 0 };
const opsTotals = { nav: 0, req: 0, dom: 0, eval: 0 };
for (const r of mainRuns) {
  if (r.perf) {
    perfTotals.openMs += r.perf.openMs ?? 0;
    perfTotals.navMs += r.perf.navMs ?? 0;
    perfTotals.reqMs += r.perf.reqMs ?? 0;
    perfTotals.domMs += r.perf.domMs ?? 0;
    perfTotals.count++;
  }
  if (r.ops) {
    opsTotals.nav += r.ops.nav ?? 0;
    opsTotals.req += r.ops.req ?? 0;
    opsTotals.dom += r.ops.dom ?? 0;
    opsTotals.eval += r.ops.eval ?? 0;
  }
}

console.log(`=== speedrun 统计（最近 ${days} 天，共 ${rows.length} 条调用，前台 ${mainRows.length} 条 / distiller ${rows.length - mainRows.length} 条）===\n`);
console.log(`1. 前台任务轮次（turns）`);
console.log(`   - 纯复用任务段：${turnsSummary(reuseEps)}`);
console.log(`   - 含 debug 探索段：${turnsSummary(exploreEps)}\n`);

console.log(`2. 窗口沉淀漏斗`);
console.log(`   - 活跃 debug 窗口：${allDebugWins.size} 个，发出沉淀提示：${windowsPrompted.size} 个`);
console.log(`   - distiller 验证调用关联窗口：${distillerWins.size} 个，已产出带 @from 的 action 窗口：${actionByFrom.size} 个`);
console.log(`   - 沉淀转化率（对已提示窗口）：${pct(windowsPrompted.size - unprecipitated.length, windowsPrompted.size)}`);
if (unprecipitated.length) console.log(`   - 尚未沉淀的提示窗口：${unprecipitated.slice(-8).join("、")}`);
console.log("");

console.log(`3. 脚本资产与复用（当前共 ${actions.length} 个 action）`);
console.log(`   - action 含 @param 比例：${pct(actions.filter((a) => a.hasParam).length, actions.length)}`);
console.log(`   - status 分布：verified ${actions.filter((a) => a.status === "verified").length} / draft ${actions.filter((a) => a.status === "draft").length}（其中 @write ${actions.filter((a) => a.status === "draft" && a.isWrite).length}） / blocked ${actions.filter((a) => a.status === "blocked").length}`);
console.log(`   - 跨任务段复用率（被调过的 action 中 ≥2 段使用）：${pct(reusedActions.length, usedActions.length)}`);
console.log(`   - 开 debug 时同站已有 action 比例：${pct(debugWithExisting.length, debugOpens.length)}\n`);

console.log(`4. 前台 spr run 质量与耗时（共 ${mainRuns.length} 次，其中 -e 内联 ${mainRuns.filter((r) => r.mode === "inline").length} 次）`);
console.log(`   - 成功率：${pct(okRuns.length, mainRuns.length)}，耗时 p50=${(pQuantile(okMs, 0.5) / 1000).toFixed(2)}s，p90=${(pQuantile(okMs, 0.9) / 1000).toFixed(2)}s`);
if (Object.keys(errCounts).length) console.log(`   - 非成功分类：${JSON.stringify(errCounts)}`);
if (perfTotals.count) {
  const n = perfTotals.count;
  console.log(`   - 平均分段耗时（${n} 次）：open=${Math.round(perfTotals.openMs / n)}ms, nav=${Math.round(perfTotals.navMs / n)}ms, req=${Math.round(perfTotals.reqMs / n)}ms, dom=${Math.round(perfTotals.domMs / n)}ms`);
  console.log(`   - 累计操作分布：req=${opsTotals.req}, nav=${opsTotals.nav}, dom=${opsTotals.dom}, eval=${opsTotals.eval}`);
}
