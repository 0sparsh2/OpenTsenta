import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { applyPageUrl, atsName, detectAts } from "../ats.ts";
import { publish } from "../bus.ts";
import { newApplyContext } from "../browser.ts";
import { config, paths } from "../config.ts";
import { now, run as dbRun } from "../db.ts";
import { writeCoverLetter } from "../resume/cover.ts";
import { renderResume, renderTextPdf } from "../resume/render.ts";
import { profileFor } from "../resume/profiles.ts";
import { resolveLayout } from "../resume/model.ts";
import { projectDocx } from "../resume/project.ts";
import { jdKeywords, tailorResume } from "../resume/tailor.ts";
import { ensureDescription } from "../ingest/describe.ts";
import {
  chargeCredit,
  getApplication,
  getJob,
  getUser,
  patchApplication,
  rememberAnswer,
  setTrackedStatus,
  type Application,
} from "../store.ts";
import type { FilledField, PipelineStatus, TraceStep } from "../types.ts";
import { answerFields, memorable, missingRequired } from "./answer.ts";
import { detectAuthState, handleAuth, submitTimeCode } from "./auth.ts";
import { extractFields, pageText, type FrameField } from "./extract.ts";
import { botWall, CONFIRMATION_RE, dismissCookieBanner, findAgreement, fillField, findApplyEntry, findApplyManual, findNext, findSubmit, hasCaptcha, probeComboboxOptions, verifyAndRepair, visibleErrors } from "./fill.ts";
import { navigate } from "./navigator.ts";

const MAX_PAGES = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  /** User approved the final review: click submit. */
  submit?: boolean;
  /** Skip review gates for this run (used by "Approve & send"). */
  approved?: boolean;
}

class Run {
  app: Application;
  trace: TraceStep[];
  constructor(app: Application) {
    this.app = app;
    this.trace = [...app.trace];
  }
  get jobId() {
    return this.app.jobId;
  }
  status(status: PipelineStatus, extra: Partial<Application> = {}) {
    this.app = patchApplication(this.app.id, { status, ...extra, trace: this.trace });
    publish(this.app.userId, { type: "application:updated", applicationId: this.app.id, status });
  }
  think(text: string, kind: TraceStep["kind"] = "thought", image?: string) {
    const step: TraceStep = { t: now(), kind, text, image };
    this.trace.push(step);
    this.app = patchApplication(this.app.id, { trace: this.trace, lastThought: kind === "thought" || kind === "action" ? text : this.app.lastThought });
    publish(this.app.userId, { type: "execution:thought", applicationId: this.app.id, jobId: this.jobId, thought: text, currentPage: this.app.currentPage ?? undefined, totalPages: this.app.totalPages ?? undefined });
  }
  async shot(page: Page, label: string) {
    const dir = path.join(paths.traces, this.app.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${String(this.trace.length).padStart(3, "0")}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: true }).catch(() => {});
    this.think(label, "screenshot", `/traces/${this.app.id}/${file}`);
    return `/traces/${this.app.id}/${file}`;
  }
}

