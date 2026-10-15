import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { api } from "./api.ts";
import { config } from "./config.ts";
import { userForToken } from "./session.ts";
import { oauthUser, resourceMetadataUrl } from "./oauth.ts";

// MCP server at /api/v1/mcp (Streamable HTTP, stateless) — the same path the reference uses.
// Tools call the REST API in-process with the caller's token, so behavior matches the dashboard.
//   claude mcp add --transport http ferry http://localhost:8787/api/v1/mcp --header "Authorization: Bearer <token>"

export type McpScope = "jobs:read" | "jobs:apply";

function buildServer(token: string, scopes: Set<McpScope> = new Set(["jobs:read", "jobs:apply"])) {
  const server = new McpServer({ name: `${config.brand.toLowerCase()}-jobs`, version: "0.2.0" });
  // Tools that change anything (queue, approve, answer, edit the profile) need the jobs:apply scope.
  const writes: { remove: () => void }[] = [];
  const write = <T extends { remove: () => void }>(t: T) => (writes.push(t), t);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(`${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data;
  };
  const out = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const callForm = async (path: string, form: FormData) => {
    const res = await api.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data;
  };

  server.registerTool(
    "get_job_matches",
    {
      title: "Get job matches",
      description: "New job postings that fit the user's résumé and preferences, best first, with a 0-100 fit score and reasons.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), min_score: z.number().int().min(0).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, min_score }) => {
      const d = (await call("GET", `/jobs/recommendations?limit=${limit ?? 10}&minScore=${min_score ?? 0}`)) as { items: { id: string; title: string; company: string; location: string; salary?: string; url: string; match: { score: number; reasons: string[]; gaps: string[] } }[]; total: number };
      return out({ total: d.total, matches: d.items.map((j) => ({ job_id: j.id, title: j.title, company: j.company, location: j.location, salary: j.salary, url: j.url, score: j.match?.score, reasons: j.match?.reasons, gaps: j.match?.gaps })) });
    },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs",
      description: "Search all open postings being watched by title, company, or location.",
      inputSchema: { query: z.string(), remote_only: z.boolean().optional(), posted_within_days: z.number().int().optional(), limit: z.number().int().max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, remote_only, posted_within_days, limit }) => {
      const p = new URLSearchParams({ q: query, limit: String(limit ?? 15), sort: "match" });
      if (remote_only) p.set("workplace", "remote");
      if (posted_within_days) p.set("posted", String(posted_within_days));
      const d = (await call("GET", `/jobs/search?${p}`)) as { items: { id: string; title: string; company: string; location: string; url: string; match: { score: number } | null }[]; total: number };
      return out({ total: d.total, jobs: d.items.map((j) => ({ job_id: j.id, title: j.title, company: j.company, location: j.location, url: j.url, score: j.match?.score ?? null })) });
    },
  );

  write(server.registerTool(
    "add_job_by_url",
    {
      title: "Add a job by URL",
      description: "Import any job posting URL (Greenhouse, Lever, Ashby, Workday, company sites...) and score it against the user's résumé.",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => out(await call("POST", "/jobs/fetch", { url })),
  ));

  write(server.registerTool(
    "apply_to_job",
    {
      title: "Apply to a job",
      description:
        "Queue an application. The agent tailors the résumé and cover letter, fills the employer's form in a browser, and pauses for the user's review before the final submit unless auto-submit is enabled. Pass job_id from get_job_matches/search_jobs, or a posting url. For several jobs use apply_to_jobs.",
      inputSchema: {
        job_id: z.string().optional(),
        url: z.string().url().optional(),
        profile: z.string().optional().describe("Résumé profile to use (name or id from list_profiles); default: the best fit for the job"),
        notes: z.string().max(4000).optional().describe("Notes for tailoring and written answers, e.g. 'lead with the payments work'"),
        preview_resume: z.boolean().optional().describe("Pause after tailoring so the user can review the résumé"),
      },
    },
    async ({ job_id, url, profile, notes, preview_resume }) => {
      if (!job_id && !url) throw new Error("Provide job_id or url");
      const resumeId = profile ? ((await call("GET", "/resumes")) as { id: string; name: string }[]).find((r) => r.id === profile || r.name.toLowerCase() === profile.toLowerCase())?.id : undefined;
      if (profile && !resumeId) throw new Error(`No résumé profile called "${profile}" (see list_profiles)`);
      const a = (await call("POST", "/applications", { jobId: job_id, url, source: "mcp", resumeId, notes, previewResume: preview_resume })) as { id: string; status: string; job: { title: string; company: string } };
      return out({ application_id: a.id, status: a.status, job: a.job, next: "Use get_application or wait_for_updates to follow progress; approve_application once it reaches PENDING_SUBMIT_REVIEW and the user agrees." });
    },
  ));

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "The user's applications. tab: all | submitted | in_flight | needs | failed | skipped.",
      inputSchema: { tab: z.enum(["all", "submitted", "in_flight", "needs", "failed", "skipped"]).optional(), limit: z.number().int().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ tab, limit }) => out(await call("GET", `/applications?tab=${tab ?? "all"}&limit=${limit ?? 25}`)),
  );

  server.registerTool(
    "get_application",
    {
      title: "Get application",
      description: "Full detail of one application: status, résumé changes, ATS score, every form field and answer, and the agent's trace.",
      inputSchema: { application_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ application_id }) => {
      const a = (await call("GET", `/applications/${application_id}`)) as Record<string, unknown> & { trace: unknown[] };
      return out({ ...a, trace: a.trace.slice(-15) });
    },
  );

  write(server.registerTool(
    "approve_application",
    {
      title: "Approve application",
      description:
        "Approve an application paused for review (résumé, cover letter, or final submit). Optionally answer fields that need the user's input: [{id, value}] using field ids from get_application. Only call this after the user has confirmed.",
      inputSchema: { application_id: z.string(), fields: z.array(z.object({ id: z.string(), value: z.string() })).optional() },
      annotations: { destructiveHint: true },
    },
    async ({ application_id, fields }) => out(await call("POST", `/applications/${application_id}/approve`, { fields })),
  ));

  server.registerTool(
    "inbox",
    {
      title: "Recruiter inbox",
      description: "Recent job-related emails (confirmations, interview requests, rejections, offers) routed to applications.",
      inputSchema: { limit: z.number().int().max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const msgs = (await call("GET", "/inbox/messages")) as { id: string; subject: string; fromAddr: string; category: string; company: string; receivedAt: string; snippet: string }[];
      return out(msgs.slice(0, limit ?? 15).map(({ id, subject, fromAddr, category, company, receivedAt, snippet }) => ({ id, subject, from: fromAddr, category, company, receivedAt, snippet })));
    },
  );

  server.registerTool(
    "get_profile",
    { title: "Get profile", description: "The user's job-search profile and preferences.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => out(await call("GET", "/profile")),
  );

  // ---------- batches: apply to a list of jobs (#28) ----------

  write(server.registerTool(
    "apply_to_jobs",
    {
      title: "Apply to a list of jobs",
      description:
        "Queue applications for many jobs at once: posting links, job ids, and/or pasted text (an email, a spreadsheet, a job-board page) to pull links from. Returns a batch with a status per job: queued, already_applied, closed, not_a_job, or no_credits. Each application pauses for review before submitting unless auto-submit is on. Follow with get_batch or wait_for_updates.",
      inputSchema: {
        items: z.array(z.string()).max(200).optional().describe("Posting URLs or Ferry job ids"),
        text: z.string().max(200000).optional().describe("Free text containing posting links"),
        profile: z.string().optional().describe("Résumé profile for all of them (name or id); default: best fit per job"),
        notes: z.string().max(4000).optional().describe("Notes for tailoring and written answers"),
        preview_resume: z.boolean().optional(),
      },
    },
    async ({ items, text, profile, notes, preview_resume }) => out(await call("POST", "/batches", { items, text, profile, notes, previewResume: preview_resume })),
  ));

  server.registerTool(
    "get_batch",
    {
      title: "Get batch progress",
      description: "Progress of a batch from apply_to_jobs: counts (working, waiting_for_review, needs_you, done, failed, skipped) and every job with its status and any reason. Omit batch_id to list recent batches.",
      inputSchema: { batch_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ batch_id }) => out(await call("GET", batch_id ? `/batches/${batch_id}` : "/batches")),
  );

  write(server.registerTool(
    "approve_batch",
    {
      title: "Approve a batch",
      description: "Approve every application in a batch that's waiting at a review gate (résumé, cover letter, or final submit). Only call this after the user has confirmed.",
      inputSchema: { batch_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ batch_id }) => out(await call("POST", `/batches/${batch_id}/approve`)),
  ));

  // ---------- questions back to the chat (#30) ----------

  server.registerTool(
    "pending_questions",
    {
      title: "Questions Ferry needs answered",
      description:
        "Required questions Ferry couldn't answer from the profile (judgment questions, essays, clearance…), with options and why, plus hand-backs it can't do itself (captchas, bot checks). Ask the user, then send answers with answer_questions.",
      inputSchema: { batch_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ batch_id }) => out(await call("GET", `/questions${batch_id ? `?batch=${batch_id}` : ""}`)),
  );

  write(server.registerTool(
    "answer_questions",
    {
      title: "Answer questions",
      description:
        "Send the user's answers to pending_questions. The application continues and still pauses for review before submitting. remember=true saves the answers so the same questions are answered next time.",
      inputSchema: {
        answers: z.array(z.object({ application_id: z.string(), field_id: z.string(), value: z.union([z.string(), z.array(z.string())]) })).min(1).max(200),
        remember: z.boolean().optional(),
      },
    },
    async ({ answers, remember }) => {
      const byApp = new Map<string, { field_id: string; value: string | string[] }[]>();
      for (const a of answers) byApp.set(a.application_id, [...(byApp.get(a.application_id) ?? []), { field_id: a.field_id, value: a.value }]);
      const results = [];
      for (const [id, list] of byApp) results.push(await call("POST", `/applications/${id}/answer`, { answers: list, remember }).catch((e) => ({ application_id: id, error: (e as Error).message })));
      return out(results);
    },
  ));

  server.registerTool(
    "wait_for_updates",
    {
      title: "Wait for progress",
      description: "Wait (up to timeout_seconds, max 50) until an application changes status (tailoring, filling, waiting for review, submitted, needs you…), then return what changed. Scope to a batch with batch_id. Returns an empty list on timeout; call again to keep following.",
      inputSchema: { batch_id: z.string().optional(), timeout_seconds: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ batch_id, timeout_seconds }) => out(await call("GET", `/updates?timeout=${timeout_seconds ?? 25}${batch_id ? `&batch=${batch_id}` : ""}`)),
  );

  // ---------- profile from the conversation (#29) ----------

  server.registerTool(
    "list_profiles",
    { title: "List résumé profiles", description: "The user's résumé profiles (one per role family), with which one is the default.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const d = (await call("GET", "/resumes")) as { id: string; name: string; isDefault: boolean; doc: { experience: unknown[]; skills: string[] } }[];
      return out(d.map((r) => ({ id: r.id, name: r.name, default: r.isDefault, roles: r.doc.experience.length, skills: r.doc.skills.length })));
    },
  );

  write(server.registerTool(
    "import_resume",
    {
      title: "Import a résumé",
      description: "Create a résumé profile from résumé text, or from a PDF/DOCX file given as base64. Fills empty contact details in the profile too. Give it a role-family name like 'Data Science' to keep several.",
      inputSchema: {
        text: z.string().max(200000).optional(),
        file_base64: z.string().max(14_000_000).optional(),
        file_name: z.string().max(200).optional().describe("e.g. resume.pdf (needed with file_base64)"),
        name: z.string().max(80).optional(),
      },
    },
    async ({ text, file_base64, file_name, name }) => {
      if (!text && !file_base64) throw new Error("Provide text or file_base64");
      const form = new FormData();
      if (file_base64) form.set("file", new Blob([Buffer.from(file_base64, "base64")]), file_name ?? "resume.pdf");
      else form.set("text", text!);
      if (name) form.set("name", name);
      const r = (await callForm("/resumes", form)) as { resume: { id: string; name: string; doc: { experience: unknown[]; skills: string[]; education: unknown[] } }; method: string };
      return out({ profile_id: r.resume.id, name: r.resume.name, roles: r.resume.doc.experience.length, education: r.resume.doc.education.length, skills: r.resume.doc.skills.length, parsed_with: r.method });
    },
  ));

  const Section = z.record(z.string(), z.unknown());
  write(server.registerTool(
    "update_profile",
    {
      title: "Update profile",
      description:
        "Partial update of the job-search profile. Sections: personal (firstName, lastName, email, phone, city, region, country, linkedin, github, website), work_auth (authorizedCountries, needsSponsorship, citizenship, visaStatus, clearance), logistics (salaryExpectation, yearsOfExperience, earliestStart, noticePeriod, willingToRelocate), preferences (titles, locations, workplace, keywords, excludeCompanies), eeo (gender, race, veteran, disability, hispanic). Only the keys you pass change.",
      inputSchema: { personal: Section.optional(), work_auth: Section.optional(), logistics: Section.optional(), preferences: Section.optional(), eeo: Section.optional() },
    },
    async ({ personal, work_auth, logistics, preferences, eeo }) => {
      const p = (await call("PUT", "/profile", { personal, workAuth: work_auth, logistics, preferences, eeo })) as Record<string, unknown>;
      const { answers: _a, library: _l, ...rest } = p;
      return out(rest);
    },
  ));

  write(server.registerTool(
    "set_answers",
    {
      title: "Save answers",
      description:
        "Add or replace answers in the answer library, used on every form: mode 'fixed' fills the text as-is ({company} and {role} are filled in); mode 'write' drafts an answer per job from this guidance (e.g. 'Why do you want to join {company}?').",
      inputSchema: { answers: z.array(z.object({ question: z.string().min(3).max(500), answer: z.string().max(4000), mode: z.enum(["fixed", "write"]).optional() })).min(1).max(50) },
    },
    async ({ answers }) => {
      const p = (await call("GET", "/profile")) as { library: { id: string; question: string; mode: string; answer: string; builtin?: string }[] };
      const lib = [...(p.library ?? [])];
      for (const a of answers) {
        const i = lib.findIndex((e) => e.question.trim().toLowerCase() === a.question.trim().toLowerCase());
        const entry = { ...(i >= 0 ? lib[i] : { id: `ans_${Math.random().toString(36).slice(2, 10)}` }), question: a.question, answer: a.answer, mode: a.mode ?? "fixed" };
        if (i >= 0) lib[i] = entry as (typeof lib)[number];
        else lib.push(entry as (typeof lib)[number]);
      }
      await call("PUT", "/profile", { library: lib });
      return out({ saved: answers.length, library_size: lib.length });
    },
  ));

  if (!scopes.has("jobs:apply")) for (const t of writes) t.remove();
  return server;
}

export const mcp = new Hono();
mcp.all("/", async (c) => {
  const h = c.req.header("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : (c.req.query("token") ?? "");
  // OAuth connections carry their granted scopes; API tokens and sessions (the user's own) can do everything.
  const viaOAuth = token ? oauthUser(token) : null;
  const scopes: Set<McpScope> | null = viaOAuth ? viaOAuth.scopes : token && userForToken(token) ? new Set(["jobs:read", "jobs:apply"]) : null;
  if (!scopes) {
    // Tells MCP clients where to sign in (RFC 9728), so connecting needs no pasted token.
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl()}"`);
    return c.json({ error: "unauthorized", hint: "Connect with OAuth, or pass an API token as 'Authorization: Bearer <token>' (Settings → MCP / CLI)" }, 401);
  }
  const server = buildServer(token, scopes);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
