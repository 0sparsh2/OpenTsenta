import type { Frame, Locator, Page } from "playwright";
import { pickOption } from "./answer.ts";
import { frameOf, shim, type FrameField } from "./extract.ts";
import type { FilledField } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FillOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

function asText(v: FilledField["value"]): string {
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
}

/** Focus a combobox without clicking: react-select inputs are a few pixels wide and often covered. */
async function focusCombo(loc: Locator) {
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const ok = await loc.evaluate((el) => {
    (el as HTMLElement).focus();
    return document.activeElement === el;
  }).catch(() => false);
  if (!ok) await loc.click({ force: true, timeout: 4000 });
}

async function visibleOptions(frame: Frame): Promise<Locator> {
  return frame.locator("[role=option]:visible, [role=listbox] li:visible");
}

async function fillCombobox(frame: Frame, loc: Locator, value: string) {
  await focusCombo(loc);
  await loc.fill("").catch(() => {});
  await loc.pressSequentially(value.slice(0, 40), { delay: 15 });
  await sleep(700);
  let opts = await visibleOptions(frame);
  if (!(await opts.count())) {
    // Some selects only filter on a shorter query.
    await loc.fill("").catch(() => {});
    await loc.pressSequentially(value.split(/[ ,]/)[0].slice(0, 20), { delay: 15 });
    await sleep(700);
    opts = await visibleOptions(frame);
  }
  const n = await opts.count();
  if (n) {
    const texts = (await opts.allInnerTexts()).map((t) => t.trim());
    const best = pickOption(texts, value) ?? texts[0];
    await opts.nth(texts.indexOf(best)).click({ timeout: 5000, force: true });
  } else {
    await loc.press("Enter");
  }
  await sleep(150);
}

/**
 * Open each option-less combobox, read its options, and close it, so answers can be chosen from
 * the real choices (Greenhouse renders yes/no and acknowledgement questions as react-selects).
 */
export async function probeComboboxOptions(page: Page, fields: FrameField[], limit = 40): Promise<number> {
  let probed = 0;
  for (const f of fields) {
    if ((f.kind !== "combobox" && f.kind !== "listbox") || f.options?.length || probed >= limit) continue;
    // Location / city autocompletes only list results after typing; skip them.
    if (/location|city|address|school|university|degree|discipline|country|phone/i.test(f.label) && !/\?/.test(f.label)) continue;
    const frame = frameOf(page, f);
    const loc = frame.locator(`[data-ferry-id="${f.id}"]`).first();
    try {
      if (f.kind === "listbox") {
        await loc.click({ timeout: 4000 });
        await sleep(300);
        const texts = (await (await visibleOptions(frame)).allInnerTexts()).map((t) => t.trim()).filter(Boolean);
        if (texts.length) f.options = texts.slice(0, 300);
        await page.keyboard.press("Escape");
        await sleep(150);
        probed++;
        continue;
      }
      await focusCombo(loc);
      await loc.press("ArrowDown");
      await sleep(250);
      const opts = await visibleOptions(frame);
      const texts = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      if (texts.length && texts.length <= 80 && !/^no options$/i.test(texts[0])) f.options = texts;
      await loc.press("Escape");
      probed++;
    } catch {
      /* leave it option-less */
    }
  }
  return probed;
}

const groupOptions = (frame: Frame, field: FrameField) => frame.locator(`[data-ferry-group="${field.id}"]`);

async function clickChoice(frame: Frame, target: Locator, on: boolean) {
  try {
    await target.setChecked(on, { timeout: 4000 });
  } catch {
    // Custom-styled inputs: click the visible label instead.
    const id = await target.getAttribute("id");
    const label = id ? frame.locator(`label[for="${id}"]`) : target.locator("xpath=ancestor::label[1]");
    if (await label.count()) await label.first().click({ timeout: 4000 });
    else await target.click({ force: true, timeout: 4000 });
  }
}

async function setRadio(frame: Frame, field: FrameField, value: string) {
  const choice = pickOption(field.options, value);
  const idx = choice ? (field.options ?? []).indexOf(choice) : -1;
  if (idx < 0) throw new Error(`no radio option matches "${value}"`);
  await clickChoice(frame, groupOptions(frame, field).nth(idx), true);
}

