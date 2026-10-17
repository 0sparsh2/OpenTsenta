import crypto from "node:crypto";
import { Hono } from "hono";
import { config } from "../config.ts";
import { run } from "../db.ts";
import { upsertJob } from "../store.ts";
import { WD_JOBS, workday } from "./workday.ts";
import { deliverLocal } from "../mail/index.ts";
import { ENTERPRISE_JOBS, icims, orc, taleo } from "./enterprise.ts";
import { HANDBACK_JOBS, handbackSubmissions, handbackUrls, linkedin, smartr } from "./handback.ts";

// A sandbox employer ("Acme Robotics") with two application styles, so the full
// find → tailor → apply → submit → confirm loop can run end to end without touching a real
// employer. /mock-ats/acme/... is a one-page form (Greenhouse-like, with a custom combobox);
// /mock-ats/wizard/... is a three-step flow (Workday-like).

interface Submission {
  id: string;
  job: string;
  at: string;
  fields: Record<string, string>;
  files: { field: string; name: string; size: number }[];
}
const submissions: Submission[] = [];

const JOBS = [
  {
    id: "1001",
    style: "acme",
    title: "Software Engineer, Platform",
    location: "Remote (US)",
    description: `Acme Robotics builds fleet software for warehouse robots.

What you'll do
• Build and operate distributed services in TypeScript and Go that coordinate thousands of robots
• Own APIs (REST and gRPC) used by our web dashboard and partner integrations
• Improve reliability: observability with Prometheus and Grafana, on-call, incident reviews
• Work with PostgreSQL, Redis, and Kafka on AWS with Kubernetes and Terraform

What we're looking for
• 3+ years building backend systems in production
• Strong TypeScript or Go; experience with distributed systems and system design
• Comfortable with Docker, Kubernetes, CI/CD
• Nice to have: React, robotics, Python

We sponsor visas. Salary $150,000 - $195,000 + equity.`,
  },
  {
    id: "1002",
    // Greenhouse-style fraud check: Submit emails a security code that must be entered to finish.
    style: "secure",
    title: "Frontend Engineer, Operator Console",
    location: "San Francisco, CA (Hybrid)",
    description: `Build the console operators use to supervise robot fleets in real time.

• React, TypeScript, Next.js, WebSockets, data visualization
• Design systems, accessibility, performance
• Partner with design (Figma) and backend teams
• 2+ years of frontend experience

Salary $140,000 - $180,000.`,
  },
  {
    id: "2001",
    style: "wizard",
    title: "Backend Engineer, Integrations",
    location: "Austin, TX (Onsite)",
    description: `Integrate Acme robots with customers' warehouse management systems.

• Python, Node.js, REST APIs, SQL, message queues (RabbitMQ or Kafka)
• Experience with AWS, Docker, Linux
• 2-5 years of experience
Salary $130,000 - $165,000.`,
  },
];

/**
 * The sandbox employers' postings, for local development and tests (and SANDBOX_JOBS=true). A real instance doesn't
 * list them: it removes any left from earlier runs, except ones you applied to or saved. The /mock-ats pages still
 * answer by direct link.
 */
