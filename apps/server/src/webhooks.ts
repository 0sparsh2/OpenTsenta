import { Hono } from "hono";
import { constructStripeEvent, handleStripeEvent } from "./billing.ts";
import { config } from "./config.ts";
import { handleInbound, sendText, twilioSignatureValid, userByPhone } from "./messaging.ts";

// Inbound webhooks. Each provider authenticates by signature or shared secret, never a user token.
export const webhooks = new Hono();

webhooks.post("/stripe", async (c) => {
  const raw = await c.req.text();
  let event;
  try {
    event = constructStripeEvent(raw, c.req.header("stripe-signature") ?? "");
  } catch (e) {
    return c.json({ error: `Invalid signature: ${(e as Error).message}` }, 400);
  }
  return c.json(handleStripeEvent(event));
});

const reply = (text: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Message></Response>`;

/** Twilio SMS + WhatsApp inbound. Configure the webhook URL as {PUBLIC_URL}/api/v1/webhooks/twilio. */
webhooks.post("/twilio", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const url = `${config.publicUrl}/api/v1/webhooks/twilio`;
  if (!twilioSignatureValid(url, form, c.req.header("x-twilio-signature") ?? "")) return c.text("Invalid signature", 403);
  const from = String(form.From ?? "").replace(/^whatsapp:/, "");
  const user = userByPhone(from);
  const text = user
    ? handleInbound(user, String(form.Body ?? ""))
    : `This number isn't linked to a ${config.brand} account yet. Sign up at ${config.webUrl} and add your phone in Settings.`;
  return c.body(reply(text), 200, { "Content-Type": "text/xml" });
});

/** Sendblue (iMessage) inbound. Configure {PUBLIC_URL}/api/v1/webhooks/sendblue?secret=SENDBLUE_WEBHOOK_SECRET. */
webhooks.post("/sendblue", async (c) => {
  const secret = process.env.SENDBLUE_WEBHOOK_SECRET;
  if (!secret || c.req.query("secret") !== secret) return c.json({ error: "forbidden" }, 403);
  const b = (await c.req.json()) as { content?: string; from_number?: string; is_outbound?: boolean };
  if (b.is_outbound || !b.from_number) return c.json({ ok: true });
  const user = userByPhone(b.from_number);
  const text = user ? handleInbound(user, b.content ?? "") : `This number isn't linked to a ${config.brand} account yet. Sign up at ${config.webUrl}.`;
  await sendText(user?.id ?? null, "imessage", b.from_number, text, { kind: "reply" });
  return c.json({ ok: true });
});