/** Stage 1: tailor résumé + cover letter, honoring the review gates. Returns false if paused. */
async function prepare(run: Run, opts: RunOptions): Promise<boolean> {
  const user = getUser(run.app.userId)!;
  const job = await ensureDescription(getJob(run.app.jobId)!);
  const resume = profileFor(user, job, run.app.resumeId);
  if (!resume) throw new Error("Upload a résumé before applying");
  if (run.app.resumeId !== resume.id) run.app = patchApplication(run.app.id, { resumeId: resume.id });
  const s = user.settings;

  if (!run.app.tailored) {
    run.status("OPTIMIZING_RESUME", { resumeId: resume.id });
    run.think(`Tailoring your "${resume.name}" profile for ${job.title} at ${job.company} (${s.optimizationMode})`);
    const t = await tailorResume(resume.doc, job, s.optimizationMode, { notes: resume.notes, instructions: run.app.tailorInstructions ?? undefined });
    run.app = patchApplication(run.app.id, { tailored: t.tailored, changes: t.changes, atsScore: t.atsScore });
    run.think(
      t.method === "off"
        ? "Résumé tailoring is off; using your default résumé as-is"
        : `${t.changes.length} change${t.changes.length === 1 ? "" : "s"} · ATS keyword score ${t.atsScore.before} → ${t.atsScore.after}`,
    );
    // Preview gate: per application if chosen when applying, else the Settings default.
    const preview = run.app.reviewResume ?? !s.autoApproveResume;
    if (preview && !opts.approved) {
      run.status("PENDING_RESUME_REVIEW");
      run.think("Paused so you can preview the tailored résumé. Approve it, edit it, or ask for changes, and Ferry continues.");
      return false;
    }
  }

  if (run.app.coverLetter == null && s.coverLetterMode !== "off") {
    run.status("OPTIMIZING_CL");
    run.think("Drafting a cover letter for this role");
    const cl = await writeCoverLetter(user.profile, run.app.tailored ?? resume.doc, job, s.coverLetterMode);
    run.app = patchApplication(run.app.id, { coverLetter: cl ?? "" });
    if (cl && !s.autoApproveCoverLetter && !opts.approved) {
      run.status("PENDING_CL_REVIEW");
      run.think("Paused: review the cover letter before it's used");
      return false;
    }
  }

  if (!run.app.resumePdf || !fs.existsSync(run.app.resumePdf)) {
    const stem = `${user.profile.personal.firstName}_${user.profile.personal.lastName}_${job.company}_${run.app.id.slice(-5)}`;
    const out = await renderResume(user.profile.personal, run.app.tailored ?? resume.doc, stem, { keywords: jdKeywords(job) });
    run.app = patchApplication(run.app.id, { resumePdf: out.file, resumeDocx: null });
    const { fit } = out;
    if (fit.limit) {
      run.think(
        fit.overflow
          ? `Résumé runs ${fit.pages} pages even at the smallest readable size (limit ${fit.limit})`
          : `Résumé fits on ${fit.pages} page${fit.pages === 1 ? "" : "s"}${fit.step ? " after tightening spacing" : ""}${fit.cut.length ? `, ${fit.cut.length} lower-priority line${fit.cut.length === 1 ? "" : "s"} cut` : ""}`,
      );
    }
  }
  // "Keep my design": the same tailored text inside the user's own Word file.
  const doc = run.app.tailored ?? resume.doc;
  if (resolveLayout(doc).style.output === "original" && resume.filePath?.toLowerCase().endsWith(".docx") && fs.existsSync(resume.filePath) && !(run.app.resumeDocx && fs.existsSync(run.app.resumeDocx))) {
    try {
      const p = await projectDocx(resume.filePath, resume.doc, doc);
      if (p.coverage >= 0.5) {
        const file = path.join(paths.artifacts, `${user.profile.personal.firstName}_${user.profile.personal.lastName}_${job.company}_${run.app.id.slice(-5)}.docx`.replace(/[^\w.-]+/g, "_"));
        fs.writeFileSync(file, p.buffer);
        run.app = patchApplication(run.app.id, { resumeDocx: file });
        run.think(`Wrote the tailored text into your own Word design (${p.replaced} edits)`);
      } else run.think("Couldn't line up your Word file with the profile closely enough; using the Ferry template instead");
    } catch (e) {
      run.think(`Couldn't use your Word design (${(e as Error).message}); using the Ferry template instead`);
    }
  }
  return true;
}

type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof newApplyContext>>["newPage"]>>;

/** Single-page apps (Ashby, Workday) render after network idle; wait for real content. */
async function waitForContent(page: BrowserPage, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Any frame counts: iCIMS and others put the whole posting inside an iframe.
    for (const f of page.frames()) {
      const ready = await f
        .evaluate(() => (document.body?.innerText?.trim().length ?? 0) > 200 || document.querySelectorAll("input:not([type=hidden]), textarea, select").length > 0)
        .catch(() => false);
      if (ready) return;
    }
    await sleep(400);
  }
}

/** Get from the posting URL to the first page of application fields. */
const CLOSED_RE = /page not found|job (posting )?(is )?(no longer|not) (available|active|open)|no longer (accepting applications|available)|position has been filled|this (job|position|posting) (has )?(expired|closed|been closed)|job not found|posting (is )?closed/i;

