import { Hono } from "hono";
import { z } from "zod";
import { all, now, one, parse, run, uid } from "../db.ts";
import { enqueue } from "../apply/queue.ts";
import { missingRequired } from "../apply/answer.ts";
import { resolveJob } from "../ingest/jd.ts";
import { pickProfile } from "../resume/profiles.ts";
import { createApplication, getApplication, getDefaultResume, getJob, getUser, listResumes, patchApplication, rememberAnswer, type User } from "../store.ts";
import { STATUS_BUCKETS, type PipelineStatus } from "../types.ts";

// Endpoints for agents (the MCP server, the CLI): apply to a list of jobs as one batch, follow it, approve what's
// ready, and answer the questions Ferry couldn't. Same rules as the dashboard: credits, review before submit, and
// real submission only with ALLOW_REAL_SUBMIT.

type Env = { Variables: { user: User } };
export const agent = new Hono<Env>();
const bad = (c: { json: (b: unknown, s: number) => Response }, msg: string, code = 400) => c.json({ error: msg }, code);

interface BatchItem {
  input: string;
  status: "queued" | "already_applied" | "closed" | "not_a_job" | "no_credits" | "error";
  reason?: string;
  application_id?: string;
  job?: { id: string; title: string; company: string };
}

/** Posting links in pasted text (an email, a spreadsheet, a list), in order, without duplicates. */
export function linksIn(text: string): string[] {
  const urls = (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
  return [...new Set(urls)];
}

/** Which résumé profile: by id or name (case-insensitive), else the best fit for the job. */
function profileFor(u: User, jobId: string, profile?: string): string | null {
  if (profile) {
    const p = listResumes(u.id).find((r) => r.id === profile || r.name.toLowerCase() === profile.toLowerCase());
    if (p) return p.id;
  }
  const job = getJob(jobId);
  return job ? (pickProfile(u, job)?.profile.id ?? null) : null;
}

/** Queue one application (the same path as Apply in the dashboard). */
async function queueOne(u: User, input: string, opts: { profile?: string; notes?: string; previewResume?: boolean; batchId: string }): Promise<BatchItem> {
  let jobId: string | undefined;
  try {
    if (/^job_[\w-]+$/.test(input)) jobId = getJob(input)?.id;
    else jobId = (await resolveJob({ url: input })).id;
  } catch (e) {
    return { input, status: "not_a_job", reason: `Couldn't read a job posting there (${(e as Error).message.slice(0, 120)})` };
  }
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) return { input, status: "not_a_job", reason: "Not a job Ferry knows, and not a posting link" };
  const brief = { id: job.id, title: job.title, company: job.company };
  if (one<{ c: string | null }>("SELECT closed_at AS c FROM jobs WHERE id = ?", job.id)?.c) return { input, status: "closed", reason: "The posting has been taken down", job: brief };
  const existing = one<{ id: string; status: string }>("SELECT id, status FROM applications WHERE user_id = ? AND job_id = ?", u.id, job.id);
  if (existing) return { input, status: "already_applied", reason: `Already in Ferry (${existing.status.toLowerCase()})`, application_id: existing.id, job: brief };
  const { app } = createApplication(u.id, job.id, "mcp", profileFor(u, job.id, opts.profile));
  patchApplication(app.id, {
    ...(typeof opts.previewResume === "boolean" ? { reviewResume: opts.previewResume } : {}),
    ...(opts.notes ? { tailorInstructions: opts.notes } : {}),
  });
  run("UPDATE applications SET batch_id = ? WHERE id = ?", opts.batchId, app.id);
  enqueue(app.id);
  return { input, status: "queued", application_id: app.id, job: brief };
}

const BatchBody = z.object({
  items: z.array(z.string().min(1).max(2000)).max(200).optional(),
  text: z.string().max(200_000).optional(),
  profile: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  previewResume: z.boolean().optional(),
});

