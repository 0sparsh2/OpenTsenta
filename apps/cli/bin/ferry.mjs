#!/usr/bin/env node
// Ferry CLI — the same agent from your terminal. Zero dependencies.
//   FERRY_URL (default http://localhost:8787), FERRY_TOKEN (or `ferry login <email>`)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONF = path.join(os.homedir(), ".ferry.json");
const conf = fs.existsSync(CONF) ? JSON.parse(fs.readFileSync(CONF, "utf8")) : {};
const BASE = (process.env.FERRY_URL || conf.url || "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.FERRY_TOKEN || conf.token;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
};

async function api(method, p, body) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => {
    console.error(c.red(`Can't reach ${BASE}: ${e.message}. Is the server running (npm run dev)?`));
    process.exit(1);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(c.red(data.error || `HTTP ${res.status}`));
    if (res.status === 401) console.error(c.dim("Run `ferry login you@example.com` or set FERRY_TOKEN."));
    process.exit(1);
  }
  return data;
}

const pad = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
};
const score = (n) => (n == null ? c.dim(" -- ") : n >= 80 ? c.green(` ${n}%`) : n >= 65 ? c.blue(` ${n}%`) : c.yellow(` ${n}%`));
const STATUS = {
  COMPLETED: ["submitted", c.green],
  NEEDS_INPUT: ["needs you", c.yellow],
  PENDING_SUBMIT_REVIEW: ["ready to send", c.yellow],
  PENDING_RESUME_REVIEW: ["review résumé", c.yellow],
  PENDING_CL_REVIEW: ["review letter", c.yellow],
  FAILED: ["failed", c.red],
  RUNNING: ["applying", c.blue],
  QUEUED: ["queued", c.dim],
  SKIPPED: ["skipped", c.dim],
};
/** Status label padded before coloring so columns line up. */
const st = (s, dry, width = 0) => {
  const [label, color] = s === "COMPLETED" && dry ? ["dry run", c.dim] : STATUS[s] || [s.toLowerCase().replace(/_/g, " "), c.blue];
  return color(label.padEnd(width));
};

function jobsTable(items) {
  for (const j of items) console.log(`${score(j.match?.score)}  ${pad(j.title, 46)} ${pad(j.company, 22)} ${c.dim(pad(j.location, 28))} ${c.dim(j.id)}`);
}

/** Read a line from the terminal without echoing it. */
function promptHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(buf);
      } else if (ch === "\u0003") process.exit(130);
      else if (ch === "\u007f") buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on("data", onData);
  });
}

const [cmd, ...args] = process.argv.slice(2);
const help = `${c.bold("ferry")} — find matches, apply, and approve from your terminal

  ferry login <email> [name]     sign in (saves a session to ~/.ferry.json)
  ferry token <api-token>        use an API token instead (Settings → MCP · CLI · Extension)
  ferry matches [n]              best new matches for your résumé
  ferry search <query>           search every watched role
  ferry add <url>                import any job posting by URL
  ferry apply <job-id|url>...    queue applications
  ferry status [tab]             applications (all|in_flight|needs|submitted|failed)
  ferry show <app-id>            answers, résumé changes, and trace
  ferry approve <app-id>         approve the paused step (or send)
  ferry inbox                    recent recruiter email
  ferry sweep                    poll every watched career page now

  ${c.dim(`server: ${BASE}`)}`;

