import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { api } from "./api.ts";
import { config } from "./config.ts";
import { userForToken } from "./session.ts";

// MCP server at /api/v1/mcp (Streamable HTTP, stateless) — the same path the reference uses.
// Tools call the REST API in-process with the caller's token, so behavior matches the dashboard.
//   claude mcp add --transport http ferry http://localhost:8787/api/v1/mcp --header "Authorization: Bearer <token>"

function buildServer(token: string) {
  const server = new McpServer({ name: `${config.brand.toLowerCase()}-jobs`, version: "0.1.0" });
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

  server.registerTool(
    "add_job_by_url",
    {
      title: "Add a job by URL",
      description: "Import any job posting URL (Greenhouse, Lever, Ashby, Workday, company sites...) and score it against the user's résumé.",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => out(await call("POST", "/jobs/fetch", { url })),
  );

  server.registerTool(
    "apply_to_job",
    {
      title: "Apply to a job",
      description:
        "Queue an application. The agent tailors the résumé and cover letter, fills the employer's form in a browser, and pauses for the user's review before the final submit unless auto-submit is enabled. Pass job_id from get_job_matches/search_jobs, or a posting url.",
      inputSchema: { job_id: z.string().optional(), url: z.string().url().optional() },
    },
    async ({ job_id, url }) => {
      if (!job_id && !url) throw new Error("Provide job_id or url");
      const a = (await call("POST", "/applications", { jobId: job_id, url, source: "mcp" })) as { id: string; status: string; job: { title: string; company: string } };
      return out({ application_id: a.id, status: a.status, job: a.job, next: "Use get_application to follow progress; approve_application once it reaches PENDING_SUBMIT_REVIEW." });
    },
  );

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

  server.registerTool(
    "approve_application",
    {
      title: "Approve application",
      description:
        "Approve an application paused for review (résumé, cover letter, or final submit). Optionally answer fields that need the user's input: [{id, value}] using field ids from get_application. Only call this after the user has confirmed.",
      inputSchema: { application_id: z.string(), fields: z.array(z.object({ id: z.string(), value: z.string() })).optional() },
      annotations: { destructiveHint: true },
    },
    async ({ application_id, fields }) => out(await call("POST", `/applications/${application_id}/approve`, { fields })),
  );

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

  return server;
}

export const mcp = new Hono();
mcp.all("/", async (c) => {
  const h = c.req.header("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : (c.req.query("token") ?? "");
  if (!userForToken(token)) {
    return c.json({ error: "unauthorized", hint: "Pass your API token as 'Authorization: Bearer <token>' (Settings → MCP / CLI)" }, 401);
  }
  const server = buildServer(token);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
