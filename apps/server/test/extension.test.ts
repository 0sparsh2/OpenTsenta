// The Chrome extension's "Fill this form", end to end: the real extension loaded into Chromium, talking to a Ferry
// server, on sandbox forms that mirror the sites Ferry's own browser can't apply on. Nothing here clicks Submit for
// you: where a test submits, it does so as the person would, after the extension has filled the form.
//   npm test --workspace apps/server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-ext-test-"));
const PORT = 8900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
process.env.DATA_DIR = dir;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = BASE;
process.env.LLM_DISABLED = "true";
process.env.HEADLESS = "true";

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { api } = await import("../src/api.ts");
const { mockAts, seedSandboxJobs } = await import("../src/mock/ats.ts");
const { closeBrowsers } = await import("../src/browser.ts");

const app = new Hono();
app.route("/api/v1", api);
app.route("/mock-ats", mockAts);
let server: ReturnType<typeof serve>;
let token = "";
let ctx: BrowserContext;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-ext-profile-"));

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()) as any;
};
const waitFor = async (id: string, statuses: string[], ms = 120000) => {
  const t0 = Date.now();
  for (;;) {
    const a = await call("GET", `/applications/${id}`);
    if (statuses.includes(a.status)) return a;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${statuses}; last ${a.status} ${a.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const jobByTitle = async (title: string) => (await call("GET", `/jobs/search?q=${encodeURIComponent(title)}&limit=10`)).items.find((j: any) => j.title === title);

const panel = (p: Page) => p.locator("#ferry-panel-host");
const panelText = (p: Page) => p.evaluate(() => document.querySelector("#ferry-panel-host")?.shadowRoot?.querySelector(".out")?.textContent ?? "");
/** Open the panel and click its fill button (once it reads `label`); returns the panel's report. */
async function fillWithPanel(p: Page, label: RegExp = /fill this form/i) {
  const host = panel(p);
  await p.waitForFunction(() => Boolean(document.querySelector("#ferry-panel-host")?.shadowRoot), null, { timeout: 15000 });
  if (await host.locator("button.pill").isVisible()) await host.locator("button.pill").click(); // else the panel is already open
  const btn = host.locator("button.fill");
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await p.waitForFunction((src) => new RegExp(src, "i").test(document.querySelector("#ferry-panel-host")?.shadowRoot?.querySelector("button.fill")?.textContent ?? ""), label.source, { timeout: 15000 });
  await btn.click();
  await p.waitForFunction(() => /Filled \d+ of \d+|error|couldn|failed/i.test(document.querySelector("#ferry-panel-host")?.shadowRoot?.querySelector(".out")?.textContent ?? ""), null, { timeout: 120000 });
  return panelText(p);
}

before(async () => {
  server = serve({ fetch: app.fetch, port: PORT });
  seedSandboxJobs();
  token = (await call("POST", "/auth/login", { email: "ext@ferry.local", name: "Alex Morgan" })).token;
  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(new URL("../../../samples/alex_morgan_resume.txt", import.meta.url))]), "alex_morgan_resume.txt");
  await (await fetch(`${BASE}/api/v1/resumes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  await call("PUT", "/profile", {
    personal: { city: "San Francisco", region: "CA", country: "US", address1: "500 Howard St", postalCode: "94105" },
    workAuth: { authorizedCountries: ["US"], needsSponsorship: false },
    logistics: { yearsOfExperience: 6 },
    preferences: { titles: ["Senior Software Engineer"], workplace: "any", seniority: ["senior", "mid"], locations: [], excludeCompanies: [], keywords: [] },
  });
  const ext = fileURLToPath(new URL("../../extension", import.meta.url));
  // The extension runs in a person's own Chrome, which doesn't announce automation; the sandbox's bot wall keys on
  // that, as real ones do, so this browser plays the person's.
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--disable-blink-features=AutomationControlled"],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  await sw.evaluate(([t, apiUrl]) => (globalThis as any).chrome.storage.local.set({ token: t, apiUrl }), [token, BASE]);
});

after(async () => {
  await ctx?.close();
  server.close();
  await closeBrowsers();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test("extension fills a plain application form in your tab and never submits", async () => {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/mock-ats/acme/jobs/1001`);
  const report = await fillWithPanel(p);
  assert.match(report, /Filled \d+ of \d+ fields/);
  assert.equal(await p.inputValue("#first_name"), "Alex");
  assert.match(await p.inputValue("#email"), /@/);
  assert.ok((await p.evaluate(() => (document.querySelector("#resume") as HTMLInputElement).files?.[0]?.size ?? 0)) > 1000, "tailored résumé attached");
  assert.ok(!p.url().includes("confirmation"), "nothing submitted");
  const subs = await (await fetch(`${BASE}/mock-ats/submissions`)).json();
  assert.equal(subs.length, 0);
  await p.close();
});

test("SmartRecruiters-style: Ferry's browser stops at the bot wall; the extension fills the web-component form in yours", async () => {
  const job = await jobByTitle("Robotics Software Engineer");
  const created = await call("POST", "/applications", { jobId: job.id });
  const handed = await waitFor(created.id, ["NEEDS_INPUT", "FAILED", "COMPLETED"]);
  assert.equal(handed.status, "NEEDS_INPUT");
  assert.match(handed.error, /bot check \(DataDome\)/);
  assert.match(handed.error, /Ferry extension/);

  // The person opens the posting, clicks "I'm interested", and fills the one-click form with the extension.
  const p = await ctx.newPage();
  await p.goto(job.url);
  await panel(p).locator("button.pill").waitFor({ timeout: 15000 });
  await p.getByText("I'm interested").click();
  await p.waitForURL(/oneclick-ui/);
  const report = await fillWithPanel(p);
  assert.match(report, /Filled 1[2-4] of 14 fields/, report); // every field, inside the components' shadow roots
  assert.doesNotMatch(report, /Still needs you/, report);

  const v = (name: string) => p.evaluate((n) => (document.querySelector(`[name=${n}]`) as any).value, name);
  assert.equal(await v("firstName"), "Alex");
  assert.match(await v("email"), /@/);
  assert.equal(await v("confirmEmail"), await v("email"));
  assert.equal(await v("location"), "San Francisco, CA, United States", "a city suggestion was picked, not just typed");
  assert.ok(await v("phone"));
  assert.match(await v("resume"), /\.pdf$/);
  assert.equal(await v("authorized"), "Yes");
  assert.equal(await v("sponsorship"), "No", "the button dropdown was opened and an option chosen");
  assert.equal(await v("years"), "6");
  assert.equal(await v("privacy"), "yes");
  assert.equal((await (await fetch(`${BASE}/mock-ats/handback-submissions`)).json()).length, 0, "the extension didn't submit");

  // The person submits; the sandbox accepts every value the extension set; "I submitted it" closes the loop.
  await p.getByRole("button", { name: "Submit", exact: true }).click();
  await p.getByText("Thank you for applying").waitFor({ timeout: 10000 });
  const sub = (await (await fetch(`${BASE}/mock-ats/handback-submissions`)).json()).at(-1);
  assert.equal(sub.kind, "smartr");
  assert.ok(sub.files.resume > 1000);
  await panel(p).locator("button.submitted").click();
  const done = await waitFor(created.id, ["COMPLETED"], 10000);
  assert.equal(done.trackedStatus, "APPLIED");
  await p.close();
});

test("LinkedIn-style Easy Apply: each step of the modal is filled as it appears; you click Next and Submit", async () => {
  const job = await jobByTitle("Fleet Reliability Engineer");
  const p = await ctx.newPage();
  await p.goto(job.url);
  await panel(p).locator("button.pill").waitFor({ timeout: 15000 });
  await p.getByRole("button", { name: /Easy Apply/ }).click();
  const dialog = p.getByRole("dialog");

  // Step 1: contact info. The email LinkedIn already has is kept.
  let report = await fillWithPanel(p);
  assert.match(report, /already filled in/);
  assert.equal(await dialog.locator("#firstName").inputValue(), "Alex");
  assert.ok(await dialog.locator("#phone").inputValue());
  assert.equal(await dialog.locator("#phoneCountry").inputValue(), "United States (+1)");
  assert.equal(await dialog.locator("#email").inputValue(), "member@example.com");
  await dialog.getByRole("button", { name: "Next" }).click();

  // Step 2: résumé upload.
  report = await fillWithPanel(p, /fill this step/i);
  assert.match(await dialog.locator("#chip").innerText(), /\.pdf$/);
  await dialog.getByRole("button", { name: "Next" }).click();

  // Step 3: screening questions, from the résumé and profile.
  report = await fillWithPanel(p, /fill this step/i);
  assert.doesNotMatch(report, /Still needs you/, report);
  assert.equal(await dialog.locator("#tsYears").inputValue(), "5", "years with TypeScript: only the 2022–present role mentions it");
  assert.equal(await dialog.locator("input[name=authorized][value=Yes]").isChecked(), true);
  assert.equal(await dialog.locator("#sponsorship").inputValue(), "No");
  assert.equal(await dialog.locator("input[name=bachelors][value=Yes]").isChecked(), true);
  await dialog.getByRole("button", { name: "Review" }).click();
  await dialog.getByRole("button", { name: "Submit application" }).click();
  await dialog.getByText("Your application was sent").waitFor({ timeout: 10000 });

  const sub = (await (await fetch(`${BASE}/mock-ats/handback-submissions`)).json()).at(-1);
  assert.equal(sub.kind, "linkedin");
  assert.equal(sub.data.firstName, "Alex");
  assert.equal(sub.data.sponsorship, "No");
  assert.ok(sub.files.resume > 1000);

  // One application in Ferry holds every step's answers; "I submitted it" marks it applied.
  await panel(p).locator("button.submitted").click();
  const listed = await call("GET", "/applications?limit=50");
  const a = (Array.isArray(listed) ? listed : listed.items).find((x: any) => x.jobId === job.id || x.job?.id === job.id);
  const full = await waitFor(a.id, ["COMPLETED"], 10000);
  const labels = full.fields.map((f: any) => f.label).join(" | ");
  assert.match(labels, /Mobile phone number/);
  assert.match(labels, /TypeScript/);
  await p.close();
});
