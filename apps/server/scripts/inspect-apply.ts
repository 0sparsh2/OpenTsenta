// Read-only: open a posting, click through "Apply" (up to 3 hops), and report where the application really lives,
// which ATS it is, whether an account wall is in front of it, and the fields on each screen.
// Nothing is typed, uploaded, or submitted.  Usage: npx tsx scripts/inspect-apply.ts <url> [more urls…]
import { chromium } from "playwright";
import { detectAts } from "../src/ats.ts";
import { detectAuthState } from "../src/apply/auth.ts";
import { extractFields } from "../src/apply/extract.ts";
import { dismissCookieBanner, findApplyEntry, findApplyManual, hasCaptcha } from "../src/apply/fill.ts";

const browser = await chromium.launch({ headless: true });
for (const url of process.argv.slice(2)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  console.log(`\n=== ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    for (let hop = 0; hop < 4; hop++) {
      await dismissCookieBanner(page).catch(() => {});
      const fields = await extractFields(page);
      const auth = await detectAuthState(page).catch(() => "?");
      const ats = detectAts(page.url());
      const frames = page.frames().length;
      console.log(`[${hop}] ${ats} · auth=${auth} · ${fields.length} fields · frames=${frames} · captcha=${await hasCaptcha(page)}\n    ${page.url().slice(0, 160)}`);
      for (const f of fields.slice(0, 40)) console.log(`      ${f.kind.padEnd(9)}${f.required ? "*" : " "} ${f.label.slice(0, 70).padEnd(71)} ${f.options ? `[${f.options.slice(0, 3).join(" | ").slice(0, 50)}${f.options.length > 3 ? " …" : ""}]` : ""}`);
      if (auth !== "none") break;
      const formLike = fields.filter((f) => !/search|keyword|alert|location/i.test(f.label)).length >= 3;
      if (formLike) break;
      const entry = (await findApplyEntry(page)) ?? (await findApplyManual(page));
      if (!entry) {
        console.log("    (no Apply button found)");
        break;
      }
      const label = ((await entry.textContent().catch(() => "")) ?? "").trim().slice(0, 40);
      const popup = ctx.waitForEvent("page", { timeout: 4000 }).catch(() => null);
      await entry.click({ timeout: 8000 }).catch((e) => console.log(`    click failed: ${(e as Error).message.split("\n")[0]}`));
      const next = await popup;
      if (next) {
        await page.close();
        Object.assign(globalThis, { __p: next });
      }
      const p = (next ?? page) as typeof page;
      await p.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await p.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      console.log(`    clicked "${label}"${next ? " (opened a new tab)" : ""}`);
      if (next) {
        // continue the loop on the new tab
        (page as unknown as { _replaced?: boolean })._replaced = true;
        Object.defineProperty(globalThis, "__page", { value: next, configurable: true });
      }
      if (next) {
        const f2 = await extractFields(next);
        const a2 = await detectAuthState(next).catch(() => "?");
        console.log(`[${hop + 1}] ${detectAts(next.url())} · auth=${a2} · ${f2.length} fields\n    ${next.url().slice(0, 160)}`);
        for (const f of f2.slice(0, 40)) console.log(`      ${f.kind.padEnd(9)}${f.required ? "*" : " "} ${f.label.slice(0, 70)}`);
        break;
      }
    }
  } catch (e) {
    console.log(`  error: ${(e as Error).message.split("\n")[0]}`);
  }
  await ctx.close();
}
await browser.close();
