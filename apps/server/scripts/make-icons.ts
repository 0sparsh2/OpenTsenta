// Render the Ferry mark to the PNG sizes Chrome (extension) and PWAs need.
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const svg = fs.readFileSync(new URL("../../web/public/favicon.svg", import.meta.url), "utf8");
const b = await chromium.launch();
const p = await b.newPage();
const out: [number, string][] = [
  [16, "../../extension/icons/16.png"],
  [32, "../../extension/icons/32.png"],
  [48, "../../extension/icons/48.png"],
  [128, "../../extension/icons/128.png"],
  [180, "../../web/public/apple-touch-icon.png"],
  [192, "../../web/public/icon-192.png"],
  [512, "../../web/public/icon-512.png"],
];
for (const [size, rel] of out) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: fileURLToPath(new URL(rel, import.meta.url)), omitBackground: true });
}
await b.close();
console.log("icons written");