switch (cmd) {
  case "token": {
    if (!args[0]?.startsWith("fy_")) throw new Error("usage: ferry token <api-token>  (Settings → MCP · CLI · Extension)");
    fs.writeFileSync(CONF, JSON.stringify({ url: BASE, token: args[0] }, null, 2), { mode: 0o600 });
    const me = await fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${args[0]}` } }).then((r) => r.json());
    console.log(me.email ? c.green(`Saved. Signed in as ${me.email}.`) : c.red("That token was rejected."));
    break;
  }
  case "login": {
    if (!args[0]) throw new Error("usage: ferry login <email> [name]");
    const cfg = await api("GET", "/auth/config");
    let password = process.env.FERRY_PASSWORD;
    if (cfg.mode === "password" && !password) password = await promptHidden("Password: ");
    const r = await api("POST", "/auth/login", { email: args[0], name: args.slice(1).join(" "), password });
    fs.writeFileSync(CONF, JSON.stringify({ url: BASE, token: r.token }, null, 2), { mode: 0o600 });
    console.log(c.green(`Signed in as ${r.user.email}. ${r.user.credits} credits.`));
    if (!r.user.onboarded) console.log(c.dim(`Finish setup (upload a résumé) at ${BASE}/welcome`));
    break;
  }
  case "matches": {
    const r = await api("GET", `/jobs/recommendations?limit=${Number(args[0]) || 15}`);
    console.log(c.dim(`${r.total} matches\n`));
    jobsTable(r.items);
    break;
  }
  case "search": {
    const r = await api("GET", `/jobs/search?q=${encodeURIComponent(args.join(" "))}&limit=25&sort=match`);
    console.log(c.dim(`${r.total} roles\n`));
    jobsTable(r.items);
    break;
  }
  case "add": {
    const j = await api("POST", "/jobs/fetch", { url: args[0] });
    console.log(`${score(j.match?.score)}  ${c.bold(j.title)} · ${j.company}  ${c.dim(j.id)}`);
    for (const r of j.match?.reasons ?? []) console.log(c.green(`   ✓ ${r}`));
    for (const g of j.match?.gaps ?? []) console.log(c.yellow(`   • ${g}`));
    break;
  }
  case "apply": {
    for (const a of args) {
      const r = await api("POST", "/applications", a.startsWith("http") ? { url: a, source: "cli" } : { jobId: a, source: "cli" });
      console.log(`${c.green("queued")}  ${pad(r.job?.title, 44)} ${pad(r.job?.company, 22)} ${c.dim(r.id)}`);
    }
    console.log(c.dim("\nFerry pauses before the final submit. Check with `ferry status needs`."));
    break;
  }
  case "status": {
    const rows = await api("GET", `/applications?tab=${args[0] || "all"}&limit=40`);
    if (!rows.length) console.log(c.dim("No applications."));
    for (const a of rows) console.log(`${st(a.status, a.confirmation?.dryRun, 14)} ${pad(a.job?.title, 42)} ${pad(a.job?.company, 20)} ${c.dim(a.id)}${a.needs?.length ? c.yellow(`  ← ${a.needs[0]}`) : ""}`);
    break;
  }
  case "show": {
    const a = await api("GET", `/applications/${args[0]}`);
    console.log(`${c.bold(a.job.title)} · ${a.job.company}  ${st(a.status, a.confirmation?.dryRun)}`);
    if (a.atsScore) console.log(c.dim(`ATS keywords ${a.atsScore.before} → ${a.atsScore.after} · ${a.changes.length} résumé edits`));
    if (a.error) console.log(c.red(a.error));
    console.log();
    for (const f of a.fields) {
      const v = f.value == null || f.value === "" ? c.yellow("(missing)") : Array.isArray(f.value) ? f.value.join(", ") : String(f.value).split("/").pop();
      console.log(`  ${pad(f.label, 50)} ${pad(v, 60)} ${c.dim(f.source)}`);
    }
    console.log(c.dim(`\n${a.trace.slice(-5).map((t) => `  · ${t.text}`).join("\n")}`));
    break;
  }
  case "approve": {
    const r = await api("POST", `/applications/${args[0]}/approve`, {});
    console.log(c.green(`Approved → ${r.status.toLowerCase()}`));
    break;
  }
  case "inbox": {
    const msgs = await api("GET", "/inbox/messages");
    for (const m of msgs.slice(0, 20)) console.log(`${pad(m.category ?? "", 16)} ${pad(m.subject, 60)} ${c.dim(m.fromAddr)}`);
    if (!msgs.length) console.log(c.dim("No job email yet."));
    break;
  }
  case "sweep": {
    await api("POST", "/sources/poll");
    console.log(c.green("Sweeping every watched career page…"));
    break;
  }
  default:
    console.log(help);
}
