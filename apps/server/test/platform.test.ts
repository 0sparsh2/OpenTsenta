// Production surfaces: password auth + sessions, Stripe billing webhooks, text-message channel,
// notifications, and per-user isolation. Runs with test keys; no network calls leave the machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-platform-"));
const PORT = 9000 + Math.floor(Math.random() * 90);
Object.assign(process.env, {
  DATA_DIR: dir,
  PORT: String(PORT),
  PUBLIC_URL: `http://localhost:${PORT}`,
  AUTH_MODE: "password",
  SANDBOX_JOBS: "true", // password mode is a real instance; these tests use the sandbox employers
  LLM_DISABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_ferry",
  STRIPE_WEBHOOK_SECRET: "whsec_test_ferry",
  STRIPE_PRICE_PRO: "price_pro_test",
  TWILIO_AUTH_TOKEN: "twilio_test_token",
});
delete process.env.TWILIO_ACCOUNT_SID; // keep outbound texts in "log" mode

const { serve } = await import("@hono/node-server");
const { Hono } = await import("hono");
const { api } = await import("../src/api.ts");
const { mockAts, seedSandboxJobs } = await import("../src/mock/ats.ts");
const { mcp } = await import("../src/mcp.ts");
const { stripe } = await import("../src/billing.ts");
const { pendingOtp } = await import("../src/messaging.ts");
const { startNotifications } = await import("../src/notify/index.ts");
const { all, one, run } = await import("../src/db.ts");

const app = new Hono();
app.route("/api/v1/mcp", mcp);
app.route("/api/v1", api);
app.route("/mock-ats", mockAts);
let server: ReturnType<typeof serve>;

const req = async (method: string, p: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://localhost:${PORT}/api/v1${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* xml */
  }
  return { status: res.status, data };
};
const latestMail = (to: string) => one<{ subject: string; text: string }>("SELECT subject, text FROM local_mail WHERE to_addr = ? ORDER BY id DESC LIMIT 1", to);
const tokenIn = (text: string) => text.match(/token=([\w-]+)/)?.[1] ?? "";

before(() => {
  server = serve({ fetch: app.fetch, port: PORT });
  seedSandboxJobs();
  startNotifications();
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let session = "";
let userId = "";

test("password sign-up sends a verification email and returns a session", async () => {
  assert.equal((await req("POST", "/auth/signup", { email: "pat@ferry.test", password: "short" })).status, 400);
  const r = await req("POST", "/auth/signup", { email: "pat@ferry.test", password: "correct horse 42", name: "Pat Lee" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.token, /^sess_/);
  session = r.data.token;
  userId = r.data.user.id;
  assert.equal(r.data.user.emailVerified, false);
  const mail = latestMail("pat@ferry.test")!;
  assert.match(mail.subject, /Confirm your email/);
  assert.equal((await req("POST", "/auth/verify-email", { token: tokenIn(mail.text) })).status, 200);
  assert.equal((await req("POST", "/auth/verify-email", { token: tokenIn(mail.text) })).status, 400, "single use");
  const me = await req("GET", "/me", undefined, session);
  assert.equal(me.data.emailVerified, true);
  assert.equal((await req("POST", "/auth/signup", { email: "pat@ferry.test", password: "correct horse 42" })).status, 409);
});

test("login, logout, magic link, and password reset", async () => {
  assert.equal((await req("POST", "/auth/login", { email: "pat@ferry.test", password: "wrong password 1" })).status, 401);
  const ok = await req("POST", "/auth/login", { email: "pat@ferry.test", password: "correct horse 42" });
  assert.equal(ok.status, 200);
  const s2 = ok.data.token;
  assert.equal((await req("POST", "/auth/logout", {}, s2)).status, 200);
  assert.equal((await req("GET", "/me", undefined, s2)).status, 401, "revoked session");

  assert.equal((await req("POST", "/auth/magic-link", { email: "pat@ferry.test" })).status, 200);
  const magic = latestMail("pat@ferry.test")!;
  assert.match(magic.subject, /sign-in link/);
  const m = await req("POST", "/auth/magic", { token: tokenIn(magic.text) });
  assert.equal(m.status, 200);
  assert.equal((await req("POST", "/auth/magic", { token: tokenIn(magic.text) })).status, 401, "single use");

  await req("POST", "/auth/forgot", { email: "pat@ferry.test" });
  const reset = latestMail("pat@ferry.test")!;
  const r = await req("POST", "/auth/reset", { token: tokenIn(reset.text), password: "new password 99" });
  assert.equal(r.status, 200);
  assert.equal((await req("GET", "/me", undefined, session)).status, 401, "reset signs out other sessions");
  session = r.data.token;
  assert.equal((await req("POST", "/auth/login", { email: "pat@ferry.test", password: "new password 99" })).status, 200);
  // The API token still works for MCP/CLI and is distinct from browser sessions.
  const me = await req("GET", "/me", undefined, session);
  assert.match(me.data.token, /^fy_/);
  assert.equal((await req("GET", "/me", undefined, me.data.token)).status, 200);
});

test("login is rate limited", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await req("POST", "/auth/login", { email: "nobody@ferry.test", password: "nope nope 11" })).status;
  assert.equal(last, 429);
});

test("Stripe webhooks: verified, idempotent, and drive plan + credits", async () => {
  const sign = (event: object) => {
    const payload = JSON.stringify(event);
    return { payload, header: stripe().webhooks.generateTestHeaderString({ payload, secret: "whsec_test_ferry" }) };
  };
  const send = (e: object, header?: string) => {
    const s = sign(e);
    return req("POST", "/webhooks/stripe", s.payload, undefined, { "stripe-signature": header ?? s.header });
  };
  const bad = await send({ id: "evt_x", type: "invoice.paid", data: { object: {} } }, "t=1,v1=deadbeef");
  assert.equal(bad.status, 400);

  const completed = { id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { object: "checkout.session", client_reference_id: userId, customer: "cus_test_1", metadata: { plan: "pro", userId } } } };
  assert.equal((await send(completed)).data.handled, true);
  assert.equal((await send(completed)).data.duplicate, true);

  const paid = { id: "evt_2", object: "event", type: "invoice.paid", data: { object: { object: "invoice", customer: "cus_test_1", period_end: Math.floor(Date.now() / 1000) + 30 * 86400, lines: { data: [{ pricing: { price_details: { price: "price_pro_test" } } }] } } } };
  assert.equal((await send(paid)).data.handled, true);
  const w = await req("GET", "/wallet", undefined, session);
  assert.equal(w.data.plan, "pro");
  assert.equal(w.data.credits, 1500);
  assert.ok(w.data.renewsAt);

  const cancelled = { id: "evt_3", object: "event", type: "customer.subscription.deleted", data: { object: { object: "subscription", customer: "cus_test_1", items: { data: [] } } } };
  await send(cancelled);
  assert.equal((await req("GET", "/wallet", undefined, session)).data.plan, "free");
});

