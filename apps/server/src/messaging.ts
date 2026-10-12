import crypto from "node:crypto";
import { config } from "./config.ts";
import { all, one, parse, run } from "./db.ts";
import { createApplication, getJob, getUser, type User } from "./store.ts";

// Text-message surface (the reference's iMessage / WhatsApp channel): Ferry texts you when a strong
// match drops; reply YES to apply, SKIP to pass. Providers: Twilio (SMS, WhatsApp), Sendblue (iMessage).
// Without provider keys, outbound messages are recorded in messages_out (status "logged").

export type Channel = "sms" | "whatsapp" | "imessage";

export interface MessagingPrefs {
  channel: Channel | null;
  matchAlerts: boolean;
  minScore: number;
  statusUpdates: boolean;
  emailDigest: boolean;
  push: boolean;
}
export const DEFAULT_PREFS: MessagingPrefs = { channel: null, matchAlerts: true, minScore: 80, statusUpdates: true, emailDigest: true, push: true };

export function prefsOf(userId: string): MessagingPrefs {
  return { ...DEFAULT_PREFS, ...parse<Partial<MessagingPrefs>>(one<{ notify: string }>("SELECT notify FROM users WHERE id = ?", userId)?.notify, {}) };
}
export function setPrefs(userId: string, patch: Partial<MessagingPrefs>) {
  const next = { ...prefsOf(userId), ...patch };
  run("UPDATE users SET notify = ? WHERE id = ?", JSON.stringify(next), userId);
  return next;
}
export function phoneOf(userId: string) {
  return one<{ phone: string | null; phone_verified: number }>("SELECT phone, phone_verified FROM users WHERE id = ?", userId);
}

export const normalizePhone = (p: string) => {
  const d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
};

export const providerFor = (channel: Channel) =>
  channel === "imessage" ? (config.sendblueKey ? "sendblue" : "log") : config.twilioSid && config.twilioToken ? "twilio" : "log";

// ---------- outbound ----------

export async function sendText(userId: string | null, channel: Channel, to: string, body: string, meta: Record<string, unknown> = {}): Promise<{ status: string }> {
  const provider = providerFor(channel);
  let status = "logged";
  try {
    if (provider === "twilio") {
      const from = channel === "whatsapp" ? `whatsapp:${config.twilioWhatsappFrom}` : config.twilioFrom;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: channel === "whatsapp" ? `whatsapp:${to}` : to, From: from, Body: body }),
      });
      status = res.ok ? "sent" : `failed:${res.status}`;
    } else if (provider === "sendblue") {
      const res = await fetch("https://api.sendblue.co/api/send-message", {
        method: "POST",
        headers: { "sb-api-key-id": config.sendblueKey, "sb-api-secret-key": config.sendblueSecret, "Content-Type": "application/json" },
        body: JSON.stringify({ number: to, content: body, from_number: config.sendblueFrom || undefined }),
      });
      status = res.ok ? "sent" : `failed:${res.status}`;
    }
  } catch (e) {
    status = `failed:${(e as Error).message.slice(0, 60)}`;
  }
  run("INSERT INTO messages_out(user_id, channel, to_addr, body, meta, status) VALUES(?,?,?,?,?,?)", userId, channel, to, body, JSON.stringify({ ...meta, provider }), status);
  return { status };
}

/** Text the user on their verified channel, if they have one. */
export async function textUser(user: User, body: string, meta: Record<string, unknown> = {}) {
  const p = prefsOf(user.id);
  const ph = phoneOf(user.id);
  if (!p.channel || !ph?.phone || !ph.phone_verified) return null;
  return sendText(user.id, p.channel, ph.phone, body, meta);
}

// ---------- phone verification ----------

const otps = new Map<string, { code: string; phone: string; channel: Channel; expires: number; tries: number }>();

export async function startPhoneVerification(user: User, phone: string, channel: Channel) {
  const to = normalizePhone(phone);
  if (!/^\+\d{8,15}$/.test(to)) throw new Error("Enter a phone number with country code, e.g. +1 415 555 0142");
  const code = String(crypto.randomInt(100000, 999999));
  otps.set(user.id, { code, phone: to, channel, expires: Date.now() + 10 * 60_000, tries: 0 });
  await sendText(user.id, channel, to, `${config.brand} code: ${code}. Reply STOP to opt out.`, { kind: "otp" });
  return { to, provider: providerFor(channel) };
}

export function confirmPhoneVerification(user: User, code: string): boolean {
  const o = otps.get(user.id);
  if (!o || o.expires < Date.now() || ++o.tries > 5) return false;
  if (o.code !== code.trim()) return false;
  otps.delete(user.id);
  // A number belongs to one account.
  run("UPDATE users SET phone = NULL, phone_verified = 0 WHERE phone = ? AND id != ?", o.phone, user.id);
  run("UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?", o.phone, user.id);
  setPrefs(user.id, { channel: o.channel });
  return true;
}
/** For tests and the local log view: the pending code (only when no real provider is configured). */
export const pendingOtp = (userId: string) => (providerFor(otps.get(userId)?.channel ?? "sms") === "log" ? otps.get(userId)?.code : undefined);

// ---------- conversation ----------

