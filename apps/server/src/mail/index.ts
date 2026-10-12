import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { all, now, one, parse, run } from "../db.ts";
import { open, seal } from "../secrets.ts";
import { getUser } from "../store.ts";
import { htmlToText } from "../util/text.ts";
import { gmailConnected, gmailFetch } from "./gmail.ts";

// One mail interface over three backends:
//  - Gmail API (OAuth, gmail.readonly)
//  - IMAP with an app password (Outlook/Hotmail, Yahoo, iCloud, Fastmail, Gmail, ...)
//  - the local sandbox mailbox (mail sent by /mock-ats employers)
// Used for (1) verification codes/links during ATS sign-up and (2) reply tracking.

export interface MailMessage {
  id: string;
  threadId?: string;
  from: string;
  fromName?: string;
  to?: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
}

// ---------- local sandbox mailbox ----------

export function deliverLocal(m: { to: string; from: string; fromName?: string; subject: string; text: string; html?: string }) {
  run("INSERT INTO local_mail(to_addr, from_addr, from_name, subject, text, html) VALUES(?,?,?,?,?,?)", m.to.toLowerCase(), m.from, m.fromName ?? null, m.subject, m.text, m.html ?? null);
}

function localFetch(address: string, sinceIso: string): MailMessage[] {
  return all<{ id: number; from_addr: string; from_name: string | null; subject: string; text: string; html: string | null; received_at: string; to_addr: string }>(
    "SELECT * FROM local_mail WHERE to_addr = ? AND received_at >= ? ORDER BY id",
    address.toLowerCase(),
    sinceIso,
  ).map((r) => ({ id: `local:${r.id}`, from: r.from_addr, fromName: r.from_name ?? undefined, to: r.to_addr, subject: r.subject, text: r.text, html: r.html ?? undefined, receivedAt: r.received_at }));
}

// ---------- IMAP ----------

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Well-known IMAP servers so most users only enter email + app password. */
export function imapDefaults(email: string): Pick<ImapConfig, "host" | "port" | "secure"> | null {
  const d = email.split("@")[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "msn.com": "outlook.office365.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "mac.com": "imap.mail.me.com",
    "fastmail.com": "imap.fastmail.com",
    "aol.com": "imap.aol.com",
    "proton.me": "127.0.0.1",
  };
  const host = map[d];
  return host ? { host, port: host === "127.0.0.1" ? 1143 : 993, secure: host !== "127.0.0.1" } : null;
}

export function saveImap(userId: string, cfg: ImapConfig) {
  run(
    "INSERT INTO oauth_tokens(user_id, provider, data) VALUES(?, 'imap', ?) ON CONFLICT(user_id, provider) DO UPDATE SET data = excluded.data",
    userId,
    seal(JSON.stringify({ ...cfg, last_sync: null })),
  );
}
export function loadImap(userId: string): (ImapConfig & { last_sync?: string | null }) | null {
  const r = one<{ data: string }>("SELECT data FROM oauth_tokens WHERE user_id = ? AND provider = 'imap'", userId);
  if (!r) return null;
  try {
    return JSON.parse(open(r.data));
  } catch {
    return null;
  }
}
export function deleteImap(userId: string) {
  run("DELETE FROM oauth_tokens WHERE user_id = ? AND provider = 'imap'", userId);
}
function setImapSync(userId: string, iso: string) {
  const c = loadImap(userId);
  if (c) run("UPDATE oauth_tokens SET data = ? WHERE user_id = ? AND provider = 'imap'", seal(JSON.stringify({ ...c, last_sync: iso })), userId);
}