async function openForm(run: Run, page: BrowserPage, target: string): Promise<{ fields: FrameField[] } | { blocked: string; closed?: boolean }> {
  const user = getUser(run.app.userId)!;
  const job = getJob(run.app.jobId)!;
  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await waitForContent(page);
    if (await dismissCookieBanner(page)) run.think("Dismissed the cookie banner (necessary cookies only)", "action");
  };
  const auth = async (): Promise<string | null> => {
    if ((await detectAuthState(page)) === "none") return null;
    const r = await handleAuth(page, {
      user,
      job,
      // A dry run on a real employer must have no side effects: never create accounts there.
      allowCreate: user.settings.allowAccountCreation && !(!job.applyUrl.includes("/mock-ats/") && !config.allowRealSubmit),
      dryRun: !job.applyUrl.includes("/mock-ats/") && !config.allowRealSubmit,
      think: (t, k) => run.think(t, k),
      onAccount: (host) => {
        if (run.app.accountHost !== host) run.app = patchApplication(run.app.id, { accountHost: host });
      },
    });
    return r.ok ? null : r.reason;
  };
  // Job-search boxes, filters and job-alert sign-ups sit on many career pages; they aren't the application.
  const NOT_APPLICATION = /search|keyword|sort by|category|radius|distance|(job )?alert|how often|filter|results page|location\b.*\(all\)|^(all|any) keywords|subscribe|newsletter/i;
  const applicationFields = (f: FrameField[]) => f.filter((x) => !NOT_APPLICATION.test(x.label) && !(x.options ?? []).slice(0, 2).some((o) => /^\(all\)$/i.test(o)));
  const usable = (f: FrameField[]) => applicationFields(f).filter((x) => x.kind !== "checkbox").length >= 2;

  if (job.ats === "linkedin") {
    const easy = /\[LinkedIn Easy Apply\]/.test(job.description);
    return {
      blocked: easy
        ? "This is a LinkedIn Easy Apply job, which only works inside LinkedIn with your account. Your tailored résumé is ready to download: apply on LinkedIn, then mark it done here."
        : `LinkedIn only shows ${job.company}'s application link to signed-in members, and Ferry doesn't use your LinkedIn login. Click Apply on LinkedIn, then paste the company's application page into Ferry and it takes over from there.`,
    };
  }
  const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: config.pageTimeoutMs });
  await settle();
  const head = (await pageText(page)).slice(0, 1500);
  // A posting link that lands on the site's home or job search has been taken down.
  const path = (u: string) => {
    try {
      return new URL(u).pathname.replace(/\/+$/, "");
    } catch {
      return "";
    }
  };
  const SEARCHY = /\/jobs\/search|\/search\/?\?|[?&](ss|q)=/i;
  const redirectedToSearch = (SEARCHY.test(page.url()) && !SEARCHY.test(target)) || (path(page.url()) === "" && path(target).length > 1);
  if (resp?.status() === 404 || CLOSED_RE.test(head) || redirectedToSearch) {
    dbRun("UPDATE jobs SET closed_at = ? WHERE id = ?", now(), job.id);
    return { blocked: "This posting has been taken down or is no longer accepting applications", closed: true };
  }
  let blocked = await auth();
  if (blocked) return { blocked };
  let fields = await extractFields(page);
  // In-flow agreement steps (Taleo's privacy agreement) come before the form: accept and move on.
  const agreement = async () => {
    for (let i = 0; i < 2 && !usable(fields); i++) {
      const agree = await findAgreement(page);
      if (!agree) return;
      run.think("Accepting the employer's privacy agreement to reach the form", "action");
      await agree.click();
      await settle();
      fields = await extractFields(page);
    }
  };
  if (!usable(fields)) {
    // Single-page career sites render the Apply button after the rest of the page (and after cookie banners).
    let entry = await findApplyEntry(page);
    for (let i = 0; !entry && i < 20; i++) {
      await sleep(500);
      entry = await findApplyEntry(page);
      if (!entry && usable(await extractFields(page))) break;
    }
    if (!entry) fields = await extractFields(page);
    if (entry) {
      run.think("Found the Apply button on the posting; opening the form", "action");
      // Keep the application in this tab: links that open a new window are followed here instead.
      await entry.evaluate((el) => el.closest("a")?.removeAttribute("target")).catch(() => {});
      const before = page.url();
      const pagesBefore = page.context().pages().length;
      await entry.click();
      // A new tab shows up within a second or so if the link opens one.
      let opened: typeof page | null = null;
      for (let i = 0; i < 6 && !opened; i++) {
        await sleep(200);
        const pages = page.context().pages();
        if (pages.length > pagesBefore) opened = pages[pages.length - 1];
      }
      if (opened) {
        await opened.waitForLoadState("domcontentloaded").catch(() => {});
        const url = opened.url();
        await opened.close().catch(() => {});
        if (url && url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.pageTimeoutMs });
      }
      await settle();
      // Single-page apps change route after the click and render later; wait (up to 8s) for a form or a sign-in screen.
      for (let i = 0; i < 16; i++) {
        if (usable(await extractFields(page)) || (await detectAuthState(page)) !== "none") break;
        if (i > 4 && page.url() === before) break; // nothing happened at all
        await sleep(500);
      }
      const manual = await findApplyManual(page);
      if (manual) {
        run.think("Choosing Apply Manually", "action");
        await manual.click();
        await settle();
      }
      blocked = await auth();
      if (blocked) return { blocked };
      fields = await extractFields(page);
      await agreement();
    }
  }
  if (!usable(fields)) {
    const r = await navigate(page, `Open the application form for "${job.title}" at ${job.company}`, (t) => run.think(t));
    if (r === "done") {
      blocked = await auth();
      if (blocked) return { blocked };
      fields = await extractFields(page);
    }
  }
  if (!usable(fields)) {
    const wall = await botWall(page);
    if (wall)
      return {
        blocked: `${atsName(job.ats)} put a bot check (${wall}) in front of this form, and Ferry doesn't get around those. Your tailored résumé and answers are ready: open the posting and apply, or fill it from your own browser with the Ferry extension.`,
      };
    return { blocked: "Couldn't find the application form on the page" };
  }
  return { fields: applicationFields(fields) };
}

