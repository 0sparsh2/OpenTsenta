import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api.ts";
import { recoverQueue } from "./apply/queue.ts";
import { closeBrowsers } from "./browser.ts";
import { config, paths, ROOT } from "./config.ts";
import { seedCompanies } from "./ingest/companies.ts";
import { startPoller } from "./ingest/poller.ts";
import { backfillJobPlaces } from "./store.ts";
import { llmEnabled } from "./llm.ts";
import { mcp } from "./mcp.ts";
import { mockAts, seedSandboxJobs } from "./mock/ats.ts";
import { startMailSync } from "./mail/index.ts";
import { setMessagingEnqueue } from "./messaging.ts";
import { startNotifications } from "./notify/index.ts";
import { enqueue } from "./apply/queue.ts";
import { markGhosted } from "./track/inbox.ts";
import { resumeFonts } from "./routes/resumes.ts";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!c.req.path.startsWith("/mock-ats")) c.header("X-Frame-Options", "DENY");
});
// Browser extensions and the local dashboard call the API cross-origin; in production set CORS_ORIGINS.
app.use("/api/*", cors({ origin: (o) => (!config.corsOrigins.length || !o || config.corsOrigins.includes(o) || o.startsWith("chrome-extension://") ? (o ?? "*") : ""), allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"], exposeHeaders: ["Mcp-Session-Id"] }));
app.get("/healthz", (c) => c.json({ ok: true, brand: config.brand, llm: llmEnabled() }));

// MCP first so the REST auth middleware never sees it.
app.route("/api/v1/mcp", mcp);
app.route("/api/v1", api);
app.route("/mock-ats", mockAts);
app.route("/resume-fonts", resumeFonts);

// Screenshots from application runs. Paths contain unguessable application ids.
app.use("/traces/*", serveStatic({ root: path.relative(process.cwd(), path.dirname(paths.traces)) || "." }));

// Serve the built dashboard + landing page in production (`npm run build` first).
const webDist = path.join(ROOT, "apps/web/dist");
if (fs.existsSync(webDist)) {
  const rel = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root: rel }));
  app.get("*", (c) => c.html(fs.readFileSync(path.join(webDist, "index.html"), "utf8")));
}

seedCompanies();
seedSandboxJobs();
recoverQueue();
startPoller();
setTimeout(() => void backfillJobPlaces(), 500); // once per location-parser version, in the background
startMailSync();
startNotifications();
setMessagingEnqueue((id) => enqueue(id));
setInterval(() => markGhosted(), 6 * 3600_000).unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`${config.brand} API on http://localhost:${info.port}  ·  LLM ${llmEnabled() ? `on (${config.model})` : "off (heuristic fallbacks)"}  ·  real submit ${config.allowRealSubmit ? "ON" : "off (dry run)"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    server.close();
    await closeBrowsers();
    process.exit(0);
  });
}
