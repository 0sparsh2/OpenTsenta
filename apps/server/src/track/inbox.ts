import { z } from "zod";
import { publish } from "../bus.ts";
import { all, one, run, uid } from "../db.ts";
import { structured, text, withFallback } from "../llm.ts";
import { getApplication, getJob, getUser, patchApplication, setTrackedStatus, toApplication } from "../store.ts";
import type { TrackedStatus } from "../types.ts";
import { truncate } from "../util/text.ts";

export const CATEGORIES = ["confirmation", "interview", "assessment", "rejection", "offer", "recruiter_reply", "verification_code", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface IncomingEmail {
  externalId?: string;
  threadId?: string;
  fromAddr: string;
  fromName?: string;
  subject: string;
  body: string;
  receivedAt?: string;
}

const STATUS_FOR: Partial<Record<Category, TrackedStatus>> = {
  interview: "INTERVIEWING",
  assessment: "INTERVIEWING",
  recruiter_reply: "INTERVIEWING",
  rejection: "REJECTED",
  offer: "OFFER",
};

// ---------- classification ----------

const ClassSchema = z.object({
  job_related: z.boolean(),
  category: z.enum(CATEGORIES),
  company: z.string().describe("Hiring company name, empty if unknown"),
  summary: z.string().describe("One sentence, under 20 words"),
});

export function heuristicClassify(e: IncomingEmail): { job_related: boolean; category: Category; company: string; summary: string } {
  const t = `${e.subject}\n${e.body}`.toLowerCase();
  const company = guessCompany(e);
  const cat: Category =
    /verification code|one-time (pass)?code|security code|\botp\b|confirm your email/.test(t)
      ? "verification_code"
      : /unfortunately|not (be )?(moving|proceeding) forward|decided to (move|pursue) (forward )?with other|other candidates|position has been filled|not selected/.test(t)
        ? "rejection"
        : /offer letter|pleased to (extend|offer)|job offer|compensation package/.test(t)
          ? "offer"
          : /assessment|coding (challenge|test)|take-?home|hackerrank|codesignal|codility/.test(t)
            ? "assessment"
            : /schedule (a|an|your)|interview|phone screen|calendly|availability|chat with|speak with you|next steps/.test(t)
              ? "interview"
              : /thank(s| you) for (applying|your application|your interest)|application (was |has been )?received|we('ve| have) received your application/.test(t)
                ? "confirmation"
                : /recruit|talent|hiring|role|position|candidacy/.test(t)
                  ? "recruiter_reply"
                  : "other";
  return { job_related: cat !== "other", category: cat, company, summary: truncate(e.subject, 120) };
}

function guessCompany(e: IncomingEmail): string {
  const domain = e.fromAddr.split("@")[1]?.toLowerCase() ?? "";
  const generic = /gmail|outlook|yahoo|greenhouse|lever|ashby|workday|myworkday|smartrecruiters|icims|hire|notifications?|no-?reply/;
  const base = domain.split(".").slice(-2, -1)[0] ?? "";
  if (base && !generic.test(domain)) return base.charAt(0).toUpperCase() + base.slice(1);
  const m = `${e.subject} ${e.fromName ?? ""}`.match(/(?:at|from|with|@)\s+([A-Z][\w&.-]+(?:\s[A-Z][\w&.-]+)?)/);
  return m?.[1] ?? e.fromName?.replace(/(recruiting|talent|careers|hiring|team)/gi, "").trim() ?? "";
}

async function classify(e: IncomingEmail) {
  return withFallback(
    "email-classify",
    () =>
      structured({
        system:
          "You triage a job seeker's inbox. Decide whether the email is about the user's own job applications, its category, and the hiring company. Newsletters, job alerts, and marketing are not job_related.",
        effort: "low",
        maxTokens: 1500,
        schema: ClassSchema,
        prompt: `From: ${e.fromName ?? ""} <${e.fromAddr}>\nSubject: ${e.subject}\n\n${truncate(e.body, 4000)}`,
      }),
    () => heuristicClassify(e),
  );
}

// ---------- routing ----------

/** Find the application an email belongs to: company name/domain match among submitted apps. */
export function routeToApplication(userId: string, company: string, e: IncomingEmail): string | null {
  const apps = all("SELECT a.*, j.company AS company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND (a.status = 'COMPLETED' OR json_extract(a.confirmation, '$.pending') = 1) ORDER BY a.submitted_at DESC", userId) as (Record<string, unknown> & { company: string })[];
  const hay = `${company} ${e.fromAddr} ${e.fromName ?? ""} ${e.subject} ${e.body.slice(0, 2000)}`.toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const flat = norm(hay);
  let best: { id: string; score: number } | null = null;
  for (const a of apps) {
    const c = norm(a.company);
    if (c.length < 2) continue;
    let score = 0;
    if (company && norm(company) === c) score += 3;
    if (flat.includes(c)) score += 2;
    const job = getJob(String(a.job_id));
    if (job && hay.includes(job.title.toLowerCase())) score += 2;
    if (score && (!best || score > best.score)) best = { id: String(a.id), score };
  }
  return best?.id ?? null;
}

// ---------- ingest ----------

export async function ingestEmail(userId: string, e: IncomingEmail) {
  if (e.externalId && one("SELECT 1 FROM inbox_messages WHERE user_id = ? AND external_id = ?", userId, e.externalId)) return null;
  const c = await classify(e);
  if (!c.job_related) return null;
  const appId = c.category === "verification_code" ? null : routeToApplication(userId, c.company, e);
  const id = uid("msg");
  run(
    `INSERT INTO inbox_messages(id, user_id, external_id, thread_id, from_addr, from_name, subject, snippet, body, received_at, category, company, application_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    e.externalId ?? id,
    e.threadId ?? null,
    e.fromAddr,
    e.fromName ?? null,
    e.subject,
    truncate(c.summary || e.body.replace(/\s+/g, " "), 240),
    e.body,
    e.receivedAt ?? new Date().toISOString(),
    c.category,
    c.company || null,
    appId,
  );
  // The employer's confirmation email: proof the submission landed (it settles one Ferry couldn't confirm on the page).
  if (appId && c.category === "confirmation") {
    const app = getApplication(appId);
    if (app?.confirmation?.pending && app.status !== "COMPLETED") {
      patchApplication(appId, { status: "COMPLETED", submittedAt: app.confirmation.clickedAt ?? new Date().toISOString(), error: null, confirmation: { ...app.confirmation, pending: false, via: "email", email: e.subject } });
      setTrackedStatus(appId, "APPLIED", `confirmed by email: ${e.subject}`);
    } else if (app?.status === "COMPLETED" && app.confirmation && !app.confirmation.email) patchApplication(appId, { confirmation: { ...app.confirmation, email: e.subject } });
  }
  const next = STATUS_FOR[c.category];
  if (appId && next) {
    const app = getApplication(appId);
    // Never move backwards from an offer, and a rejection is final.
    if (app && app.trackedStatus !== "OFFER" && app.trackedStatus !== "REJECTED") setTrackedStatus(appId, next, `${c.category}: ${e.subject}`);
  }
  publish(userId, { type: "inbox:new", messageId: id, subject: e.subject, category: c.category });
  return getMessage(id);
}

// ---------- read / reply ----------

export interface InboxMessage {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  category: Category | null;
  company: string | null;
  applicationId: string | null;
  draftReply: string | null;
  read: boolean;
}
const toMessage = (r: Record<string, unknown>): InboxMessage => ({
  id: String(r.id),
  fromAddr: String(r.from_addr),
  fromName: (r.from_name as string) ?? null,
  subject: String(r.subject),
  snippet: String(r.snippet),
  body: String(r.body),
  receivedAt: String(r.received_at),
  category: (r.category as Category) ?? null,
  company: (r.company as string) ?? null,
  applicationId: (r.application_id as string) ?? null,
  draftReply: (r.draft_reply as string) ?? null,
  read: Boolean(r.read),
});
export const getMessage = (id: string) => {
  const r = one("SELECT * FROM inbox_messages WHERE id = ?", id);
  return r ? toMessage(r) : undefined;
};
export const listMessages = (userId: string, limit = 100) => all("SELECT * FROM inbox_messages WHERE user_id = ? ORDER BY received_at DESC LIMIT ?", userId, limit).map(toMessage);
export const unreadCount = (userId: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox_messages WHERE user_id = ? AND read = 0", userId)?.n ?? 0;

export async function draftReply(messageId: string): Promise<string> {
  const m = getMessage(messageId)!;
  const user = getUser(one<{ user_id: string }>("SELECT user_id FROM inbox_messages WHERE id = ?", messageId)!.user_id)!;
  const name = `${user.profile.personal.firstName} ${user.profile.personal.lastName}`.trim();
  const draft = await withFallback(
    "draft-reply",
    () =>
      text({
        system: `Draft a short, warm, professional reply from the candidate (${name}) to a recruiter email. Under 120 words. If they ask for availability, offer two concrete windows in the next 3 business days as placeholders like [Tue 2-4pm]. Output only the email body.`,
        effort: "low",
        maxTokens: 1500,
        prompt: `From: ${m.fromName ?? ""} <${m.fromAddr}>\nSubject: ${m.subject}\n\n${truncate(m.body, 5000)}`,
      }),
    () =>
      m.category === "interview" || m.category === "recruiter_reply"
        ? `Hi${m.fromName ? ` ${m.fromName.split(" ")[0]}` : ""},\n\nThank you for reaching out. I'd be glad to chat. I'm available [Tue 2–4pm] or [Wed 10am–12pm] — happy to adjust to what works for you.\n\nBest,\n${name}`
        : `Hi${m.fromName ? ` ${m.fromName.split(" ")[0]}` : ""},\n\nThank you for the update.\n\nBest,\n${name}`,
  );
  run("UPDATE inbox_messages SET draft_reply = ? WHERE id = ?", draft, messageId);
  return draft;
}

// ---------- ghosting ----------

export function markGhosted(days = 21) {
  const rows = all(
    `SELECT a.* FROM applications a WHERE a.status = 'COMPLETED' AND a.tracked_status = 'APPLIED'
     AND a.submitted_at < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM inbox_messages m WHERE m.application_id = a.id AND m.category != 'confirmation')`,
    `-${days} days`,
  ).map(toApplication);
  for (const a of rows) setTrackedStatus(a.id, "GHOSTED", `No reply in ${days} days`);
  return rows.length;
}