/** Apply to a list: posting links, Ferry job ids, or text to pull links out of. */
agent.post("/batches", async (c) => {
  const u = c.get("user");
  const b = BatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Send items (links or job ids) or text with links in it");
  if (!getDefaultResume(u.id)) return bad(c, "Import a résumé first", 409);
  const inputs = [...new Set([...(b.data.items ?? []).map((s) => s.trim()), ...linksIn(b.data.text ?? "")])].filter(Boolean).slice(0, 200);
  if (!inputs.length) return bad(c, "No links or job ids found");
  const id = uid("bat");
  run("INSERT INTO batches(id, user_id, items) VALUES(?, ?, '[]')", id, u.id);
  const items: BatchItem[] = new Array(inputs.length);
  let credits = getUser(u.id)!.credits - (one<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status NOT IN ('COMPLETED','FAILED','SKIPPED')", u.id)?.n ?? 0);
  // A few at a time: reading postings takes a moment each.
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let i = next++; i < inputs.length; i = next++) {
        if (credits <= 0) {
          items[i] = { input: inputs[i], status: "no_credits", reason: "Out of application credits" };
          continue;
        }
        items[i] = await queueOne(u, inputs[i], { profile: b.data.profile, notes: b.data.notes, previewResume: b.data.previewResume, batchId: id }).catch((e) => ({
          input: inputs[i],
          status: "error" as const,
          reason: (e as Error).message.slice(0, 200),
        }));
        if (items[i].status === "queued") credits--;
      }
    }),
  );
  run("UPDATE batches SET items = ? WHERE id = ?", JSON.stringify(items), id);
  return c.json(batchView(u, id));
});

const BUCKET: Record<string, string> = {};
for (const [bucket, statuses] of Object.entries(STATUS_BUCKETS)) for (const s of statuses) BUCKET[s] = bucket;
const bucketOf = (s: PipelineStatus) => (s === "NEEDS_INPUT" ? "needs_you" : s === "COMPLETED" ? "done" : s.startsWith("PENDING_") ? "waiting_for_review" : BUCKET[s] === "in_flight" ? "working" : BUCKET[s] ?? "working");

function batchView(u: User, id: string) {
  const b = one<{ id: string; created_at: string; items: string }>("SELECT id, created_at, items FROM batches WHERE id = ? AND user_id = ?", id, u.id);
  if (!b) return null;
  const items = parse<BatchItem[]>(b.items, []).map((it) => {
    if (!it.application_id) return { ...it, progress: it.status };
    const a = getApplication(it.application_id);
    if (!a) return { ...it, progress: "gone" };
    const progress = bucketOf(a.status);
    return { ...it, progress, application_status: a.status, ...(a.error && progress !== "done" ? { detail: a.error } : {}) };
  });
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.progress] = (counts[it.progress] ?? 0) + 1;
  return { batch_id: b.id, created_at: b.created_at, counts, items };
}

agent.get("/batches", (c) => {
  const u = c.get("user");
  return c.json(all<{ id: string }>("SELECT id FROM batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", u.id).map((b) => batchView(u, b.id)));
});
agent.get("/batches/:id", (c) => {
  const v = batchView(c.get("user"), c.req.param("id"));
  return v ? c.json(v) : bad(c, "Not found", 404);
});

/** Approve everything in a batch that's waiting at a review gate (call only after the user said yes). */
agent.post("/batches/:id/approve", (c) => {
  const u = c.get("user");
  const v = batchView(u, c.req.param("id"));
  if (!v) return bad(c, "Not found", 404);
  const approved: string[] = [];
  for (const it of v.items) {
    const a = it.application_id ? getApplication(it.application_id) : undefined;
    if (!a || !a.status.startsWith("PENDING_")) continue;
    const finalGate = a.status === "PENDING_SUBMIT_REVIEW" || a.status === "PENDING_REVIEW";
    patchApplication(a.id, { status: "QUEUED", error: null });
    enqueue(a.id, finalGate ? { approved: true, submit: true } : { approved: true });
    approved.push(a.id);
  }
  return c.json({ approved, batch: batchView(u, v.batch_id) });
});