test("text channel: verify phone, get match alerts, apply by replying", async () => {
  const fd = new FormData();
  fd.set("file", new Blob([fs.readFileSync(new URL("../../../samples/alex_morgan_resume.txt", import.meta.url))]), "resume.txt");
  await fetch(`http://localhost:${PORT}/api/v1/resumes`, { method: "POST", headers: { Authorization: `Bearer ${session}` }, body: fd });

  const s = await req("POST", "/messaging/otp/send", { phone: "(415) 555-0199", channel: "imessage" }, session);
  assert.equal(s.data.to, "+14155550199");
  assert.equal(s.data.provider, "log");
  assert.equal((await req("POST", "/messaging/otp/verify", { code: "000000" }, session)).status, 400);
  assert.equal((await req("POST", "/messaging/otp/verify", { code: pendingOtp(userId) }, session)).status, 200);

  // A strong match triggers a text.
  const { matchJobsForUser } = await import("../src/match/score.ts");
  const { getUser, toJob } = await import("../src/store.ts");
  const jobs = all("SELECT * FROM jobs WHERE company LIKE 'Acme%'").map(toJob);
  await req("PATCH", "/messaging/prefs", { minScore: 40 }, session);
  // The résumé upload already rescored everything, silently (those jobs aren't news); these arrive as new postings.
  const { rematchPending } = await import("../src/match/score.ts");
  for (let i = 0; i < 100 && rematchPending(userId); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!(await req("GET", "/messaging", undefined, session)).data.log.some((m: any) => /^New match:/.test(m.body)), "a rescore sends no alerts");
  run("DELETE FROM matches WHERE user_id = ?", userId);
  await matchJobsForUser(getUser(userId)!, jobs, { minStore: 0 });
  const msgs = (await req("GET", "/messaging", undefined, session)).data.log;
  assert.ok(msgs.some((m: any) => /^New match:/.test(m.body)), `match alert sent: ${JSON.stringify(msgs.map((m: any) => m.body))}`);

  const list = await req("POST", "/messaging/simulate", { text: "matches" }, session);
  assert.match(list.data.reply, /Top matches:\n1\./);
  const apply = await req("POST", "/messaging/simulate", { text: "apply 1" }, session);
  assert.match(apply.data.reply, /On it: applying/);
  const apps = await req("GET", "/applications", undefined, session);
  assert.equal(apps.data.length, 1);
  assert.equal((await req("POST", "/messaging/simulate", { text: "STOP" }, session)).data.reply.includes("won't get more texts"), true);
});

test("Twilio webhook: signature checked, reply generated", async () => {
  const params = { From: "+14155550199", Body: "status" };
  const url = `http://localhost:${PORT}/api/v1/webhooks/twilio`;
  const sig = crypto.createHmac("sha1", "twilio_test_token").update(url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("")).digest("base64");
  const form = new URLSearchParams(params).toString();
  const good = await req("POST", "/webhooks/twilio", form, undefined, { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": sig });
  assert.equal(good.status, 200);
  assert.match(good.data, /<Message>Submitted 0/);
  const badSig = await req("POST", "/webhooks/twilio", form, undefined, { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "nope" });
  assert.equal(badSig.status, 403);
});

test("users can't read each other's data; MCP accepts sessions and API tokens", async () => {
  const other = await req("POST", "/auth/signup", { email: "sam@ferry.test", password: "another pass 7" });
  const mine = await req("POST", "/inbox/ingest", { from: "talent@acme.example", subject: "Interview", body: "Let's schedule an interview" }, session);
  assert.ok(mine.data.message);
  assert.equal((await req("POST", `/inbox/messages/${mine.data.message.id}/draft-reply`, {}, other.data.token)).status, 404);
  const apps = (await req("GET", "/applications", undefined, session)).data;
  assert.equal((await req("GET", `/applications/${apps[0].id}`, undefined, other.data.token)).status, 404);

  const init = await fetch(`http://localhost:${PORT}/api/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(init.status, 200);
});
