// Ferry as an MCP server, end to end: hand it a list of jobs, follow the batch, answer what it asks back in the chat,
// approve; set up the profile from the conversation; connect with OAuth (PKCE, scopes, rotation); and the stdio bridge.
//   npm test --workspace apps/server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-mcp-"));
const PORT = 9000 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
Object.assign(process.env, { DATA_DIR: dir, PORT: String(PORT), PUBLIC_URL: BASE, WEB_URL: BASE, LLM_DISABLED: "true", HEADLESS: "true", AUTH_MODE: "dev" });

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { api } = await import("../src/api.ts");
const { mcp } = await import("../src/mcp.ts");
const { oauth } = await import("../src/oauth.ts");
const { mockAts, seedSandboxJobs } = await import("../src/mock/ats.ts");
const { closeBrowsers } = await import("../src/browser.ts");
const { linksIn } = await import("../src/routes/agent.ts");

const app = new Hono();
app.route("/", oauth);
app.route("/api/v1/mcp", mcp);
app.route("/api/v1", api);
app.route("/mock-ats", mockAts);
let server: ReturnType<typeof serve>;
let token = "";

const rest = async (method: string, p: string, body?: unknown, auth = token) => {
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
let rpcId = 0;
async function rpc(method: string, params: unknown, auth = token) {
  const res = await fetch(`${BASE}/api/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}
async function tool(name: string, args: Record<string, unknown> = {}, auth = token) {
  const r = await rpc("tools/call", { name, arguments: args }, auth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.error) throw new Error(r.body.error.message);
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
}
const toolNames = async (auth = token) => ((await rpc("tools/list", {}, auth)).body.result.tools as { name: string }[]).map((t) => t.name).sort();
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

before(async () => {
  server = serve({ fetch: app.fetch, port: PORT });
  seedSandboxJobs();
  token = (await rest("POST", "/auth/login", { email: "mcp@ferry.local", name: "Alex Morgan" }, "")).data.token;
});
after(async () => {
  server.close();
  await closeBrowsers();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("links are pulled out of pasted text, in order, once each", () => {
  assert.deepEqual(linksIn("Apply to https://a.co/j/1, and https://b.co/x?y=2.\nAlso https://a.co/j/1"), ["https://a.co/j/1", "https://b.co/x?y=2"]);
});

test("profile from the conversation: import a résumé, list profiles, update work authorization, save answers", async () => {
  const resume = fs.readFileSync(new URL("../../../samples/alex_morgan_resume.txt", import.meta.url), "utf8");
  const imported = await tool("import_resume", { text: resume, name: "Software Engineer" });
  assert.equal(imported.name, "Software Engineer");
  assert.equal(imported.roles, 3);
  assert.deepEqual((await tool("list_profiles")).map((p: any) => [p.name, p.default]), [["Software Engineer", true]]);
  const p = await tool("update_profile", { work_auth: { authorizedCountries: ["US"], needsSponsorship: false, citizenship: "US", clearance: "None" }, personal: { city: "San Francisco", region: "CA", country: "US" } });
  assert.equal(p.workAuth.clearance, "None");
  assert.equal(p.personal.firstName, "Alex", "only the keys passed change");
  assert.equal(p.answers, undefined, "remembered answers aren't sent back");
  const saved = await tool("set_answers", { answers: [{ question: "Are you open to relocation?", answer: "Yes, for the right role." }] });
  assert.equal(saved.saved, 1);
  const lib = (await rest("GET", "/profile")).data.library;
  assert.ok(lib.some((e: any) => e.question === "Are you open to relocation?" && e.mode === "fixed"));
});

test("apply to a list: batch statuses, progress, questions back to the chat, approve the batch", async () => {
  // Ferry shouldn't write the open-ended answer itself here, so it comes back as a question.
  await rest("PATCH", "/settings", { autoWriteAnswers: false });
  const acme = `${BASE}/mock-ats/acme/jobs/1001`;
  const batch = await tool("apply_to_jobs", { items: [acme, "job_nope"], text: `Also this one: ${acme} (same as above)`, notes: "Lead with the platform work" });
  const byInput = Object.fromEntries(batch.items.map((i: any) => [i.input, i]));
  assert.equal(byInput[acme].status, "queued");
  assert.equal(byInput.job_nope.status, "not_a_job");
  assert.equal(batch.items.length, 2, "the duplicate link counts once");
  const appId = byInput[acme].application_id;
  const { getApplication } = await import("../src/store.ts");
  assert.equal(getApplication(appId)!.tailorInstructions, "Lead with the platform work", "notes steer tailoring and answers");

  // Progress: wait_for_updates reports the first status change.
  const update = await tool("wait_for_updates", { batch_id: batch.batch_id, timeout_seconds: 50 });
  assert.ok(update.changed.length >= 1);

  // It stops on the question it can't answer; the agent asks the user and sends the answer back.
  const q = await until(
    () => tool("pending_questions", { batch_id: batch.batch_id }),
    (r: any) => r.questions.length > 0,
  );
  const why = q.questions.find((x: any) => /why do you want/i.test(x.question));
  assert.ok(why, JSON.stringify(q));
  assert.equal(why.application_id, appId);
  const answered = await tool("answer_questions", { answers: [{ application_id: appId, field_id: why.field_id, value: "I want to build fleet software at scale." }], remember: true });
  assert.deepEqual(answered[0].still_needed, []);

  // It continues and pauses for review before submitting; approving the batch (after the user said yes) sends it.
  const ready = await until(
    () => tool("get_batch", { batch_id: batch.batch_id }),
    (b: any) => b.counts.waiting_for_review === 1,
  );
  assert.equal(ready.counts.not_a_job, 1);
  const approved = await tool("approve_batch", { batch_id: batch.batch_id });
  assert.deepEqual(approved.approved, [appId]);
  const done = await until(
    () => tool("get_batch", { batch_id: batch.batch_id }),
    (b: any) => b.counts.done === 1,
  );
  assert.equal(done.items.find((i: any) => i.application_id === appId).application_status, "COMPLETED");
  const subs = await (await fetch(`${BASE}/mock-ats/submissions`)).json();
  assert.equal(subs.at(-1).fields.why, "I want to build fleet software at scale.");
  // remember=true: the answer is saved for next time.
  assert.ok(Object.values((await rest("GET", "/profile")).data.answers).includes("I want to build fleet software at scale."));
});

test("OAuth: discovery, registration, consent, PKCE, read-only scope, refresh rotation, disconnect", async () => {
  // An unauthenticated MCP request points the client at the metadata.
  const unauth = await rpc("tools/list", {}, "");
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:\d+\/.well-known\/oauth-protected-resource"/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${BASE}/api/v1/mcp`);
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);

  const bad = await fetch(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(bad.status, 400, "plain http only to localhost");
  const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test Desktop", redirect_uris: ["http://127.0.0.1:33418/callback"] }) })).json();
  const redirect = "http://127.0.0.1:33418/callback";
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  // /oauth/authorize sends the browser to Ferry's consent page with the request.
  const auth = await fetch(`${meta.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope: "jobs:read", state: "xyz" })}`, { redirect: "manual" });
  assert.equal(auth.status, 302);
  const consent = new URL(auth.headers.get("location")!);
  assert.equal(consent.pathname, "/oauth/consent");
  assert.equal(consent.searchParams.get("scope"), "jobs:read");
  assert.equal((await rest("GET", `/oauth/client?client_id=${reg.client_id}`)).data.name, "Test Desktop");

  // The signed-in user allows read-only access; the app gets a one-time code.
  const decision = (await rest("POST", "/oauth/approve", { client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, scope: "jobs:read", state: "xyz", allow: true })).data;
  const back = new URL(decision.redirect);
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code")!;
  const exchange = (verifierUsed: string, codeUsed = code) =>
    fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: codeUsed, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifierUsed }) });
  assert.equal((await exchange("wrong-verifier")).status, 400, "PKCE checked");
  assert.equal((await exchange(verifier)).status, 400, "a code works once (the failed attempt used it up)");

  // Again, properly.
  const code2 = new URL((await rest("POST", "/oauth/approve", { client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, scope: "jobs:read", allow: true })).data.redirect).searchParams.get("code")!;
  const tok = await (await exchange(verifier, code2)).json();
  assert.equal(tok.token_type, "Bearer");
  assert.equal(tok.scope, "jobs:read");

  // Read-only: the write tools aren't offered, and the REST API refuses changes.
  const readTools = await toolNames(tok.access_token);
  assert.ok(readTools.includes("get_job_matches") && readTools.includes("pending_questions"));
  for (const w of ["apply_to_jobs", "apply_to_job", "approve_batch", "answer_questions", "update_profile", "import_resume"]) assert.ok(!readTools.includes(w), w);
  assert.equal((await rest("GET", "/applications", undefined, tok.access_token)).status, 200);
  assert.equal((await rest("POST", "/batches", { items: ["job_x"] }, tok.access_token)).status, 403);
  const all = await toolNames();
  assert.ok(all.includes("apply_to_jobs") && all.includes("approve_batch"), "API tokens get every tool");

  // Refresh rotates: the old refresh token stops working.
  const refresh = (rt: string) => fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: reg.client_id }) });
  const tok2 = await (await refresh(tok.refresh_token)).json();
  assert.ok(tok2.access_token && tok2.access_token !== tok.access_token);
  assert.equal((await refresh(tok.refresh_token)).status, 400);

  // Settings → Connected apps lists it; disconnecting cuts it off.
  const conns = (await rest("GET", "/oauth/connections")).data;
  assert.deepEqual(conns.map((x: any) => [x.name, x.scope]), [["Test Desktop", "jobs:read"]]);
  await rest("DELETE", `/oauth/connections/${reg.client_id}`);
  assert.equal((await rpc("tools/list", {}, tok2.access_token)).status, 401);
});

test("ferry mcp: the stdio bridge speaks JSON-RPC lines to Ferry", async () => {
  const cli = fileURLToPath(new URL("../../cli/bin/ferry.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "mcp"], { env: { ...process.env, FERRY_URL: BASE, FERRY_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, "ferry-jobs");
  assert.ok(byId[2].result.tools.some((t: any) => t.name === "apply_to_jobs"));
  assert.equal(lines.length, 2, "the notification gets no reply");
});
