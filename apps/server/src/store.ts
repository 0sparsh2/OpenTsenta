import crypto from "node:crypto";
import { all, kvGet, kvSet, one, parse, run, uid, now, tx } from "./db.ts";
import { placesOf, PLACES_VERSION } from "./ingest/places.ts";
import { config } from "./config.ts";
import { defaultLibrary, withDefaults } from "./apply/library-defaults.ts";
import {
  DEFAULT_APPLY_SETTINGS,
  type ApplySettings,
  type AtsScore,
  type FilledField,
  type Job,
  type PipelineStatus,
  type Profile,
  type ResumeChange,
  type ResumeDoc,
  type TraceStep,
  type TrackedStatus,
} from "./types.ts";

// ---------- users ----------

export interface User {
  id: string;
  email: string;
  name: string | null;
  token: string;
  plan: string;
  credits: number;
  onboarded: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
  settings: ApplySettings;
  profile: Profile;
  createdAt: string;
}

export function emptyProfile(email = "", name = ""): Profile {
  const [firstName = "", ...rest] = name.trim().split(/\s+/);
  return {
    personal: { firstName, lastName: rest.join(" "), email },
    workAuth: { authorizedCountries: ["US"], needsSponsorship: false },
    eeo: {},
    preferences: { titles: [], locations: [], workplace: "any", seniority: [], excludeCompanies: [], keywords: [] },
    logistics: {},
    answers: {},
    library: defaultLibrary(),
  };
}

function toUser(r: Record<string, unknown>): User {
  const profile = parse<Profile>(r.profile, emptyProfile(String(r.email), String(r.name ?? "")));
  const base = emptyProfile(String(r.email), String(r.name ?? ""));
  return {
    id: String(r.id),
    email: String(r.email),
    name: (r.name as string) ?? null,
    token: String(r.token),
    plan: String(r.plan),
    credits: Number(r.credits),
    onboarded: Boolean(r.onboarded),
    emailVerified: Boolean(r.email_verified),
    hasPassword: Boolean(r.password_hash),
    settings: { ...DEFAULT_APPLY_SETTINGS, ...parse<Partial<ApplySettings>>(r.settings, {}) },
    profile: {
      ...base,
      ...profile,
      personal: { ...base.personal, ...profile.personal },
      workAuth: { ...base.workAuth, ...profile.workAuth },
      preferences: { ...base.preferences, ...profile.preferences },
      logistics: { ...base.logistics, ...profile.logistics },
      eeo: { ...base.eeo, ...profile.eeo },
      answers: profile.answers ?? {},
      library: withDefaults(profile.library),
    },
    createdAt: String(r.created_at),
  };
}

export const newToken = () => `fy_${crypto.randomBytes(24).toString("base64url")}`;

