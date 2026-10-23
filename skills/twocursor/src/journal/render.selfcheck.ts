import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderSnapshot } from "./render.ts";
import { normalizeSite, readSites, writeSites } from "./sites.ts";

const text = renderSnapshot({
  url: "https://example.com/", title: "示例", headings: ["标题一"], interactiveTotal: 10, interactiveVisible: 4, inViewShown: 2,
  items: [{ ref: "e1", t: "button", n: "提交" }, { ref: "e2", t: "input", k: "text", n: "搜索", v: "abc" }],
}, 7);
assert.match(text, /^tab7 https:\/\/example\.com\/ "示例"/);
assert.match(text, /@e1 button "提交"/);
assert.match(text, /@e2 input\[text\] "搜索" value="abc"/);
assert.match(text, /只列出视图内/);

assert.equal(normalizeSite("https://www.zhihu.com/question/1"), "zhihu.com");
assert.equal(normalizeSite("ithome.com"), "ithome.com");
assert.equal(normalizeSite("news.bbc.co.uk"), "bbc.co.uk");
assert.equal(normalizeSite("  "), null);

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-sites-")), "sites.json");
assert.deepEqual(readSites(file), []);
writeSites(["b.com", "a.com", "a.com"], file);
assert.deepEqual(readSites(file), ["a.com", "b.com"]);

console.log("render.selfcheck ok");
