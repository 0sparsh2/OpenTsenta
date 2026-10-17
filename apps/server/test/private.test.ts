// A private Ferry (ALLOW_SIGNUPS=false), as when it's exposed through a tunnel: existing accounts sign in,
// nobody new gets an account by sign-up, local-mode login, or an email link.
//   npm test --workspace apps/server
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ferry-private-")), AUTH_MODE: "password", ALLOW_SIGNUPS: "false", LLM_DISABLED: "true" });
const { api } = await import("../src/api.ts");
const { createUser, getUserByEmail, setPasswordHash } = await import("../src/store.ts");
const { hashPassword } = await import("../src/session.ts");

const post = (url: string, body: unknown) => api.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("private instance: no new accounts by any route; the owner still signs in", async () => {
  assert.deepEqual(await (await api.request("/auth/config")).json(), { mode: "password", brand: "Ferry", signups: false });

  const signup = await post("/auth/signup", { email: "stranger@example.com", password: "a-long-passw0rd" });
  assert.equal(signup.status, 403);
  assert.match((await signup.json()).error, /private/);

  const magic = await post("/auth/magic-link", { email: "stranger@example.com" });
  assert.deepEqual(await magic.json(), { ok: true }, "same answer as for a real account");
  assert.equal(getUserByEmail("stranger@example.com"), undefined, "no account was made");

  const owner = createUser("owner@example.com", "Owner");
  setPasswordHash(owner.id, await hashPassword("owner-passw0rd-1"));
  const login = await post("/auth/login", { email: "owner@example.com", password: "owner-passw0rd-1" });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).token);
  assert.equal((await post("/auth/signup", { email: "owner@example.com", password: "x" })).status, 400, "an existing email isn't told sign-ups are closed");
});

test("a real instance doesn't list the sandbox employers' practice postings", async () => {
  const { ingestJob } = await import("../src/store.ts");
  const { seedSandboxJobs } = await import("../src/mock/ats.ts");
  const { one } = await import("../src/db.ts");
  const left = ingestJob({ companyId: null, company: "Acme Robotics (sandbox)", ats: "mock", externalId: "old-1001", title: "Software Engineer, Platform", location: "Remote", workplace: "remote", url: "https://old-tunnel.example/mock-ats/acme/jobs/1001", applyUrl: "https://old-tunnel.example/mock-ats/acme/jobs/1001", description: "", sponsorsVisa: null });
  seedSandboxJobs();
  assert.equal(one("SELECT 1 FROM jobs WHERE id = ?", left.id), undefined, "left over from an earlier run: removed");
  assert.equal(one("SELECT 1 FROM jobs WHERE url LIKE '%/mock-ats/%'"), undefined, "none seeded");
});
