import type { Frame, Locator, Page } from "playwright";
import { mailSources, waitForVerification } from "../mail/index.ts";
import { askFor } from "./codes.ts";
import { accountHost, createAccountRecord, getAccount, markAccount } from "../vault.ts";
import type { User } from "../store.ts";
import type { Job } from "../types.ts";
import { pageText } from "./extract.ts";
import { hasCaptcha } from "./fill.ts";

// Handles the account wall many ATSes put in front of the application (Workday, iCIMS, Taleo,
// SuccessFactors, ...): sign in with a stored per-employer account, or create one with the user's
// email and a generated password, then complete email verification from the user's inbox.

export type AuthState = "none" | "signin" | "signup" | "email_first" | "verify_code" | "verify_link";

export interface AuthContext {
  user: User;
  job: Job;
  think: (text: string, kind?: "thought" | "action" | "error") => void;
  allowCreate: boolean;
  /** A dry run on a real employer: no accounts are ever created. */
  dryRun?: boolean;
  /** Called with the vault host once an account is used or created, so the application can show it. */
  onAccount?: (host: string) => void;
  /** The application, so a code that never reaches a connected inbox can be asked for (see codes.ts). */
  appId?: string;
}

/**
 * The emailed code or link: from a connected inbox if there is one (Gmail, IMAP; the local inbox is the sandbox's),
 * else asked for, keeping the employer's page open: Claude or muse can read it from your email, or you type it.
 */
