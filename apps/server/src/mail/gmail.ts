import { config } from "../config.ts";
import { one, run } from "../db.ts";
import { open, seal } from "../secrets.ts";
import { htmlToText } from "../util/text.ts";
import type { MailMessage } from "./index.ts";

// Gmail via Google's API with the gmail.readonly scope, the same scope the reference uses.
// Configure GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET with redirect URI
// {PUBLIC_URL}/api/v1/integrations/gmail/callback.

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const redirectUri = () => `${config.publicUrl}/api/v1/integrations/gmail/callback`;

export const gmailConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

export function authUrl(state: string) {
  const p = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

const load = (userId: string): Tokens | null => {
  const r = one<{ data: string }>("SELECT data FROM oauth_tokens WHERE user_id = ? AND provider = 'gmail'", userId);
  if (!r) return null;
  try {
    return JSON.parse(open(r.data));
  } catch {
    return null;
  }
};
const save = (userId: string, t: Tokens) =>
  run("INSERT INTO oauth_tokens(user_id, provider, data) VALUES(?, 'gmail', ?) ON CONFLICT(user_id, provider) DO UPDATE SET data = excluded.data", userId, seal(JSON.stringify(t)));

export const gmailConnected = (userId: string) => Boolean(load(userId));

export async function exchangeCode(userId: string, code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  save(userId, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
}

export function disconnectGmail(userId: string) {
  const t = load(userId);
  if (t) void fetch(`https://oauth2.googleapis.com/revoke?token=${t.refresh_token ?? t.access_token}`, { method: "POST" }).catch(() => {});
  run("DELETE FROM oauth_tokens WHERE user_id = ? AND provider = 'gmail'", userId);
}

async function accessToken(userId: string): Promise<string | null> {
  const t = load(userId);
  if (!t) return null;
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: config.googleClientId, client_secret: config.googleClientSecret, grant_type: "refresh_token" }),
  });
  if (!res.ok) return null;
  const n = (await res.json()) as { access_token: string; expires_in: number };
  save(userId, { ...t, access_token: n.access_token, expires_at: Date.now() + n.expires_in * 1000 });
  return n.access_token;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
function partOf(p: GmailPart, type: string): string {
  if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) {
    const t = partOf(c, type);
    if (t) return t;
  }
  return "";
}

export async function gmailFetch(userId: string, since: Date, max = 60): Promise<MailMessage[]> {
  const token = await accessToken(userId);
  if (!token) return [];
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:spam -in:trash -category:promotions -category:social`;
  const list = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
    messages?: { id: string }[];
  };
  const out: MailMessage[] = [];
  for (const { id } of list.messages ?? []) {
    const m = (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      id: string;
      threadId: string;
      snippet: string;
      internalDate: string;
      payload: GmailPart & { headers: { name: string; value: string }[] };
    };
    const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    const from = h("from");
    const html = partOf(m.payload, "text/html");
    out.push({
      id: `gmail:${m.id}`,
      threadId: m.threadId,
      from: from.match(/<([^>]+)>/)?.[1] ?? from,
      fromName: from.replace(/<[^>]+>/, "").replace(/"/g, "").trim(),
      subject: h("subject"),
      text: partOf(m.payload, "text/plain") || (html ? htmlToText(html) : m.snippet),
      html: html || undefined,
      receivedAt: new Date(Number(m.internalDate)).toISOString(),
    });
  }
  return out;
}
