import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { onAnyEvent } from "../bus.ts";
import { config } from "../config.ts";
import { all, run } from "../db.ts";
import { onMatched } from "../match/score.ts";
import { notifyMatch, prefsOf, textUser } from "../messaging.ts";
import { getApplication, getJob, getUser, type User } from "../store.ts";
import { emailTemplates, sendEmail } from "./email.ts";
import { fcmEnabled, sendFcm } from "./fcm.ts";

// Fans events out to the channels each user turned on: text (SMS / WhatsApp / iMessage),
// web push, and a batched email digest of new matches.

// ---------- web push ----------

function vapid() {
  if (config.vapidPublic && config.vapidPrivate) return { publicKey: config.vapidPublic, privateKey: config.vapidPrivate };
  const file = path.join(config.dataDir, "vapid.json");
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  return JSON.parse(fs.readFileSync(file, "utf8")) as { publicKey: string; privateKey: string };
}
const keys = vapid();
webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
export const vapidPublicKey = () => keys.publicKey;

/** Native app device token (iOS/Android via FCM). Stored alongside web subscriptions. */
export function saveNativeToken(userId: string, token: string, platform: string) {
  savePushSubscription(userId, { endpoint: `fcm:${token}`, type: "fcm", token, platform } as { endpoint: string });
}

export function savePushSubscription(userId: string, sub: { endpoint: string }) {
  run("INSERT INTO push_subscriptions(endpoint, user_id, data) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, data = excluded.data", sub.endpoint, userId, JSON.stringify(sub));
}
export function deletePushSubscription(endpoint: string) {
  run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
}

export async function pushUser(userId: string, payload: { title: string; body: string; url?: string }) {
  if (!prefsOf(userId).push) return 0;
  let sent = 0;
  for (const s of all<{ endpoint: string; data: string }>("SELECT endpoint, data FROM push_subscriptions WHERE user_id = ?", userId)) {
    try {
      const sub = JSON.parse(s.data) as { type?: string; token?: string };
      if (sub.type === "fcm") {
        if (!fcmEnabled()) continue;
        if (await sendFcm(sub.token!, payload)) sent++;
        else deletePushSubscription(s.endpoint);
        continue;
      }
      await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) deletePushSubscription(s.endpoint);
    }
  }
  return sent;
}

// ---------- match alerts (rate limited) ----------

const lastText = new Map<string, number[]>();
function canText(userId: string) {
  const now = Date.now();
  const recent = (lastText.get(userId) ?? []).filter((t) => now - t < 24 * 3600_000);
  if (recent.length >= 5 || (recent.length && now - recent[recent.length - 1] < 20 * 60_000)) return false;
  recent.push(now);
  lastText.set(userId, recent);
  return true;
}

const digest = new Map<string, { title: string; company: string; score: number }[]>();

export function startNotifications() {
  onMatched((user, job, m) => {
    const p = prefsOf(user.id);
    if (m.score < p.minScore) return;
    if (p.emailDigest) {
      const list = digest.get(user.id) ?? [];
      if (list.length < 25) list.push({ title: job.title, company: job.company, score: m.score });
      digest.set(user.id, list);
    }
    if (canText(user.id)) void notifyMatch(user, job.id, m.score);
    void pushUser(user.id, { title: `New match · ${m.score}%`, body: `${job.title} at ${job.company}`, url: "/app/jobs" });
  });

  onAnyEvent((userId, e) => {
    if (e.type !== "application:updated" && e.type !== "inbox:new") return;
    const user = getUser(userId);
    if (!user) return;
    const p = prefsOf(userId);
    if (e.type === "inbox:new") {
      if (e.category && ["interview", "offer", "assessment"].includes(e.category)) {
        void pushUser(userId, { title: e.category === "offer" ? "Offer!" : "A recruiter replied", body: e.subject, url: "/app/inbox" });
        if (p.statusUpdates) void textUser(user, `Recruiter reply: "${e.subject}". Open ${config.webUrl}/app/inbox`, { kind: "reply" });
      }
      return;
    }
    const app = getApplication(e.applicationId);
    const job = app && getJob(app.jobId);
    if (!app || !job) return;
    const name = `${job.title} at ${job.company.replace(/\s*\(.*?\)/, "")}`;
    const url = `${config.webUrl}/app/applications/${app.id}`;
    if (e.status === "NEEDS_INPUT" || e.status === "PENDING_SUBMIT_REVIEW") {
      const body = e.status === "NEEDS_INPUT" ? `${name} needs you: ${app.error ?? "a few answers"}.` : `${name} is filled in and waiting for your OK.`;
      void pushUser(userId, { title: "Ferry needs you", body, url: `/app/applications/${app.id}` });
      if (p.statusUpdates) void textUser(user, `${body} ${url}`, { kind: "status", applicationId: app.id });
    }
    if (e.status === "COMPLETED" && !app.confirmation?.dryRun) {
      void pushUser(userId, { title: "Application submitted", body: name, url: `/app/applications/${app.id}` });
      if (p.statusUpdates) void textUser(user, `Submitted ✓ ${name}.`, { kind: "status", applicationId: app.id });
    }
  });

  // Email digest of new matches, at most every 6 hours per user.
  setInterval(() => void flushDigests(), 6 * 3600_000).unref();
}

export async function flushDigests() {
  for (const [userId, items] of digest) {
    digest.delete(userId);
    const user: User | undefined = getUser(userId);
    if (!user || !items.length) continue;
    const lines = items.sort((a, b) => b.score - a.score).map((i) => `${i.score}% · ${i.title} at ${i.company}`);
    await sendEmail({ to: user.email, ...emailTemplates.digest(lines, `${config.webUrl}/app/jobs`) }).catch(() => {});
  }
}
