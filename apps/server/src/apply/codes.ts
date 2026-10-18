import { publish } from "../bus.ts";

// Verification codes from people instead of an inbox. When an employer emails a code (or a link) and Ferry can't read
// it from a connected inbox, it asks: the question shows up in pending_questions (Claude, muse, any MCP client that
// can read the user's email) and on the application in the dashboard, and the employer's page stays open until
// someone answers or the time runs out. In memory, like the browser page it belongs to.

export type AskKind = "verification_code" | "verification_link";

interface Ask {
  appId: string;
  userId: string;
  kind: AskKind;
  question: string;
  host: string;
  askedAt: string;
  expiresAt: string;
  resolve: (answer: string | null) => void;
}

const asks = new Map<string, Ask>();
export const ASK_FIELD_ID = "verification_code";

/** Ask for a code (or link) for this application and wait for the answer; null if nobody answers in time. */
export function askFor(appId: string, userId: string, kind: AskKind, host: string, timeoutMs = 10 * 60_000): Promise<string | null> {
  asks.get(appId)?.resolve(null);
  const what = kind === "verification_code" ? "verification code" : "verification link";
  const question =
    kind === "verification_code"
      ? `${host} just emailed a ${what} to finish this application. What is the code? (It expires soon; answer within ${Math.round(timeoutMs / 60_000)} minutes.)`
      : `${host} just emailed a link to verify the email address for this application. Paste the link from that email.`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), timeoutMs);
    const done = (answer: string | null) => {
      clearTimeout(timer);
      if (asks.get(appId)?.resolve === done) asks.delete(appId);
      resolve(answer);
    };
    const now = Date.now();
    asks.set(appId, { appId, userId, kind, question, host, askedAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString(), resolve: done });
    publish(userId, { type: "application:asks", applicationId: appId, question });
  });
}

/** The open question on an application, if Ferry is waiting on one. */
export function askOn(appId: string) {
  const a = asks.get(appId);
  return a ? { field_id: ASK_FIELD_ID, kind: a.kind, question: a.question, host: a.host, asked_at: a.askedAt, expires_at: a.expiresAt } : null;
}

export const asksFor = (userId: string) => [...asks.values()].filter((a) => a.userId === userId).map((a) => ({ application_id: a.appId, ...askOn(a.appId)! }));

/** Hand Ferry the answer. A code keeps its letters and digits; a link must be a web address. */
export function answerAsk(userId: string, appId: string, value: string): { ok: true } | { ok: false; error: string } {
  const a = asks.get(appId);
  if (!a || a.userId !== userId) return { ok: false, error: "Ferry isn't waiting for a code on this application (it may have arrived by email, or timed out)" };
  if (a.kind === "verification_code") {
    const code = value.replace(/[\s-]/g, "");
    if (!/^[A-Za-z0-9]{4,12}$/.test(code)) return { ok: false, error: "That doesn't look like a verification code (4-12 letters or digits)" };
    a.resolve(code);
  } else {
    const link = value.trim();
    if (!/^https?:\/\/\S+$/.test(link)) return { ok: false, error: "Send the full link from the email (starting with https://)" };
    a.resolve(link);
  }
  return { ok: true };
}
