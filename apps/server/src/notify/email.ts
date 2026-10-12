import { config } from "../config.ts";
import { deliverLocal } from "../mail/index.ts";

// Outbound email: Resend when RESEND_API_KEY is set, otherwise the local sandbox mailbox
// (visible under Settings → Email → Sandbox mailbox), so every flow works offline.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(m: OutboundEmail): Promise<{ id: string; via: "resend" | "local" }> {
  if (config.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.mailFrom, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`Resend rejected the email: ${res.status} ${await res.text()}`);
    const d = (await res.json()) as { id: string };
    return { id: d.id, via: "resend" };
  }
  const from = config.mailFrom.match(/<([^>]+)>/)?.[1] ?? config.mailFrom;
  deliverLocal({ to: m.to, from, fromName: config.brand, subject: m.subject, text: m.text, html: m.html });
  return { id: `local:${Date.now()}`, via: "local" };
}

const wrap = (body: string) =>
  `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0E1B2C">
  <p style="font-weight:700;font-size:18px;margin:0 0 16px">${config.brand}</p>${body}
  <p style="color:#98A1AB;font-size:12px;margin-top:28px">You're receiving this because you have a ${config.brand} account.</p></div>`;

export const emailTemplates = {
  verify: (link: string) => ({
    subject: `Confirm your email for ${config.brand}`,
    text: `Confirm your email address to finish setting up ${config.brand}:\n\n${link}\n\nThe link expires in 24 hours.`,
    html: wrap(`<p>Confirm your email address to finish setting up your account.</p><p><a href="${link}" style="display:inline-block;background:#0E1B2C;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm email</a></p><p style="color:#66717F;font-size:13px">The link expires in 24 hours.</p>`),
  }),
  magic: (link: string) => ({
    subject: `Your ${config.brand} sign-in link`,
    text: `Sign in to ${config.brand}:\n\n${link}\n\nThe link works once and expires in 20 minutes.`,
    html: wrap(`<p><a href="${link}" style="display:inline-block;background:#0E1B2C;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Sign in</a></p><p style="color:#66717F;font-size:13px">The link works once and expires in 20 minutes.</p>`),
  }),
  reset: (link: string) => ({
    subject: `Reset your ${config.brand} password`,
    text: `Reset your password:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
    html: wrap(`<p><a href="${link}" style="display:inline-block;background:#0E1B2C;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p><p style="color:#66717F;font-size:13px">If you didn't ask for this, ignore this email.</p>`),
  }),
  digest: (lines: string[], link: string) => ({
    subject: `${lines.length} new role${lines.length === 1 ? "" : "s"} that fit you`,
    text: `${lines.join("\n")}\n\nReview and apply: ${link}`,
    html: wrap(`<ul style="padding-left:18px">${lines.map((l) => `<li style="margin:6px 0">${l.replace(/</g, "&lt;")}</li>`).join("")}</ul><p><a href="${link}">Review and apply</a></p>`),
  }),
};
