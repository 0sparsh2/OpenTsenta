// Read-only: open a job's application page and print the fields the agent would see.
// Nothing is typed, uploaded, or submitted.  Usage: npx tsx scripts/inspect-form.ts <url> [ats]
import { chromium } from "playwright";
import { applyPageUrl, detectAts } from "../src/ats.ts";
import { extractFields } from "../src/apply/extract.ts";
import { findApplyEntry, findSubmit, hasCaptcha } from "../src/apply/fill.ts";

const url = process.argv[2];
const ats = process.argv[3] ?? detectAts(url);
const target = applyPageUrl(ats, url, url);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
let fields = await extractFields(page);
if (fields.length < 2) {
  const entry = await findApplyEntry(page);
  if (entry) {
    await entry.click();
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    fields = await extractFields(page);
  }
}
console.log(`${ats} ${target}\n${fields.length} fields · submit button: ${Boolean(await findSubmit(page))} · captcha: ${await hasCaptcha(page)}`);
for (const f of fields) console.log(`  ${f.kind.padEnd(9)}${f.required ? "*" : " "} ${f.label.slice(0, 70).padEnd(71)} ${f.options ? `[${f.options.slice(0, 4).join(" | ").slice(0, 60)}${f.options.length > 4 ? " …" : ""}]` : ""}`);
await browser.close();