export function seedSandboxJobs() {
  if (!config.sandboxJobs) {
    run(
      "DELETE FROM jobs WHERE url LIKE '%/mock-ats/%' AND id NOT IN (SELECT job_id FROM applications) AND id NOT IN (SELECT job_id FROM matches WHERE status != 'new')",
    );
    return;
  }
  for (const j of HANDBACK_JOBS) {
    const url = handbackUrls(config.publicUrl, j);
    upsertJob({
      companyId: null,
      company: "Acme Robotics (sandbox)",
      ats: j.kind === "smartr" ? "smartrecruiters" : "linkedin",
      externalId: j.kind === "smartr" ? `acme-sr:${j.id}` : `linkedin:${j.id}`,
      title: j.title,
      location: j.location,
      workplace: /remote/i.test(j.location) ? "remote" : /hybrid/i.test(j.location) ? "hybrid" : "onsite",
      url,
      applyUrl: url,
      // Easy Apply postings carry this marker (as resolveLinkedIn stores them).
      description: j.kind === "linkedin" ? `${j.description}\n\n[LinkedIn Easy Apply]` : j.description,
      salary: j.description.match(/\$[\d,]+ - \$[\d,]+/)?.[0],
      postedAt: new Date().toISOString(),
      sponsorsVisa: null,
    });
  }
  for (const j of ENTERPRISE_JOBS) {
    const slug = j.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const url =
      j.kind === "orc"
        ? `${config.publicUrl}/mock-ats/orc/acme/job/${j.id}`
        : j.kind === "taleo"
          ? `${config.publicUrl}/mock-ats/taleo/careersection/ext/jobdetail.ftl?job=${j.id}`
          : `${config.publicUrl}/mock-ats/icims/jobs/${j.id}/${slug}/job`;
    upsertJob({
      companyId: null,
      company: "Acme Robotics (sandbox)",
      ats: j.kind === "orc" ? "oraclecloud" : j.kind,
      externalId: `acme-${j.kind}:${j.id}`,
      title: j.title,
      location: j.location,
      workplace: /remote/i.test(j.location) ? "remote" : /hybrid/i.test(j.location) ? "hybrid" : "onsite",
      url,
      applyUrl: url,
      description: j.description,
      salary: j.description.match(/\$[\d,]+ - \$[\d,]+/)?.[0],
      postedAt: new Date().toISOString(),
      sponsorsVisa: null,
    });
  }
  for (const j of WD_JOBS) {
    const url = `${config.publicUrl}/mock-ats/workday/acme/job/${j.id}`;
    upsertJob({
      companyId: null,
      company: "Acme Robotics (sandbox)",
      ats: "workday",
      externalId: `acme-wd:${j.id}`,
      title: j.title,
      location: j.location,
      workplace: /remote/i.test(j.location) ? "remote" : /hybrid/i.test(j.location) ? "hybrid" : "onsite",
      url,
      applyUrl: url,
      description: j.description,
      salary: j.description.match(/\$[\d,]+ - \$[\d,]+/)?.[0],
      postedAt: new Date().toISOString(),
      sponsorsVisa: null,
    });
  }
  for (const j of JOBS) {
    const url = `${config.publicUrl}/mock-ats/${j.style}/jobs/${j.id}`;
    upsertJob({
      companyId: null,
      company: "Acme Robotics (sandbox)",
      ats: "mock",
      externalId: `acme:${j.id}`,
      title: j.title,
      location: j.location,
      workplace: /remote/i.test(j.location) ? "remote" : /hybrid/i.test(j.location) ? "hybrid" : "onsite",
      url,
      applyUrl: url,
      description: j.description,
      salary: j.description.match(/\$[\d,]+ - \$[\d,]+/)?.[0],
      postedAt: new Date().toISOString(),
      sponsorsVisa: /sponsor visas/i.test(j.description) ? true : null,
    });
  }
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1d1d1f;line-height:1.5}
h1{font-size:26px;margin-bottom:4px} .loc{color:#666;margin-bottom:20px} pre{white-space:pre-wrap;font:inherit;background:#fafafa;padding:16px;border-radius:8px}
.field{margin:14px 0} label,.q{display:block;font-weight:600;margin-bottom:6px;font-size:14px} input[type=text],input[type=email],input[type=tel],input[type=url],select,textarea{width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:6px;font:inherit;box-sizing:border-box}
textarea{min-height:110px} .opt{font-weight:400;display:flex;gap:8px;align-items:center;margin:4px 0} button{background:#111;color:#fff;border:0;padding:11px 18px;border-radius:8px;font-weight:600;cursor:pointer;margin-top:12px}
.combo{position:relative} .menu{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #ccc;border-radius:6px;z-index:5;max-height:180px;overflow:auto} .menu div{padding:8px 10px;cursor:pointer} .menu div:hover{background:#f2f2f2}
.err{color:#b00020;font-size:13px} .step{display:none} .step.on{display:block} .badge{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:99px;padding:2px 10px;font-size:12px;margin-bottom:12px}
</style></head><body><div class="badge">Sandbox employer · nothing leaves your machine</div>${body}</body></html>`;

const acmeForm = (j: (typeof JOBS)[number]) => `
<h1>${j.title}</h1><div class="loc">Acme Robotics · ${j.location}</div>
<pre>${j.description}</pre>
<h2>Apply for this job</h2>
<form id="application_form" method="post" action="/mock-ats/${j.style}/jobs/${j.id}/submit" enctype="multipart/form-data" novalidate>
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required></div>
  <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div class="field combo"><label id="loc-label" for="location">Location (City) *</label>
    <input id="location" name="location" type="text" role="combobox" aria-autocomplete="list" aria-labelledby="loc-label" aria-required="true" autocomplete="off">
    <div class="menu" id="loc-menu" role="listbox" hidden></div></div>
  <div class="field"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" required></div>
  <div class="field"><label for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file" accept=".pdf,.doc,.docx"></div>
  <div class="field"><label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin" type="url"></div>
  <div class="field"><label for="website">Website</label><input id="website" name="website" type="url"></div>
  <div class="field" style="position:absolute;left:-9999px;top:0"><label for="company_website_url">Company website</label><input id="company_website_url" name="company_website_url" type="text" tabindex="-1" autocomplete="off"></div>
  <div class="field"><label for="source">How did you hear about this job? *</label>
    <select id="source" name="source" required><option value="">Select...</option><option>LinkedIn</option><option>Company Website</option><option>Referral</option><option>Other</option></select></div>
  <fieldset class="field" style="border:0;padding:0"><legend class="q">Are you legally authorized to work in the United States? *</legend>
    <label class="opt"><input type="radio" name="authorized" value="yes" required> Yes</label>
    <label class="opt"><input type="radio" name="authorized" value="no"> No</label></fieldset>
  <fieldset class="field" style="border:0;padding:0"><legend class="q">Will you now or in the future require visa sponsorship? *</legend>
    <label class="opt"><input type="radio" name="sponsorship" value="yes" required> Yes</label>
    <label class="opt"><input type="radio" name="sponsorship" value="no"> No</label></fieldset>
  <div class="field"><label for="why">Why do you want to work at Acme Robotics? *</label><textarea id="why" name="why" required></textarea></div>
  <h3>Voluntary Self-Identification</h3>
  <div class="field"><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Non-binary</option><option>Decline To Self Identify</option></select></div>
  <div class="field"><label for="veteran">Veteran Status</label><select id="veteran" name="veteran"><option value="">Select...</option><option>I am a veteran</option><option>I am not a veteran</option><option>I don't wish to answer</option></select></div>
  <div class="field"><label class="opt"><input type="checkbox" id="consent" name="consent" required> I acknowledge the Acme Robotics candidate privacy notice *</label></div>
  <div id="errors" class="err" role="alert"></div>
  <button type="submit">Submit Application</button>
</form>
<script>
const CITIES=["San Francisco, CA","New York, NY","Austin, TX","Seattle, WA","Boston, MA","Chicago, IL","Los Angeles, CA","Denver, CO","Remote"];
const inp=document.getElementById('location'),menu=document.getElementById('loc-menu');
inp.addEventListener('input',()=>{const q=inp.value.toLowerCase();const m=CITIES.filter(c=>c.toLowerCase().includes(q.split(',')[0].trim()));menu.innerHTML=m.map(c=>'<div role="option">'+c+'</div>').join('');menu.hidden=!m.length;inp.dataset.chosen='';});
menu.addEventListener('click',e=>{const o=e.target.closest('[role=option]');if(!o)return;inp.value=o.textContent;inp.dataset.chosen='1';menu.hidden=true;});
document.getElementById('application_form').addEventListener('submit',e=>{
  const f=e.target,errs=[];
  for(const el of f.querySelectorAll('[required]')){ if(el.type==='radio'){ if(!f.querySelector('input[name="'+el.name+'"]:checked')) errs.push(el.name+' is required'); } else if(el.type==='checkbox'){ if(!el.checked) errs.push('Please acknowledge the privacy notice'); } else if(!el.value) errs.push((el.labels[0]||{}).textContent+' is required'); }
  if(inp.dataset.chosen!=='1') errs.push('Pick a location from the list');
  if(errs.length){e.preventDefault();document.getElementById('errors').textContent=[...new Set(errs)].join(' · ');}
});
</script>`;

const wizardForm = (j: (typeof JOBS)[number]) => `
<h1>${j.title}</h1><div class="loc">Acme Robotics · ${j.location}</div>
<pre>${j.description}</pre>
<form id="wiz" method="post" action="/mock-ats/wizard/jobs/${j.id}/submit" enctype="multipart/form-data" novalidate>
 <div class="step on" data-step="1"><h2>Step 1 of 3 · My Information</h2>
  <div class="field"><label for="w_first">Legal First Name *</label><input id="w_first" name="first_name" type="text" required></div>
  <div class="field"><label for="w_last">Legal Last Name *</label><input id="w_last" name="last_name" type="text" required></div>
  <div class="field"><label for="w_email">Email Address *</label><input id="w_email" name="email" type="email" required></div>
  <div class="field"><label for="w_phone">Phone Number *</label><input id="w_phone" name="phone" type="tel" required></div>
  <div class="field"><label for="w_country">Country *</label><select id="w_country" name="country" required><option value="">Select One</option><option>United States</option><option>Canada</option><option>India</option><option>United Kingdom</option></select></div>
  <button type="button" class="next">Next</button></div>
 <div class="step" data-step="2"><h2>Step 2 of 3 · My Experience</h2>
  <div class="field"><label for="w_resume">Upload Resume *</label><input id="w_resume" name="resume" type="file" required></div>
  <div class="field"><label for="w_school">School or University</label><input id="w_school" name="school" type="text"></div>
  <div class="field"><label for="w_years">Years of professional experience *</label><select id="w_years" name="years" required><option value="">Select One</option><option>0-1</option><option>2-4</option><option>5-7</option><option>8+</option></select></div>
  <button type="button" class="next">Next</button></div>
 <div class="step" data-step="3"><h2>Step 3 of 3 · Application Questions</h2>
  <fieldset class="field" style="border:0;padding:0"><legend class="q">Are you at least 18 years of age? *</legend>
   <label class="opt"><input type="radio" name="age" value="yes" required> Yes</label><label class="opt"><input type="radio" name="age" value="no"> No</label></fieldset>
  <fieldset class="field" style="border:0;padding:0"><legend class="q">Have you previously worked for Acme Robotics? *</legend>
   <label class="opt"><input type="radio" name="former" value="yes" required> Yes</label><label class="opt"><input type="radio" name="former" value="no"> No</label></fieldset>
  <div class="field"><label for="w_project">Describe an integration project you're proud of. *</label><textarea id="w_project" name="project" required></textarea></div>
  <div id="werr" class="err" role="alert"></div>
  <button type="submit">Submit</button></div>
</form>
<script>
const steps=[...document.querySelectorAll('.step')];
document.querySelectorAll('.next').forEach(b=>b.addEventListener('click',()=>{
  const cur=b.closest('.step');const bad=[...cur.querySelectorAll('[required]')].filter(el=>!el.value);
  if(bad.length){alert('Complete required fields');return;}
  cur.classList.remove('on');steps[steps.indexOf(cur)+1].classList.add('on');window.scrollTo(0,0);
}));
document.getElementById('wiz').addEventListener('submit',e=>{const f=e.target;const miss=['age','former'].filter(n=>!f.querySelector('input[name='+n+']:checked'));if(miss.length||!f.project.value){e.preventDefault();document.getElementById('werr').textContent='Answer all questions';}});
</script>`;

export const mockAts = new Hono();
// Workday-style tenant (accounts + email verification) is mounted first so its routes win.
mockAts.route("/workday", workday);
mockAts.route("/orc", orc);
mockAts.route("/icims", icims);
mockAts.route("/taleo", taleo);
mockAts.route("/smartr", smartr);
mockAts.route("/linkedin", linkedin);

mockAts.get("/:style/jobs/:id", (c) => {
  const j = JOBS.find((x) => x.id === c.req.param("id") && x.style === c.req.param("style"));
  if (!j) return c.text("Not found", 404);
  return c.html(page(`${j.title} - Acme Robotics`, j.style === "wizard" ? wizardForm(j) : acmeForm(j)));
});

const pendingSecure = new Map<string, { code: string; sub: Omit<Submission, "id"> }>();

mockAts.post("/:style/jobs/:id/submit", async (c) => {
  const body = await c.req.parseBody({ all: false });
  const fields: Record<string, string> = {};
  const files: Submission["files"] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v instanceof File) {
      if (v.size) files.push({ field: k, name: v.name, size: v.size });
    } else fields[k] = String(v);
  }
  // A bot trap: people never see this field, so anything in it means a script filled the form.
  if (fields.company_website_url) return c.text("Your application could not be submitted.", 400);
  const draft = { job: `${c.req.param("style")}:${c.req.param("id")}`, at: new Date().toISOString(), fields, files };
  if (c.req.param("style") === "secure") {
    // Hold the application and email an 8-character security code, as Greenhouse does on some boards.
    const token = crypto.randomBytes(8).toString("hex");
    const code = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 8);
    pendingSecure.set(token, { code, sub: draft });
    deliverLocal({ to: (fields.email ?? "").toLowerCase(), from: "no-reply@us.greenhouse-mail.local", fromName: "Acme Robotics (via Greenhouse)", subject: "Security code for your application to Acme Robotics", text: `Copy and paste this code into the security code field on your application: ${code}` });
    return c.html(
      page(
        "Verify your application",
        `<h1>Security code</h1><p>A verification code was sent to ${(fields.email ?? "").replace(/</g, "&lt;")}. Enter the 8-character code to submit your application.</p>
<form method="post" action="/mock-ats/secure/jobs/${c.req.param("id")}/verify"><input type="hidden" name="token" value="${token}">
<div class="code">${Array.from({ length: 8 }, (_, i) => `<input type="text" maxlength="1" name="c${i}" aria-label="Security code character ${i + 1}" style="width:36px;text-align:center">`).join("")}</div>
<p><button type="submit">Submit application</button></p></form>`,
      ),
    );
  }
  const sub: Submission = { id: `sub_${submissions.length + 1}`, ...draft };
  submissions.push(sub);
  return c.redirect(`/mock-ats/confirmation/${sub.id}`);
});

mockAts.post("/secure/jobs/:id/verify", async (c) => {
  const b = await c.req.parseBody();
  const held = pendingSecure.get(String(b.token ?? ""));
  const code = Array.from({ length: 8 }, (_, i) => String(b[`c${i}`] ?? "")).join("").toUpperCase();
  if (!held || held.code !== code) return c.html(page("Verify your application", `<p class="err">That security code is incorrect.</p>`), 400);
  pendingSecure.delete(String(b.token));
  const sub: Submission = { id: `sub_${submissions.length + 1}`, ...held.sub };
  submissions.push(sub);
  return c.redirect(`/mock-ats/confirmation/${sub.id}`);
});

mockAts.get("/confirmation/:id", (c) => {
  const s = submissions.find((x) => x.id === c.req.param("id"));
  if (!s) return c.text("Not found", 404);
  return c.html(
    page(
      "Application received",
      `<h1>Thank you for applying!</h1><p>Your application has been submitted to Acme Robotics. Reference <b>${s.id}</b>.</p>
       <pre>${JSON.stringify({ fields: s.fields, files: s.files }, null, 2).replace(/</g, "&lt;")}</pre>`,
    ),
  );
});

mockAts.get("/submissions", (c) => c.json(submissions));
mockAts.get("/handback-submissions", (c) => c.json(handbackSubmissions));