interface Convo {
  pendingJobId?: string;
  list?: string[];
}
const getConvo = (userId: string): Convo => parse(one<{ state: string }>("SELECT state FROM conversations WHERE user_id = ?", userId)?.state, {});
const setConvo = (userId: string, c: Convo) =>
  run("INSERT INTO conversations(user_id, state, updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at", userId, JSON.stringify(c));

type Enqueue = (appId: string) => void;
let enqueueApp: Enqueue = () => {};
export const setMessagingEnqueue = (fn: Enqueue) => (enqueueApp = fn);

export async function notifyMatch(user: User, jobId: string, score: number) {
  const p = prefsOf(user.id);
  if (!p.matchAlerts || score < p.minScore) return;
  const job = getJob(jobId);
  if (!job) return;
  setConvo(user.id, { ...getConvo(user.id), pendingJobId: jobId });
  await textUser(user, `New match: ${job.title} at ${job.company.replace(/\s*\(.*?\)/, "")}, ${score}%. Reply YES to apply or SKIP to pass.`, { kind: "match", jobId });
}

function applyTo(user: User, jobId: string): string {
  const job = getJob(jobId);
  if (!job) return "That job is no longer available.";
  if (user.credits <= 0) return "You're out of application credits. Top up in Settings → Credits.";
  const { app, created } = createApplication(user.id, jobId, "message");
  if (created) enqueueApp(app.id);
  return created
    ? `On it: applying to ${job.title} at ${job.company.replace(/\s*\(.*?\)/, "")}. I'll text you before anything is sent.`
    : `You already have an application for ${job.title}. Status: ${app.status.toLowerCase().replace(/_/g, " ")}.`;
}

/** Handle an inbound text and return the reply. */
export function handleInbound(user: User, text: string): string {
  const t = text.trim().toLowerCase();
  const convo = getConvo(user.id);
  if (/^(stop|unsubscribe|cancel|end|quit)$/.test(t)) {
    setPrefs(user.id, { matchAlerts: false, statusUpdates: false });
    return `You won't get more texts from ${config.brand}. Reply START to turn them back on.`;
  }
  if (/^(start|unstop)$/.test(t)) {
    setPrefs(user.id, { matchAlerts: true, statusUpdates: true });
    return "Texts are back on. Reply MATCHES to see your best new roles.";
  }
  if (/^(y|yes|yep|apply|sure|do it|go)$/.test(t)) {
    if (!convo.pendingJobId) return "Nothing pending. Reply MATCHES to see your best new roles.";
    const reply = applyTo(user, convo.pendingJobId);
    setConvo(user.id, { ...convo, pendingJobId: undefined });
    return reply;
  }
  if (/^(n|no|skip|pass|nah)$/.test(t)) {
    if (convo.pendingJobId) run("UPDATE matches SET status = 'skipped' WHERE user_id = ? AND job_id = ?", user.id, convo.pendingJobId);
    setConvo(user.id, { ...convo, pendingJobId: undefined });
    return "Skipped. I'll text you the next good one.";
  }
  if (/^(matches|jobs|new|list)$/.test(t)) {
    const rows = all<{ id: string; title: string; company: string; score: number }>(
      `SELECT j.id, j.title, j.company, m.score FROM matches m JOIN jobs j ON j.id = m.job_id WHERE m.user_id = ? AND m.status = 'new' AND j.closed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = m.user_id AND a.job_id = m.job_id) ORDER BY m.score DESC LIMIT 3`,
      user.id,
    );
    if (!rows.length) return "No new matches right now. I'll text you when one drops.";
    setConvo(user.id, { ...convo, list: rows.map((r) => r.id) });
    return `Top matches:\n${rows.map((r, i) => `${i + 1}. ${r.title} at ${r.company.replace(/\s*\(.*?\)/, "")} (${r.score}%)`).join("\n")}\nReply APPLY 1, 2, or 3.`;
  }
  const pick = t.match(/^apply\s*(\d)$/);
  if (pick) {
    const id = convo.list?.[Number(pick[1]) - 1];
    return id ? applyTo(user, id) : "Reply MATCHES first, then APPLY with a number.";
  }
  if (/^(status|how'?s it going|update)$/.test(t)) {
    const counts = all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM applications WHERE user_id = ? GROUP BY status", user.id);
    const n = (s: string[]) => counts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
    return `Submitted ${n(["COMPLETED"])} · in progress ${n(["QUEUED", "OPTIMIZING", "OPTIMIZING_RESUME", "OPTIMIZING_CL", "READY", "RUNNING"])} · needs you ${n(["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "PENDING_RESUME_REVIEW", "PENDING_CL_REVIEW"])}. Credits left: ${getUser(user.id)?.credits}.`;
  }
  return "Commands: MATCHES, YES (apply), SKIP, STATUS, STOP. Open the dashboard for everything else.";
}

export function userByPhone(phone: string): User | undefined {
  const r = one<{ id: string }>("SELECT id FROM users WHERE phone = ? AND phone_verified = 1", normalizePhone(phone));
  return r ? getUser(r.id) : undefined;
}

// ---------- Twilio signature ----------

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)). */
export function twilioSignatureValid(url: string, params: Record<string, string>, signature: string, authToken = config.twilioToken): boolean {
  if (!authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export const recentMessages = (userId: string) => all("SELECT channel, to_addr, body, status, created_at FROM messages_out WHERE user_id = ? ORDER BY id DESC LIMIT 30", userId);
