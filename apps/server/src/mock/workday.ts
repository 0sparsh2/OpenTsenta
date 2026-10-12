import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { deliverLocal } from "../mail/index.ts";

// Workday-style sandbox tenant ("acme"): candidate account required, email verification code,
// multi-step server-rendered application with server-side validation, confirmation email.
// Mirrors the parts of real Workday flows the agent must handle; nothing leaves the machine.

interface Account {
  email: string;
  password: string;
  verified: boolean;
  code: string;
}
interface Draft {
  jobId: string;
  data: Record<string, string>;
  files: Record<string, { name: string; size: number }>;
}
const accounts = new Map<string, Account>();
const sessions = new Map<string, { email: string; draft?: Draft }>();
export const workdaySubmissions: { id: string; email: string; jobId: string; at: string; data: Record<string, string>; files: Draft["files"] }[] = [];

export const WD_JOBS = [
  {
    id: "3001",
    title: "Site Reliability Engineer",
    location: "Seattle, WA (Hybrid)",
    description: `Keep Acme's robot fleet control plane available 24/7.

• Kubernetes, Terraform, AWS, Prometheus, Grafana
• Go or Python for automation; Linux internals
• On-call ownership, incident response, postmortems
• 3+ years in SRE / platform roles

Salary $150,000 - $190,000.`,
  },
  {
    id: "3002",
    title: "Senior Full Stack Engineer, Fleet Dashboard",
    location: "Remote (US)",
    description: `Own the dashboard warehouse operators use to command robot fleets.

• React, TypeScript, Node.js, PostgreSQL, GraphQL
• Real-time data (WebSockets), design systems
• 5+ years building production web apps

Salary $170,000 - $210,000.`,
  },
];

const US_STATES = ["Alabama", "Alaska", "Arizona", "California", "Colorado", "Florida", "Georgia", "Illinois", "Massachusetts", "New York", "Texas", "Washington"];

