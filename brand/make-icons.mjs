// 重新生成图标：node brand/make-icons.mjs（本机要装 python3 和 Chrome；Chrome 路径不同时用 CHROME 环境变量指定）。
// 先跑 brand/icon.py 生成 brand/icon.svg，再用无头 Chrome 出 skills/spr/src/chrome-extension/icons/ 下 16、32、48、128 四个 PNG。
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../skills/spr/src/chrome-extension/icons");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [16, 32, 48, 128];

execFileSync("python3", [path.join(HERE, "icon.py")], { stdio: "inherit" });
const svg = `file://${path.join(HERE, "icon.svg")}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-icons-"));
try {
  for (const size of SIZES) {
    const page = path.join(tmp, `${size}.html`);
    fs.writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent"><img src="${svg}" style="width:${size}px;height:${size}px;display:block">`);
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${path.join(tmp, "profile")}`, "--default-background-color=00000000", "--force-device-scale-factor=1", `--window-size=${size},${size}`, `--screenshot=${path.join(OUT, `${size}.png`)}`, `file://${page}`], { stdio: "ignore" });
    console.log(`${size}.png`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