/** Stage 2: drive the ATS form in a real browser. */
async function execute(run: Run, opts: RunOptions) {
  const user = getUser(run.app.userId)!;
  const job = getJob(run.app.jobId)!;
  const resume = profileFor(user, job, run.app.resumeId)!;
  const ats = job.ats === "unknown" ? detectAts(job.applyUrl) : job.ats;
  const isSandbox = job.applyUrl.includes("/mock-ats/");
  const realDryRun = !isSandbox && !config.allowRealSubmit;
  const target = applyPageUrl(ats, job.url, job.applyUrl);
  const coverPdf = run.app.coverLetter ? await renderTextPdf("Cover letter", run.app.coverLetter, `cover_${run.app.id}`) : null;

  run.status("RUNNING", { attempts: run.app.attempts + 1, error: null, currentPage: 1, totalPages: null });
  publish(user.id, { type: "execution:started", applicationId: run.app.id, jobId: run.jobId });
  run.think(`Opening ${target}`, "action");

  const ctx = await newApplyContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(config.pageTimeoutMs);
  try {
    const opened = await openForm(run, page, target);
    if ("blocked" in opened) {
      await run.shot(page, "Blocked");
      run.think(opened.blocked, "error");
      run.status(opened.closed ? "SKIPPED" : "NEEDS_INPUT", { error: opened.blocked });
      return;
    }
    let fields = opened.fields;
    const answerCtx = () => ({
      profile: user.profile,
      doc: run.app.tailored ?? resume.doc,
      job,
      resumePdf: run.app.resumePdf,
      resumeDocx: run.app.resumeDocx,
      coverPdf,
      coverText: run.app.coverLetter,
      prior: run.app.fields,
      notes: [resume.notes, run.app.tailorInstructions].filter(Boolean).join("\n"),
      autoWrite: user.settings.autoWriteAnswers,
    });

    const fillPage = async (pageNo: number, pageFields: FrameField[]) => {
      const probed = await probeComboboxOptions(page, pageFields);
      if (probed) run.think(`Read the choices in ${probed} dropdown${probed === 1 ? "" : "s"}`);
      const answers = await answerFields(answerCtx(), pageFields);
      const filled: (FrameField & FilledField)[] = [];
      for (const a of answers) {
        const f = { ...(pageFields.find((x) => x.id === a.id) as FrameField), ...a, page: pageNo };
        if (f.kind === "file" && realDryRun && f.value) {
          // Uploading can send the résumé to the employer's parser before any submit; skip in dry runs.
          f.note = "Not uploaded (dry run)";
        } else {
          const res = await fillField(page, f);
          if (!res.ok) {
            f.note = `Could not fill: ${res.error}`;
            if (f.required) f.value = null;
          }
        }
        filled.push(f);
      }
      if (filled.some((f) => f.kind === "file" && f.value && !realDryRun)) await sleep(1200);
      const repaired = await verifyAndRepair(page, filled);
      if (repaired) run.think(`Restored ${repaired} field${repaired === 1 ? "" : "s"} the employer's résumé parser overwrote`, "action");
      return filled;
    };

    const allFilled: (FrameField & FilledField)[] = [];
    let pageNo = 1;
    for (; pageNo <= MAX_PAGES; pageNo++) {
      run.app = patchApplication(run.app.id, { currentPage: pageNo });
      run.think(`Page ${pageNo}: found ${fields.length} field${fields.length === 1 ? "" : "s"}`);
      const filled = await fillPage(pageNo, fields);
      allFilled.push(...filled);
      run.think(`Filled ${filled.filter((a) => a.value != null).length}/${filled.length} on page ${pageNo}`, "action");
      await run.shot(page, `Page ${pageNo} filled`);

      const submit = await findSubmit(page);
      const next = submit ? null : await findNext(page);
      if (!next) break;
      if (missingRequired(filled).length) break;
      const before = page.url();
      await next.click();
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await waitForContent(page);
      await sleep(700);
      const nextFields = (await extractFields(page)).filter((f) => !allFilled.some((a) => a.id === f.id));
      if (!nextFields.length) {
        const errs = await visibleErrors(page);
        if (errs.length) throw new Error(`Form rejected page ${pageNo}: ${errs.join("; ")}`);
        if (page.url() === before && (await navigate(page, "Advance to the next step of the application", (t) => run.think(t))) === "done") {
          const again = (await extractFields(page)).filter((f) => !allFilled.some((a) => a.id === f.id));
          if (again.length) {
            fields = again;
            continue;
          }
        }
        break;
      }
      fields = nextFields;
    }
    run.app = patchApplication(run.app.id, { fields: allFilled.map(stripFrame), totalPages: pageNo });

    const missing = missingRequired(allFilled);
    if (missing.length) {
      run.think(`Needs you: ${missing.map((m) => `"${m.label}"`).join(", ")}`, "error");
      run.status("NEEDS_INPUT", { error: `${missing.length} required question${missing.length === 1 ? "" : "s"} need your answer` });
      return;
    }

    const wantsSubmit = opts.submit || user.settings.autoSubmitApplication;
    if (!wantsSubmit) {
      run.think("Everything is filled in. Paused before the final submit so you can review it.");
      run.status("PENDING_SUBMIT_REVIEW");
      return;
    }

    if (await hasCaptcha(page)) {
      await run.shot(page, "Captcha challenge");
      run.think("The employer shows a captcha before submit. Open the job and submit it yourself; your answers are saved.", "error");
      run.status("NEEDS_INPUT", { error: "Captcha required" });
      return;
    }

    if (realDryRun) {
      run.think("Dry run: stopped right before clicking Submit (set ALLOW_REAL_SUBMIT=true to send real applications)", "action");
      const shot = await run.shot(page, "Ready to submit (dry run)");
      finish(run, { url: page.url(), text: "Dry run, not submitted", screenshot: shot, dryRun: true });
      return;
    }

    // Submit, with one recovery pass if the employer rejects fields.
    for (let attempt = 0; attempt < 2; attempt++) {
      const submitBtn = await findSubmit(page);
      if (!submitBtn) throw new Error("Couldn't find the submit button");
      run.think(attempt ? "Submitting again after fixing the flagged fields" : "Submitting the application", "action");
      const clickedAt = new Date();
      await submitBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      // Emailed security code before the submission counts (Greenhouse fraud check).
      const sc = await submitTimeCode(page, { user, job, think: (t, k) => run.think(t, k) }, clickedAt);
      if (typeof sc === "object") {
        run.status("NEEDS_INPUT", { error: sc.fail });
        return;
      }
      if (sc === "entered") {
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await sleep(1500);
      }
      const text = await pageText(page);
      const confirmed = CONFIRMATION_RE.test(text) || /confirm|thank|success/i.test(page.url());
      if (confirmed) {
        const shot = await run.shot(page, "Confirmation");
        finish(run, { url: page.url(), text: (text.match(CONFIRMATION_RE)?.[0] ?? "Submitted").slice(0, 200), screenshot: shot, dryRun: false });
        return;
      }
      await run.shot(page, "After submit");
      if (await hasCaptcha(page)) {
        run.status("NEEDS_INPUT", { error: "Captcha required after submit" });
        return;
      }
      const errs = await visibleErrors(page);
      if (attempt === 1) throw new Error(errs.length ? `Submit rejected: ${errs.join("; ")}` : "No confirmation after submit");
      run.think(`The employer flagged: ${errs.join("; ") || "unknown errors"}. Re-checking the form.`, "error");
      const recheck = await extractFields(page);
      const empty = [];
      for (const f of recheck) {
        const v = await page.locator(`[data-ferry-id="${f.id}"]`).first().inputValue({ timeout: 1500 }).catch(() => "x");
        if (f.required && !v && f.kind !== "file") empty.push(f);
      }
      if (!empty.length) throw new Error(errs.length ? `Submit rejected: ${errs.join("; ")}` : "No confirmation after submit");
      const fixed = await fillPage(pageNo, empty);
      allFilled.push(...fixed);
      run.app = patchApplication(run.app.id, { fields: allFilled.map(stripFrame) });
      if (missingRequired(fixed).length) {
        run.status("NEEDS_INPUT", { error: `The employer requires: ${missingRequired(fixed).map((m) => m.label).join(", ")}` });
        return;
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

function stripFrame(f: FrameField & FilledField): FilledField {
  const { frameIndex: _frameIndex, ...rest } = f;
  return rest;
}

function finish(run: Run, confirmation: NonNullable<Application["confirmation"]>) {
  const userId = run.app.userId;
  // Remember what the user typed so the next form is faster (but not job-specific prose like "Why Stripe?").
  const user = getUser(userId);
  const job = getJob(run.app.jobId);
  if (user && job) for (const f of run.app.fields) if (memorable({ profile: user.profile, job }, f)) rememberAnswer(userId, f.label, f.value as string);
  if (!confirmation.dryRun) chargeCredit(userId, run.app.id);
  run.status("COMPLETED", { confirmation, submittedAt: now(), currentPage: null });
  setTrackedStatus(run.app.id, "APPLIED", confirmation.dryRun ? "dry run" : undefined);
  publish(userId, { type: "execution:completed", applicationId: run.app.id, jobId: run.jobId, dryRun: Boolean(confirmation.dryRun) });
}

/** Run one application through the pipeline from wherever it currently is. */
export async function processApplication(appId: string, opts: RunOptions = {}) {
  const app = getApplication(appId);
  if (!app) return;
  if (["COMPLETED", "SKIPPED"].includes(app.status) && !opts.submit) return;
  const user = getUser(app.userId)!;
  if (user.credits <= 0 && !opts.approved) {
    patchApplication(appId, { status: "NEEDS_INPUT", error: "Out of application credits" });
    return;
  }
  const run = new Run(app);
  try {
    if (!(await prepare(run, opts))) return;
    run.status("READY");
    await execute(run, opts);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0].slice(0, 400);
    run.think(msg, "error");
    run.status("FAILED", { error: msg, currentPage: null });
    publish(run.app.userId, { type: "execution:failed", applicationId: run.app.id, jobId: run.jobId, error: msg });
  }
}
