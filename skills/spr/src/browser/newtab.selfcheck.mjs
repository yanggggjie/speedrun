// 页面新开标签页的拦截判断（chrome-extension/page/newtab.js，扩展和这里共用同一份源码）：拦漏了 Chrome 会抢前台，拦错了会悄悄改变网站行为（把应该在 iframe 里打开的、下载、弹出窗口都当新标签页）。
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ctx = { window: {}, URL };
vm.runInNewContext(fs.readFileSync(new URL("../chrome-extension/page/newtab.js", import.meta.url), "utf8"), ctx);
const N = ctx.window.__sprNewTab;
const L = (over) => ({ href: "https://a.com/x", target: "", download: false, frameNamed: false, ...over });

// 链接
assert.equal(N.link(L({ target: "_blank" }), {}), true, "target=_blank");
assert.equal(N.link(L({ target: "someWindow" }), {}), true, "命名的新窗口");
assert.equal(N.link(L({ target: "frameA", frameNamed: true }), {}), false, "target 是页面里的 iframe：在 iframe 里打开");
for (const t of ["", "_self", "_top", "_parent", "_SELF"]) assert.equal(N.link(L({ target: t }), {}), false, `target=${t} 在当前页打开`);
assert.equal(N.link(L(), { meta: true }), true, "cmd+点击");
assert.equal(N.link(L(), { ctrl: true }), true, "ctrl+点击");
assert.equal(N.link(L(), { shift: true }), true, "shift+点击（新窗口）");
assert.equal(N.link(L(), { button: 1 }), true, "中键");
assert.equal(N.link(L(), { button: 0 }), false, "普通点击");
assert.equal(N.link(L({ target: "_blank", download: true }), {}), false, "download 链接是下载，不开标签页");
assert.equal(N.link(L({ target: "_blank" }), { alt: true }), false, "alt+点击是下载");
assert.equal(N.link(L({ target: "_blank", href: "mailto:a@b.c" }), {}), false, "非 http(s) 不拦");
assert.equal(N.link(L({ target: "_blank", href: "javascript:void 0" }), {}), false);

// window.open
assert.equal(N.open("/x"), true, "window.open(url)");
assert.equal(N.open("https://a.com/x", "_blank"), true);
assert.equal(N.open(undefined), true, "先开空窗口、后设地址");
assert.equal(N.open("about:blank"), true);
assert.equal(N.open("https://a.com/x", "_blank", "width=500,height=600"), false, "带窗口参数的弹出窗口（OAuth 登录）放过");
assert.equal(N.open("https://a.com/x", "_self"), false, "在当前页打开");
assert.equal(N.open("https://a.com/x", "frameA", undefined, true), false, "在 iframe 里打开");
assert.equal(N.open("mailto:a@b.c"), false);

// 表单
assert.equal(N.form("_blank"), true);
assert.equal(N.form(""), false);
assert.equal(N.form("frameA", true), false);
console.log("newtab.selfcheck ok");
