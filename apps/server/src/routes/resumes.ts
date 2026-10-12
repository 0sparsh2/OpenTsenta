import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { paths } from "../config.ts";
import { uid } from "../db.ts";
import { enqueue } from "../apply/queue.ts";
import { BUILTINS, writeAnswers } from "../apply/library.ts";
import { buildDocx } from "../resume/docx.ts";
import { normalizeDoc, resolveLayout } from "../resume/model.ts";
import { fileToText, parseResume } from "../resume/parse.ts";
import { duplicateProfile, profileFor, suggestProfileName, suggestTargets } from "../resume/profiles.ts";
import { projectDocx } from "../resume/project.ts";
import { fitResume, fontFilePath, FONTS, previewResume, renderResume, TEMPLATES } from "../resume/render.ts";
import { jdKeywords, tailorResume } from "../resume/tailor.ts";
import { modifyResume } from "../resume/edit.ts";
import { rateLimited } from "../session.ts";
import {
  deleteResume,
  getApplication,
  getJob,
  getResume,
  listResumes,
  patchApplication,
  saveResume,
  setDefaultResume,
  updateProfile,
  type Application,
  type Resume,
  type User,
} from "../store.ts";
import type { Profile, ResumeDoc, ResumeLayout } from "../types.ts";
import { all } from "../db.ts";

// Résumé profiles, the block editor's preview, tailored résumés per application, and the answer library.

type Env = { Variables: { user: User } };
export const resumes = new Hono<Env>();

const bad = (c: Context, msg: string, code: 400 | 404 | 409 | 429 = 400) => c.json({ error: msg }, code);
export const MAX_REDOS = 3;

/** Public: font files the preview iframe links to (the PDF renderer embeds them instead). */
export const resumeFonts = new Hono();
resumeFonts.get("/:file", (c) => {
  const file = fontFilePath(c.req.param("file"));
  if (!file) return c.notFound();
  return new Response(fs.readFileSync(file), {
    headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" },
  });
});

const ownProfile = (c: Context<Env>, id = c.req.param("id")) => {
  const r = id ? getResume(id) : undefined;
  return r && r.userId === c.get("user").id ? r : undefined;
};
const ownApp = (c: Context<Env>) => {
  const a = getApplication(c.req.param("id") ?? "");
  return a && a.userId === c.get("user").id ? a : undefined;
};

export function profileView(r: Resume, counts?: Map<string, number>) {
  const doc = normalizeDoc(r.doc);
  return {
    id: r.id,
    name: r.name,
    isDefault: r.isDefault,
    fileName: r.fileName,
    hasDocx: Boolean(r.fileName?.toLowerCase().endsWith(".docx") && r.filePath && fs.existsSync(r.filePath)),
    origin: r.origin,
    targets: r.targets,
    notes: r.notes,
    createdAt: r.createdAt,
    doc,
    layout: resolveLayout(doc),
    applications: counts?.get(r.id) ?? 0,
  };
}

const sendFile = (buf: Buffer | Uint8Array, name: string, type: string, inline = false) =>
  new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w. -]+/g, "_")}"` } });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fileStem = (p: Profile["personal"], extra = "") => `${p.firstName || "Resume"}_${p.lastName}${extra ? `_${extra}` : ""}`.replace(/\s+/g, "_");

// ---------- catalog ----------

resumes.get("/resume/catalog", (c) =>
  c.json({
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, font: t.font, entry: t.entry })),
    fonts: Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label, generic: f.generic })),
    maxRedos: MAX_REDOS,
  }),
);

// ---------- profiles ----------

resumes.get("/resumes", (c) => {
  const u = c.get("user");
  const counts = new Map(all<{ resume_id: string; n: number }>("SELECT resume_id, COUNT(*) AS n FROM applications WHERE user_id = ? AND resume_id IS NOT NULL GROUP BY resume_id", u.id).map((r) => [r.resume_id, r.n]));
  return c.json(listResumes(u.id).map((r) => profileView(r, counts)));
});

