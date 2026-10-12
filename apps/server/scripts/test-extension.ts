// Load the Chrome extension into Chromium, sign in through the dashboard bridge, open the sandbox
// job posting, and use the panel to queue an application.  npx tsx scripts/test-extension.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ext = fileURLToPath(new URL("../../extension", import.meta.url));
const token = fs.readFileSync(fileURLToPath(new URL("../../../data/.demo_token", import.meta.url)), "utf8").trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-ext-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  console.log("service worker:", sw.url());
  const dash = await ctx.newPage();
  await dash.goto("http://localhost:8787/");
  await dash.evaluate((t) => localStorage.setItem("ferry.token", t), token);
  await dash.reload();
  await dash.waitForTimeout(2500);
  const stored = await sw.evaluate(() => chrome.storage.local.get(["token", "apiUrl"]));
  console.log("bridge synced token:", Boolean((stored as { token?: string }).token), (stored as { apiUrl?: string }).apiUrl);

  const job = await ctx.newPage();
  await job.goto("http://localhost:8787/mock-ats/wizard/jobs/2001");
  const pill = job.locator("#ferry-panel-host").locator("button.pill");
  await pill.waitFor({ timeout: 8000 });
  console.log("panel shown:", await pill.innerText());
  await pill.click();
  await job.locator("#ferry-panel-host").locator("button.add").click();
  await job.locator("#ferry-panel-host").locator(".ok, .err").waitFor({ timeout: 15000 });
  console.log("after add:", (await job.locator("#ferry-panel-host").locator(".out").innerText()).replace(/\n+/g, " | "));
  await job.screenshot({ path: fileURLToPath(new URL("../../../data/extension-panel.png", import.meta.url)) });

  const other = await ctx.newPage();
  await other.goto("http://localhost:8787/");
  await other.waitForTimeout(1500);
  console.log("panel on non-job page:", await other.locator("#ferry-panel-host").count());
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