const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Acme Robotics Careers</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f6f9;color:#1d2a3a}
header{background:#0b5cad;color:#fff;padding:14px 28px;font-weight:600}
main{max-width:720px;margin:28px auto;background:#fff;border-radius:10px;padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:24px;margin:0 0 6px} h2{font-size:18px} .muted{color:#5b6b7f} pre{white-space:pre-wrap;font:inherit}
label,.q{display:block;font-weight:600;font-size:14px;margin-bottom:6px} .field{margin:16px 0}
input[type=text],input[type=email],input[type=password],input[type=tel],select,textarea{width:100%;padding:9px 10px;border:1px solid #b8c4d2;border-radius:4px;font:inherit;box-sizing:border-box}
.opt{font-weight:400;display:flex;gap:8px;align-items:center} button,.btn{background:#0b5cad;color:#fff;border:0;padding:10px 18px;border-radius:4px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.link{color:#0b5cad} .err{background:#fdecea;color:#a12622;padding:10px 12px;border-radius:4px;margin:12px 0}
.steps{display:flex;gap:6px;margin-bottom:18px;font-size:12px} .steps span{padding:4px 8px;border-radius:99px;background:#e6edf5} .steps .on{background:#0b5cad;color:#fff}
.badge{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:99px;padding:2px 10px;font-size:12px;margin-bottom:12px}
</style></head><body><header>Acme Robotics · Careers</header><main><div class="badge">Sandbox Workday tenant · nothing leaves your machine</div>${body}</main></body></html>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const base = "/mock-ats/workday/acme";
const STEPS = ["My Information", "My Experience", "Application Questions", "Voluntary Disclosures", "Review"];
const stepsBar = (n: number) => `<div class="steps">${STEPS.map((s, i) => `<span class="${i === n ? "on" : ""}">${i + 1}. ${s}</span>`).join("")}</div>`;

function session(c: Context) {
  const sid = getCookie(c, "wd_session");
  return sid ? sessions.get(sid) : undefined;
}
function startSession(c: Context, email: string) {
  const sid = crypto.randomBytes(12).toString("hex");
  sessions.set(sid, { email });
  setCookie(c, "wd_session", sid, { path: "/mock-ats/workday", httpOnly: true, sameSite: "Lax" });
}
const strongPassword = (p: string) => p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

export const workday = new Hono();

workday.get("/acme/job/:id", (c) => {
  const j = WD_JOBS.find((x) => x.id === c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  return c.html(
    shell(
      j.title,
      `<h1>${j.title}</h1><p class="muted">${j.location} · Full time · Job ID R-${j.id}</p><pre>${esc(j.description)}</pre>
      <button type="button" id="apply" onclick="document.getElementById('how').hidden=false">Apply</button>
      <div id="how" hidden style="margin-top:16px;padding:16px;border:1px solid #b8c4d2;border-radius:8px">
        <p class="q">Start Your Application</p>
        <button type="button" onclick="location.href='${base}/job/${j.id}/apply?autofill=1'">Autofill with Resume</button>
        <button type="button" onclick="location.href='${base}/job/${j.id}/apply'">Apply Manually</button>
        <button type="button" disabled>Use My Last Application</button>
      </div>`,
    ),
  );
});

workday.get("/acme/job/:id/apply", (c) => {
  const s = session(c);
  if (s) {
    s.draft = { jobId: c.req.param("id"), data: {}, files: {} };
    return c.redirect(`${base}/application/0`);
  }
  return c.redirect(`${base}/login?job=${c.req.param("id")}`);
});

const loginPage = (job: string, error = "") =>
  shell(
    "Sign In",
    `<h1>Sign In</h1>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="${base}/login?job=${job}">
      <div class="field"><label for="email">Email Address</label><input id="email" name="email" type="email" autocomplete="username"></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password"></div>
      <button type="submit">Sign In</button>
    </form>
    <p class="muted">Don't have an account yet? <a class="link" href="${base}/create-account?job=${job}">Create Account</a></p>`,
  );

workday.get("/acme/login", (c) => c.html(loginPage(c.req.query("job") ?? "")));
workday.post("/acme/login", async (c) => {
  const job = c.req.query("job") ?? "";
  const b = await c.req.parseBody();
  const email = String(b.email ?? "").toLowerCase();
  const a = accounts.get(email);
  if (!a || a.password !== String(b.password ?? "")) return c.html(loginPage(job, "Invalid email address or password."));
  if (!a.verified) return c.html(loginPage(job, "Verify your email address before signing in. Check your inbox for the code."));
  startSession(c, email);
  return c.redirect(`${base}/job/${job}/apply`);
});

const createPage = (job: string, error = "") =>
  shell(
    "Create Account",
    `<h1>Create Account</h1>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="${base}/create-account?job=${job}">
      <div class="field"><label for="ca-email">Email Address *</label><input id="ca-email" name="email" type="email" required></div>
      <div class="field"><label for="ca-pw">Password *</label><input id="ca-pw" name="password" type="password" required></div>
      <div class="field"><label for="ca-pw2">Verify New Password *</label><input id="ca-pw2" name="password2" type="password" required></div>
      <div class="field"><label class="opt"><input type="checkbox" name="agree" required> Yes, I have read and consent to the Acme Robotics Candidate Privacy Statement *</label></div>
      <button type="submit">Create Account</button>
    </form>
    <p class="muted">Password must be at least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character.</p>
    <p class="muted">Already have an account? <a class="link" href="${base}/login?job=${job}">Sign In</a></p>`,
  );

workday.get("/acme/create-account", (c) => c.html(createPage(c.req.query("job") ?? "")));
workday.post("/acme/create-account", async (c) => {
  const job = c.req.query("job") ?? "";
  const b = await c.req.parseBody();
  const email = String(b.email ?? "").toLowerCase().trim();
  const pw = String(b.password ?? "");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.html(createPage(job, "Enter a valid email address."));
  if (pw !== String(b.password2 ?? "")) return c.html(createPage(job, "Passwords do not match."));
  if (!strongPassword(pw)) return c.html(createPage(job, "Password does not meet the requirements."));
  if (!b.agree) return c.html(createPage(job, "You must consent to the Candidate Privacy Statement."));
  if (accounts.get(email)?.verified) return c.html(createPage(job, "An account with this email already exists. Sign in instead."));
  const code = String(crypto.randomInt(100000, 999999));
  accounts.set(email, { email, password: pw, verified: false, code });
  deliverLocal({
    to: email,
    from: "acmerobotics@myworkday.example",
    fromName: "Acme Robotics via Workday",
    subject: "Verify your Acme Robotics candidate account",
    text: `Hello,\n\nThanks for creating a candidate account with Acme Robotics.\nYour verification code is: ${code}\n\nThis code expires in 30 minutes.`,
    html: `<p>Thanks for creating a candidate account with Acme Robotics.</p><p>Your verification code is: <b>${code}</b></p>`,
  });
  return c.redirect(`${base}/verify?job=${job}&email=${encodeURIComponent(email)}`);
});

const verifyPage = (job: string, email: string, error = "") =>
  shell(
    "Verify Email",
    `<h1>Verify your email</h1><p class="muted">We sent a 6-digit verification code to ${esc(email)}. Enter it below.</p>
    ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="${base}/verify?job=${job}&email=${encodeURIComponent(email)}">
      <div class="field"><label for="code">Verification Code</label><input id="code" name="code" type="text" inputmode="numeric" maxlength="6"></div>
      <button type="submit">Verify</button>
    </form>`,
  );
workday.get("/acme/verify", (c) => c.html(verifyPage(c.req.query("job") ?? "", c.req.query("email") ?? "")));
workday.post("/acme/verify", async (c) => {
  const job = c.req.query("job") ?? "";
  const email = (c.req.query("email") ?? "").toLowerCase();
  const b = await c.req.parseBody();
  const a = accounts.get(email);
  if (!a || a.code !== String(b.code ?? "").trim()) return c.html(verifyPage(job, email, "That code is incorrect or expired."));
  a.verified = true;
  startSession(c, email);
  return c.redirect(`${base}/job/${job}/apply`);
});

// ---------- application steps ----------

function stepForm(n: number, d: Draft, error = "") {
  const v = (k: string) => esc(d.data[k] ?? "");
  // Real Workday renders many dropdowns as <button aria-haspopup="listbox"> with a popup list of options.
  const listbox = (name: string, label: string, opts: string[], req = true) =>
    `<div class="field" data-automation-id="formField-${name}"><label id="lb-${name}">${label}${req ? " *" : ""}</label>
      <input type="hidden" name="${name}" value="${v(name)}">
      <button type="button" class="lbx" aria-haspopup="listbox" aria-labelledby="lb-${name}" ${req ? 'aria-required="true"' : ""} data-name="${name}" style="width:100%;text-align:left;background:#fff;color:#1d2a3a;border:1px solid #b8c4d2">${v(name) || "Select One"}</button>
      <ul role="listbox" hidden style="list-style:none;margin:4px 0 0;padding:4px;border:1px solid #b8c4d2;border-radius:4px;max-height:180px;overflow:auto">${opts.map((o) => `<li role="option" style="padding:6px 8px;cursor:pointer">${o}</li>`).join("")}</ul></div>`;
  const sel = (name: string, label: string, opts: string[], req = true) =>
    `<div class="field"><label for="${name}">${label}${req ? " *" : ""}</label><select id="${name}" name="${name}"${req ? " required" : ""}><option value="">Select One</option>${opts
      .map((o) => `<option${d.data[name] === o ? " selected" : ""}>${o}</option>`)
      .join("")}</select></div>`;
  const radio = (name: string, q: string) =>
    `<fieldset class="field" style="border:0;padding:0"><legend class="q">${q} *</legend>${["Yes", "No"].map((o) => `<label class="opt"><input type="radio" name="${name}" value="${o}" required${d.data[name] === o ? " checked" : ""}> ${o}</label>`).join("")}</fieldset>`;
  const text = (name: string, label: string, req = true, type = "text") =>
    `<div class="field"><label for="${name}">${label}${req ? " *" : ""}</label><input id="${name}" name="${name}" type="${type}" value="${v(name)}"${req ? " required" : ""}></div>`;
  let body = "";
  if (n === 0)
    body = `${listbox("country", "Country", ["United States of America", "Canada", "India", "United Kingdom"])}
      ${text("legalFirst", "Legal Name - First Name")}${text("legalLast", "Legal Name - Last Name")}
      ${text("address1", "Address Line 1")}${text("city", "City")}${listbox("state", "State", US_STATES)}${text("postal", "Postal Code")}
      ${sel("deviceType", "Phone Device Type", ["Mobile", "Home", "Work"])}${text("phone", "Phone Number", true, "tel")}
      ${sel("source", "How Did You Hear About Us?", ["Company Website", "LinkedIn", "Indeed", "Employee Referral", "Other"])}`;
  if (n === 1)
    body = `<div class="field"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" required>${d.files.resume ? `<p class="muted">Uploaded: ${esc(d.files.resume.name)}</p>` : ""}</div>
      ${text("jobTitle", "Most Recent Job Title")}${text("company", "Most Recent Company")}${text("linkedin", "LinkedIn Profile", false, "text")}`;
  if (n === 2)
    body = `${radio("authorized", "Are you legally authorized to work in the United States?")}
      ${radio("sponsor", "Will you now or in the future require sponsorship for employment visa status?")}
      ${sel("years", "How many years of relevant experience do you have?", ["Less than 1 year", "1-2 years", "3-5 years", "6-9 years", "10+ years"])}
      ${radio("formerEmployee", "Have you previously been employed by Acme Robotics?")}`;
  if (n === 3)
    body = `${sel("gender", "Gender", ["Male", "Female", "I do not wish to self-identify"], false)}
      ${sel("ethnicity", "Race/Ethnicity", ["Asian", "Black or African American", "Hispanic or Latino", "White", "Two or More Races", "I do not wish to self-identify"], false)}
      ${sel("veteran", "Veteran Status", ["I am not a veteran", "I identify as one or more of the classifications of protected veterans", "I do not wish to self-identify"], false)}
      <div class="field"><label class="opt"><input type="checkbox" name="terms" required${d.data.terms ? " checked" : ""}> I certify that the information provided is true and complete *</label></div>`;
  if (n === 4)
    body = `<h2>Review</h2><ul>${Object.entries(d.data)
      .map(([k, val]) => `<li><b>${esc(k)}</b>: ${esc(val)}</li>`)
      .join("")}${Object.entries(d.files)
      .map(([k, f]) => `<li><b>${esc(k)}</b>: ${esc(f.name)}</li>`)
      .join("")}</ul>`;
  const job = WD_JOBS.find((j) => j.id === d.jobId);
  return shell(
    STEPS[n],
    `<h1>${esc(job?.title ?? "Application")}</h1>${stepsBar(n)}<h2>${STEPS[n]}</h2>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="${base}/application/${n}" enctype="multipart/form-data" novalidate>${body}
    <button type="submit">${n === 4 ? "Submit" : "Save and Continue"}</button></form>
    <script>
      document.querySelectorAll(".lbx").forEach((b) => {
        const list = b.nextElementSibling, hidden = b.previousElementSibling;
        b.addEventListener("click", () => { list.hidden = !list.hidden; });
        list.addEventListener("click", (e) => { const o = e.target.closest("[role=option]"); if (!o) return; hidden.value = o.textContent; b.textContent = o.textContent; list.hidden = true; });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") list.hidden = true; });
      });
    </script>`,
  );
}

const REQUIRED: Record<number, string[]> = {
  0: ["country", "legalFirst", "legalLast", "address1", "city", "state", "postal", "deviceType", "phone", "source"],
  1: ["jobTitle", "company"],
  2: ["authorized", "sponsor", "years", "formerEmployee"],
  3: ["terms"],
  4: [],
};

workday.get("/acme/application/:n", (c) => {
  const s = session(c);
  if (!s?.draft) return c.redirect(`${base}/login`);
  return c.html(stepForm(Number(c.req.param("n")), s.draft));
});
workday.post("/acme/application/:n", async (c) => {
  const s = session(c);
  if (!s?.draft) return c.redirect(`${base}/login`);
  const n = Number(c.req.param("n"));
  const b = await c.req.parseBody();
  for (const [k, val] of Object.entries(b)) {
    if (val instanceof File) {
      if (val.size) s.draft.files[k] = { name: val.name, size: val.size };
    } else s.draft.data[k] = String(val);
  }
  const missing = REQUIRED[n].filter((k) => !s.draft!.data[k]);
  if (n === 1 && !s.draft.files.resume) missing.push("Resume/CV");
  if (missing.length) return c.html(stepForm(n, s.draft, `Errors found: ${missing.join(", ")} required`));
  if (n < 4) return c.redirect(`${base}/application/${n + 1}`);
  const id = `wd_${workdaySubmissions.length + 1}`;
  workdaySubmissions.push({ id, email: s.email, jobId: s.draft.jobId, at: new Date().toISOString(), data: { ...s.draft.data }, files: { ...s.draft.files } });
  const job = WD_JOBS.find((j) => j.id === s.draft!.jobId);
  deliverLocal({
    to: s.email,
    from: "acmerobotics@myworkday.example",
    fromName: "Acme Robotics Recruiting",
    subject: `Thank you for applying to ${job?.title} at Acme Robotics`,
    text: `Hi ${s.draft.data.legalFirst ?? ""},\n\nThank you for applying to the ${job?.title} role at Acme Robotics. We've received your application and our team will review it shortly.\n\nAcme Robotics Talent Acquisition`,
  });
  s.draft = undefined;
  return c.html(shell("Submitted", `<h1>Thank you for applying!</h1><p>Your application has been submitted. Reference ${id}.</p>`));
});

workday.get("/submissions", (c) => c.json({ submissions: workdaySubmissions, accounts: [...accounts.values()].map((a) => ({ email: a.email, verified: a.verified })) }));