/** What Ferry needs from the user: unanswered required questions, and hand-backs it can't do itself. */
agent.get("/questions", (c) => {
  const u = c.get("user");
  const batch = c.req.query("batch");
  const rows = all<{ id: string }>(
    `SELECT id FROM applications WHERE user_id = ? AND status = 'NEEDS_INPUT' ${batch ? "AND batch_id = ?" : ""} ORDER BY updated_at DESC LIMIT 100`,
    u.id,
    ...(batch ? [batch] : []),
  );
  const questions: unknown[] = [];
  const handBacks: unknown[] = [];
  for (const { id } of rows) {
    const a = getApplication(id)!;
    const job = getJob(a.jobId);
    const brief = { application_id: a.id, job: job ? { title: job.title, company: job.company, url: job.url } : null };
    const missing = missingRequired(a.fields);
    for (const f of missing) questions.push({ ...brief, field_id: f.id, question: f.label, kind: f.kind, options: f.options, why: f.note ?? "Not in your profile or résumé" });
    if (!missing.length)
      handBacks.push({
        ...brief,
        reason: a.error,
        what_to_do: "Open the posting and finish it yourself (or fill it from your own browser with the Ferry extension), then mark it done in Ferry.",
      });
  }
  return c.json({ questions, hand_backs: handBacks });
});

/** Answer questions on one application and let it continue. It still stops for review before submitting. */
agent.post("/applications/:id/answer", async (c) => {
  const u = c.get("user");
  const a = getApplication(c.req.param("id"));
  if (!a || a.userId !== u.id) return bad(c, "Not found", 404);
  const b = z
    .object({ answers: z.array(z.object({ field_id: z.string(), value: z.union([z.string(), z.array(z.string())]) })).min(1).max(100), remember: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, "Send answers: [{ field_id, value }]");
  const unknown = b.data.answers.filter((x) => !a.fields.some((f) => f.id === x.field_id)).map((x) => x.field_id);
  if (unknown.length) return bad(c, `No such field on this application: ${unknown.join(", ")}`);
  const fields = a.fields.map((f) => {
    const ans = b.data.answers.find((x) => x.field_id === f.id);
    return ans ? { ...f, value: ans.value, source: "user" as const, confidence: 1, note: undefined } : f;
  });
  if (b.data.remember) for (const x of b.data.answers) if (typeof x.value === "string") rememberAnswer(u.id, a.fields.find((f) => f.id === x.field_id)!.label, x.value);
  const left = missingRequired(fields);
  patchApplication(a.id, { fields, error: left.length ? `${left.length} required question${left.length === 1 ? "" : "s"} still need your answer` : null, ...(left.length ? {} : { status: "QUEUED" }) });
  if (!left.length) enqueue(a.id);
  return c.json({ application_id: a.id, still_needed: left.map((f) => ({ field_id: f.id, question: f.label })), status: getApplication(a.id)!.status });
});

/** Long poll: wait (up to 50 s) until any of the user's applications (or a batch's) changes status. */
agent.get("/updates", async (c) => {
  const u = c.get("user");
  const batch = c.req.query("batch");
  const timeout = Math.min(50, Math.max(1, Number(c.req.query("timeout") ?? 25))) * 1000;
  const snap = () =>
    new Map(
      all<{ id: string; status: string }>(`SELECT id, status FROM applications WHERE user_id = ? ${batch ? "AND batch_id = ?" : "AND updated_at >= datetime('now', '-1 day')"}`, u.id, ...(batch ? [batch] : [])).map((r) => [r.id, r.status]),
    );
  const before = snap();
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 1000));
    const after = snap();
    const changed = [...after].filter(([id, s]) => before.get(id) !== s);
    if (changed.length)
      return c.json({
        changed: changed.map(([id, s]) => {
          const a = getApplication(id)!;
          const job = getJob(a.jobId);
          return { application_id: id, from: before.get(id) ?? null, to: s, progress: bucketOf(s as PipelineStatus), job: job ? { title: job.title, company: job.company } : null, detail: a.error ?? a.lastThought ?? null };
        }),
        at: now(),
      });
  }
  return c.json({ changed: [], at: now() });
});