async function obtainVerification(
  ctx: { user: User; appId?: string; think: AuthContext["think"] },
  opts: { since: Date; senderHints: string[]; prefer: "code" | "link"; host: string },
): Promise<{ code?: string; link?: string; from: string } | null> {
  const src = mailSources(ctx.user.id);
  const realInbox = src.gmail || src.imap;
  const v = await waitForVerification(ctx.user.id, { since: opts.since, senderHints: opts.senderHints, timeoutMs: realInbox ? 120_000 : 20_000, prefer: opts.prefer });
  if (v && (v.code || v.link)) return { code: v.code, link: v.link, from: `"${v.message.subject}"` };
  if (!ctx.appId) return null;
  ctx.think(
    realInbox
      ? "The code didn't show up in your inbox, so Ferry is asking for it (Claude, muse or the dashboard can answer)"
      : "No inbox connected, so Ferry is asking for the emailed code (Claude, muse or the dashboard can answer; connect Gmail in Settings → Email to skip this)",
    "action",
  );
  const answer = await askFor(ctx.appId, ctx.user.id, opts.prefer === "link" ? "verification_link" : "verification_code", opts.host);
  if (!answer) return null;
  return opts.prefer === "link" && /^https?:/.test(answer) ? { link: answer, from: "your answer" } : { code: answer, from: "your answer" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function visibleCount(frame: Frame, sel: string) {
  return frame.locator(`${sel}:visible`).count().catch(() => 0);
}

/** The frame that holds the auth form (Workday and others sometimes use iframes). */
async function authFrame(page: Page): Promise<Frame> {
  for (const f of page.frames()) if ((await visibleCount(f, "input[type=password]")) > 0) return f;
  // Email-first sign-in inside an iframe (iCIMS): the frame with a visible email box.
  for (const f of page.frames()) if (f !== page.mainFrame() && (await visibleCount(f, "input[type=email], input[name*=email i], input[id*=email i]")) > 0) return f;
  return page.mainFrame();
}

export async function detectAuthState(page: Page): Promise<AuthState> {
  const frame = await authFrame(page);
  const pw = await visibleCount(frame, "input[type=password]");
  const text = (await pageText(page)).toLowerCase();
  if (pw >= 2) return "signup";
  if (pw === 1) return /create (an )?account|sign up|register/.test(text.slice(0, 300)) && !/sign in|log in/.test(text.slice(0, 200)) ? "signup" : "signin";
  const codeInputs = await frame
    .locator("input:visible")
    .evaluateAll((els) =>
      els.filter((e) => {
        const i = e as HTMLInputElement;
        const label = `${i.labels?.[0]?.innerText ?? ""} ${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""} ${i.autocomplete}`.toLowerCase();
        if (i.type === "hidden" || /postal|zip|area|promo|discount|country|referral|coupon|post code/.test(label)) return false;
        return /verification|one-time|\botp\b|passcode|security code|confirmation code|sign-?in code|access code|^\s*code\s*$|\bcode\b.*(sent|email)/.test(label) || i.autocomplete === "one-time-code";
      }).length,
    )
    .catch(() => 0);
  // Split code boxes (one digit each), as Oracle Recruiting and others use.
  const digitBoxes = await frame.locator("input[maxlength='1']:visible").count().catch(() => 0);
  const others = await frame
    .locator("input:visible:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=search]):not([maxlength='1']), select:visible, textarea:visible")
    .count()
    .catch(() => 0);
  // Verification screens are sparse; a page that already shows an application form isn't one (Greenhouse keeps
  // its submit-time security-code boxes in the form).
  const sparse = others <= 3;
  if (sparse && (codeInputs > 0 || digitBoxes >= 4) && /verif|one-time|we sent|sent (you )?(a|an|the) (code|email)|enter the code|(enter|type) (the|your) (\d-digit |verification |security |one-time )?code/.test(text)) return "verify_code";
  if (sparse && /(check|verify) your (email|inbox)|we('ve| have) sent (you )?(an email|a (verification )?link)|click the link (in|we)|activate your account/.test(text)) return "verify_link";
  // Email-first sign-in (iCIMS, Oracle Recruiting, ADP, Phenom): one email box, maybe a terms checkbox, nothing else.
  const hasEmail = (await frame.locator("input[type=email]:visible, input[name*=email i]:visible, input[id*=email i]:visible, input[autocomplete=email]:visible").count().catch(() => 0)) > 0;
  if (
    hasEmail &&
    others <= 2 &&
    (/\/(login|signin|sign-in|apply\/email|talentcommunity\/apply)\b/i.test(`${page.url()} ${frame.url()}`) ||
      /sign in|log in|returning candidate|enter your email|we('ll| will) (send|email) (you )?(a|an) (code|link|one-time)|continue with email|verify your email address/.test(text.slice(0, 1500)))
  )
    return "email_first";
  return "none";
}

async function clickByText(page: Page, re: RegExp, roles = "button, input[type=submit], a, [role=button]"): Promise<boolean> {
  for (const f of page.frames()) {
    const cands = f.locator(roles.split(",").map((r) => `${r.trim()}:visible`).join(", "));
    const n = Math.min(await cands.count().catch(() => 0), 120);
    for (let i = 0; i < n; i++) {
      const el = cands.nth(i);
      const t = ((await el.innerText().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "").trim();
      if (t && t.length < 60 && re.test(t)) {
        await el.click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        await sleep(600);
        return true;
      }
    }
  }
  return false;
}

/** The editable email/username box (read-only echoes of an email already given don't count). */
async function emailInput(frame: Frame): Promise<Locator | null> {
  const editable = ":not([readonly]):not([disabled])";
  const typed = frame.locator(`input[type=email]:visible${editable}`);
  if (await typed.count()) return typed.first();
  const byLabel = frame.getByLabel(/e-?mail|username|user name/i).and(frame.locator(`input${editable}`));
  if (await byLabel.count()) return byLabel.first();
  const named = frame.locator(["input[name*=email i]", "input[id*=email i]", "input[autocomplete=username]", "input[name*=user i]"].map((s) => `${s}:visible${editable}`).join(", "));
  return (await named.count()) ? named.first() : null;
}

async function checkConsents(frame: Frame) {
  const boxes = frame.locator("input[type=checkbox]:visible");
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    const label = ((await b.evaluate((e) => (e as HTMLInputElement).labels?.[0]?.innerText ?? e.closest("label")?.textContent ?? "").catch(() => "")) || "").toLowerCase();
    if (/agree|consent|privacy|terms|accept|acknowledge/.test(label) && !/marketing|newsletter|sms|text message/.test(label)) await b.check({ force: true }).catch(() => {});
  }
}

/**
 * Drive the page through any sign-in / sign-up / verification screens.
 * Returns "ok" when the application form (or no auth wall) is showing, otherwise a reason.
 */
export async function handleAuth(page: Page, ctx: AuthContext): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = accountHost(page.url());
  const email = (ctx.user.profile.personal.email || ctx.user.email).toLowerCase();
  let since = new Date();
  let triedSignin = false;
  let triedSignup = false;
  let retriedGenerated = false;
  let triedEmail = false;
  const senderHints = [ctx.job.company.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0], "workday", "icims", "taleo", "successfactors", "oracle", host.split(".")[0]].filter(Boolean);

  for (let step = 0; step < 8; step++) {
    const state = await detectAuthState(page);
    if (state === "none") return { ok: true };
    const frame = await authFrame(page);
    // Never solve or bypass a captcha: hand it to the user with what they need to finish.
    if ((state === "signin" || state === "signup") && (await hasCaptcha(page))) {
      const acct = getAccount(ctx.user.id, host);
      return {
        ok: false,
        reason: `${host} asks you to prove you're human before ${state === "signin" ? "signing in" : "creating an account"}. Open the posting and ${acct ? `sign in with ${acct.email}` : "create the account yourself (your application password works)"}, then finish the application or mark it done here.`,
      };
    }

    if (state === "signin") {
      const acct = getAccount(ctx.user.id, host);
      if (acct && !triedSignin) {
        triedSignin = true;
        ctx.onAccount?.(host);
        ctx.think(`Signing in to ${host} with your saved employer account`, "action");
        const e = await emailInput(frame);
        if (e) await e.fill(acct.email);
        await frame.locator("input[type=password]:visible").first().fill(acct.password);
        since = new Date();
        if (!(await clickByText(page, /^(sign in|log ?in|continue|next|submit)$/i))) await frame.locator("input[type=password]:visible").first().press("Enter");
        const after = (await pageText(page)).toLowerCase();
        if (/invalid|incorrect|not recognized|try again/.test(after) && (await detectAuthState(page)) === "signin") {
          markAccount(ctx.user.id, host, "failed");
          return { ok: false, reason: `The saved account for ${host} was rejected. Reset its password on the employer site, then retry.` };
        }
        if (/verify your email|not verified|verification/.test(after)) {
          // Account exists but was never verified: fall through to verification handling.
          ctx.think("The employer still needs the account's email verified");
        } else markAccount(ctx.user.id, host, "active");
        continue;
      }
      if (!ctx.allowCreate)
        return {
          ok: false,
          reason: `${host} needs a candidate account to apply. ${ctx.dryRun ? "Dry runs never create employer accounts." : 'Turn on "Create employer accounts for me" in Settings, or create one yourself and retry.'}`,
        };
      if (triedSignup) return { ok: false, reason: "Account creation didn't complete on the employer site" };
      ctx.think("No account with this employer yet; opening Create Account", "action");
      if (!(await clickByText(page, /create (an )?account|sign up|register|new user|join/i))) return { ok: false, reason: "Couldn't find a Create Account option on the sign-in page" };
      continue;
    }

    if (state === "signup") {
      // Never create an account unless the user allows it (and never during a dry run on a real site).
      if (!ctx.allowCreate)
        return {
          ok: false,
          reason: `${host} needs a candidate account to apply. ${ctx.dryRun ? "Dry runs never create employer accounts." : 'Turn on "Create employer accounts for me" in Settings, or create one yourself and retry.'}`,
        };
      let acct = getAccount(ctx.user.id, host);
      if (triedSignup) {
        const text = await pageText(page);
        // The site's password policy rejected the user's application password: retry once with a generated one.
        if (acct?.passwordKind === "application" && !retriedGenerated && /password/i.test(text) && /(must|require|least|invalid|allowed|character)/i.test(text)) {
          retriedGenerated = true;
          ctx.think(`${host} didn't accept your application password; using a generated one for this employer`, "action");
          acct = createAccountRecord(ctx.user.id, host, email, ctx.job.ats, { forceGenerated: true });
        } else return { ok: false, reason: `Account creation was rejected by ${host}: ${text.match(/(error|must|invalid|already)[^.\n]{0,120}/i)?.[0] ?? "unknown error"}` };
      }
      triedSignup = true;
      acct ??= createAccountRecord(ctx.user.id, host, email, ctx.job.ats);
      ctx.onAccount?.(host);
      ctx.think(
        `Creating your candidate account at ${host} (${acct.email}) with ${acct.passwordKind === "application" ? "your application password" : "a generated password (saved in Settings → Employer accounts)"}`,
        "action",
      );
      // Every email box, plus a user-name box (Taleo and others): the email doubles as the user name.
      const ids = frame.locator("input:visible:not([readonly]):not([disabled]):not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])");
      let filled = 0;
      for (let i = 0, n = await ids.count(); i < n; i++) {
        const el = ids.nth(i);
        const desc = await el
          .evaluate((e) => {
            const i = e as HTMLInputElement;
            return `${i.type} ${i.labels?.[0]?.innerText ?? ""} ${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""} ${i.autocomplete}`.toLowerCase();
          })
          .catch(() => "");
        if (/\bemail\b|e-mail/.test(desc) || /user ?name|login( id)?\b|user ?id\b/.test(desc)) {
          await el.fill(acct.email).catch(() => {});
          filled++;
        }
      }
      if (!filled) await (await emailInput(frame))?.fill(acct.email).catch(() => {});
      const pws = frame.locator("input[type=password]:visible:not([readonly]):not([disabled])");
      for (let i = 0, n = await pws.count(); i < n; i++) await pws.nth(i).fill(acct.password);
      for (const [re, v] of [
        [/first name|given name/i, ctx.user.profile.personal.firstName],
        [/last name|family name|surname/i, ctx.user.profile.personal.lastName],
      ] as const) {
        const f = frame.getByLabel(re);
        if (v && (await f.count())) await f.first().fill(v).catch(() => {});
      }
      await checkConsents(frame);
      since = new Date();
      if (!(await clickByText(page, /^(create account|sign up|register|create|continue|submit)$/i))) await pws.last().press("Enter");
      continue;
    }

    if (state === "email_first") {
      const acct = getAccount(ctx.user.id, host);
      // Entering the email can create a candidate profile and send a code: never in a dry run, and only when allowed.
      if (ctx.dryRun || (!acct && !ctx.allowCreate))
        return {
          ok: false,
          reason: `${host} signs candidates in by email before the application (it creates a candidate profile and emails a code). ${ctx.dryRun ? "Dry runs stop here." : 'Turn on "Create employer accounts for me" in Settings to let Ferry continue, or sign in yourself.'}`,
        };
      if (triedEmail) return { ok: false, reason: `Got stuck on ${host}'s email sign-in step` };
      triedEmail = true;
      const e = await emailInput(frame);
      if (!e) return { ok: false, reason: `Couldn't find the email box on ${host}'s sign-in page` };
      await e.fill(acct?.email ?? email);
      await checkConsents(frame);
      ctx.onAccount?.(host);
      ctx.think(`Signing in to ${host} with ${acct?.email ?? email}`, "action");
      since = new Date();
      if (!(await clickByText(page, /^(next|continue|submit|sign in|log ?in|send( me)? (a |the )?(code|link)|get (a |the )?code|verify|apply|start)$/i, "button, input[type=submit], input[type=button], a, [role=button]"))) await e.press("Enter");
      continue;
    }

    if (state === "verify_code" || state === "verify_link") {
      ctx.think("Waiting for the employer's verification email", "action");
      const v = await obtainVerification(ctx, { since, senderHints, prefer: state === "verify_link" ? "link" : "code", host });
      if (!v) return { ok: false, reason: "The verification code never came through (no connected inbox had it, and nobody answered in time). Connect Gmail in Settings → Email, or verify the account yourself." };
      if (state === "verify_code" && v.code) {
        ctx.think(`Entering the verification code from ${v.from}`, "action");
        await enterCode(page, frame, v.code, /^(verify|submit|continue|confirm|next)$/i);
      } else if (v.link) {
        ctx.think(`Opening the verification link from ${v.from}`, "action");
        await page.goto(v.link, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      } else return { ok: false, reason: "Got the verification email but couldn't find a code or link in it" };
      markAccount(ctx.user.id, host, "active");
      continue;
    }
  }
  return { ok: false, reason: "Got stuck on the employer's sign-in screens" };
}

/** Type a code into split one-character boxes or a single code field, then press the given button. */
async function enterCode(page: Page, frame: Frame, code: string, button: RegExp) {
  const boxes = frame.locator("input[maxlength='1']:visible");
  const nBoxes = await boxes.count();
  if (nBoxes >= 4 && nBoxes >= code.length) {
    for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]);
    if (!(await clickByText(page, button))) await boxes.nth(code.length - 1).press("Enter");
    return;
  }
  const codeField = frame.locator("input:visible").filter({ hasNot: frame.locator("[type=password]") });
  const labelled = frame.getByLabel(/code|verification|otp|pin/i);
  const target = (await labelled.count()) ? labelled.first() : codeField.first();
  await target.fill(code);
  if (!(await clickByText(page, button))) await target.press("Enter");
}

export const SUBMIT_CODE_TEXT = /(verification|security) code (has been |was )?sent|enter the (\d+-character |\d-digit )?(security |verification )?code|code (to|in order to) (submit|complete)|check your (email|inbox) for (a|the) code/i;

/**
 * Some boards (Greenhouse's fraud check) email a security code after Submit and hold the application until it's
 * entered. Read it from the inbox, enter it, and submit again. "none" when no such prompt is showing.
 */
export async function submitTimeCode(page: Page, ctx: { user: User; job: Job; think: AuthContext["think"]; appId?: string }, since: Date): Promise<"none" | "entered" | { fail: string }> {
  const text = await pageText(page);
  if (!SUBMIT_CODE_TEXT.test(text)) return "none";
  let frame = page.mainFrame();
  for (const f of page.frames()) if ((await visibleCount(f, "input[maxlength='1']")) >= 4 || (await f.getByLabel(/security code|verification code/i).count().catch(() => 0)) > 0) frame = f;
  ctx.think("The employer emailed a security code to finish submitting", "action");
  const hints = [ctx.job.company.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0], "greenhouse", "security code"].filter(Boolean);
  const v = await obtainVerification(ctx, { since, senderHints: hints, prefer: "code", host: ctx.job.company.replace(/\s*\(.*?\)/, "") });
  if (!v?.code) return { fail: "The employer's security code never came through (no connected inbox had it, and nobody answered in time). Connect Gmail in Settings → Email, or submit the application yourself." };
  ctx.think(`Entering the security code from ${v.from}`, "action");
  await enterCode(page, frame, v.code, /^(submit( application)?|verify|confirm|continue)$/i);
  return "entered";
}