/** Import a résumé file (or pasted text) as a new profile. The first import also fills empty contact fields. */
resumes.post("/resumes", async (c) => {
  const u = c.get("user");
  const body = await c.req.parseBody();
  const file = body.file;
  let text = typeof body.text === "string" ? body.text : "";
  let filePath: string | null = null;
  let fileName: string | null = null;
  if (file instanceof File && file.size) {
    if (file.size > 10 * 1024 * 1024) return bad(c, "File too large (10 MB max)");
    fileName = file.name;
    filePath = path.join(paths.uploads, `${uid("f")}_${file.name.replace(/[^\w.-]+/g, "_")}`);
    fs.writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
    text = await fileToText(filePath, fileName);
  }
  if (!text.trim()) return bad(c, "Upload a PDF, DOCX, or TXT résumé (or paste text)");
  const parsed = await parseResume(text);
  const doc = normalizeDoc(parsed.doc);
  const name = (typeof body.name === "string" && body.name.trim()) || suggestProfileName(doc);
  const resume = saveResume({ userId: u.id, name, filePath, fileName, text, doc, isDefault: false, targets: suggestTargets(doc, name), origin: "import" });

  const p = u.profile;
  const fill = <T,>(cur: T | undefined, v: T | undefined) => (cur ? cur : v);
  p.personal = {
    ...p.personal,
    firstName: fill(p.personal.firstName, parsed.contact.firstName) ?? "",
    lastName: fill(p.personal.lastName, parsed.contact.lastName) ?? "",
    phone: fill(p.personal.phone, parsed.contact.phone),
    city: fill(p.personal.city, parsed.contact.city),
    region: fill(p.personal.region, parsed.contact.region),
    country: fill(p.personal.country, parsed.contact.country),
    linkedin: fill(p.personal.linkedin, parsed.contact.linkedin),
    github: fill(p.personal.github, parsed.contact.github),
    website: fill(p.personal.website, parsed.contact.website),
  };
  if (!p.preferences.titles.length && doc.experience[0]?.title) p.preferences.titles = [doc.experience[0].title];
  updateProfile(u.id, p);
  return c.json({ resume: profileView(resume), profile: { ...resume, text: undefined }, method: parsed.method, contact: p });
});

resumes.post("/resumes/duplicate", async (c) => {
  const b = z.object({ sourceId: z.string(), name: z.string().min(1).max(80) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Pick a profile to copy and give the new one a name");
  const r = duplicateProfile(c.get("user"), b.data.sourceId, b.data.name.trim());
  return r ? c.json(profileView(r)) : bad(c, "Not found", 404);
});

const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  doc: z.any().optional(),
  layout: z.any().optional(),
  targets: z.object({ titles: z.array(z.string()), keywords: z.array(z.string()) }).optional(),
  notes: z.string().max(4000).optional(),
});

resumes.put("/resumes/:id", async (c) => {
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  const b = UpdateBody.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Invalid profile");
  const doc = normalizeDoc((b.data.doc as ResumeDoc | undefined) ?? r.doc);
  doc.layout = resolveLayout(doc, (b.data.layout as ResumeLayout | undefined) ?? doc.layout ?? r.doc.layout);
  const saved = saveResume({ ...r, name: b.data.name?.trim() ?? r.name, doc, targets: b.data.targets ?? r.targets, notes: b.data.notes ?? r.notes });
  return c.json(profileView(saved));
});

/** Format settings only (template, size, page limit, section order, hidden sections/links). */
resumes.put("/resumes/:id/layout", async (c) => {
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  const { layout } = (await c.req.json().catch(() => ({}))) as { layout?: ResumeLayout };
  const doc = { ...r.doc, layout: resolveLayout(r.doc, layout) };
  return c.json(profileView(saveResume({ ...r, doc })));
});

resumes.post("/resumes/:id/set-default", (c) => {
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  setDefaultResume(c.get("user").id, r.id);
  return c.json({ ok: true });
});

resumes.delete("/resumes/:id", (c) => {
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  if (r.isDefault) return bad(c, "Your default profile can't be deleted. Make another one the default first.", 409);
  deleteResume(c.get("user").id, r.id);
  return c.json({ ok: true });
});

resumes.get("/resumes/:id/pdf", async (c) => {
  const u = c.get("user");
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  const out = await renderResume(u.profile.personal, r.doc, `profile_${r.id}`);
  return sendFile(fs.readFileSync(out.file), `${fileStem(u.profile.personal, r.name)}.pdf`, "application/pdf", true);
});

resumes.get("/resumes/:id/docx", async (c) => {
  const u = c.get("user");
  const r = ownProfile(c);
  if (!r) return bad(c, "Not found", 404);
  const fit = await fitResume(u.profile.personal, r.doc);
  return sendFile(await buildDocx({ personal: u.profile.personal, doc: r.doc, fit }), `${fileStem(u.profile.personal, r.name)}.docx`, DOCX);
});

resumes.get("/resumes/:id/original", (c) => {
  const r = ownProfile(c);
  if (!r?.filePath || !fs.existsSync(r.filePath)) return bad(c, "No uploaded file for this profile", 404);
  const ext = path.extname(r.fileName ?? r.filePath).toLowerCase();
  return sendFile(fs.readFileSync(r.filePath), r.fileName ?? `resume${ext}`, ext === ".pdf" ? "application/pdf" : ext === ".docx" ? DOCX : "text/plain");
});

// ---------- live preview (block editor) ----------

