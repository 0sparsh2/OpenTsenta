import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ATS_LIST, atsName, detectAts, parseJobUrl } from "./ats.ts";
import { subscribe } from "./bus.ts";
import { config, paths, ROOT } from "./config.ts";
import { all, one, parse, run, uid } from "./db.ts";
import { addCompany, listCompanies } from "./ingest/companies.ts";
import { resolveJob } from "./ingest/jd.ts";
import { pollAll, pollerStatus } from "./ingest/poller.ts";
import { FETCHERS } from "./ingest/sources.ts";
import { compileQuery, describeQuery } from "./match/query.ts";
import { locationSuggestions } from "./ingest/locations.ts";
import { ensureDescription } from "./ingest/describe.ts";
import { llmEnabled } from "./llm.ts";
import { matchJobsForUser, rematchUser, saveMatch } from "./match/score.ts";
import { cancel, enqueue, queueStatus } from "./apply/queue.ts";
import { resumes } from "./routes/resumes.ts";
import { extension } from "./routes/extension.ts";
import { agent } from "./routes/agent.ts";
import { oauthApi, oauthUser } from "./oauth.ts";
import { pickProfile } from "./resume/profiles.ts";
import {
  createApplication,
  createUser,
  getApplication,
  getDefaultResume,
  getJob,
  getResume,
  getUserByEmail,
  getUser,
  passwordHashOf,
  rotateApiToken,
  setEmailVerified,
  setPasswordHash,
  grantCredits,
  listResumes,
  patchApplication,
  saveResume,
  setDefaultResume,
  setOnboarded,
  setTrackedStatus,
  toApplication,
  toJob,
  updateProfile,
  updateSettings,
  displayName,
  type Application,
  type User,
} from "./store.ts";
import { draftReply, getMessage, ingestEmail, listMessages, unreadCount } from "./track/inbox.ts";
import { authUrl, disconnectGmail, exchangeCode, gmailConfigured, gmailConnected } from "./mail/gmail.ts";
import { deleteImap, imapDefaults, loadImap, mailSources, saveImap, syncMail, testImap } from "./mail/index.ts";
import { applicationPasswordStatus, deleteAccount, deleteApplicationPassword, getApplicationPassword, listAccounts, PASSWORD_RULES, passwordRuleFailures, revealAccount, setApplicationPassword } from "./vault.ts";
import { emailTemplates, sendEmail } from "./notify/email.ts";
import { consumeToken, createSession, hashPassword, issueToken, listSessions, passwordProblem, rateLimited, revokeAllSessions, revokeSession, userForToken, verifyPassword } from "./session.ts";
import { webhooks } from "./webhooks.ts";
import { checkout, PLANS, portal, stripeEnabled } from "./billing.ts";
import { confirmPhoneVerification, handleInbound, phoneOf, prefsOf, providerFor, recentMessages, setPrefs, startPhoneVerification } from "./messaging.ts";
import { deletePushSubscription, pushUser, saveNativeToken, savePushSubscription, vapidPublicKey } from "./notify/index.ts";
import { STATUS_BUCKETS, TRACKED_STATUSES, type FilledField, type Job, type Profile, type ResumeDoc } from "./types.ts";

type Env = { Variables: { user: User } };
export const api = new Hono<Env>();

const bad = (c: Context, msg: string, code: 400 | 401 | 402 | 403 | 404 | 409 = 400) => c.json({ error: msg }, code);

// ---------- auth ----------

const ip = (c: Context) => c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
const throttled = (c: Context, key: string, max = 10, windowMs = 10 * 60_000) => rateLimited(`${key}:${ip(c)}`, max, windowMs);
const link = (path: string, token: string) => `${config.webUrl.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}`;

async function sendVerification(user: User) {
  const t = emailTemplates.verify(link("/auth/verify", issueToken(user.id, "verify_email", 24 * 60)));
  await sendEmail({ to: user.email, ...t }).catch((e) => console.warn("[mail] verification:", (e as Error).message));
}
const session = (c: Context, user: User) => c.json({ token: createSession(user.id, c.req.header("user-agent")), user: publicUser(getUser(user.id)!) });

api.get("/auth/config", (c) => c.json({ mode: config.authMode, brand: config.brand }));

