// manifest.json 的 key 决定扩展 ID，install.ts 里的 EXTENSION_ID 必须与它一致。
// TabBot 曾沿用 yodo 的 key，两个扩展 ID 相同，在 Chrome 里互相替换；这里固定下来，key 变了要同步改 EXTENSION_ID。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { EXTENSION_ID } from "./install.ts";

const manifest = JSON.parse(fs.readFileSync(new URL("../chrome-extension/manifest.json", import.meta.url), "utf8")) as { key: string };
const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
const id = [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
assert.equal(id, EXTENSION_ID);
assert.notEqual(EXTENSION_ID, "apnadjjfmlppoolfkobcbppllognhkcb", "不能是 yodo 扩展的 ID");
console.log("extension id selfcheck ok");
