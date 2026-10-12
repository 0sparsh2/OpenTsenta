// End-to-end: résumé → match → tailor → browser apply → submit → confirmation → inbox routing,
// against the local sandbox employer. Runs with an isolated data dir and no LLM.
//   npm test --workspace apps/server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-test-"));
const PORT = 8800 + Math.floor(Math.random() * 100);
process.env.DATA_DIR = dir;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = `http://localhost:${PORT}`;
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
// Same forms at a path the engine doesn't recognize as the sandbox: treated like a real employer.
app.route("/demo-careers", mockAts);
let server: ReturnType<typeof serve>;
let token = "";

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${PORT}/api/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
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

before(async () => {
  server = serve({ fetch: app.fetch, port: PORT });
  seedSandboxJobs();
  token = (await call("POST", "/auth/login", { email: "test@ferry.local", name: "Alex Morgan" })).token;
  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(new URL("../../../samples/alex_morgan_resume.txt", import.meta.url))]), "alex_morgan_resume.txt");
  const up = await (await fetch(`http://localhost:${PORT}/api/v1/resumes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  assert.equal(up.resume.doc.experience.length, 3);
  await call("PUT", "/profile", {
    personal: { city: "San Francisco", region: "CA", country: "US", address1: "500 Howard St", postalCode: "94105" },
    workAuth: { authorizedCountries: ["US"], needsSponsorship: false },
    logistics: { yearsOfExperience: 6 },
    preferences: { titles: ["Senior Software Engineer"], workplace: "any", seniority: ["senior", "mid"], locations: [], excludeCompanies: [], keywords: [] },
  });
});

after(async () => {
  server.close();
  await closeBrowsers();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sandbox jobs are matched with reasons", async () => {
  const res = await call("GET", "/jobs/search?q=Acme&limit=10&sort=match");
  assert.ok(res.items.length >= 3);
  const platform = res.items.find((j: any) => j.title.includes("Platform"));
  const detail = await call("GET", `/jobs/${platform.id}`);
  assert.ok(detail.match.score >= 60, `score ${detail.match.score}`);
  assert.ok(detail.match.reasons.length > 0);
});

test("one-page form: fills, writes the open question for this job, submits your edit after review", async () => {
  const jobs = (await call("GET", "/jobs/search?q=Acme&limit=10")).items;
  const job = jobs.find((j: any) => j.title.includes("Platform"));
  const created = await call("POST", "/applications", { jobId: job.id });
  assert.ok(created.profile?.name, "application is pinned to a profile");
  let a = await waitFor(created.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"]);
  assert.equal(a.status, "PENDING_SUBMIT_REVIEW", a.error);
  const byLabel = (l: string) => a.fields.find((f: any) => f.label.startsWith(l));
  assert.equal(byLabel("First Name").value, "Alex");
  assert.equal(byLabel("Location").value, "San Francisco, CA");
  assert.equal(byLabel("Are you legally authorized").value, "Yes");
  assert.equal(byLabel("Will you now or in the future").value, "No");
  assert.match(byLabel("Gender").value, /decline/i);
  assert.match(String(byLabel("Resume").value), /\.pdf$/);
  // "Why do you want to work at Acme Robotics?" is written for this job from the résumé.
  const why = byLabel("Why do you want");
  assert.equal(why.source, "written");
  assert.match(why.value, /Acme Robotics/);
  assert.doesNotMatch(why.value, /\{company\}/);

  await call("POST", `/applications/${a.id}/approve`, { fields: [{ id: why.id, value: "I want to build fleet software." }] });
  a = await waitFor(a.id, ["COMPLETED", "FAILED", "NEEDS_INPUT"]);
  assert.equal(a.status, "COMPLETED", a.error);
  assert.equal(a.confirmation.dryRun, false);
  assert.equal(a.trackedStatus, "APPLIED");

  const subs = await (await fetch(`http://localhost:${PORT}/mock-ats/submissions`)).json();
  const sub = subs.at(-1);
  assert.equal(sub.fields.why, "I want to build fleet software.");
  assert.equal(sub.fields.authorized, "yes");
  assert.ok(sub.files.some((f: any) => f.field === "resume" && f.size > 1000));

  // Job-specific prose isn't saved as a reusable answer.
  const profile = await call("GET", "/profile");
  assert.ok(!Object.keys(profile.answers).some((q) => q.includes("acme")), JSON.stringify(profile.answers));

  const wallet = await call("GET", "/wallet");
  assert.equal(wallet.credits, 24);
});