resumes.post("/resume/preview", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => ({}))) as { doc?: ResumeDoc; layout?: ResumeLayout; applicationId?: string };
  if (!b.doc) return bad(c, "doc is required");
  const doc = normalizeDoc(b.doc);
  let keywords: string[] | undefined;
  if (b.applicationId) {
    const a = getApplication(b.applicationId);
    const job = a && a.userId === u.id ? getJob(a.jobId) : undefined;
    if (job) keywords = jdKeywords(job);
  }
  const out = await previewResume(u.profile.personal, doc, b.layout ?? doc.layout, { keywords });
  return c.json({ html: out.html, layout: out.layout, fit: { pages: out.fit.pages, limit: out.fit.limit, step: out.fit.step, cut: out.fit.cut, overflow: out.fit.overflow, fontSize: out.fit.vars.fontSize } });
});

// ---------- prompt to modify ----------

/**
 * "Make it one page", "drop the internship", "lead with my Kubernetes work": returns the edited résumé without
 * saving it, so the editor can show it with an undo. Pass applicationId to use that job's posting as context.
 */
resumes.post("/resume/modify", async (c) => {
  const u = c.get("user");
  if (rateLimited(`modify:${u.id}`, 40, 60 * 60_000)) return bad(c, "That's a lot of edits in an hour. Try again shortly, or edit the blocks directly.", 429);
  const b = (await c.req.json().catch(() => ({}))) as { doc?: ResumeDoc; prompt?: string; applicationId?: string };
  const prompt = (b.prompt ?? "").trim().slice(0, 1000);
  if (!b.doc || !prompt) return bad(c, "Say what to change");
  let job = null;
  if (b.applicationId) {
    const a = getApplication(b.applicationId);
    job = a && a.userId === u.id ? (getJob(a.jobId) ?? null) : null;
  }
  return c.json(await modifyResume(b.doc, prompt, job));
});

// ---------- tailored résumé per application ----------

function tailoredView(u: User, a: Application) {
  const job = getJob(a.jobId);
  const profile = job ? profileFor(u, job, a.resumeId) : undefined;
  return {
    applicationId: a.id,
    status: a.status,
    profile: profile ? { id: profile.id, name: profile.name, hasDocx: profileView(profile).hasDocx } : null,
    base: profile ? normalizeDoc(profile.doc) : null,
    tailored: a.tailored ? normalizeDoc(a.tailored) : null,
    changes: a.changes,
    atsScore: a.atsScore,
    keywords: job ? jdKeywords(job) : [],
    redos: { used: a.redos, remaining: Math.max(0, MAX_REDOS - a.redos), max: MAX_REDOS },
    instructions: a.tailorInstructions,
    profiles: listResumes(u.id).map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault })),
    editable: !["RUNNING", "COMPLETED"].includes(a.status),
  };
}

resumes.get("/applications/:id/resume", (c) => {
  const a = ownApp(c);
  return a ? c.json(tailoredView(c.get("user"), a)) : bad(c, "Not found", 404);
});

/** Save edits to this application's résumé (blocks and/or layout). */
resumes.put("/applications/:id/resume", async (c) => {
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const b = (await c.req.json().catch(() => ({}))) as { tailored?: ResumeDoc; layout?: ResumeLayout };
  const doc = normalizeDoc(b.tailored ?? a.tailored ?? undefined);
  doc.layout = resolveLayout(doc, b.layout ?? doc.layout);
  const next = patchApplication(a.id, { tailored: doc, resumePdf: null, resumeDocx: null });
  return c.json(tailoredView(c.get("user"), next));
});

