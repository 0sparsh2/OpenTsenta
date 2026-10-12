import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "../config.ts";

// Firebase Cloud Messaging HTTP v1 sender for the native apps (Android directly, iOS via APNs in FCM).
// Auth: a self-signed RS256 JWT from the service account, exchanged for an access token.

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let sa: ServiceAccount | null = null;
let cached: { token: string; exp: number } | null = null;

export const fcmEnabled = () => Boolean(config.fcmServiceAccount && fs.existsSync(config.fcmServiceAccount));
function account(): ServiceAccount {
  return (sa ??= JSON.parse(fs.readFileSync(config.fcmServiceAccount, "utf8")));
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(a: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }),
  );
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(a.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(account()) }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
  const d = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return d.access_token;
}

/** Returns false when the token is no longer valid (caller should delete it). */
export async function sendFcm(token: string, p: { title: string; body: string; url?: string }): Promise<boolean> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account().project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title: p.title, body: p.body }, data: { url: p.url ?? "/app" }, apns: { payload: { aps: { sound: "default" } } } } }),
  });
  if (res.status === 404 || res.status === 400) return false;
  if (!res.ok) throw new Error(`FCM send failed: ${res.status}`);
  return true;
}
