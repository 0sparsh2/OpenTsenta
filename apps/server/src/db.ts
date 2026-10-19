import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { paths } from "./config.ts";

export const db = new DatabaseSync(paths.db);
// Incremental vacuum: space freed by the job sweep goes back to the disk a little at a time (takes effect on a new
// database; an existing one needs a one-time VACUUM to switch).
db.exec("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
/** Return up to `pages` free pages (4 KB each) to the disk. A no-op unless auto_vacuum is incremental. */
export const reclaimSpace = (pages = 4000) => db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  token TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  credits INTEGER NOT NULL DEFAULT 25,
  onboarded INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_path TEXT,
  file_name TEXT,
  text TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ats TEXT NOT NULL,
  board TEXT NOT NULL,
  careers_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_polled_at TEXT,
  last_error TEXT,
  job_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ats, board)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  company TEXT NOT NULL,
  ats TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  workplace TEXT NOT NULL DEFAULT 'unknown',
  department TEXT,
  employment_type TEXT,
  url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  salary TEXT,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  sponsors_visa INTEGER,
  UNIQUE(ats, external_id)
);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company_id);

CREATE TABLE IF NOT EXISTS matches (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  gaps TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS matches_user_score ON matches(user_id, status, score DESC);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  source TEXT NOT NULL DEFAULT 'dashboard',
  tailored TEXT,
  changes TEXT NOT NULL DEFAULT '[]',
  ats_score TEXT,
  resume_pdf TEXT,
  cover_letter TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  trace TEXT NOT NULL DEFAULT '[]',
  last_thought TEXT,
  current_page INTEGER,
  total_pages INTEGER,
  confirmation TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  tracked_status TEXT,
  status_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, job_id)
);
CREATE INDEX IF NOT EXISTS applications_user ON applications(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT,
  thread_id TEXT,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  category TEXT,
  company TEXT,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  draft_reply TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, external_id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  application_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS ats_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  ats TEXT,
  email TEXT NOT NULL,
  password_sealed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(user_id, host)
);

-- Sandbox mailbox: mail "sent" by the local mock employers lands here, so verification codes and
-- confirmation emails can be exercised end to end without a real inbox.
CREATE TABLE IF NOT EXISTS local_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  html TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS local_mail_to ON local_mail(to_addr, id);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

export const uid = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
export const now = () => new Date().toISOString();

export function parse<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, unknown>;

export function one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function kvGet<T>(k: string, d: T): T {
  const r = one<{ v: string }>("SELECT v FROM kv WHERE k = ?", k);
  return r ? parse(r.v, d) : d;
}
export function kvSet(k: string, v: unknown) {
  run("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
}

// ---------- additive migrations ----------

function addColumn(table: string, column: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn("users", "password_hash", "TEXT");
addColumn("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "stripe_customer_id", "TEXT");
addColumn("users", "plan_renews_at", "TEXT");
addColumn("users", "phone", "TEXT");
addColumn("users", "phone_verified", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "notify", "TEXT NOT NULL DEFAULT '{}'");
// Résumé profiles: role-specific targets and notes for the agent; which profile a match/application used.
addColumn("resumes", "targets", "TEXT NOT NULL DEFAULT '{}'");
addColumn("resumes", "notes", "TEXT NOT NULL DEFAULT ''");
addColumn("resumes", "origin", "TEXT NOT NULL DEFAULT 'import'");
addColumn("matches", "profile_id", "TEXT");
addColumn("applications", "redos", "INTEGER NOT NULL DEFAULT 0");
addColumn("applications", "tailor_instructions", "TEXT");
addColumn("applications", "resume_docx", "TEXT");
addColumn("applications", "account_host", "TEXT");
addColumn("applications", "hand_off", "TEXT");
addColumn("applications", "review_resume", "INTEGER");
addColumn("ats_accounts", "password_kind", "TEXT NOT NULL DEFAULT 'generated'");
// Per-board polling schedule: big paged boards less often, failing boards back off.
addColumn("companies", "next_poll_at", "TEXT");
// OAuth for MCP clients (oauth.ts): registered apps, one-time codes, and access/refresh tokens (stored hashed).
db.exec(`CREATE TABLE IF NOT EXISTS mcp_oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (id TEXT PRIMARY KEY, access_hash TEXT UNIQUE NOT NULL, refresh_hash TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
// Batches: a list of jobs an agent (MCP, CLI) handed over in one go.
addColumn("applications", "batch_id", "TEXT");
db.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, items TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS applications_batch ON applications(batch_id) WHERE batch_id IS NOT NULL;`);
addColumn("companies", "fail_count", "INTEGER NOT NULL DEFAULT 0");
// A hash of what the board says about a job: unchanged jobs aren't rewritten on every poll.
addColumn("jobs", "content_hash", "TEXT");
// Jobs dropped for age that their boards still list (they have no posting date): not re-added while they stay listed.
db.exec(`CREATE TABLE IF NOT EXISTS job_tombstones (ats TEXT NOT NULL, external_id TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (ats, external_id));`);

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS one_time_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages_out (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  body TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- job search indexes ----------

// Places each job's location names (city, metro, state, country, remote), for the location filter.
db.exec(`
CREATE TABLE IF NOT EXISTS job_places (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (job_id, key)
);
CREATE INDEX IF NOT EXISTS job_places_key ON job_places(key, job_id);
CREATE INDEX IF NOT EXISTS job_places_facet ON job_places(key, kind, label);
`);

// Open jobs, with just what list views filter and sort on. Job rows carry whole descriptions, so scanning them
// to find the open ones reads most of the database; this index doesn't.
db.exec(`CREATE INDEX IF NOT EXISTS jobs_open ON jobs(first_seen_at, posted_at, workplace, sponsors_visa, company, id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_closed ON jobs(closed_at) WHERE closed_at IS NOT NULL;
-- Deleting a job cascades to its matches and applications: without these, every delete scans both tables.
CREATE INDEX IF NOT EXISTS matches_job ON matches(job_id);
CREATE INDEX IF NOT EXISTS applications_job ON applications(job_id);`);

// Full-text index over title, company, location and description (keyword search with AND / OR / NOT / phrases).
// External-content table kept in sync by triggers; unchanged text isn't re-indexed on every poll.
// Bump FTS_VERSION when the index's settings change: the index is dropped and rebuilt from the jobs table.
const FTS_VERSION = 2;
const ftsVersion = Number(one<{ v: string }>("SELECT v FROM kv WHERE k = 'fts_version'")?.v ?? 0);
if (ftsVersion !== FTS_VERSION) db.exec("DROP TABLE IF EXISTS jobs_fts");
const hadFts = Boolean(one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs_fts'"));
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(title, company, location, description, content='jobs', content_rowid='rowid', tokenize="porter unicode61 remove_diacritics 2 tokenchars '+#'");
CREATE TRIGGER IF NOT EXISTS jobs_fts_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.rowid, new.title, new.company, new.location, new.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_au AFTER UPDATE OF title, company, location, description ON jobs
WHEN old.title IS NOT new.title OR old.company IS NOT new.company OR old.location IS NOT new.location OR old.description IS NOT new.description BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description) VALUES ('delete', old.rowid, old.title, old.company, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company, location, description) VALUES (new.rowid, new.title, new.company, new.location, new.description);
END;
`);
if (!hadFts) {
  db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')");
  kvSet("fts_version", FTS_VERSION);
}
