// 重新生成扩展图标：node scripts/dev/make-icons.mjs（本机要装 Chrome；路径不同时用 CHROME 环境变量指定）。
// 源文件是 scripts/dev/icons/icon.svg，所有尺寸共用一份。
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../src/chrome-extension/icons");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [[16, "icon.svg"], [32, "icon.svg"], [48, "icon.svg"], [128, "icon.svg"]];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-icons-"));
try {
  for (const [size, svg] of SIZES) {
    const page = path.join(tmp, `${size}.html`);
    const src = pathToFileUrl(path.join(HERE, "icons", svg));
    fs.writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent"><img src="${src}" style="width:${size}px;height:${size}px;display:block">`);
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${path.join(tmp, "profile")}`, "--default-background-color=00000000", "--force-device-scale-factor=1", `--window-size=${size},${size}`, `--screenshot=${path.join(OUT, `${size}.png`)}`, pathToFileUrl(page)], { stdio: "ignore" });
    console.log(`${size}.png ← ${svg}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function pathToFileUrl(file) {
  return `file://${file}`;
}