export async function imapFetch(cfg: ImapConfig, since: Date, max = 60): Promise<MailMessage[]> {
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  await client.connect();
  const out: MailMessage[] = [];
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ since }, { uid: true })) || [];
      const recent = uids.slice(-max);
      if (recent.length) {
        for await (const msg of client.fetch(recent, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.source) continue;
          const p = await simpleParser(msg.source);
          const from = p.from?.value?.[0];
          out.push({
            id: `imap:${cfg.user}:${msg.uid}`,
            threadId: p.messageId,
            from: from?.address ?? "",
            fromName: from?.name,
            subject: p.subject ?? "",
            text: p.text ?? (p.html ? htmlToText(String(p.html)) : ""),
            html: p.html ? String(p.html) : undefined,
            receivedAt: (p.date ?? (msg.internalDate instanceof Date ? msg.internalDate : new Date())).toISOString(),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

export async function testImap(cfg: ImapConfig): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const msgs = await imapFetch(cfg, new Date(Date.now() - 2 * 86400_000), 5);
    return { ok: true, count: msgs.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- unified access ----------

export function mailSources(userId: string) {
  return { gmail: gmailConnected(userId), imap: Boolean(loadImap(userId)), local: true };
}

/** All new mail for a user across connected sources since a point in time. */
export async function fetchMail(userId: string, since: Date): Promise<MailMessage[]> {
  const user = getUser(userId);
  if (!user) return [];
  const out: MailMessage[] = [];
  const addresses = new Set([user.email, user.profile.personal.email].filter(Boolean).map((a) => a.toLowerCase()));
  for (const a of addresses) out.push(...localFetch(a, since.toISOString()));
  if (gmailConnected(userId)) out.push(...(await gmailFetch(userId, since).catch(() => [])));
  const imap = loadImap(userId);
  if (imap) out.push(...(await imapFetch(imap, since).catch(() => [])));
  return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

// ---------- verification codes and links ----------

const CODE_PATTERNS = [
  /(?:verification|security|one[- ]time|confirmation|access|login|sign[- ]in)\s*(?:code|pin|passcode)\b[^0-9A-Z]{0,40}([0-9]{4,8}|[A-Z0-9]{6,8})\b/i,
  /\b(?:code|pin|passcode|otp)\s*(?:is|:)\s*([0-9]{4,8}|[A-Z0-9]{6,8})\b/i,
  /\b(?:use|enter|type)\s+(?:the\s+|this\s+)?(?:code|pin|passcode)\s+([0-9]{4,8}|[A-Z0-9]{6,8})\b/i,
  /\b([0-9]{6})\b/,
];
const LINK_RE = /https?:\/\/[^\s"'<>]+(?:verif|confirm|activat|validate|token|magic|login)[^\s"'<>]*/i;

export function extractVerification(m: Pick<MailMessage, "text" | "html" | "subject">): { code?: string; link?: string } {
  const body = `${m.subject}\n${m.text}`;
  let code: string | undefined;
  for (const re of CODE_PATTERNS) {
    const hit = body.match(re);
    if (hit && !/^(19|20)\d{2}$/.test(hit[1])) {
      code = hit[1];
      break;
    }
  }
  const hrefs = [...(m.html ?? "").matchAll(/href="([^"]+)"/gi)].map((x) => x[1].replace(/&amp;/g, "&"));
  const link = hrefs.find((h) => LINK_RE.test(h)) ?? body.match(LINK_RE)?.[0];
  return { code, link };
}

/**
 * Wait for a verification email that arrived after `since` and looks like it came from the
 * employer's ATS. Polls every few seconds up to `timeoutMs`.
 */
export async function waitForVerification(
  userId: string,
  opts: { since: Date; senderHints: string[]; timeoutMs?: number; prefer?: "code" | "link" },
): Promise<{ code?: string; link?: string; message: MailMessage } | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const hints = opts.senderHints.map((h) => h.toLowerCase()).filter(Boolean);
  while (Date.now() < deadline) {
    const msgs = await fetchMail(userId, new Date(opts.since.getTime() - 5000));
    for (const m of msgs.reverse()) {
      const hay = `${m.from} ${m.fromName ?? ""} ${m.subject}`.toLowerCase();
      const relevant = /verif|confirm|code|activate|one-time|sign in|security/i.test(`${m.subject} ${m.text.slice(0, 500)}`);
      if (!relevant) continue;
      if (hints.length && !hints.some((h) => hay.includes(h))) continue;
      const v = extractVerification(m);
      if ((opts.prefer === "link" && v.link) || (opts.prefer !== "link" && v.code) || v.code || v.link) return { ...v, message: m };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

// ---------- tracking sync ----------

/** Pull new mail from every connected source into the tracker. */
export async function syncMail(userId: string): Promise<{ synced: number }> {
  const { ingestEmail, heuristicClassify } = await import("../track/inbox.ts");
  const key = `mail_sync:${userId}`;
  const last = parse<string | null>(one<{ v: string }>("SELECT v FROM kv WHERE k = ?", key)?.v, null);
  const since = last ? new Date(last) : new Date(Date.now() - 30 * 86400_000);
  const startedAt = now();
  const msgs = await fetchMail(userId, since);
  let synced = 0;
  for (const m of msgs) {
    const email = { externalId: m.id, threadId: m.threadId, fromAddr: m.from, fromName: m.fromName, subject: m.subject, body: m.text, receivedAt: m.receivedAt };
    if (!heuristicClassify(email).job_related) continue;
    if (await ingestEmail(userId, email)) synced++;
  }
  run("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, JSON.stringify(startedAt));
  if (loadImap(userId)) setImapSync(userId, startedAt);
  return { synced };
}

export function startMailSync(intervalMs = 5 * 60_000) {
  const tick = async () => {
    for (const { id } of all<{ id: string }>("SELECT id FROM users")) await syncMail(id).catch((e) => console.warn("[mail]", (e as Error).message));
  };
  setInterval(() => void tick(), intervalMs).unref();
}