async function setCheckboxes(frame: Frame, field: FrameField, value: FilledField["value"]) {
  if (!field.options?.length) {
    const want = /^(yes|true|on|1|checked)$/i.test(asText(value));
    await clickChoice(frame, frame.locator(`[data-ferry-id="${field.id}"]`).first(), want);
    return;
  }
  const wanted = (Array.isArray(value) ? value : String(value ?? "").split("|")).map((s) => s.trim()).filter(Boolean);
  for (const w of wanted) {
    const choice = pickOption(field.options, w);
    const idx = choice ? field.options.indexOf(choice) : -1;
    if (idx >= 0) await clickChoice(frame, groupOptions(frame, field).nth(idx), true);
  }
}

export async function fillField(page: Page, f: FrameField & FilledField): Promise<FillOutcome> {
  if (f.value == null || (typeof f.value === "string" && f.value === "")) return { id: f.id, ok: true };
  const frame = frameOf(page, f);
  const loc = frame.locator(`[data-ferry-id="${f.id}"]`).first();
  try {
    switch (f.kind) {
      case "file":
        await loc.setInputFiles(String(f.value), { timeout: 10000 });
        break;
      case "select": {
        const opts = await loc.locator("option").allInnerTexts();
        const choice = pickOption(
          opts.map((o) => o.trim()),
          asText(f.value),
        );
        if (!choice) throw new Error(`no option matches "${asText(f.value)}"`);
        await loc.selectOption({ label: choice }, { timeout: 5000 });
        break;
      }
      case "combobox":
        await fillCombobox(frame, loc, asText(f.value));
        break;
      case "listbox": {
        await loc.click({ timeout: 5000 });
        await sleep(300);
        const opts = await visibleOptions(frame);
        const texts = (await opts.allInnerTexts()).map((t) => t.trim());
        const choice = pickOption(texts, asText(f.value));
        if (!choice) {
          await page.keyboard.press("Escape");
          throw new Error(`no option matches "${asText(f.value)}"`);
        }
        const target = opts.nth(texts.indexOf(choice));
        await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await target.click({ timeout: 5000 });
        await sleep(150);
        break;
      }
      case "radio":
        await setRadio(frame, f, asText(f.value));
        break;
      case "checkbox":
        await setCheckboxes(frame, f, f.value);
        break;
      case "date": {
        const v = asText(f.value);
        await loc.fill(/^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v, { timeout: 5000 });
        break;
      }
      default:
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await loc.fill(asText(f.value), { timeout: 5000 });
        // Fire blur so React-controlled inputs commit the value.
        await loc.dispatchEvent("blur").catch(() => {});
    }
    return { id: f.id, ok: true };
  } catch (e) {
    return { id: f.id, ok: false, error: (e as Error).message.split("\n")[0].slice(0, 200) };
  }
}

// ---------- navigation helpers ----------

