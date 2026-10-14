import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");

// Minimal .env loader so the server runs with `npm run dev` and no extra tooling.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k: string, d: boolean) => (process.env[k] ? process.env[k] === "true" || process.env[k] === "1" : d);

export const config = {
  brand: env("BRAND_NAME", "Ferry"),
  port: num("PORT", 8787),
  publicUrl: env("PUBLIC_URL", `http://localhost:${num("PORT", 8787)}`),
  // Where the dashboard lives (links in emails/texts). `npm start` serves it from the API itself.
  webUrl: env("WEB_URL", env("PUBLIC_URL", `http://localhost:${num("PORT", 8787)}`)),
  dataDir: path.resolve(ROOT, env("DATA_DIR", "data")),

  // LLM. Every AI feature has a deterministic fallback, so the app works without a key.
  anthropicEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !bool("LLM_DISABLED", false),
  model: env("LLM_MODEL", "claude-opus-5-5"),

  // Discovery
  pollIntervalMin: num("POLL_INTERVAL_MIN", 120),
  pollOnBoot: bool("POLL_ON_BOOT", true),
  pollConcurrency: num("POLL_CONCURRENCY", 12),
  /** Boards whose ATS pages through results (Workday, iCIMS, Oracle…) are polled this often. */
  pollHeavyIntervalMin: num("POLL_HEAVY_INTERVAL_MIN", 720),
  /** Closed jobs nobody applied to or saved are deleted after this many days. */
  closedJobRetentionDays: num("CLOSED_JOB_RETENTION_DAYS", 30),

  // Apply worker
  applyConcurrency: num("APPLY_CONCURRENCY", 2),
  headless: bool("HEADLESS", true),
  // Hard safety switch: when false the agent fills forms and stops before the final submit, always.
  allowRealSubmit: bool("ALLOW_REAL_SUBMIT", false),
  pageTimeoutMs: num("PAGE_TIMEOUT_MS", 45000),

  // Credits
  freeCredits: num("FREE_CREDITS", 25),

  // Gmail (optional)
  googleClientId: env("GOOGLE_CLIENT_ID"),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET"),

  // Auth: "dev" = passwordless email sign-in (local use); "password" = passwords + email verification.
  authMode: env("AUTH_MODE", "dev") as "dev" | "password",
  corsOrigins: env("CORS_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean),

  // Outbound email (verification, magic links, notifications). Without a key, mail goes to the local mailbox.
  resendApiKey: env("RESEND_API_KEY"),
  mailFrom: env("MAIL_FROM", "Ferry <noreply@ferry.local>"),

  // Billing (Stripe Checkout + webhooks). Without keys, plan changes grant credits directly (local use).
  stripeSecretKey: env("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET"),
  stripePrices: { starter: env("STRIPE_PRICE_STARTER"), pro: env("STRIPE_PRICE_PRO"), power: env("STRIPE_PRICE_POWER") } as Record<string, string>,

  // Messaging: Twilio (SMS + WhatsApp) and Sendblue (iMessage). Without keys, messages are logged.
  twilioSid: env("TWILIO_ACCOUNT_SID"),
  twilioToken: env("TWILIO_AUTH_TOKEN"),
  twilioFrom: env("TWILIO_FROM"),
  twilioWhatsappFrom: env("TWILIO_WHATSAPP_FROM"),
  sendblueKey: env("SENDBLUE_API_KEY"),
  sendblueSecret: env("SENDBLUE_API_SECRET"),
  sendblueFrom: env("SENDBLUE_FROM"),

  // Web push (VAPID). Generated and stored under the data dir if not set.
  vapidPublic: env("VAPID_PUBLIC_KEY"),
  vapidPrivate: env("VAPID_PRIVATE_KEY"),
  vapidSubject: env("VAPID_SUBJECT", "mailto:admin@ferry.local"),
  // Native push (iOS + Android apps) via Firebase Cloud Messaging: path to a service-account JSON.
  fcmServiceAccount: env("FCM_SERVICE_ACCOUNT"),
};

export const paths = {
  db: path.join(config.dataDir, "ferry.db"),
  uploads: path.join(config.dataDir, "uploads"),
  artifacts: path.join(config.dataDir, "artifacts"),
  traces: path.join(config.dataDir, "traces"),
};
for (const p of [config.dataDir, paths.uploads, paths.artifacts, paths.traces]) fs.mkdirSync(p, { recursive: true });
