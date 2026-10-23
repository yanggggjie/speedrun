import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderSnapshot } from "./render.ts";
import { BUILTIN_EXCLUDE, describeConfig, effectiveExclude, extensionConfig, normalizeHost, readConfig, writeConfig } from "./sites.ts";

const text = renderSnapshot({
  url: "https://example.com/", title: "示例", headings: ["标题一"], interactiveTotal: 10, interactiveVisible: 4, inViewShown: 2,
  items: [{ ref: "e1", t: "button", n: "提交" }, { ref: "e2", t: "input", k: "text", n: "搜索", v: "abc" }],
}, 7);
assert.match(text, /^tab7 https:\/\/example\.com\/ "示例"/);
assert.match(text, /@e1 button "提交"/);
assert.match(text, /@e2 input\[text\] "搜索" value="abc"/);
assert.match(text, /只列出视图内/);

// 域名规范化：去掉 www.，但不折叠到注册域名（accounts.google.com 不能变成 google.com）
assert.equal(normalizeHost("https://www.zhihu.com/question/1"), "zhihu.com");
assert.equal(normalizeHost("accounts.google.com"), "accounts.google.com");
assert.equal(normalizeHost("news.bbc.co.uk"), "news.bbc.co.uk");
assert.equal(normalizeHost("localhost"), "localhost");
assert.equal(normalizeHost("  "), null);
assert.equal(normalizeHost("notadomain"), null);

// 录制范围：没有文件、旧版的只录点名站点的列表，都是默认的"录所有站点"
const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sites-"));
process.on("exit", () => fs.rmSync(sitesDir, { recursive: true, force: true })); // 自检结束清掉临时目录
const file = path.join(sitesDir, "sites.json");
assert.deepEqual(readConfig(file), { mode: "all", only: [], exclude: [], allow: [] });
fs.writeFileSync(file, JSON.stringify({ sites: ["zhihu.com"] }));
assert.equal(readConfig(file).mode, "all", "旧版配置按默认处理");
writeConfig({ mode: "all", only: [], exclude: ["b.com", "a.com", "a.com"], allow: ["proton.me"] }, file);
assert.deepEqual(readConfig(file), { mode: "all", only: [], exclude: ["a.com", "b.com"], allow: ["proton.me"] });

// 实际排除 = 内置 + 用户排除 - 重新打开的；只录点名站点时不用排除
const eff = effectiveExclude(readConfig(file));
assert.ok(eff.includes("mail.google.com") && eff.includes("a.com") && !eff.includes("proton.me"));
assert.equal(eff.length, BUILTIN_EXCLUDE.length + 2 - 1);
assert.deepEqual(effectiveExclude({ mode: "only", only: ["x.com"], exclude: [], allow: [] }), []);
assert.deepEqual(extensionConfig({ mode: "only", only: ["x.com"], exclude: ["y.com"], allow: [] }), { mode: "only", sites: ["x.com"], exclude: [] });
assert.deepEqual(extensionConfig({ mode: "all", only: ["x.com"], exclude: [], allow: [] }).sites, []);
assert.match(describeConfig({ mode: "all", only: [], exclude: ["a.com"], allow: [] }), /录制所有 http\/https 站点，内置排除 \d+ 个敏感站点.*你另外排除了 a\.com/);
assert.match(describeConfig({ mode: "only", only: ["x.com"], exclude: [], allow: [] }), /只录 1 个站点：x\.com/);
assert.match(describeConfig({ mode: "only", only: [], exclude: [], allow: [] }), /不录任何东西/);

console.log("render.selfcheck ok");