const SUBMIT_RE = /^(submit( application| my application)?|send application|apply( now)?|complete application|finish)$/i;
const NEXT_RE = /^(next|continue|save (and|&) continue|next step|proceed|review)$/i;
const APPLY_ENTRY_RE =
  /^(apply( now| online| here| today)?|apply (for|to) (this|the) (job|position|role|opening)( online| now)?|apply to (job|position)|i'?m interested|(start|begin) (my |your |an? )?application|apply manually|easy apply)$/i;
// Workday-style "how do you want to apply" choice: manual is predictable and doesn't hand the résumé to the employer's parser first.
const APPLY_MANUAL_RE = /^(apply manually|enter manually|fill (it )?out manually|apply without (a )?resume)$/i;

async function findButton(page: Page, re: RegExp): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const cands = frame.locator("button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible, a:visible, [role=button]:visible");
    const n = Math.min(await cands.count().catch(() => 0), 200);
    for (let i = 0; i < n; i++) {
      const c = cands.nth(i);
      const raw = ((await c.innerText().catch(() => "")) || (await c.getAttribute("value").catch(() => "")) || (await c.getAttribute("aria-label").catch(() => "")) || "").trim();
      // "Apply now »", "Apply →", "› Submit": compare the words, not the arrows and icons around them.
      const t = raw.replace(/[^\p{L}\p{N}'’\s]+/gu, " ").replace(/\s+/g, " ").trim();
      if (t && t.length < 50 && re.test(t)) return c;
    }
  }
  return null;
}

export const findSubmit = (page: Page) => findButton(page, SUBMIT_RE);
export const findNext = (page: Page) => findButton(page, NEXT_RE);
export const findApplyEntry = (page: Page) => findButton(page, APPLY_ENTRY_RE);
export const findApplyManual = (page: Page) => findButton(page, APPLY_MANUAL_RE);

const AGREE_RE = /^(i )?(accept|agree)( (and|&) continue| to (the )?terms)?$/i;
/** An in-flow agreement step (Taleo's privacy agreement): a page whose only action is Accept. */
export async function findAgreement(page: Page): Promise<Locator | null> {
  const btn = await findButton(page, AGREE_RE);
  if (!btn) return null;
  const text = (await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")).toLowerCase();
  return /privacy|agreement|terms|consent|personal data/.test(text) ? btn : null;
}

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha/i;

/**
 * Full-page bot protection (DataDome, Cloudflare, PerimeterX, Akamai) that stands in front of the whole site.
 * Ferry doesn't try to get past these; it hands the application back.
 */
export async function botWall(page: Page): Promise<string | null> {
  for (const f of page.frames()) {
    const u = f.url();
    if (/captcha-delivery\.com|datadome/i.test(u)) return "DataDome";
    if (/challenges\.cloudflare\.com/i.test(u) && f !== page.mainFrame()) {
      const el = await f.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      if (box && box.width > 200) return "Cloudflare";
    }
  }
  const title = (await page.title().catch(() => "")).toLowerCase();
  const text = (await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")).slice(0, 600).toLowerCase();
  if (/just a moment|attention required/.test(title) && /cloudflare|checking your browser|verify you are human/.test(`${title} ${text}`)) return "Cloudflare";
  if (/px-captcha|press (&|and) hold/.test(text) || (await page.locator("#px-captcha").count().catch(() => 0)) > 0) return "PerimeterX";
  if (/access denied/.test(title) && /reference #/.test(text)) return "Akamai";
  return null;
}
export async function hasCaptcha(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (CAPTCHA_RE.test(f.url()) && !/size=invisible/.test(f.url())) {
      const el = await f.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      // Invisible reCAPTCHA (v3, Enterprise) keeps its badge and challenge frame on the page but hidden until it
      // decides to challenge; only a widget a person could see blocks us (a challenge after Submit is caught there).
      const shown = el
        ? await el
            .evaluate((n) => {
              for (let e: Element | null = n as Element; e; e = e.parentElement) {
                const s = getComputedStyle(e);
                if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
              }
              return true;
            })
            .catch(() => true)
        : false;
      if (shown && box && box.width > 120 && box.height > 60 && box.y >= 0 && box.x >= 0) return true;
    }
  }
  return false;
}

/** Visible validation errors after a submit attempt. */
export async function visibleErrors(page: Page): Promise<string[]> {
  const errs: string[] = [];
  for (const f of page.frames()) {
    try {
      await shim(f);
      const got = await f.evaluate(() =>
        Array.from(document.querySelectorAll("[role=alert], .error, .field-error, [class*='error' i], [aria-invalid=true]"))
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "").trim())
          .filter((t) => t && t.length < 200),
      );
      errs.push(...got);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(errs)].slice(0, 8);
}

export const CONFIRMATION_RE =
  /thank(s| you) for (applying|your application|submitting|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)/i;

// ---------- cookie banners ----------

const COOKIE_REJECT_RE =
  /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|only (necessary|essential|required)( cookies)?|(use|accept|allow) (only )?(necessary|essential|required)( cookies)?|necessary only|essential only|continue without accepting)$/i;

/** Dismiss a consent banner choosing the most privacy-preserving option; never clicks "Accept all". */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  const btn = await findButton(page, COOKIE_REJECT_RE);
  if (btn) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    return true;
  }
  for (const f of page.frames()) {
    const close = f.locator("#onetrust-close-btn-container button:visible, [id*=cookie i] button[aria-label*=close i]:visible, [class*=cookie i] button[aria-label*=close i]:visible").first();
    if (await close.count().catch(() => 0)) {
      await close.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// ---------- read-back ----------

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Read typed values back and restore any the page changed. Many ATSes parse the uploaded résumé
 * and overwrite fields we already filled; this puts the tailored answers back.
 */
export async function verifyAndRepair(page: Page, filled: (FrameField & FilledField)[]): Promise<number> {
  let repaired = 0;
  for (const f of filled) {
    if (!["text", "email", "tel", "url", "number", "textarea"].includes(f.kind) || f.value == null || f.value === "") continue;
    const loc = frameOf(page, f).locator(`[data-ferry-id="${f.id}"]`).first();
    const cur = await loc.inputValue({ timeout: 2000 }).catch(() => null);
    if (cur == null) continue;
    const want = asText(f.value);
    const same = f.kind === "tel" ? digits(cur).endsWith(digits(want).slice(-10)) : cur.trim() === want.trim();
    if (!same) {
      await loc.fill(want).catch(() => {});
      repaired++;
    }
  }
  return repaired;
}