test("multi-step wizard: walks every step, writes the project answer, submits", async () => {
  const jobs = (await call("GET", "/jobs/search?q=Acme&limit=10")).items;
  const job = jobs.find((j: any) => j.title.includes("Integrations"));
  const created = await call("POST", "/applications", { jobId: job.id });
  let a = await waitFor(created.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"]);
  assert.equal(a.status, "PENDING_SUBMIT_REVIEW", a.error);
  assert.equal(a.totalPages, 3);
  const years = a.fields.find((f: any) => f.label.startsWith("Years of professional"));
  assert.equal(years.value, "5-7");
  const proj = a.fields.find((f: any) => f.label.startsWith("Describe an integration"));
  assert.equal(proj.source, "written");
  assert.ok(proj.value.length > 40, proj.value);
  await call("POST", `/applications/${a.id}/approve`, {});
  a = await waitFor(a.id, ["COMPLETED", "FAILED", "NEEDS_INPUT"]);
  assert.equal(a.status, "COMPLETED", a.error);
  const sub = (await (await fetch(`http://localhost:${PORT}/mock-ats/submissions`)).json()).at(-1);
  assert.equal(sub.fields.project, proj.value);
});

test("recruiter email is routed to the application and moves the tracker", async () => {
  const r = await call("POST", "/inbox/ingest", {
    from: "talent@acmerobotics.example",
    fromName: "Acme Robotics Recruiting",
    subject: "Next steps for Software Engineer, Platform at Acme Robotics",
    body: "Hi Alex, thanks for applying to Acme Robotics! We'd love to schedule a 30-minute interview. What's your availability this week?",
  });
  assert.equal(r.message.category, "interview");
  assert.ok(r.message.applicationId, "routed to an application");
  const tracker = await call("GET", "/tracker");
  assert.equal(tracker.columns.INTERVIEWING.length, 1);
});

test("MCP-equivalent flow: add a job by URL from the sandbox", async () => {
  const j = await call("POST", "/jobs/fetch", { url: `http://localhost:${PORT}/mock-ats/acme/jobs/1002` });
  assert.ok(j.title.length > 0);
});

test("real-employer safety: fills everything, stops before Submit, sends nothing, charges nothing", async () => {
  const before = (await call("GET", "/wallet")).credits;
  const subsBefore = (await (await fetch(`http://localhost:${PORT}/mock-ats/submissions`)).json()).length;
  const job = await call("POST", "/jobs/fetch", { url: `http://localhost:${PORT}/demo-careers/acme/jobs/1001` });
  const created = await call("POST", "/applications", { jobId: job.id });
  let a = await waitFor(created.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"]);
  if (a.status === "NEEDS_INPUT") {
    const missing = a.fields.filter((f: any) => f.required && (f.value == null || f.value === ""));
    await call("POST", `/applications/${a.id}/approve`, { fields: missing.map((f: any) => ({ id: f.id, value: "Answer" })) });
  } else {
    assert.equal(a.status, "PENDING_SUBMIT_REVIEW", a.error);
    await call("POST", `/applications/${a.id}/approve`, {});
  }
  a = await waitFor(a.id, ["COMPLETED", "FAILED"]);
  assert.equal(a.status, "COMPLETED", a.error);
  assert.equal(a.confirmation.dryRun, true);
  const subsAfter = (await (await fetch(`http://localhost:${PORT}/mock-ats/submissions`)).json()).length;
  assert.equal(subsAfter, subsBefore, "nothing was submitted");
  assert.equal((await call("GET", "/wallet")).credits, before, "dry runs are free");
});

test("Workday-style tenant: creates an account with your application password, verifies by emailed code, applies, then reuses it", async () => {
  const { workdaySubmissions } = await import("../src/mock/workday.ts");
  // Your own password for job-site accounts; weak ones are refused.
  assert.match((await call("PUT", "/application-password", { password: "short" })).error, /12 characters/);
  await call("PUT", "/application-password", { password: "Harbor-Lights-2026!" });
  assert.equal((await call("GET", "/application-password")).hasPassword, true);
  const jobs = (await call("GET", "/jobs/search?q=Acme&limit=20")).items;
  const sre = jobs.find((j: any) => j.title === "Site Reliability Engineer");
  assert.ok(sre, "workday sandbox job seeded");

  const created = await call("POST", "/applications", { jobId: sre.id });
  let a = await waitFor(created.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"], 180000);
  assert.equal(a.status, "PENDING_SUBMIT_REVIEW", `${a.status}: ${a.error} :: ${a.trace.slice(-4).map((t: any) => t.text).join(" | ")}`);
  assert.ok(a.trace.some((t: any) => /Creating your candidate account/.test(t.text)), "created an account");
  assert.ok(a.trace.some((t: any) => /verification code/.test(t.text)), "entered the emailed code");
  const accounts = await call("GET", "/ats-accounts");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].status, "active");
  assert.equal(accounts[0].passwordKind, "application");
  const pw = await call("POST", `/ats-accounts/${accounts[0].id}/reveal`);
  assert.equal(pw.password, "Harbor-Lights-2026!");
  // The application shows which account it used, and can reveal its password.
  const acct = await call("GET", `/applications/${a.id}/account`);
  assert.equal(acct.account.host, accounts[0].host);
  assert.equal(acct.email, "test@ferry.local");
  assert.equal((await call("POST", `/applications/${a.id}/account/reveal`)).password, "Harbor-Lights-2026!");
  const byLabel = (l: string) => a.fields.find((f: any) => f.label.startsWith(l));
  assert.equal(byLabel("State").value, "California");
  assert.equal(byLabel("How many years").value, "6-9 years");
  assert.equal(byLabel("Phone Device Type").value, "Mobile");
  assert.equal(byLabel("Address Line 1").value, "500 Howard St");

  await call("POST", `/applications/${a.id}/approve`, {});
  a = await waitFor(a.id, ["COMPLETED", "FAILED", "NEEDS_INPUT"], 180000);
  assert.equal(a.status, "COMPLETED", `${a.error} :: ${a.trace.slice(-4).map((t: any) => t.text).join(" | ")}`);
  assert.ok(a.trace.some((t: any) => /Signing in to .* saved employer account/.test(t.text)), "signed in with the saved account");
  const sub = workdaySubmissions.at(-1)!;
  assert.equal(sub.data.state, "California");
  assert.equal(sub.data.sponsor, "No");
  assert.ok(sub.files.resume?.size > 1000);

  // The confirmation email lands in the tracker via mail sync.
  const sync = await call("POST", "/integrations/mail/sync");
  assert.ok(sync.synced >= 1, "confirmation email synced");
  const inbox = await call("GET", "/inbox/messages");
  assert.ok(inbox.some((m: any) => m.category === "confirmation" && m.applicationId === a.id), "routed to the application");

  // Second job at the same employer: sign in, no new account.
  const fs2 = jobs.find((j: any) => j.title.startsWith("Senior Full Stack Engineer, Fleet"));
  const b = await call("POST", "/applications", { jobId: fs2.id });
  const done = await waitFor(b.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"], 180000);
  assert.equal(done.status, "PENDING_SUBMIT_REVIEW", done.error);
  assert.equal((await call("GET", "/ats-accounts")).length, 1, "reused the account");
  assert.ok(!done.trace.some((t: any) => /Creating your candidate account/.test(t.text)));
});