/** "Redo with instructions": re-tailor from the profile. Optionally keep the instructions for future roles. */
resumes.post("/applications/:id/resume/redo", async (c) => {
  const u = c.get("user");
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const b = z.object({ instructions: z.string().max(2000).default(""), applyToFuture: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Invalid request");
  if (a.redos >= MAX_REDOS) return bad(c, `You've used all ${MAX_REDOS} redos for this application. Edit the blocks directly instead.`, 429);
  if (["RUNNING", "COMPLETED"].includes(a.status)) return bad(c, "This application has already been sent", 409);
  const job = getJob(a.jobId);
  const profile = job ? profileFor(u, job, a.resumeId) : undefined;
  if (!job || !profile) return bad(c, "Not found", 404);
  const instructions = b.data.instructions.trim();
  const mode = u.settings.optimizationMode === "off" ? "honest" : u.settings.optimizationMode;
  const t = await tailorResume(profile.doc, job, mode, { notes: profile.notes, instructions });
  if (instructions && b.data.applyToFuture) saveResume({ ...profile, notes: [profile.notes, instructions].filter(Boolean).join("\n") });
  const next = patchApplication(a.id, { tailored: t.tailored, changes: t.changes, atsScore: t.atsScore, resumePdf: null, resumeDocx: null, redos: a.redos + 1, tailorInstructions: instructions || null, resumeId: profile.id });
  return c.json(tailoredView(u, next));
});

/** Apply with a different profile: re-tailors from it. */
resumes.post("/applications/:id/profile", async (c) => {
  const u = c.get("user");
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const { profileId } = (await c.req.json().catch(() => ({}))) as { profileId?: string };
  const profile = profileId ? getResume(profileId) : undefined;
  if (!profile || profile.userId !== u.id) return bad(c, "Not found", 404);
  if (["RUNNING", "COMPLETED"].includes(a.status)) return bad(c, "This application has already been sent", 409);
  patchApplication(a.id, { resumeId: profile.id, tailored: null, changes: [], atsScore: null, resumePdf: null, resumeDocx: null, status: "QUEUED", error: null, tailorInstructions: null });
  enqueue(a.id);
  return c.json(tailoredView(u, getApplication(a.id)!));
});

async function appResumeFile(u: User, a: Application) {
  const job = getJob(a.jobId)!;
  const profile = profileFor(u, job, a.resumeId);
  const doc = a.tailored ?? profile?.doc;
  if (!doc) return null;
  return { job, profile, doc };
}

resumes.get("/applications/:id/resume.pdf", async (c) => {
  const u = c.get("user");
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  let file = a.resumePdf && a.resumePdf.endsWith(".pdf") && fs.existsSync(a.resumePdf) ? a.resumePdf : null;
  if (!file) {
    const src = await appResumeFile(u, a);
    if (!src) return bad(c, "No résumé", 404);
    file = (await renderResume(u.profile.personal, src.doc, `preview_${a.id}`, { keywords: jdKeywords(src.job) })).file;
  }
  return sendFile(fs.readFileSync(file), `${fileStem(u.profile.personal, getJob(a.jobId)?.company)}.pdf`, "application/pdf", true);
});

/** Word version: Ferry's template, or (?original=1) the tailored text in your own uploaded design. */
resumes.get("/applications/:id/resume.docx", async (c) => {
  const u = c.get("user");
  const a = ownApp(c);
  if (!a) return bad(c, "Not found", 404);
  const src = await appResumeFile(u, a);
  if (!src) return bad(c, "No résumé", 404);
  const name = `${fileStem(u.profile.personal, src.job.company)}.docx`;
  if (c.req.query("original") === "1") {
    if (!src.profile?.filePath?.toLowerCase().endsWith(".docx") || !fs.existsSync(src.profile.filePath)) return bad(c, "This profile wasn't imported from a Word file", 404);
    const p = await projectDocx(src.profile.filePath, src.profile.doc, src.doc);
    return sendFile(p.buffer, name, DOCX);
  }
  const fit = await fitResume(u.profile.personal, src.doc, undefined, { keywords: jdKeywords(src.job) });
  return sendFile(await buildDocx({ personal: u.profile.personal, doc: src.doc, fit }), name, DOCX);
});

// ---------- answer library ----------

resumes.get("/answers/builtins", (c) => c.json(BUILTINS.map((b) => ({ id: b.id, question: b.question, mode: b.mode, hint: b.hint }))));

/** Try an answer: draft it for one of your matched jobs (or a given job) without applying. */
resumes.post("/answers/draft", async (c) => {
  const u = c.get("user");
  const b = z
    .object({ question: z.string().min(3).max(500), notes: z.string().max(2000).default(""), builtin: z.string().optional(), jobId: z.string().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Give a question to draft");
  const jobId =
    b.data.jobId ??
    all<{ job_id: string }>("SELECT m.job_id FROM matches m JOIN jobs j ON j.id = m.job_id WHERE m.user_id = ? AND j.closed_at IS NULL ORDER BY m.score DESC LIMIT 1", u.id)[0]?.job_id;
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) return bad(c, "No matched jobs yet to draft against", 404);
  const profile = profileFor(u, job);
  if (!profile) return bad(c, "Import a résumé first", 409);
  const question = b.data.question.replace(/\{company\}/gi, job.company).replace(/\{(role|title)\}/gi, job.title);
  const [w] = await writeAnswers({ profile: u.profile, doc: profile.doc, job, notes: profile.notes }, [
    { field: { id: "q", label: question, kind: "textarea", required: true }, entry: { id: "draft", question: b.data.question, mode: "write", answer: b.data.notes, builtin: b.data.builtin } },
  ]);
  return c.json({ job: { id: job.id, title: job.title, company: job.company }, profile: { id: profile.id, name: profile.name }, question, answer: w?.value ?? "", method: w?.method ?? "template" });
});
