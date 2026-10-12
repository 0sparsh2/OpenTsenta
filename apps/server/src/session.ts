import crypto from "node:crypto";
import { promisify } from "node:util";
import { now, one, run, uid } from "./db.ts";
import { getUser, getUserByToken, type User } from "./store.ts";

// Account security: scrypt password hashes, hashed session tokens (many per user, revocable), and
// single-use tokens for email verification, magic links, and password reset.
// The long-lived per-user API token (users.token) stays separate: it's what MCP and the CLI use.

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, key] = stored.split("$");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), 64);
  const want = Buffer.from(key, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "Use letters and numbers";
  return null;
}

// ---------- sessions ----------

export function createSession(userId: string, userAgent?: string): string {
  const token = `sess_${crypto.randomBytes(32).toString("base64url")}`;
  run("INSERT INTO sessions(id, user_id, token_hash, user_agent, last_used_at) VALUES(?,?,?,?,?)", uid("ses"), userId, sha256(token), userAgent?.slice(0, 200) ?? null, now());
  return token;
}

/** Resolve a bearer token: a browser session (sess_…) or the user's API token (fy_…). */
export function userForToken(token: string): User | undefined {
  if (token.startsWith("sess_")) {
    const s = one<{ user_id: string; id: string; last_used_at: string | null }>("SELECT id, user_id, last_used_at FROM sessions WHERE token_hash = ?", sha256(token));
    if (!s) return undefined;
    // Touch at most once a minute.
    if (!s.last_used_at || Date.now() - new Date(s.last_used_at).getTime() > 60_000) run("UPDATE sessions SET last_used_at = ? WHERE id = ?", now(), s.id);
    return getUser(s.user_id);
  }
  return getUserByToken(token);
}

export function revokeSession(token: string) {
  run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
}
export function listSessions(userId: string) {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId)?.n ?? 0;
}
export function revokeAllSessions(userId: string) {
  run("DELETE FROM sessions WHERE user_id = ?", userId);
}

// ---------- one-time tokens ----------

export type TokenPurpose = "verify_email" | "magic_link" | "reset_password" | "oauth_state";

export function issueToken(userId: string, purpose: TokenPurpose, ttlMinutes: number): string {
  const token = crypto.randomBytes(24).toString("base64url");
  run("INSERT INTO one_time_tokens(token_hash, user_id, purpose, expires_at) VALUES(?,?,?,?)", sha256(token), userId, purpose, new Date(Date.now() + ttlMinutes * 60_000).toISOString());
  return token;
}

export function consumeToken(token: string, purpose: TokenPurpose): string | null {
  const r = one<{ user_id: string; expires_at: string; used: number }>("SELECT user_id, expires_at, used FROM one_time_tokens WHERE token_hash = ? AND purpose = ?", sha256(token), purpose);
  if (!r || r.used || new Date(r.expires_at).getTime() < Date.now()) return null;
  run("UPDATE one_time_tokens SET used = 1 WHERE token_hash = ?", sha256(token));
  return r.user_id;
}

// ---------- simple fixed-window rate limiter ----------

const hits = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) {
    hits.set(key, { n: 1, reset: t + windowMs });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    return false;
  }
  h.n++;
  return h.n > max;
}
