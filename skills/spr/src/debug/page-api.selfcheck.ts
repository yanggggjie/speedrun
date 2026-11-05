// 页面函数：站点文件只有结构，不带值；trace 的结构累积；重要的线索排在前面。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clues, mergeCalls, mergeScan, shapeOf } from "./page-api.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-pageapi-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const obj = (at: string, n: number) => ({ path: at, kind: "object", methods: Array.from({ length: n }, (_, i) => `m${i}/0`), props: [], getters: [], hidden: 0 });

assert.deepEqual(clues([obj("Small", 2), obj("App", 3), obj("App.api", 9), obj("Other", 8)]), ["App", "Other"], "按顶层对象累计方法数，太小的不算线索");

const file = mergeScan(root, "example.com", { url: "https://example.com/", objects: [obj("App", 1)], canvas: false, scripts: "a.js" }, 1);
const sum = mergeCalls(root, "example.com", [{ path: "App.set", args: [{ row: 1, text: "秘密内容" }], t: 1 }], 2);
assert.deepEqual(sum, [{ path: "App.set", count: 1, args: ["{row:number,text:string}"] }]);
const saved = fs.readFileSync(file, "utf8");
assert.ok(!saved.includes("秘密内容"), "站点文件不能有参数的值");
assert.ok(JSON.parse(saved).objects.App, "快照累积进站点文件");
mergeCalls(root, "example.com", [{ path: "App.set", args: [{ row: 2, text: "x" }], t: 3 }], 3);
assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).calls["App.set"].count, 2, "调用次数累积");
assert.equal(shapeOf([1, 2]), "[number]");
assert.equal(shapeOf("[元素]"), "[元素]");
console.log("page-api.selfcheck ok");
