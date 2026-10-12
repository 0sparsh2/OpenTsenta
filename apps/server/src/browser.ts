import { chromium, type Browser, type BrowserContext } from "playwright";
import { config } from "./config.ts";

// Two long-lived browsers: a headless one for PDF rendering and the apply worker's one,
// which can be headed so you can watch applications happen ("window in the corner").

let renderBrowser: Promise<Browser> | null = null;
let applyBrowser: Promise<Browser> | null = null;

export function getRenderBrowser() {
  renderBrowser ??= chromium.launch({ headless: true });
  return renderBrowser;
}

export function getApplyBrowser() {
  applyBrowser ??= chromium.launch({
    headless: config.headless,
    args: config.headless ? [] : ["--window-size=1100,900", "--window-position=40,40"],
  });
  return applyBrowser;
}

export async function newApplyContext(): Promise<BrowserContext> {
  const b = await getApplyBrowser();
  return b.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    locale: "en-US",
  });
}

export async function closeBrowsers() {
  for (const p of [renderBrowser, applyBrowser]) {
    if (p) await (await p).close().catch(() => {});
  }
  renderBrowser = applyBrowser = null;
}
