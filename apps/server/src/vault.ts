import { all, now, one, run, uid } from "./db.ts";
import { generatePassword, open, seal } from "./secrets.ts";

// Per-employer ATS accounts (Workday tenants, iCIMS portals, ...). Workday in particular needs a
// separate candidate account per company; the agent creates one with the user's email and a
// generated password, and reuses it for every later application at that employer.

export interface AtsAccount {
  id: string;
  host: string;
  ats: string | null;
  email: string;
  status: string;
  /** "application" = the user's own application password; "generated" = a random one Ferry made. */
  passwordKind: "application" | "generated";
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------- the user's application password ----------
// One password the user chooses for every job site that makes them create an account, so they can sign
// in themselves later. Sites with stricter rules (or no password set) get a generated one instead.

export const PASSWORD_RULES: { rule: string; test: (p: string) => boolean }[] = [
  { rule: "At least 12 characters", test: (p) => p.length >= 12 },
  { rule: "A lowercase letter", test: (p) => /[a-z]/.test(p) },
  { rule: "An uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { rule: "A number", test: (p) => /\d/.test(p) },
  { rule: "A special character", test: (p) => /[^A-Za-z0-9\s]/.test(p) },
];
export const passwordRuleFailures = (p: string) => PASSWORD_RULES.filter((r) => !r.test(p)).map((r) => r.rule);

const pwKey = (userId: string) => `apppw:${userId}`;

export function applicationPasswordStatus(userId: string) {
  const r = one<{ v: string }>("SELECT v FROM kv WHERE k = ?", pwKey(userId));
  const v = r ? (JSON.parse(r.v) as { updatedAt: string }) : null;
  return { hasPassword: Boolean(v), updatedAt: v?.updatedAt ?? null };
}
export function setApplicationPassword(userId: string, password: string) {
  const v = JSON.stringify({ sealed: seal(password), updatedAt: now() });
  run("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", pwKey(userId), v);
}
export function getApplicationPassword(userId: string): string | null {
  const r = one<{ v: string }>("SELECT v FROM kv WHERE k = ?", pwKey(userId));
  return r ? open((JSON.parse(r.v) as { sealed: string }).sealed) : null;
}
export function deleteApplicationPassword(userId: string) {
  run("DELETE FROM kv WHERE k = ?", pwKey(userId));
}

/** Accounts are scoped to the tenant host, e.g. acme.wd5.myworkdayjobs.com. */
export function accountHost(url: string): string {
  try {
    const u = new URL(url);
    // Local sandbox tenants live under one host; scope by path tenant instead.
    if (u.pathname.startsWith("/mock-ats/")) return `${u.host}/${u.pathname.split("/").slice(2, 4).join("/")}`;
    return u.host.toLowerCase();
  } catch {
    return url;
  }
}

const toAccount = (r: Record<string, unknown>): AtsAccount => ({
  id: String(r.id),
  host: String(r.host),
  ats: (r.ats as string) ?? null,
  email: String(r.email),
  status: String(r.status),
  passwordKind: r.password_kind === "application" ? "application" : "generated",
  createdAt: String(r.created_at),
  lastUsedAt: (r.last_used_at as string) ?? null,
});

export function getAccount(userId: string, host: string): (AtsAccount & { password: string }) | null {
  const r = one("SELECT * FROM ats_accounts WHERE user_id = ? AND host = ?", userId, host);
  if (!r) return null;
  return { ...toAccount(r), password: open(String(r.password_sealed)) };
}

/** New employer account: the user's application password when set, else a generated one. */
export function createAccountRecord(userId: string, host: string, email: string, ats: string | null, opts: { forceGenerated?: boolean } = {}): AtsAccount & { password: string } {
  const own = opts.forceGenerated ? null : getApplicationPassword(userId);
  const password = own ?? generatePassword();
  run(
    `INSERT INTO ats_accounts(id, user_id, host, ats, email, password_sealed, status, password_kind) VALUES(?,?,?,?,?,?, 'pending', ?)
     ON CONFLICT(user_id, host) DO UPDATE SET email = excluded.email, password_sealed = excluded.password_sealed, status = 'pending', password_kind = excluded.password_kind`,
    uid("acct"),
    userId,
    host,
    ats,
    email,
    seal(password),
    own ? "application" : "generated",
  );
  return getAccount(userId, host)!;
}

export function markAccount(userId: string, host: string, status: "active" | "pending" | "failed") {
  run("UPDATE ats_accounts SET status = ?, last_used_at = ? WHERE user_id = ? AND host = ?", status, now(), userId, host);
}

export const listAccounts = (userId: string) => all("SELECT * FROM ats_accounts WHERE user_id = ? ORDER BY created_at DESC", userId).map(toAccount);

export function revealAccount(userId: string, id: string): string | null {
  const r = one<{ password_sealed: string }>("SELECT password_sealed FROM ats_accounts WHERE user_id = ? AND id = ?", userId, id);
  return r ? open(r.password_sealed) : null;
}
export function deleteAccount(userId: string, id: string) {
  run("DELETE FROM ats_accounts WHERE user_id = ? AND id = ?", userId, id);
}
