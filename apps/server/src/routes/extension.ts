import fs from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import { answerFields } from "../apply/answer.ts";
import { ensureDescription } from "../ingest/describe.ts";
import { resolveJob } from "../ingest/jd.ts";
import { profileFor } from "../resume/profiles.ts";
import { renderResume } from "../resume/render.ts";
import { jdKeywords, tailorResume } from "../resume/tailor.ts";
import { createApplication, getApplication, getJob, patchApplication, setTrackedStatus, type User } from "../store.ts";
import type { FormField } from "../types.ts";

// "Fill this form" from the Ferry Chrome extension: for sites that block automated browsers (SmartRecruiters'
// DataDome, LinkedIn Easy Apply, captcha-gated sign-ins). The extension reads the form in the user's own tab,
// Ferry answers it here with the same engine, and the extension fills it in. The user submits it themselves.

type Env = { Variables: { user: User } };
export const extension = new Hono<Env>();

const Field = z.object({
  id: z.string().max(80),
  label: z.string().max(600),
  kind: z.enum(["text", "email", "tel", "url", "number", "date", "textarea", "select", "combobox", "radio", "checkbox", "file", "listbox"]),
  required: z.boolean(),
  options: z.array(z.string().max(300)).max(400).optional(),
  maxLength: z.number().int().positive().optional(),
  accept: z.string().max(200).optional(),
});
const FillBody = z.object({
  /** The posting this form belongs to (remembered from the posting page), else the form page itself. */
  jobUrl: z.string().url().optional(),
  url: z.string().url(),
  title: z.string().max(300).optional(),
  company: z.string().max(200).optional(),
  fields: z.array(Field).min(1).max(250),
});

extension.post("/extension/fill", async (c) => {
  const u = c.get("user");
  const b = FillBody.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Couldn't read that form" }, 400);
  const job = await ensureDescription(await resolveJob({ url: b.data.jobUrl ?? b.data.url, title: b.data.title, company: b.data.company, onPage: true }));
  const profile = profileFor(u, job);
  if (!profile) return c.json({ error: "Import a résumé in Ferry first" }, 409);
  const { app: created } = createApplication(u.id, job.id, "extension", profile.id);
  let app = getApplication(created.id)!;

  // A tailored résumé for this job (once), rendered to the PDF the extension attaches.
  if (!app.tailored) {
    const t = await tailorResume(profile.doc, job, u.settings.optimizationMode, { notes: profile.notes });
    app = patchApplication(app.id, { tailored: t.tailored, changes: t.changes, atsScore: t.atsScore, resumeId: profile.id });
  }
  if (!app.resumePdf || !fs.existsSync(app.resumePdf)) {
    const out = await renderResume(u.profile.personal, app.tailored ?? profile.doc, `${u.profile.personal.firstName}_${u.profile.personal.lastName}_${job.company}_${app.id.slice(-5)}`, { keywords: jdKeywords(job) });
    app = patchApplication(app.id, { resumePdf: out.file });
  }

  const fields = b.data.fields as FormField[];
  const answered = await answerFields(
    {
      profile: u.profile,
      doc: app.tailored ?? profile.doc,
      job,
      resumePdf: app.resumePdf,
      coverPdf: null,
      coverText: app.coverLetter,
      prior: app.fields,
      notes: profile.notes,
      autoWrite: u.settings.autoWriteAnswers,
    },
    fields,
  );
  // File inputs: the extension downloads the tailored résumé itself; never send server paths to a page.
  const answers = answered.map((f) => (f.kind === "file" ? { ...f, value: /resume|cv\b|curriculum/i.test(f.label) ? "resume" : null } : f));
  // Multi-step forms (Easy Apply) arrive one step at a time: keep the earlier steps' answers on the application.
  const key = (f: { kind: string; label: string }) => `${f.kind}:${f.label.toLowerCase()}`;
  const now = new Set(answered.map(key));
  app = patchApplication(app.id, {
    fields: [...(app.fields ?? []).filter((f) => !now.has(key(f))), ...answered],
    status: "NEEDS_INPUT",
    error: "Filled in your browser by the Ferry extension. Review it there and submit, then mark it done here.",
    lastThought: `Filled ${answers.filter((a) => a.value != null && a.value !== "").length} of ${answers.length} fields in your browser`,
  });
  return c.json({
    applicationId: app.id,
    job: { id: job.id, title: job.title, company: job.company },
    answers: answers.map((a) => ({ id: a.id, value: a.value, source: a.source, note: a.note })),
    resumeUrl: `/api/v1/applications/${app.id}/resume.pdf`,
  });
});

/** The extension's "I submitted it" button. */
extension.post("/extension/submitted", async (c) => {
  const { applicationId } = (await c.req.json().catch(() => ({}))) as { applicationId?: string };
  const a = applicationId ? getApplication(applicationId) : undefined;
  if (!a || a.userId !== c.get("user").id) return c.json({ error: "Not found" }, 404);
  const job = getJob(a.jobId);
  patchApplication(a.id, { status: "COMPLETED", submittedAt: new Date().toISOString(), error: null, confirmation: { text: "Submitted by you in your browser (filled by the Ferry extension)." } });
  setTrackedStatus(a.id, "APPLIED", "submitted from the extension");
  return c.json({ ok: true, job: job ? { title: job.title, company: job.company } : null });
});
