import Stripe from "stripe";
import { config } from "./config.ts";
import { one, run } from "./db.ts";
import { getUser, grantCredits, type User } from "./store.ts";

// Plans mirror the reference pricing: every tier is the full product, tiers differ by volume.
export const PLANS = [
  { id: "starter", name: "Starter", price: 19, credits: 600, blurb: "Enough for a real job search" },
  { id: "pro", name: "Pro", price: 39, credits: 1500, blurb: "For a high-volume search", popular: true },
  { id: "power", name: "Power", price: 99, credits: 4500, blurb: "Hit every match first" },
] as const;
export type PlanId = (typeof PLANS)[number]["id"];

let client: Stripe | null = null;
export const stripeEnabled = () => Boolean(config.stripeSecretKey);
export const stripe = () => (client ??= new Stripe(config.stripeSecretKey || "sk_test_placeholder"));

const planForPrice = (priceId?: string | null) => (Object.entries(config.stripePrices).find(([, v]) => v && v === priceId)?.[0] as PlanId | undefined) ?? undefined;

async function customerFor(user: User): Promise<string> {
  const existing = one<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM users WHERE id = ?", user.id)?.stripe_customer_id;
  if (existing) return existing;
  const c = await stripe().customers.create({ email: user.email, name: user.name ?? undefined, metadata: { userId: user.id } });
  run("UPDATE users SET stripe_customer_id = ? WHERE id = ?", c.id, user.id);
  return c.id;
}

/** Start a subscription checkout, or (no Stripe configured) switch plan and grant credits locally. */
export async function checkout(user: User, planId: string): Promise<{ url?: string; local?: boolean }> {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) throw new Error("Unknown plan");
  if (!stripeEnabled()) {
    run("UPDATE users SET plan = ? WHERE id = ?", plan.id, user.id);
    grantCredits(user.id, plan.credits, `plan_${plan.id}_local`);
    return { local: true };
  }
  const price = config.stripePrices[plan.id];
  if (!price) throw new Error(`Set STRIPE_PRICE_${plan.id.toUpperCase()} to the Stripe price id for ${plan.name}`);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: await customerFor(user),
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${config.webUrl}/app/settings?tab=billing&checkout=success`,
    cancel_url: `${config.webUrl}/app/settings?tab=billing&checkout=cancelled`,
    metadata: { userId: user.id, plan: plan.id },
    subscription_data: { metadata: { userId: user.id, plan: plan.id } },
  });
  return { url: session.url ?? undefined };
}

export async function portal(user: User): Promise<string> {
  const s = await stripe().billingPortal.sessions.create({ customer: await customerFor(user), return_url: `${config.webUrl}/app/settings?tab=billing` });
  return s.url;
}

function userForCustomer(customer: string | null | undefined): User | undefined {
  if (!customer) return undefined;
  const r = one<{ id: string }>("SELECT id FROM users WHERE stripe_customer_id = ?", customer);
  return r ? getUser(r.id) : undefined;
}

/** Apply a verified Stripe event. Idempotent: each event id is processed once. */
export function handleStripeEvent(event: Stripe.Event): { handled: boolean; duplicate?: boolean } {
  if (one("SELECT 1 FROM stripe_events WHERE id = ?", event.id)) return { handled: false, duplicate: true };
  run("INSERT INTO stripe_events(id, type) VALUES(?, ?)", event.id, event.type);
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.client_reference_id ?? s.metadata?.userId;
      if (!userId) return { handled: false };
      run("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?), plan = ? WHERE id = ?", typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null), s.metadata?.plan ?? "starter", userId);
      return { handled: true };
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const user = userForCustomer(typeof inv.customer === "string" ? inv.customer : inv.customer?.id);
      if (!user) return { handled: false };
      const line = inv.lines?.data?.[0] as (Stripe.InvoiceLineItem & { pricing?: { price_details?: { price?: string } }; price?: { id?: string } }) | undefined;
      const priceId = line?.pricing?.price_details?.price ?? line?.price?.id;
      const plan = PLANS.find((p) => p.id === (planForPrice(priceId) ?? user.plan));
      if (!plan) return { handled: false };
      // Each paid 30-day cycle resets the allowance to the plan's volume.
      const delta = plan.credits - user.credits;
      if (delta > 0) grantCredits(user.id, delta, `cycle_${plan.id}`);
      run("UPDATE users SET plan = ?, plan_renews_at = ? WHERE id = ?", plan.id, inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null, user.id);
      return { handled: true };
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const user = userForCustomer(typeof sub.customer === "string" ? sub.customer : sub.customer.id);
      const plan = planForPrice(sub.items.data[0]?.price?.id);
      if (user && plan) run("UPDATE users SET plan = ? WHERE id = ?", plan, user.id);
      return { handled: Boolean(user && plan) };
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const user = userForCustomer(typeof sub.customer === "string" ? sub.customer : sub.customer.id);
      if (user) run("UPDATE users SET plan = 'free', plan_renews_at = NULL WHERE id = ?", user.id);
      return { handled: Boolean(user) };
    }
    default:
      return { handled: false };
  }
}

export function constructStripeEvent(raw: string, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return stripe().webhooks.constructEvent(raw, signature, config.stripeWebhookSecret);
}