export function getUser(id: string) {
  const r = one("SELECT * FROM users WHERE id = ?", id);
  return r ? toUser(r) : undefined;
}
export function getUserByToken(token: string) {
  const r = one("SELECT * FROM users WHERE token = ?", token);
  return r ? toUser(r) : undefined;
}
/** A person's name ("Sparsh Nagpal", "José O'Neil-Ruiz"), not something typed into the wrong box. */
export const looksLikeName = (s: string | null | undefined) => Boolean(s && /^[\p{L}][\p{L}\p{M}'’.\- ]{0,79}$/u.test(s.trim()));
export function setUserName(userId: string, name: string) {
  run("UPDATE users SET name = ? WHERE id = ?", name, userId);
}
/** The name to greet someone by: their profile's name, else the account name if it's a real name. */
export function displayName(u: User) {
  const full = [u.profile.personal.firstName, u.profile.personal.lastName].filter(Boolean).join(" ").trim();
  return full || (looksLikeName(u.name) ? u.name : "");
}

export function getUserByEmail(email: string) {
  const r = one("SELECT * FROM users WHERE email = ?", email.toLowerCase());
  return r ? toUser(r) : undefined;
}
export function listUsers() {
  return all("SELECT * FROM users").map(toUser);
}

export function createUser(email: string, name = ""): User {
  const id = uid("usr");
  const e = email.toLowerCase().trim();
  run(
    "INSERT INTO users(id, email, name, token, credits, profile, settings) VALUES(?,?,?,?,?,?,?)",
    id,
    e,
    name || null,
    newToken(),
    config.freeCredits,
    JSON.stringify(emptyProfile(e, name)),
    JSON.stringify(DEFAULT_APPLY_SETTINGS),
  );
  run("INSERT INTO ledger(user_id, delta, reason) VALUES(?,?,?)", id, config.freeCredits, "free_tier");
  return getUser(id)!;
}

export function updateProfile(userId: string, profile: Profile) {
  run("UPDATE users SET profile = ? WHERE id = ?", JSON.stringify(profile), userId);
}
export function updateSettings(userId: string, patch: Partial<ApplySettings>) {
  const u = getUser(userId)!;
  const next = { ...u.settings, ...patch };
  run("UPDATE users SET settings = ? WHERE id = ?", JSON.stringify(next), userId);
  return next;
}
export function setOnboarded(userId: string, v = true) {
  run("UPDATE users SET onboarded = ? WHERE id = ?", v ? 1 : 0, userId);
}

/** Remember an answer to an application question (the agent's long-term memory). */
export function rememberAnswer(userId: string, question: string, answer: string) {
  const u = getUser(userId);
  if (!u || !answer.trim()) return;
  u.profile.answers[normalizeQuestion(question)] = answer.trim();
  updateProfile(userId, u.profile);
}
export const normalizeQuestion = (q: string) =>
  q
    .toLowerCase()
    .replace(/\*|\(required\)|\(optional\)/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------- credits ----------

export function chargeCredit(userId: string, applicationId: string): boolean {
  return tx(() => {
    const r = one<{ credits: number }>("SELECT credits FROM users WHERE id = ?", userId);
    if (!r || r.credits <= 0) return false;
    run("UPDATE users SET credits = credits - 1 WHERE id = ?", userId);
    run("INSERT INTO ledger(user_id, delta, reason, application_id) VALUES(?,?,?,?)", userId, -1, "application_submitted", applicationId);
    return true;
  });
}
export function grantCredits(userId: string, amount: number, reason: string) {
  run("UPDATE users SET credits = credits + ? WHERE id = ?", amount, userId);
  run("INSERT INTO ledger(user_id, delta, reason) VALUES(?,?,?)", userId, amount, reason);
}

// ---------- resumes ----------

/**
 * A résumé profile: one imported résumé (blocks + layout) aimed at a role family, e.g. "Backend Engineer".
 * Contact details, eligibility and the answer library are shared on the user; these hold what differs per role.
 */
export interface Resume {
  id: string;
  userId: string;
  name: string;
  filePath: string | null;
  fileName: string | null;
  text: string;
  doc: ResumeDoc;
  isDefault: boolean;
  /** Titles and keywords this profile is for; drives which profile a job uses. */
  targets: ProfileTargets;
  /** Free-text guidance for tailoring and written answers ("lead with infra work, mention on-call"). */
  notes: string;
  origin: "import" | "duplicate" | "blank";
  createdAt: string;
}
export interface ProfileTargets {
  titles: string[];
  keywords: string[];
}
const toResume = (r: Record<string, unknown>): Resume => {
  const t = parse<Partial<ProfileTargets>>(r.targets, {});
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    filePath: (r.file_path as string) ?? null,
    fileName: (r.file_name as string) ?? null,
    text: String(r.text ?? ""),
    doc: parse<ResumeDoc>(r.doc, { experience: [], education: [], skills: [] }),
    isDefault: Boolean(r.is_default),
    targets: { titles: t.titles ?? [], keywords: t.keywords ?? [] },
    notes: String(r.notes ?? ""),
    origin: (r.origin as Resume["origin"]) ?? "import",
    createdAt: String(r.created_at),
  };
};
export function listResumes(userId: string) {
  return all("SELECT * FROM resumes WHERE user_id = ? ORDER BY is_default DESC, created_at ASC", userId).map(toResume);
}
export function getResume(id: string) {
  const r = one("SELECT * FROM resumes WHERE id = ?", id);
  return r ? toResume(r) : undefined;
}
export function getDefaultResume(userId: string) {
  return listResumes(userId)[0];
}
type ResumeInput = Omit<Resume, "id" | "createdAt" | "targets" | "notes" | "origin"> & { id?: string; targets?: ProfileTargets; notes?: string; origin?: Resume["origin"] };
export function saveResume(r: ResumeInput) {
  const id = r.id ?? uid("res");
  const existing = r.id ? getResume(r.id) : undefined;
  const targets = JSON.stringify(r.targets ?? existing?.targets ?? { titles: [], keywords: [] });
  const notes = r.notes ?? existing?.notes ?? "";
  if (existing) {
    run(
      "UPDATE resumes SET name=?, file_path=?, file_name=?, text=?, doc=?, targets=?, notes=? WHERE id=?",
      r.name,
      r.filePath,
      r.fileName,
      r.text,
      JSON.stringify(r.doc),
      targets,
      notes,
      id,
    );
  } else {
    const first = !one("SELECT 1 FROM resumes WHERE user_id = ?", r.userId);
    run(
      "INSERT INTO resumes(id, user_id, name, file_path, file_name, text, doc, is_default, targets, notes, origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      r.userId,
      r.name,
      r.filePath,
      r.fileName,
      r.text,
      JSON.stringify(r.doc),
      first || r.isDefault ? 1 : 0,
      targets,
      notes,
      r.origin ?? "import",
    );
  }
  return getResume(id)!;
}
export function deleteResume(userId: string, id: string) {
  const r = getResume(id);
  if (!r || r.userId !== userId || r.isDefault) return false;
  tx(() => {
    run("DELETE FROM resumes WHERE id = ?", id);
    run("UPDATE matches SET profile_id = NULL WHERE user_id = ? AND profile_id = ?", userId, id);
  });
  return true;
}
export function setDefaultResume(userId: string, id: string) {
  tx(() => {
    run("UPDATE resumes SET is_default = 0 WHERE user_id = ?", userId);
    run("UPDATE resumes SET is_default = 1 WHERE user_id = ? AND id = ?", userId, id);
  });
}

// ---------- jobs ----------

export const toJob = (r: Record<string, unknown>): Job => ({
  id: String(r.id),
  companyId: (r.company_id as string) ?? null,
  company: String(r.company),
  ats: String(r.ats),
  externalId: String(r.external_id),
  title: String(r.title),
  location: String(r.location ?? ""),
  workplace: (r.workplace as Job["workplace"]) ?? "unknown",
  department: (r.department as string) ?? undefined,
  employmentType: (r.employment_type as string) ?? undefined,
  url: String(r.url),
  applyUrl: String(r.apply_url),
  description: String(r.description ?? ""),
  salary: (r.salary as string) ?? undefined,
  postedAt: (r.posted_at as string) ?? undefined,
  firstSeenAt: String(r.first_seen_at),
  sponsorsVisa: r.sponsors_visa == null ? null : Boolean(r.sponsors_visa),
});

export function getJob(id: string) {
  const r = one("SELECT * FROM jobs WHERE id = ?", id);
  return r ? toJob(r) : undefined;
}

export type JobInput = Omit<Job, "id" | "firstSeenAt">;

/** Insert or refresh a job. Returns the job and whether it was new. */
/** Where a job is, as filterable places (see ingest/places.ts). */
export function indexJobPlaces(jobId: string, location: string, workplace: string) {
  run("DELETE FROM job_places WHERE job_id = ?", jobId);
  for (const p of placesOf(location, workplace)) run("INSERT OR IGNORE INTO job_places(job_id, kind, key, label) VALUES(?,?,?,?)", jobId, p.kind, p.key, p.label);
}

/**
 * Re-derive every open job's places when the location parser changes (and the first time). Runs in small batches
 * that yield between them, so the server keeps answering while hundreds of thousands of jobs are indexed.
 */
export async function backfillJobPlaces() {
  if (kvGet<number>("places_version", 0) === PLACES_VERSION) return;
  const t0 = Date.now();
  run("DELETE FROM job_places");
  let last = 0;
  let count = 0;
  for (;;) {
    const rows = all<{ rid: number; id: string; location: string; workplace: string }>(
      "SELECT rowid AS rid, id, location, workplace FROM jobs WHERE closed_at IS NULL AND rowid > ? ORDER BY rowid LIMIT 2000",
      last,
    );
    if (!rows.length) break;
    tx(() => {
      for (const r of rows) for (const p of placesOf(r.location, r.workplace)) run("INSERT OR IGNORE INTO job_places(job_id, kind, key, label) VALUES(?,?,?,?)", r.id, p.kind, p.key, p.label);
    });
    last = rows[rows.length - 1].rid;
    count += rows.length;
    await new Promise((r) => setTimeout(r, 5));
  }
  kvSet("places_version", PLACES_VERSION);
  console.log(`[places] indexed ${count} open jobs in ${Math.round((Date.now() - t0) / 1000)}s`);
}

const contentHash = (j: JobInput) =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify([j.title, j.company, j.location, j.workplace, j.department ?? null, j.employmentType ?? null, j.url, j.applyUrl, j.description, j.salary ?? null, j.postedAt ?? null, j.sponsorsVisa ?? null]))
    .digest("base64url");

/** The poller's upsert: a job its board describes exactly as last time isn't rewritten (most jobs, most polls). */
export function ingestJob(j: JobInput): { id: string; isNew: boolean } {
  const hash = contentHash(j);
  const ex = one<{ id: string; content_hash: string | null; closed_at: string | null }>("SELECT id, content_hash, closed_at FROM jobs WHERE ats = ? AND external_id = ?", j.ats, j.externalId);
  if (ex && ex.content_hash === hash && !ex.closed_at) return { id: ex.id, isNew: false };
  const { job, isNew } = upsertJob(j);
  run("UPDATE jobs SET content_hash = ? WHERE id = ?", hash, job.id);
  return { id: job.id, isNew };
}

export function upsertJob(j: JobInput): { job: Job; isNew: boolean } {
  const existing = one<{ id: string; location: string; workplace: string; closed_at: string | null }>("SELECT id, location, workplace, closed_at FROM jobs WHERE ats = ? AND external_id = ?", j.ats, j.externalId);
  if (existing) {
    // Places are kept for open jobs only: a reopened job, or a moved one, is indexed again.
    if (existing.closed_at || existing.location !== j.location || existing.workplace !== j.workplace) indexJobPlaces(existing.id, j.location, j.workplace);
    run(
      `UPDATE jobs SET title=?, location=?, workplace=?, department=?, employment_type=?, url=?, apply_url=?,
       description=CASE WHEN length(?) > 0 THEN ? ELSE description END, salary=?, posted_at=COALESCE(?, posted_at), closed_at=NULL,
       sponsors_visa=COALESCE(?, sponsors_visa), company=? WHERE id=?`,
      j.title,
      j.location,
      j.workplace,
      j.department ?? null,
      j.employmentType ?? null,
      j.url,
      j.applyUrl,
      j.description,
      j.description,
      j.salary ?? null,
      j.postedAt ?? null,
      j.sponsorsVisa == null ? null : j.sponsorsVisa ? 1 : 0,
      j.company,
      existing.id,
    );
    return { job: getJob(existing.id)!, isNew: false };
  }
  const id = uid("job");
  run(
    `INSERT INTO jobs(id, company_id, company, ats, external_id, title, location, workplace, department, employment_type,
     url, apply_url, description, salary, posted_at, sponsors_visa, first_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    j.companyId,
    j.company,
    j.ats,
    j.externalId,
    j.title,
    j.location,
    j.workplace,
    j.department ?? null,
    j.employmentType ?? null,
    j.url,
    j.applyUrl,
    j.description,
    j.salary ?? null,
    j.postedAt ?? null,
    j.sponsorsVisa == null ? null : j.sponsorsVisa ? 1 : 0,
    now(),
  );
  indexJobPlaces(id, j.location, j.workplace);
  return { job: getJob(id)!, isNew: true };
}

// ---------- applications ----------

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  resumeId: string | null;
  status: PipelineStatus;
  source: string;
  tailored: ResumeDoc | null;
  changes: ResumeChange[];
  atsScore: AtsScore | null;
  resumePdf: string | null;
  /** The tailored text in the user's own .docx design (profiles imported from Word with "Keep my design"). */
  resumeDocx: string | null;
  coverLetter: string | null;
  fields: FilledField[];
  trace: TraceStep[];
  lastThought: string | null;
  currentPage: number | null;
  totalPages: number | null;
  confirmation: { url?: string; text?: string; screenshot?: string; dryRun?: boolean } | null;
  error: string | null;
  attempts: number;
  submittedAt: string | null;
  trackedStatus: TrackedStatus | null;
  statusHistory: { status: string; at: string; note?: string }[];
  /** The employer account (vault host) this application signed in or signed up with. */
  accountHost: string | null;
  /** Pause to preview the tailored résumé before applying (null = follow Settings). */
  reviewResume: boolean | null;
  /** Résumé redos used ("Redo with instructions"). */
  redos: number;
  /** The latest redo instructions, applied on top of the profile's notes. */
  tailorInstructions: string | null;
  createdAt: string;
  updatedAt: string;
}

export const toApplication = (r: Record<string, unknown>): Application => ({
  id: String(r.id),
  userId: String(r.user_id),
  jobId: String(r.job_id),
  resumeId: (r.resume_id as string) ?? null,
  status: r.status as PipelineStatus,
  source: String(r.source),
  tailored: parse<ResumeDoc | null>(r.tailored, null),
  changes: parse<ResumeChange[]>(r.changes, []),
  atsScore: parse<AtsScore | null>(r.ats_score, null),
  resumePdf: (r.resume_pdf as string) ?? null,
  resumeDocx: (r.resume_docx as string) ?? null,
  coverLetter: (r.cover_letter as string) ?? null,
  fields: parse<FilledField[]>(r.fields, []),
  trace: parse<TraceStep[]>(r.trace, []),
  lastThought: (r.last_thought as string) ?? null,
  currentPage: (r.current_page as number) ?? null,
  totalPages: (r.total_pages as number) ?? null,
  confirmation: parse(r.confirmation, null),
  error: (r.error as string) ?? null,
  attempts: Number(r.attempts ?? 0),
  submittedAt: (r.submitted_at as string) ?? null,
  trackedStatus: (r.tracked_status as TrackedStatus) ?? null,
  statusHistory: parse(r.status_history, []),
  accountHost: (r.account_host as string) ?? null,
  reviewResume: r.review_resume == null ? null : Boolean(r.review_resume),
  redos: Number(r.redos ?? 0),
  tailorInstructions: (r.tailor_instructions as string) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export function getApplication(id: string) {
  const r = one("SELECT * FROM applications WHERE id = ?", id);
  return r ? toApplication(r) : undefined;
}

export function createApplication(userId: string, jobId: string, source: string, resumeId?: string | null) {
  const existing = one<{ id: string }>("SELECT id FROM applications WHERE user_id = ? AND job_id = ?", userId, jobId);
  if (existing) return { app: getApplication(existing.id)!, created: false };
  const id = uid("app");
  run(
    "INSERT INTO applications(id, user_id, job_id, resume_id, status, source, status_history) VALUES(?,?,?,?,?,?,?)",
    id,
    userId,
    jobId,
    resumeId ?? null,
    "QUEUED",
    source,
    JSON.stringify([{ status: "QUEUED", at: now() }]),
  );
  run("UPDATE matches SET status = 'queued' WHERE user_id = ? AND job_id = ?", userId, jobId);
  return { app: getApplication(id)!, created: true };
}

const COLS: Record<string, string> = {
  status: "status",
  resumeId: "resume_id",
  tailored: "tailored",
  changes: "changes",
  atsScore: "ats_score",
  resumePdf: "resume_pdf",
  resumeDocx: "resume_docx",
  coverLetter: "cover_letter",
  fields: "fields",
  trace: "trace",
  lastThought: "last_thought",
  currentPage: "current_page",
  totalPages: "total_pages",
  confirmation: "confirmation",
  error: "error",
  attempts: "attempts",
  submittedAt: "submitted_at",
  trackedStatus: "tracked_status",
  statusHistory: "status_history",
  redos: "redos",
  accountHost: "account_host",
  reviewResume: "review_resume",
  tailorInstructions: "tailor_instructions",
};
const JSON_COLS = new Set(["tailored", "changes", "atsScore", "fields", "trace", "confirmation", "statusHistory"]);

export function patchApplication(id: string, patch: Partial<Application>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null));
  }
  if (!sets.length) return getApplication(id)!;
  sets.push("updated_at = ?");
  vals.push(now());
  run(`UPDATE applications SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
  return getApplication(id)!;
}

export function setTrackedStatus(id: string, status: TrackedStatus, note?: string) {
  const app = getApplication(id);
  if (!app || app.trackedStatus === status) return app;
  const history = [...app.statusHistory, { status, at: now(), note }];
  return patchApplication(id, { trackedStatus: status, statusHistory: history });
}

export function setPasswordHash(userId: string, hash: string) {
  run("UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
}
export function passwordHashOf(userId: string): string | null {
  return one<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", userId)?.password_hash ?? null;
}
export function setEmailVerified(userId: string) {
  run("UPDATE users SET email_verified = 1 WHERE id = ?", userId);
}
export function rotateApiToken(userId: string): string {
  const t = newToken();
  run("UPDATE users SET token = ? WHERE id = ?", t, userId);
  return t;
}
