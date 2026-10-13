// Load the Chrome extension into Chromium, sign in through the dashboard bridge, open a sandbox application
// form, click "Fill this form", and check what landed in the page (nothing is submitted).
//   npx tsx scripts/test-extension-fill.ts            (needs the server on :8787 and data/.demo_token)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.FERRY_URL ?? "http://localhost:8787";
const ext = fileURLToPath(new URL("../../extension", import.meta.url));
const token = fs.readFileSync(fileURLToPath(new URL("../../../data/.demo_token", import.meta.url)), "utf8").trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-ext-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✔" : "✖"} ${what}`);
  if (!ok) failed = true;
};
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const dash = await ctx.newPage();
  await dash.goto(`${base}/`);
  await dash.evaluate((t) => localStorage.setItem("ferry.token", t), token);
  await dash.reload();
  await dash.waitForTimeout(2500);
  check(Boolean(((await sw.evaluate(() => chrome.storage.local.get(["token"]))) as { token?: string }).token), "dashboard bridge synced the token");

  const form = await ctx.newPage();
  await form.goto(`${base}/mock-ats/acme/jobs/1001`);
  const panel = form.locator("#ferry-panel-host");
  await panel.locator("button.pill").waitFor({ timeout: 10000 });
  await form.waitForTimeout(3000); // the panel checks for a form every 2.5s
  check((await panel.locator("button.pill").innerText()).includes("fill this form"), "panel offers to fill the form");
  await panel.locator("button.pill").click();
  await panel.locator("button.fill").click();
  await panel.locator(".ok, .err").waitFor({ timeout: 90000 });
  const summary = (await panel.locator(".out").innerText()).replace(/\n+/g, " ");
  console.log("  panel:", summary);
  check(/Filled \d+ of \d+ fields/.test(summary), "filled the form");
  check((await form.inputValue("#first_name").catch(() => "")) !== "", "first name typed into the page");
  check(/@/.test(await form.inputValue("#email").catch(() => "")), "email typed into the page");
  const files = await form.evaluate(() => (document.querySelector("input[type=file][name=resume]") as HTMLInputElement | null)?.files?.[0]?.size ?? 0);
  check(files > 1000, `tailored résumé attached (${files} bytes)`);
  const submitted = await form.evaluate(() => location.pathname.includes("confirmation"));
  check(!submitted, "nothing was submitted");
  await form.screenshot({ path: fileURLToPath(new URL("../../../data/extension-fill.png", import.meta.url)), fullPage: true });
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
