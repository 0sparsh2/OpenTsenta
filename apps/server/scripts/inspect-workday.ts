// Read-only: open a Workday posting, click Apply, and report what the candidate sees next.
// Nothing is typed and no account is created.  npx tsx scripts/inspect-workday.ts <posting-url>
import { chromium } from "playwright";
const url = process.argv[2];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await p.waitForTimeout(2000);
const btns = async () => (await p.locator("button:visible, a[role=button]:visible").allInnerTexts()).map((t) => t.trim()).filter((t) => t && t.length < 40);
console.log("posting buttons:", (await btns()).slice(0, 15));
await p.getByRole("button", { name: /^apply$/i }).first().click().catch(() => p.getByText(/^apply$/i).first().click());
await p.waitForTimeout(2500);
console.log("after Apply:", (await btns()).slice(0, 15));
const manual = p.getByRole("button", { name: /apply manually/i }).or(p.getByText(/apply manually/i));
if (await manual.count()) {
  await manual.first().click();
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(2500);
}
console.log("url:", p.url());
console.log("inputs:", await p.locator("input:visible").evaluateAll((els) => els.map((e) => `${(e as HTMLInputElement).type}:${e.getAttribute("data-automation-id") ?? ""}:${(e as HTMLInputElement).labels?.[0]?.innerText ?? e.getAttribute("aria-label") ?? ""}`)));
console.log("listbox buttons:", await p.locator("[aria-haspopup=listbox]:visible").count());
console.log("buttons:", (await btns()).slice(0, 20));
console.log("text:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600));
await b.close();
