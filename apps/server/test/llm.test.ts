// Claude integration contract: every AI feature calls the Messages API with the right model,
// beta header, server-side fallback, and structured-output schema, and parses the response.
// Uses a local fake of the API (test/fake-anthropic.ts); real-model quality needs a real key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAnthropic } from "./fake-anthropic.ts";

const fake = await startFakeAnthropic();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-llm-"));
const PORT = 8900 + Math.floor(Math.random() * 90);
Object.assign(process.env, {
  DATA_DIR: dir,
  PORT: String(PORT),
  PUBLIC_URL: `http://localhost:${PORT}`,
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_BASE_URL: fake.url,
  LLM_PROVIDER: "anthropic", // a NIM key in .env must not route this Anthropic-contract test to NVIDIA
  LLM_DISABLED: "false",
  HEADLESS: "true",
});

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { api } = await import("../src/api.ts");
const { mockAts, seedSandboxJobs } = await import("../src/mock/ats.ts");
const { closeBrowsers } = await import("../src/browser.ts");
const { llmEnabled } = await import("../src/llm.ts");

const app = new Hono();
app.route("/api/v1", api);
app.route("/mock-ats", mockAts);
let server: ReturnType<typeof serve>;
let token = "";
const call = async (method: string, p: string, body?: unknown) =>
  (await (await fetch(`http://localhost:${PORT}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()) as any;
const waitFor = async (id: string, statuses: string[]) => {
  for (let i = 0; i < 180; i++) {
    const a = await call("GET", `/applications/${id}`);
    if (statuses.includes(a.status)) return a;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timeout");
};

before(async () => {
  server = serve({ fetch: app.fetch, port: PORT });
  seedSandboxJobs();
  token = (await call("POST", "/auth/login", { email: "llm@ferry.local", name: "Alex Morgan" })).token;
  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(new URL("../../../samples/alex_morgan_resume.txt", import.meta.url))]), "resume.txt");
  await fetch(`http://localhost:${PORT}/api/v1/resumes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  await call("PUT", "/profile", {
    personal: { firstName: "Alex", lastName: "Morgan", city: "San Francisco", region: "CA", country: "US" },
    workAuth: { authorizedCountries: ["US"], needsSponsorship: false },
    logistics: { yearsOfExperience: 6 },
  });
});
after(async () => {
  server.close();
  await closeBrowsers();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LLM mode is on and requests use the documented contract", async () => {
  assert.equal(llmEnabled(), true);
  const jobs = (await call("GET", "/jobs/search?q=Acme&limit=10")).items;
  const job = await call("GET", `/jobs/${jobs.find((j: any) => j.title === "Software Engineer, Platform").id}`);
  assert.ok(job.match);
  // Force an LLM-scored match through the fetch endpoint.
  const fetched = await call("POST", "/jobs/fetch", { url: job.url });
  assert.equal(fetched.match.method, "llm");
  assert.equal(fetched.match.score, 91);

  const parsed = fake.requests.filter((r) => r.body.output_config?.format);
  assert.ok(parsed.length >= 2, "résumé parse + match used structured outputs");
  for (const r of fake.requests) {
    assert.equal(r.body.model, "claude-opus-5-5");
    assert.equal(r.body.fallbacks, "default");
    assert.match(String(r.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.match(String(r.headers["x-api-key"]), /sk-ant-test/);
    assert.ok(r.body.output_config?.effort, "effort set explicitly");
  }
  const match = fake.requests.find((r) => /senior technical recruiter/.test(r.body.system));
  assert.equal(match!.body.output_config.format.type, "json_schema");
  assert.equal(match!.body.output_config.format.schema.additionalProperties, false);
});

test("tailoring, cover letter, and AI answers flow into a ready-to-send application", async () => {
  const jobs = (await call("GET", "/jobs/search?q=Acme&limit=10")).items;
  const job = jobs.find((j: any) => j.title === "Software Engineer, Platform");
  const created = await call("POST", "/applications", { jobId: job.id });
  const a = await waitFor(created.id, ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "FAILED"]);
  assert.equal(a.status, "PENDING_SUBMIT_REVIEW", a.error);
  assert.ok(a.changes.some((c: any) => /Built distributed/.test(c.after)), "LLM tailoring applied");
  assert.match(a.coverLetter, /Fake-model cover letter/);
  const why = a.fields.find((f: any) => f.label.startsWith("Why do you want"));
  assert.equal(why.source, "written");
  assert.match(why.value, /Acme's fleet software/);
});

test("email classification and reply drafts go through the model", async () => {
  const r = await call("POST", "/inbox/ingest", { from: "jobs@acme.example", subject: "Interview", body: "We'd like to schedule an interview with you." });
  assert.equal(r.message.category, "interview");
  const d = await call("POST", `/inbox/messages/${r.message.id}/draft-reply`);
  assert.match(d.draft, /Tuesday/);
});
