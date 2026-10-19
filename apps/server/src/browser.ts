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
  const opts = { headless: config.headless, args: config.headless ? [] : ["--window-size=1100,900", "--window-position=40,40"] };
  // An installed Chrome when asked for (falls back to the bundled Chromium if it isn't there).
  applyBrowser ??= config.applyBrowserChannel
    ? chromium.launch({ ...opts, channel: config.applyBrowserChannel }).catch((e) => {
        console.warn(`[browser] ${config.applyBrowserChannel} didn't start (${(e as Error).message.split("\n")[0]}); using the bundled Chromium`);
        return chromium.launch(opts);
      })
    : chromium.launch(opts);
  return applyBrowser;
}

export async function newApplyContext(): Promise<BrowserContext> {
  const b = await getApplyBrowser();
  // The browser's own user agent: Ferry doesn't pretend to be something else.
  return b.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
}

export async function closeBrowsers() {
  for (const p of [renderBrowser, applyBrowser]) {
    if (p) await (await p).close().catch(() => {});
  }
  renderBrowser = applyBrowser = null;
}