api.post("/auth/signup", async (c) => {
  if (throttled(c, "signup", 10)) return bad(c, "Too many attempts. Try again in a few minutes.", 429 as 400);
  const b = z.object({ email: z.string().email(), password: z.string().optional(), name: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "A valid email is required");
  const email = b.data.email.toLowerCase();
  if (config.authMode === "dev") return session(c, getUserByEmail(email) ?? createUser(email, b.data.name ?? ""));
  const problem = passwordProblem(b.data.password ?? "");
  if (problem) return bad(c, problem);
  if (getUserByEmail(email)) return bad(c, "An account with this email already exists. Sign in instead.", 409);
  const user = createUser(email, b.data.name ?? "");
  setPasswordHash(user.id, await hashPassword(b.data.password!));
  await sendVerification(user);
  return session(c, user);
});

api.post("/auth/login", async (c) => {
  const b = z.object({ email: z.string().email(), password: z.string().optional(), name: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "A valid email is required");
  const email = b.data.email.toLowerCase();
  if (throttled(c, `login:${email}`, 8)) return bad(c, "Too many attempts. Try again in a few minutes.", 429 as 400);
  if (config.authMode === "dev") return session(c, getUserByEmail(email) ?? createUser(email, b.data.name ?? ""));
  const user = getUserByEmail(email);
  if (!user || !(await verifyPassword(b.data.password ?? "", passwordHashOf(user.id)))) return bad(c, "Wrong email or password", 401);
  return session(c, user);
});

/** Always answers ok, so the endpoint can't be used to discover which emails have accounts. */
api.post("/auth/magic-link", async (c) => {
  const b = z.object({ email: z.string().email() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "A valid email is required");
  if (throttled(c, `magic:${b.data.email.toLowerCase()}`, 5)) return c.json({ ok: true });
  const user = getUserByEmail(b.data.email) ?? createUser(b.data.email, "");
  const t = emailTemplates.magic(link("/auth/magic", issueToken(user.id, "magic_link", 20)));
  await sendEmail({ to: user.email, ...t }).catch((e) => console.warn("[mail] magic link:", (e as Error).message));
  return c.json({ ok: true });
});
api.post("/auth/magic", async (c) => {
  const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
  const userId = token ? consumeToken(token, "magic_link") : null;
  if (!userId) return bad(c, "This sign-in link is invalid or has expired", 401);
  setEmailVerified(userId);
  return session(c, getUser(userId)!);
});
api.post("/auth/verify-email", async (c) => {
  const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
  const userId = token ? consumeToken(token, "verify_email") : null;
  if (!userId) return bad(c, "This confirmation link is invalid or has expired");
  setEmailVerified(userId);
  return c.json({ ok: true });
});
api.post("/auth/forgot", async (c) => {
  const { email } = (await c.req.json().catch(() => ({}))) as { email?: string };
  const user = email ? getUserByEmail(email) : undefined;
  if (user && !throttled(c, `reset:${user.email}`, 5)) {
    const t = emailTemplates.reset(link("/auth/reset", issueToken(user.id, "reset_password", 60)));
    await sendEmail({ to: user.email, ...t }).catch(() => {});
  }
  return c.json({ ok: true });
});
api.post("/auth/reset", async (c) => {
  const { token, password } = (await c.req.json().catch(() => ({}))) as { token?: string; password?: string };
  const problem = passwordProblem(password ?? "");
  if (problem) return bad(c, problem);
  const userId = token ? consumeToken(token, "reset_password") : null;
  if (!userId) return bad(c, "This reset link is invalid or has expired");
  setPasswordHash(userId, await hashPassword(password!));
  revokeAllSessions(userId);
  setEmailVerified(userId);
  return session(c, getUser(userId)!);
});

// Gmail OAuth callback is hit by Google, not the app, so it sits before the auth middleware.
// `state` is a single-use token, never the user's API token.
api.get("/integrations/gmail/callback", async (c) => {
  const userId = consumeToken(c.req.query("state") ?? "", "oauth_state");
  const code = c.req.query("code");
  if (!userId || !code) return c.text("Invalid or expired OAuth callback", 400);
  await exchangeCode(userId, code);
  void syncMail(userId).catch(() => {});
  return c.redirect(`${config.webUrl}/app/settings?tab=email&gmail=connected`);
});

// Inbound webhooks (Stripe, Twilio, Sendblue) authenticate by signature, not bearer tokens.
api.route("/webhooks", webhooks);

api.use("*", async (c, next) => {
  const h = c.req.header("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : c.req.query("token");
  // OAuth access tokens (MCP clients): a read-only connection may look but not change anything.
  const viaOAuth = token ? oauthUser(token) : null;
  if (viaOAuth && !viaOAuth.scopes.has("jobs:apply") && c.req.method !== "GET") return bad(c, "This connection is read-only (jobs:read). Reconnect with the jobs:apply permission to act.", 403);
  const user = viaOAuth?.user ?? (token ? userForToken(token) : undefined);
  if (!user) return bad(c, "Unauthorized", 401);
  c.set("user", user);
  await next();
});

api.post("/auth/logout", (c) => {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer sess_")) revokeSession(h.slice(7));
  return c.json({ ok: true });
});
api.post("/auth/logout-all", (c) => {
  revokeAllSessions(c.get("user").id);
  return c.json({ ok: true });
});
api.post("/auth/resend-verification", async (c) => {
  const u = c.get("user");
  if (!u.emailVerified && !throttled(c, `verify:${u.id}`, 3)) await sendVerification(u);
  return c.json({ ok: true });
});
api.post("/auth/password", async (c) => {
  const u = c.get("user");
  const { current, password } = (await c.req.json().catch(() => ({}))) as { current?: string; password?: string };
  const problem = passwordProblem(password ?? "");
  if (problem) return bad(c, problem);
  if (u.hasPassword && !(await verifyPassword(current ?? "", passwordHashOf(u.id)))) return bad(c, "Current password is wrong", 401);
  setPasswordHash(u.id, await hashPassword(password!));
  return c.json({ ok: true });
});
api.post("/auth/api-token/rotate", (c) => c.json({ token: rotateApiToken(c.get("user").id) }));
api.get("/auth/sessions", (c) => c.json({ count: listSessions(c.get("user").id) }));

const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  emailVerified: u.emailVerified,
  hasPassword: u.hasPassword,
  name: displayName(u),
  plan: u.plan,
  credits: u.credits,
  onboarded: u.onboarded,
  createdAt: u.createdAt,
});

api.get("/me", (c) => {
  const u = c.get("user");
  // In local mode, where the CLI lives (Claude Desktop runs `node <cliPath> mcp`; `npx ferry` would fetch an unrelated package).
  const cliPath = config.authMode === "dev" ? path.join(ROOT, "apps/cli/bin/ferry.mjs") : undefined;
  return c.json({ ...publicUser(u), token: u.token, llm: llmEnabled(), allowRealSubmit: config.allowRealSubmit, brand: config.brand, authMode: config.authMode, cliPath });
});

// ---------- realtime ----------

api.get("/events", (c) => {
  const user = c.get("user");
  return streamSSE(c, async (stream) => {
    const unsub = subscribe(user.id, (e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 25000);
    stream.onAbort(() => {
      unsub();
      clearInterval(ping);
    });
    await new Promise<void>((resolve) => stream.onAbort(resolve));
  });
});

// ---------- dashboard ----------

api.get("/dashboard/bootstrap", (c) => {
  const u = c.get("user");
  return c.json({
    user: publicUser(u),
    counts: applicationCounts(u.id),
    topMatches: recommendations(u.id, 8, 0),
    recent: listApplications(u.id, "all", 8),
    unread: unreadCount(u.id),
    hasResume: Boolean(getDefaultResume(u.id)),
    poller: pollerStatus(),
    totals: one("SELECT COUNT(*) AS jobs, COUNT(DISTINCT company) AS companies FROM jobs WHERE closed_at IS NULL"),
    llm: llmEnabled(),
  });
});

// ---------- profile, settings, résumés ----------

api.get("/profile", (c) => c.json(c.get("user").profile));
api.put("/profile", async (c) => {
  const u = c.get("user");
  const p = (await c.req.json()) as Profile;
  const merged: Profile = {
    ...u.profile,
    ...p,
    personal: { ...u.profile.personal, ...p.personal },
    workAuth: { ...u.profile.workAuth, ...p.workAuth },
    preferences: { ...u.profile.preferences, ...p.preferences },
    logistics: { ...u.profile.logistics, ...p.logistics },
    eeo: { ...u.profile.eeo, ...p.eeo },
    answers: p.answers ?? u.profile.answers,
    library: Array.isArray(p.library) ? p.library.filter((e) => e && typeof e.question === "string" && e.question.trim()) : u.profile.library,
  };
  updateProfile(u.id, merged);
  return c.json(merged);
});

api.get("/settings", (c) => c.json(c.get("user").settings));
api.patch("/settings", async (c) => c.json(updateSettings(c.get("user").id, await c.req.json())));

// Résumé profiles, previews, tailored résumés and the answer library live in routes/resumes.ts.
api.route("/", resumes);
api.route("/", extension);
api.route("/", agent);
api.route("/", oauthApi);

api.post("/onboarding/complete", (c) => {
  const u = c.get("user");
  setOnboarded(u.id);
  setImmediate(() => void rematchUser(u).catch((e) => console.error("[rematch]", e)));
  return c.json({ ok: true });
});

api.post("/jobs/rematch", (c) => {
  const u = c.get("user");
  setImmediate(() => void rematchUser(u).catch((e) => console.error("[rematch]", e)));
  return c.json({ ok: true });
});

// ---------- jobs ----------

function jobView(j: Job, m?: Record<string, unknown> | null, app?: { id?: unknown; status?: unknown } | null) {
  return {
    applicationId: (app?.id as string) ?? null,
    applicationStatus: (app?.status as string) ?? null,
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    workplace: j.workplace,
    department: j.department,
    ats: j.ats,
    atsName: atsName(j.ats),
    url: j.url,
    salary: j.salary,
    postedAt: j.postedAt,
    firstSeenAt: j.firstSeenAt,
    sponsorsVisa: j.sponsorsVisa,
    match: m
      ? { score: Number(m.score), verdict: m.verdict, reasons: parse<string[]>(m.reasons, []), gaps: parse<string[]>(m.gaps, []), method: m.method, status: m.status, profileId: (m.profile_id as string) ?? null }
      : null,
  };
}

function recommendations(userId: string, limit: number, offset: number, minScore = 0) {
  const rows = all(
    `SELECT j.*, m.score, m.verdict, m.reasons, m.gaps, m.method, m.status, m.profile_id FROM matches m JOIN jobs j ON j.id = m.job_id
     WHERE m.user_id = ? AND m.status = 'new' AND j.closed_at IS NULL AND m.score >= ?
     AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = m.user_id AND a.job_id = m.job_id)
     ORDER BY m.score DESC, j.first_seen_at DESC LIMIT ? OFFSET ?`,
    userId,
    minScore,
    limit,
    offset,
  );
  return rows.map((r) => jobView(toJob(r), r));
}

api.get("/jobs/recommendations", (c) => {
  const u = c.get("user");
  const limit = Math.min(400, Number(c.req.query("limit") ?? 30));
  const offset = Number(c.req.query("offset") ?? 0);
  const minScore = Number(c.req.query("minScore") ?? 0);
  const total = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM matches m JOIN jobs j ON j.id = m.job_id WHERE m.user_id = ? AND m.status = 'new' AND j.closed_at IS NULL AND m.score >= ? AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = m.user_id AND a.job_id = m.job_id)",
    u.id,
    minScore,
  )?.n;
  return c.json({ items: recommendations(u.id, limit, offset, minScore), total });
});

api.get("/jobs/search", (c) => {
  const u = c.get("user");
  const q = (c.req.query("q") ?? "").trim();
  const scope = c.req.query("in") === "all" ? "all" : "title";
  const where: string[] = ["j.closed_at IS NULL"];
  const params: unknown[] = [];
  // Keywords: AND by default, OR, "phrases", -exclusions, (groups), prefix*. See match/query.ts.
  const query = compileQuery(q, scope);
  let hits = "";
  const hitParams: unknown[] = [];
  if (query.include) {
    hits = "JOIN (SELECT rowid AS rid, bm25(jobs_fts, 10.0, 4.0, 0.0, 1.0) AS rank FROM jobs_fts WHERE jobs_fts MATCH ?) h ON h.rid = j.rowid";
    hitParams.push(query.include);
  }
  if (query.exclude) {
    where.push("j.rowid NOT IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)");
    params.push(query.exclude);
  }
  // Places: any of the picked cities, metros, states, countries, or remote buckets.
  const places = (c.req.query("places") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (places.length) {
    where.push(`j.id IN (SELECT job_id FROM job_places WHERE key IN (${places.map(() => "?").join(",")}))`);
    params.push(...places);
  }
  const workplace = c.req.query("workplace");
  if (workplace && workplace !== "any") {
    where.push("j.workplace = ?");
    params.push(workplace);
  }
  const company = c.req.query("company");
  if (company) {
    where.push("j.company = ?");
    params.push(company);
  }
  const posted = c.req.query("posted");
  if (posted && /^\d+$/.test(posted)) {
    where.push("COALESCE(j.posted_at, j.first_seen_at) >= datetime('now', ?)");
    params.push(`-${posted} days`);
  }
  if (c.req.query("sponsors") === "1") where.push("j.sponsors_visa = 1");
  // "For you": matched above a minimum fit, not skipped or applied to (the same filters apply).
  const forYou = c.req.query("forYou") === "1";
  if (forYou) {
    where.push("m.status = 'new' AND m.score >= ?", "NOT EXISTS (SELECT 1 FROM applications a2 WHERE a2.user_id = m.user_id AND a2.job_id = m.job_id)");
    params.push(Number(c.req.query("minScore") ?? 0));
  }
  const limit = Math.min(400, Number(c.req.query("limit") ?? 40));
  const offset = Number(c.req.query("offset") ?? 0);
  const sortBy = c.req.query("sort");
  const sort =
    sortBy === "relevance" && hits ? "h.rank ASC" : sortBy === "newest" ? "COALESCE(j.posted_at, j.first_seen_at) DESC" : sortBy === "match" || !sortBy ? "COALESCE(m.score, -1) DESC, COALESCE(j.posted_at, j.first_seen_at) DESC" : "COALESCE(j.posted_at, j.first_seen_at) DESC";
  // The page's job ids first (from the open-jobs index), then the full rows for just those.
  const ids = all<{ id: string }>(
    `SELECT j.id FROM jobs j ${hits}
     LEFT JOIN matches m ON m.job_id = j.id AND m.user_id = ?
     WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    ...hitParams,
    u.id,
    ...params,
    limit,
    offset,
  ).map((r) => r.id);
  const byId = new Map(
    (ids.length
      ? all<Record<string, unknown>>(
          `SELECT j.*, m.score, m.verdict, m.reasons, m.gaps, m.method, m.status, m.profile_id, a.id AS app_id, a.status AS app_status FROM jobs j
           LEFT JOIN matches m ON m.job_id = j.id AND m.user_id = ?
           LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ?
           WHERE j.id IN (${ids.map(() => "?").join(",")})`,
          u.id,
          u.id,
          ...ids,
        )
      : []
    ).map((r) => [r.id as string, r]),
  );
  const rows = ids.map((id) => byId.get(id)!).filter(Boolean) as Record<string, any>[];
  const total = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM jobs j ${hits} ${forYou ? "JOIN matches m ON m.job_id = j.id AND m.user_id = ?" : ""} WHERE ${where.join(" AND ")}`,
    ...hitParams,
    ...(forYou ? [u.id] : []),
    ...params,
  )?.n;
  return c.json({
    items: rows.map((r) => jobView(toJob(r), r.score == null ? null : r, r.app_id ? { id: r.app_id, status: r.app_status } : null)),
    total,
    query: query.node ? { reading: describeQuery(query.node), scope } : null,
  });
});

/** Location suggestions for the filter: places with open jobs, grouped (remote, metros, cities, states, countries). */
api.get("/jobs/locations", (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const picked = new Set((c.req.query("selected") ?? "").split(",").filter(Boolean));
  return c.json(locationSuggestions(q, picked));
});

api.get("/jobs/companies", (c) => c.json(all("SELECT company, COUNT(*) AS n FROM jobs WHERE closed_at IS NULL GROUP BY company ORDER BY n DESC")));

api.get("/jobs/:id", async (c) => {
  const u = c.get("user");
  const found = getJob(c.req.param("id"));
  if (!found) return bad(c, "Not found", 404);
  const job = await ensureDescription(found);
  let m = one("SELECT * FROM matches WHERE user_id = ? AND job_id = ?", u.id, job.id);
  const pick = m ? null : pickProfile(u, job);
  if (pick) {
    saveMatch(u.id, job.id, { ...pick.match, profileId: pick.profile.id });
    m = one("SELECT * FROM matches WHERE user_id = ? AND job_id = ?", u.id, job.id);
  }
  const app = one<{ id: string }>("SELECT id FROM applications WHERE user_id = ? AND job_id = ?", u.id, job.id);
  return c.json({ ...jobView(job, m), description: job.description, applyUrl: job.applyUrl, applicationId: app?.id ?? null });
});

api.post("/jobs/:id/skip", (c) => {
  run("UPDATE matches SET status = 'skipped' WHERE user_id = ? AND job_id = ?", c.get("user").id, c.req.param("id"));
  return c.json({ ok: true });
});

/** Add a role by URL (dashboard paste box, browser extension, MCP). */
api.post("/jobs/fetch", async (c) => {
  const u = c.get("user");
  const body = z
    .object({ url: z.string().url(), title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), description: z.string().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return bad(c, "A job URL is required");
  try {
    const job = await resolveJob(body.data);
    await matchJobsForUser(u, [job], { minStore: 0, llmBudget: 1 });
    const m = one("SELECT * FROM matches WHERE user_id = ? AND job_id = ?", u.id, job.id);
    return c.json(jobView(job, m));
  } catch (e) {
    return bad(c, `Couldn't read that job: ${(e as Error).message}`);
  }
});

// ---------- applications ----------

/** The profile an application uses: the one it's pinned to, else what the job matched with. */
function profileOf(a: Application) {
  const id = a.resumeId ?? one<{ profile_id: string | null }>("SELECT profile_id FROM matches WHERE user_id = ? AND job_id = ?", a.userId, a.jobId)?.profile_id;
  const r = id ? getResume(id) : undefined;
  return r && r.userId === a.userId ? { id: r.id, name: r.name } : null;
}

/** Profile for a new application: an explicit choice, else the match's profile, else the best fit. */
function chooseProfile(u: User, jobId: string, requested?: string) {
  if (requested) {
    const r = getResume(requested);
    if (r && r.userId === u.id) return r.id;
  }
  const matched = one<{ profile_id: string | null }>("SELECT profile_id FROM matches WHERE user_id = ? AND job_id = ?", u.id, jobId)?.profile_id;
  if (matched && getResume(matched)) return matched;
  const job = getJob(jobId);
  return job ? (pickProfile(u, job)?.profile.id ?? null) : null;
}

function appView(a: Application, withDetail = false) {
  const job = getJob(a.jobId);
  const base = {
    id: a.id,
    status: a.status,
    profile: profileOf(a),
    reviewResume: a.reviewResume,
    trackedStatus: a.trackedStatus,
    source: a.source,
    job: job ? { id: job.id, title: job.title, company: job.company, location: job.location, ats: job.ats, atsName: atsName(job.ats), url: job.url } : null,
    atsScore: a.atsScore,
    changesCount: a.changes.length,
    hasCoverLetter: Boolean(a.coverLetter),
    lastThought: a.lastThought,
    currentPage: a.currentPage,
    totalPages: a.totalPages,
    error: a.error,
    confirmation: a.confirmation,
    submittedAt: a.submittedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    needs: a.fields.filter((f) => f.required && (f.value == null || f.value === "")).map((f) => f.label),
  };
  if (!withDetail) return base;
  return { ...base, tailored: a.tailored, changes: a.changes, coverLetter: a.coverLetter, fields: a.fields, trace: a.trace, statusHistory: a.statusHistory, resumeId: a.resumeId, hasPdf: Boolean(a.resumePdf) };
}

function listApplications(userId: string, tab: string, limit = 200, q = "") {
  const statuses = STATUS_BUCKETS[tab];
  const where = ["a.user_id = ?"];
  const params: unknown[] = [userId];
  if (statuses) {
    where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (q) {
    where.push("(j.title LIKE ? OR j.company LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  return all(`SELECT a.* FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC LIMIT ?`, ...params, limit).map((r) => appView(toApplication(r)));
}

function applicationCounts(userId: string) {
  const rows = all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM applications WHERE user_id = ? GROUP BY status", userId);
  const counts: Record<string, number> = { all: 0 };
  for (const [bucket, statuses] of Object.entries(STATUS_BUCKETS)) counts[bucket] = rows.filter((r) => statuses.includes(r.status as never)).reduce((s, r) => s + r.n, 0);
  counts.all = rows.reduce((s, r) => s + r.n, 0);
  return counts;
}

api.get("/applications", (c) => c.json(listApplications(c.get("user").id, c.req.query("tab") ?? "all", Number(c.req.query("limit") ?? 200), c.req.query("q") ?? "")));
api.get("/applications/counts", (c) => c.json(applicationCounts(c.get("user").id)));
api.get("/applications/queue", (c) => c.json(queueStatus()));

api.post("/applications", async (c) => {
  const u = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { jobId?: string; url?: string; resumeId?: string; source?: string; description?: string; title?: string; company?: string; previewResume?: boolean; notes?: string };
  if (!getDefaultResume(u.id)) return bad(c, "Upload a résumé first", 409);
  if (u.credits <= 0) return bad(c, "You're out of application credits", 402);
  let jobId = body.jobId;
  if (!jobId && body.url) jobId = (await resolveJob({ url: body.url, title: body.title, company: body.company, description: body.description })).id;
  if (!jobId || !getJob(jobId)) return bad(c, "Unknown job", 404);
  const { app, created } = createApplication(u.id, jobId, body.source ?? "dashboard", chooseProfile(u, jobId, body.resumeId));
  if (created && typeof body.previewResume === "boolean") patchApplication(app.id, { reviewResume: body.previewResume });
  // Notes for this job ("lead with the payments work") steer tailoring and written answers.
  if (created && body.notes?.trim()) patchApplication(app.id, { tailorInstructions: body.notes.trim().slice(0, 4000) });
  enqueue(app.id);
  return c.json(appView(getApplication(app.id)!));
});

api.post("/applications/bulk", async (c) => {
  const u = c.get("user");
  const { jobIds } = (await c.req.json()) as { jobIds: string[] };
  if (!getDefaultResume(u.id)) return bad(c, "Upload a résumé first", 409);
  const out = [];
  for (const id of jobIds.slice(0, Math.max(0, u.credits))) {
    if (!getJob(id)) continue;
    const { app } = createApplication(u.id, id, "dashboard", chooseProfile(u, id));
    enqueue(app.id);
    out.push(app.id);
  }
  return c.json({ queued: out });
});

const ownApp = (c: Context<Env>) => {
  const a = getApplication(c.req.param("id") ?? "");
  return a && a.userId === c.get("user").id ? a : undefined;
};

api.get("/applications/:id", (c) => {
  const a = ownApp(c);
  return a ? c.json({ ...appView(a, true), job: { ...appView(a).job, description: getJob(a.jobId)?.description } }) : bad(c, "Not found", 404);
});

/** Approve whatever gate the application is paused at, optionally with edits. */
api.post("/applications/:id/approve", async (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const body = (await c.req.json().catch(() => ({}))) as { fields?: { id: string; value: FilledField["value"] }[]; tailored?: ResumeDoc; coverLetter?: string };
  const patch: Partial<Application> = {};
  if (body.tailored) {
    patch.tailored = body.tailored;
    patch.resumePdf = null;
    patch.resumeDocx = null;
  }
  if (body.coverLetter != null) patch.coverLetter = body.coverLetter;
  if (body.fields?.length) {
    patch.fields = a.fields.map((f) => {
      const edit = body.fields!.find((e) => e.id === f.id);
      return edit ? { ...f, value: edit.value, source: "user" as const, confidence: 1, note: undefined } : f;
    });
  }
  patchApplication(a.id, { ...patch, error: null });
  if (a.status === "PENDING_RESUME_REVIEW" || a.status === "PENDING_CL_REVIEW") {
    patchApplication(a.id, { status: "QUEUED" });
    enqueue(a.id, { approved: true });
  } else {
    patchApplication(a.id, { status: "QUEUED" });
    enqueue(a.id, { approved: true, submit: true });
  }
  return c.json(appView(getApplication(a.id)!));
});

api.put("/applications/:id/cover-letter", async (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const { text } = (await c.req.json()) as { text: string };
  return c.json(appView(patchApplication(a.id, { coverLetter: text }), true));
});
api.post("/applications/:id/regenerate", (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  patchApplication(a.id, { tailored: null, changes: [], atsScore: null, resumePdf: null, resumeDocx: null, coverLetter: null, status: "QUEUED", error: null });
  run("UPDATE applications SET cover_letter = NULL, tailored = NULL WHERE id = ?", a.id);
  enqueue(a.id);
  return c.json(appView(getApplication(a.id)!));
});
api.post("/applications/:id/retry", (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  patchApplication(a.id, { status: "QUEUED", error: null });
  enqueue(a.id);
  return c.json(appView(getApplication(a.id)!));
});
api.post("/applications/:id/skip", (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  cancel(a.id);
  return c.json(appView(patchApplication(a.id, { status: "SKIPPED" })));
});
api.post("/applications/skip-bulk", async (c) => {
  const { ids } = (await c.req.json()) as { ids: string[] };
  for (const id of ids) {
    const a = getApplication(id);
    if (a?.userId === c.get("user").id) {
      cancel(id);
      patchApplication(id, { status: "SKIPPED" });
    }
  }
  return c.json({ ok: true });
});
api.patch("/applications/:id/tracked", async (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const { status } = (await c.req.json()) as { status: (typeof TRACKED_STATUSES)[number] };
  if (!TRACKED_STATUSES.includes(status)) return bad(c, "Bad status");
  return c.json(appView(setTrackedStatus(a.id, status, "moved manually")!));
});

// ---------- tracker ----------

api.get("/tracker", (c) => {
  const u = c.get("user");
  const apps = all("SELECT * FROM applications WHERE user_id = ? AND tracked_status IS NOT NULL ORDER BY submitted_at DESC", u.id).map(toApplication);
  const columns = Object.fromEntries(TRACKED_STATUSES.map((s) => [s, apps.filter((a) => a.trackedStatus === s).map((a) => appView(a))]));
  const flows = new Map<string, number>();
  for (const a of apps) {
    const seq = a.statusHistory.map((h) => h.status).filter((s) => TRACKED_STATUSES.includes(s as never));
    for (let i = 0; i < seq.length - 1; i++) if (seq[i] !== seq[i + 1]) flows.set(`${seq[i]}|${seq[i + 1]}`, (flows.get(`${seq[i]}|${seq[i + 1]}`) ?? 0) + 1);
  }
  return c.json({ columns, flows: [...flows].map(([k, value]) => ({ source: k.split("|")[0], target: k.split("|")[1], value })) });
});

// ---------- inbox ----------

api.get("/inbox/messages", (c) => {
  const msgs = listMessages(c.get("user").id);
  return c.json(msgs.map((m) => ({ ...m, application: m.applicationId ? appView(getApplication(m.applicationId)!) : null })));
});
api.get("/inbox/unread-count", (c) => c.json({ count: unreadCount(c.get("user").id) }));
api.post("/inbox/messages/:id/read", (c) => {
  run("UPDATE inbox_messages SET read = 1 WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});
api.post("/inbox/read-all", (c) => {
  run("UPDATE inbox_messages SET read = 1 WHERE user_id = ?", c.get("user").id);
  return c.json({ ok: true });
});
api.post("/inbox/messages/:id/draft-reply", async (c) => {
  const m = one("SELECT id FROM inbox_messages WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id) ? getMessage(c.req.param("id")) : undefined;
  if (!m) return bad(c, "Not found", 404);
  return c.json({ draft: await draftReply(m.id) });
});
/** Manual ingest: paste or forward an email (also a webhook target for mail forwarding). */
api.post("/inbox/ingest", async (c) => {
  const b = (await c.req.json()) as { from: string; fromName?: string; subject: string; body: string; receivedAt?: string };
  if (!b.from || !b.subject) return bad(c, "from and subject are required");
  const m = await ingestEmail(c.get("user").id, { fromAddr: b.from, fromName: b.fromName, subject: b.subject, body: b.body ?? "", receivedAt: b.receivedAt });
  return c.json({ message: m, ignored: !m });
});

api.get("/integrations/mail", (c) => {
  const u = c.get("user");
  const imap = loadImap(u.id);
  return c.json({ ...mailSources(u.id), gmailConfigured: gmailConfigured(), imapUser: imap?.user ?? null, imapHost: imap?.host ?? null, lastSync: one<{ v: string }>("SELECT v FROM kv WHERE k = ?", `mail_sync:${u.id}`)?.v?.replace(/"/g, "") ?? null });
});
api.get("/integrations/gmail", (c) => c.json({ configured: gmailConfigured(), connected: gmailConnected(c.get("user").id), lastSync: null }));
api.get("/integrations/gmail/connect", (c) => c.json({ url: authUrl(issueToken(c.get("user").id, "oauth_state", 15)) }));
api.delete("/integrations/gmail", (c) => {
  disconnectGmail(c.get("user").id);
  return c.json({ ok: true });
});
/** Connect any IMAP inbox with an app password (Outlook, Yahoo, iCloud, Fastmail, Gmail...). */
api.post("/integrations/imap", async (c) => {
  const b = (await c.req.json()) as { email: string; password: string; host?: string; port?: number; secure?: boolean };
  if (!b.email || !b.password) return bad(c, "Email and app password are required");
  const d = imapDefaults(b.email);
  const cfg = { user: b.email, pass: b.password, host: b.host || d?.host || "", port: b.port || d?.port || 993, secure: b.secure ?? d?.secure ?? true };
  if (!cfg.host) return bad(c, "Unknown mail provider: enter the IMAP host");
  const t = await testImap(cfg);
  if (!t.ok) return bad(c, `Couldn't sign in to ${cfg.host}: ${t.error}`);
  saveImap(c.get("user").id, cfg);
  void syncMail(c.get("user").id).catch(() => {});
  return c.json({ ok: true, host: cfg.host });
});
api.delete("/integrations/imap", (c) => {
  deleteImap(c.get("user").id);
  return c.json({ ok: true });
});
api.post("/integrations/mail/sync", async (c) => c.json(await syncMail(c.get("user").id)));
api.post("/integrations/gmail/sync", async (c) => c.json(await syncMail(c.get("user").id)));

/** Sandbox mailbox: mail the local mock employers sent to this user. */
api.get("/dev/mailbox", (c) => {
  const u = c.get("user");
  const addrs = [u.email, u.profile.personal.email].filter(Boolean).map((a) => a.toLowerCase());
  return c.json(all(`SELECT * FROM local_mail WHERE to_addr IN (${addrs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 50`, ...addrs));
});

// ---------- employer (ATS) accounts the agent created or uses ----------

api.get("/ats-accounts", (c) => c.json(listAccounts(c.get("user").id)));
api.post("/ats-accounts/:id/reveal", (c) => {
  const p = revealAccount(c.get("user").id, c.req.param("id"));
  return p ? c.json({ password: p }) : bad(c, "Not found", 404);
});
api.delete("/ats-accounts/:id", (c) => {
  deleteAccount(c.get("user").id, c.req.param("id"));
  return c.json({ ok: true });
});

// The user's own application password, used for every employer that needs an account.
api.get("/application-password", (c) => c.json({ ...applicationPasswordStatus(c.get("user").id), rules: PASSWORD_RULES.map((r) => r.rule) }));
api.put("/application-password", async (c) => {
  const { password } = (await c.req.json().catch(() => ({}))) as { password?: string };
  const failed = passwordRuleFailures(password ?? "");
  if (failed.length) return bad(c, `Password needs: ${failed.join(", ").toLowerCase()}`);
  setApplicationPassword(c.get("user").id, password!);
  return c.json(applicationPasswordStatus(c.get("user").id));
});
api.post("/application-password/reveal", (c) => {
  const p = getApplicationPassword(c.get("user").id);
  return p ? c.json({ password: p }) : bad(c, "No application password saved", 404);
});
api.delete("/application-password", (c) => {
  deleteApplicationPassword(c.get("user").id);
  return c.json(applicationPasswordStatus(c.get("user").id));
});

/** The employer account an application used: "Applied using you@… at acme.wd5.myworkdayjobs.com". */
api.get("/applications/:id/account", (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const u = c.get("user");
  const acct = a.accountHost ? listAccounts(u.id).find((x) => x.host === a.accountHost) : undefined;
  return c.json({
    email: acct?.email ?? (u.profile.personal.email || u.email),
    account: acct ? { id: acct.id, host: acct.host, status: acct.status, passwordKind: acct.passwordKind, createdAt: acct.createdAt } : null,
  });
});
api.post("/applications/:id/account/reveal", (c) => {
  const a = ownApp(c);
  const u = c.get("user");
  const acct = a?.accountHost ? listAccounts(u.id).find((x) => x.host === a.accountHost) : undefined;
  const p = acct ? revealAccount(u.id, acct.id) : null;
  return p ? c.json({ password: p }) : bad(c, "No saved password for this application", 404);
});

/** "I finished it myself": for applications the agent handed back (captcha, assessment, account trouble). */
api.post("/applications/:id/finished", (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  if (a.status === "COMPLETED") return c.json(appView(a));
  cancel(a.id);
  patchApplication(a.id, { status: "COMPLETED", submittedAt: new Date().toISOString(), confirmation: { text: "You finished this application yourself." }, error: null });
  setTrackedStatus(a.id, "APPLIED", "finished by you");
  return c.json(appView(getApplication(a.id)!));
});

// ---------- sources (career pages being watched) ----------

api.get("/sources", (c) => c.json({ companies: listCompanies(), poller: pollerStatus(), atsList: ATS_LIST.map(({ id, name, discovery }) => ({ id, name, discovery })) }));
api.post("/sources", async (c) => {
  const b = (await c.req.json()) as { name?: string; ats?: string; board?: string; url?: string };
  let { ats, board } = b;
  if (b.url) {
    const p = parseJobUrl(b.url);
    ats = p.ats;
    board = p.board;
  }
  if (!ats || !board || !FETCHERS[ats])
    return bad(c, "Paste a careers or job link from Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, iCIMS, Oracle, Rippling, BambooHR, Pinpoint, Breezy, or Recruitee");
  // Check the board is real (and learn the company's name) before watching it.
  const sample = await FETCHERS[ats]({ id: null, name: b.name || board, ats, board }).catch(() => null);
  if (!sample) return bad(c, "Couldn't read that company's job board. Check the link and try again.");
  const co = addCompany(b.name || (ats !== "workday" && sample[0]?.company && sample[0].company !== board ? sample[0].company : board), ats, board);
  void pollAll({ onlyIds: [co.id] });
  return c.json({ ...co, openJobs: sample.length });
});
api.post("/sources/poll", (c) => {
  void pollAll({ force: true });
  return c.json(pollerStatus());
});

// ---------- wallet / plans ----------

api.get("/subscription/plans", (c) => c.json(PLANS));
api.get("/wallet", (c) => {
  const u = c.get("user");
  const renews = one<{ plan_renews_at: string | null }>("SELECT plan_renews_at FROM users WHERE id = ?", u.id)?.plan_renews_at ?? null;
  return c.json({ credits: u.credits, plan: u.plan, renewsAt: renews, stripe: stripeEnabled(), ledger: all("SELECT delta, reason, application_id, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50", u.id) });
});
/** Stripe Checkout when configured; otherwise switches plan and grants credits (local use). */
api.post("/subscription/checkout", async (c) => {
  const { plan } = (await c.req.json()) as { plan: string };
  try {
    return c.json(await checkout(c.get("user"), plan));
  } catch (e) {
    return bad(c, (e as Error).message);
  }
});
api.post("/subscription/portal", async (c) => {
  if (!stripeEnabled()) return bad(c, "Billing isn't configured on this server");
  return c.json({ url: await portal(c.get("user")) });
});

// ---------- messaging (SMS / WhatsApp / iMessage) and notifications ----------

api.get("/messaging", (c) => {
  const u = c.get("user");
  const ph = phoneOf(u.id);
  return c.json({ prefs: prefsOf(u.id), phone: ph?.phone ?? null, verified: Boolean(ph?.phone_verified), providers: { sms: providerFor("sms"), whatsapp: providerFor("whatsapp"), imessage: providerFor("imessage") }, log: recentMessages(u.id) });
});
api.post("/messaging/otp/send", async (c) => {
  const { phone, channel } = (await c.req.json()) as { phone: string; channel: "sms" | "whatsapp" | "imessage" };
  if (throttled(c, `otp:${c.get("user").id}`, 5)) return bad(c, "Too many codes. Try again in a few minutes.", 429 as 400);
  try {
    return c.json(await startPhoneVerification(c.get("user"), phone, channel));
  } catch (e) {
    return bad(c, (e as Error).message);
  }
});
api.post("/messaging/otp/verify", async (c) => {
  const { code } = (await c.req.json()) as { code: string };
  return confirmPhoneVerification(c.get("user"), code) ? c.json({ ok: true }) : bad(c, "That code is wrong or expired");
});
api.patch("/messaging/prefs", async (c) => c.json(setPrefs(c.get("user").id, await c.req.json())));
api.delete("/messaging/phone", (c) => {
  run("UPDATE users SET phone = NULL, phone_verified = 0 WHERE id = ?", c.get("user").id);
  setPrefs(c.get("user").id, { channel: null });
  return c.json({ ok: true });
});
/** Simulate an inbound text (dashboard "try it" box and tests); real providers use /webhooks. */
api.post("/messaging/simulate", async (c) => {
  const { text } = (await c.req.json()) as { text: string };
  return c.json({ reply: handleInbound(c.get("user"), text) });
});

api.get("/push/key", (c) => c.json({ key: vapidPublicKey() }));
api.post("/push/subscribe", async (c) => {
  const sub = (await c.req.json()) as { endpoint: string };
  if (!sub?.endpoint?.startsWith("https://")) return bad(c, "Invalid subscription");
  savePushSubscription(c.get("user").id, sub);
  return c.json({ ok: true });
});
api.post("/push/native", async (c) => {
  const { token, platform } = (await c.req.json()) as { token: string; platform: string };
  if (!token || token.length < 20) return bad(c, "Invalid device token");
  saveNativeToken(c.get("user").id, token, platform ?? "unknown");
  return c.json({ ok: true });
});
api.post("/push/unsubscribe", async (c) => {
  const { endpoint } = (await c.req.json()) as { endpoint: string };
  deletePushSubscription(endpoint);
  return c.json({ ok: true });
});
api.post("/push/test", async (c) => c.json({ sent: await pushUser(c.get("user").id, { title: "Ferry", body: "Notifications are on.", url: "/app" }) }));

export { detectAts };
