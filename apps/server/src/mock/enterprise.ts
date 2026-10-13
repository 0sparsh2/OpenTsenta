import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { deliverLocal } from "../mail/index.ts";

// Two more sandbox employers, mirroring enterprise ATS flows the agent must get through:
//   /mock-ats/orc   Oracle Recruiting-style: "Apply Now" renders the email step client-side (a route change),
//                   email + terms → a 6-digit code emailed to you → split one-digit code boxes → 2-step form.
//   /mock-ats/icims iCIMS-style: posting inside an iframe → email-first login → create an account with a
//                   password → one-page profile form.
// Nothing leaves the machine; codes go to the local sandbox mailbox.

export const ENTERPRISE_JOBS: { kind: "orc" | "icims" | "taleo"; id: string; title: string; location: string; description: string }[] = [
  {
    kind: "orc" as const,
    id: "5001",
    title: "Data Platform Engineer",
    location: "Austin, TX (Hybrid)",
    description: `Build the data platform behind Acme's robot telemetry.

• Python, SQL, Spark or Flink, Kafka
• Data modeling and pipeline reliability
• 3+ years building production data systems

Salary $150,000 - $185,000.`,
  },
  {
    kind: "icims" as const,
    id: "7001",
    title: "Backend Engineer, Payments",
    location: "Remote (US)",
    description: `Own billing and payments for Acme's fleet subscriptions.

• Go or TypeScript, PostgreSQL, Stripe-style APIs
• Idempotency, ledgers, reconciliation
• 4+ years building backend services

Salary $160,000 - $200,000.`,
  },
  {
    kind: "taleo" as const,
    id: "8001",
    title: "Embedded Software Engineer",
    location: "Boston, MA (On-site)",
    description: `Write the firmware that keeps Acme's robots moving safely.

• C/C++, RTOS, embedded Linux
• Motor control and sensor fusion
• 3+ years of embedded experience

Salary $140,000 - $175,000.`,
  },
];

export const enterpriseSubmissions: { kind: "orc" | "icims" | "taleo"; jobId: string; email: string; data: Record<string, string>; files: Record<string, number>; at: string }[] = [];

const shell = (brand: string, title: string, body: string, color = "#7b3fa0") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f5f7;color:#222}
header{background:${color};color:#fff;padding:14px 28px;font-weight:600}
main{max-width:700px;margin:24px auto;background:#fff;border-radius:8px;padding:26px 30px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:23px;margin:0 0 6px} pre{white-space:pre-wrap;font:inherit} .muted{color:#666}
label,.q{display:block;font-weight:600;font-size:14px;margin-bottom:6px} .field{margin:16px 0}
input[type=text],input[type=email],input[type=password],input[type=tel],select,textarea{width:100%;padding:9px 10px;border:1px solid #bbb;border-radius:4px;font:inherit;box-sizing:border-box}
.opt{font-weight:400;display:flex;gap:8px;align-items:center} button,.btn{background:${color};color:#fff;border:0;padding:10px 18px;border-radius:4px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.code input{width:42px;height:48px;text-align:center;font-size:22px;margin-right:6px} .err{background:#fdecea;color:#a12622;padding:10px 12px;border-radius:4px;margin:12px 0}
.badge{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:99px;padding:2px 10px;font-size:12px;margin-bottom:12px}
</style></head><body><header>Acme Robotics · ${brand}</header><main><div class="badge">Sandbox ${brand} · nothing leaves your machine</div>${body}</main></body></html>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const job = (kind: "orc" | "icims" | "taleo", id: string) => ENTERPRISE_JOBS.find((j) => j.kind === kind && j.id === id);
const sid = () => crypto.randomBytes(12).toString("hex");

// ---------- Oracle Recruiting-style ----------

const orcCodes = new Map<string, string>(); // email → code
const orcSessions = new Map<string, { email: string; step1?: Record<string, string>; files?: Record<string, number> }>();
export const orc = new Hono();

orc.get("/acme/job/:id", (c) => {
  const j = job("orc", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  return c.html(
    shell(
      "Oracle Recruiting",
      `${j.title} | Acme`,
      `<div id="app"><h1>${esc(j.title)}</h1><p class="muted">${esc(j.location)}</p><pre>${esc(j.description)}</pre><button type="button" id="apply">Apply Now</button></div>
<script>
document.getElementById('apply').addEventListener('click', () => {
  // Single-page app: change the route, render the next step a moment later.
  history.pushState({}, '', location.pathname + '/apply/email');
  document.getElementById('app').innerHTML = '<p class="muted">Loading…</p>';
  setTimeout(() => {
    document.getElementById('app').innerHTML = \`<h1>Apply</h1><p>Enter your email address to start your application. We'll email you a verification code.</p>
<form method="post" action="${c.req.path}/apply/email">
<div class="field"><label for="em">Email Address *</label><input type="email" id="em" name="email" required></div>
<div class="field"><label class="opt"><input type="checkbox" name="terms" value="yes" required> I agree with the terms and conditions</label></div>
<button type="submit">Next</button></form>\`;
  }, 900);
});
</script>`,
    ),
  );
});

orc.post("/acme/job/:id/apply/email", async (c) => {
  const b = await c.req.parseBody();
  const email = String(b.email ?? "").toLowerCase();
  if (!email || b.terms !== "yes") return c.html(shell("Oracle Recruiting", "Apply", `<div class="err">Enter your email and accept the terms.</div>`), 400);
  const code = String(crypto.randomInt(100000, 999999));
  orcCodes.set(email, code);
  deliverLocal({ to: email, from: "no-reply@acme-sandbox.oraclecloud.local", fromName: "Acme Robotics Careers", subject: "Your one-time verification code", text: `Use this code to continue your application: ${code}\n\nIt expires in 15 minutes.` });
  return c.redirect(`/mock-ats/orc/acme/job/${c.req.param("id")}/apply/code?email=${encodeURIComponent(email)}`);
});

orc.get("/acme/job/:id/apply/code", (c) => {
  const email = c.req.query("email") ?? "";
  return c.html(
    shell(
      "Oracle Recruiting",
      "Verify",
      `<h1>Confirm your email</h1><p>Enter the verification code we sent to ${esc(email)}.</p>
<form method="post" class="code"><input type="hidden" name="email" value="${esc(email)}">
${[0, 1, 2, 3, 4, 5].map((i) => `<input type="text" inputmode="numeric" maxlength="1" name="d${i}" aria-label="Digit ${i + 1}">`).join("")}
<div class="field"><button type="submit">Verify</button></div></form>`,
    ),
  );
});

orc.post("/acme/job/:id/apply/code", async (c) => {
  const b = await c.req.parseBody();
  const email = String(b.email ?? "").toLowerCase();
  const code = [0, 1, 2, 3, 4, 5].map((i) => String(b[`d${i}`] ?? "")).join("");
  if (!email || orcCodes.get(email) !== code) return c.html(shell("Oracle Recruiting", "Verify", `<div class="err">That code didn't match.</div>`), 400);
  orcCodes.delete(email);
  const s = sid();
  orcSessions.set(s, { email });
  setCookie(c, "orc_session", s, { path: "/mock-ats/orc", httpOnly: true, sameSite: "Lax" });
  return c.redirect(`/mock-ats/orc/acme/job/${c.req.param("id")}/apply/form/1`);
});

const orcSession = (c: Context) => orcSessions.get(getCookie(c, "orc_session") ?? "");

orc.get("/acme/job/:id/apply/form/:step", (c) => {
  const s = orcSession(c);
  if (!s) return c.redirect(`/mock-ats/orc/acme/job/${c.req.param("id")}/apply/email`);
  const step = c.req.param("step");
  const body =
    step === "1"
      ? `<h1>Contact information</h1><p class="muted">Step 1 of 2</p><form method="post" enctype="multipart/form-data">
<div class="field"><label for="fn">First Name *</label><input type="text" id="fn" name="first" required></div>
<div class="field"><label for="ln">Last Name *</label><input type="text" id="ln" name="last" required></div>
<div class="field"><label for="ph">Phone Number *</label><input type="tel" id="ph" name="phone" required></div>
<div class="field"><label for="cv">Resume *</label><input type="file" id="cv" name="resume" required></div>
<button type="submit">Next</button></form>`
      : `<h1>Application questions</h1><p class="muted">Step 2 of 2</p><form method="post">
<div class="field"><label for="prev">Have you previously been employed by Acme Robotics? *</label><select id="prev" name="previous" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<div class="field"><span class="q">Are you legally authorized to work in the United States? *</span><label class="opt"><input type="radio" name="authorized" value="Yes" required> Yes</label><label class="opt"><input type="radio" name="authorized" value="No"> No</label></div>
<div class="field"><label for="nc">Are you currently subject to a non-compete agreement? *</label><select id="nc" name="noncompete" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<div class="field"><label for="sig">E-Signature: type your full legal name *</label><input type="text" id="sig" name="signature" required></div>
<button type="submit">Submit</button></form>`;
  return c.html(shell("Oracle Recruiting", "Application", body));
});

orc.post("/acme/job/:id/apply/form/:step", async (c) => {
  const s = orcSession(c);
  if (!s) return c.redirect(`/mock-ats/orc/acme/job/${c.req.param("id")}/apply/email`);
  const b = await c.req.parseBody();
  if (c.req.param("step") === "1") {
    const file = b.resume;
    if (!(file instanceof File) || !file.size || !b.first || !b.last || !b.phone) return c.html(shell("Oracle Recruiting", "Application", `<div class="err">All fields are required.</div>`), 400);
    s.step1 = { first: String(b.first), last: String(b.last), phone: String(b.phone) };
    s.files = { resume: file.size };
    return c.redirect(`/mock-ats/orc/acme/job/${c.req.param("id")}/apply/form/2`);
  }
  const data = { ...(s.step1 ?? {}), previous: String(b.previous ?? ""), authorized: String(b.authorized ?? ""), noncompete: String(b.noncompete ?? ""), signature: String(b.signature ?? "") };
  if (!data.previous || !data.authorized || !data.noncompete || !data.signature) return c.html(shell("Oracle Recruiting", "Application", `<div class="err">Answer every question.</div>`), 400);
  enterpriseSubmissions.push({ kind: "orc", jobId: c.req.param("id"), email: s.email, data, files: s.files ?? {}, at: new Date().toISOString() });
  return c.html(shell("Oracle Recruiting", "Submitted", `<h1>Thank you for applying</h1><p>Your application has been submitted.</p>`));
});

// ---------- iCIMS-style ----------

const icimsAccounts = new Map<string, { password: string; first: string; last: string }>();
const icimsSessions = new Map<string, string>(); // session → email
export const icims = new Hono();
const icimsSession = (c: Context) => icimsSessions.get(getCookie(c, "icims_session") ?? "");

icims.get("/jobs/:id/:slug/job", (c) => {
  const j = job("icims", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  if (c.req.query("in_iframe") !== "1") {
    // The real thing wraps the posting in an iframe on the company's branded page.
    return c.html(shell("iCIMS", `${j.title}`, `<iframe title="Job" src="${c.req.path}?in_iframe=1" style="width:100%;height:640px;border:0"></iframe>`, "#2b6cb0"));
  }
  return c.html(
    shell("iCIMS", j.title, `<p class="muted">Returning Candidate? Log back in!</p><h1>${esc(j.title)}</h1><p>${esc(j.location)}</p><pre>${esc(j.description)}</pre>
<a class="btn" href="/mock-ats/icims/jobs/${j.id}/${c.req.param("slug")}/login?in_iframe=1">Apply for this job online</a>`, "#2b6cb0"),
  );
});

icims.get("/jobs/:id/:slug/login", (c) =>
  c.html(
    shell("iCIMS", "Login", `<h1>Welcome</h1><p>Please enter your email address to apply or log back in.</p>
<form method="post"><div class="field"><label for="em">Email</label><input type="email" id="em" name="email" required></div>
<button type="submit">Next</button></form>`, "#2b6cb0"),
  ),
);

icims.post("/jobs/:id/:slug/login", async (c) => {
  const b = await c.req.parseBody();
  const email = String(b.email ?? "").toLowerCase();
  const base = `/mock-ats/icims/jobs/${c.req.param("id")}/${c.req.param("slug")}`;
  if (b.password != null) {
    const a = icimsAccounts.get(email);
    if (!a || a.password !== b.password) return c.html(shell("iCIMS", "Login", `<div class="err">Invalid email or password. Please try again.</div>`, "#2b6cb0"), 401);
  } else if (b.password1 != null) {
    if (b.password1 !== b.password2 || String(b.password1).length < 8) return c.html(shell("iCIMS", "Create", `<div class="err">Passwords must match and be at least 8 characters.</div>`, "#2b6cb0"), 400);
    if (b.privacy !== "yes") return c.html(shell("iCIMS", "Create", `<div class="err">You must accept the privacy policy.</div>`, "#2b6cb0"), 400);
    icimsAccounts.set(email, { password: String(b.password1), first: String(b.first ?? ""), last: String(b.last ?? "") });
  } else {
    // Email only: known accounts get a password box, new ones the create-account form.
    const known = icimsAccounts.has(email);
    return c.html(
      shell(
        "iCIMS",
        known ? "Login" : "Create Account",
        known
          ? `<h1>Log in</h1><form method="post"><input type="hidden" name="email" value="${esc(email)}"><p>${esc(email)}</p>
<div class="field"><label for="pw">Password</label><input type="password" id="pw" name="password" required></div><button type="submit">Log In</button></form>`
          : `<h1>Create an account</h1><p>Create an account to apply.</p><form method="post"><input type="hidden" name="email" value="${esc(email)}">
<div class="field"><label for="em2">Email</label><input type="email" id="em2" name="email_display" value="${esc(email)}" readonly></div>
<div class="field"><label for="f">First Name</label><input type="text" id="f" name="first" required></div>
<div class="field"><label for="l">Last Name</label><input type="text" id="l" name="last" required></div>
<div class="field"><label for="p1">Password</label><input type="password" id="p1" name="password1" required></div>
<div class="field"><label for="p2">Confirm Password</label><input type="password" id="p2" name="password2" required></div>
<div class="field"><label class="opt"><input type="checkbox" name="privacy" value="yes"> I have read and accept the privacy policy</label></div>
<button type="submit">Create Account</button></form>`,
        "#2b6cb0",
      ),
    );
  }
  const s = sid();
  icimsSessions.set(s, email);
  setCookie(c, "icims_session", s, { path: "/mock-ats/icims", httpOnly: true, sameSite: "Lax" });
  return c.redirect(`${base}/candidate?in_iframe=1`);
});

icims.get("/jobs/:id/:slug/candidate", (c) => {
  if (!icimsSession(c)) return c.redirect(`/mock-ats/icims/jobs/${c.req.param("id")}/${c.req.param("slug")}/login?in_iframe=1`);
  return c.html(
    shell(
      "iCIMS",
      "Candidate Profile",
      `<h1>Candidate profile</h1><form method="post" enctype="multipart/form-data">
<div class="field"><label for="cv">Upload your resume *</label><input type="file" id="cv" name="resume" required></div>
<div class="field"><label for="a1">Address *</label><input type="text" id="a1" name="address" required></div>
<div class="field"><label for="ci">City *</label><input type="text" id="ci" name="city" required></div>
<div class="field"><label for="st">State *</label><select id="st" name="state" required><option value="">Select</option><option>California</option><option>New York</option><option>Texas</option><option>Washington</option></select></div>
<div class="field"><label for="zp">Zip Code *</label><input type="text" id="zp" name="zip" required></div>
<div class="field"><label for="ph">Phone *</label><input type="tel" id="ph" name="phone" required></div>
<div class="field"><span class="q">Are you 18 years of age or older? *</span><label class="opt"><input type="radio" name="adult" value="Yes" required> Yes</label><label class="opt"><input type="radio" name="adult" value="No"> No</label></div>
<div class="field"><label for="sp">Will you now or in the future require visa sponsorship? *</label><select id="sp" name="sponsorship" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<div class="field"><label for="g">Gender</label><select id="g" name="gender"><option value="">Select</option><option>Male</option><option>Female</option><option>I do not wish to self-identify</option></select></div>
<button type="submit">Submit Application</button></form>`,
      "#2b6cb0",
    ),
  );
});

icims.post("/jobs/:id/:slug/candidate", async (c) => {
  const email = icimsSession(c);
  if (!email) return c.redirect(`/mock-ats/icims/jobs/${c.req.param("id")}/${c.req.param("slug")}/login?in_iframe=1`);
  const b = await c.req.parseBody();
  const file = b.resume;
  const data: Record<string, string> = {};
  for (const k of ["address", "city", "state", "zip", "phone", "adult", "sponsorship", "gender"]) data[k] = String(b[k] ?? "");
  if (!(file instanceof File) || !file.size || ["address", "city", "state", "zip", "phone", "adult", "sponsorship"].some((k) => !data[k]))
    return c.html(shell("iCIMS", "Candidate Profile", `<div class="err">Please complete all required fields.</div>`, "#2b6cb0"), 400);
  enterpriseSubmissions.push({ kind: "icims", jobId: c.req.param("id"), email, data, files: { resume: file.size }, at: new Date().toISOString() });
  return c.html(shell("iCIMS", "Thank you", `<h1>Thank you!</h1><p>Your application was submitted.</p>`, "#2b6cb0"));
});

// ---------- Taleo-style ----------
// Legacy careersection flow: "Apply Online" → login or "New User" registration (user name + password + email) →
// privacy agreement (Accept) → personal information → attachments → questionnaire → eSignature → review → Submit.

const taleoAccounts = new Map<string, { password: string; email: string }>();
const taleoSessions = new Map<string, { user: string; data: Record<string, string>; files: Record<string, number> }>();
export const taleo = new Hono();
const taleoSession = (c: Context) => taleoSessions.get(getCookie(c, "taleo_session") ?? "");
const T = "/mock-ats/taleo/careersection/ext";
const tshell = (title: string, body: string) => shell("Taleo", title, body, "#1f5d36");

taleo.get("/careersection/ext/jobdetail.ftl", (c) => {
  const j = job("taleo", c.req.query("job") ?? "");
  if (!j) return c.text("Not found", 404);
  return c.html(tshell(`Job Description - ${j.title}`, `<p class="muted">Welcome. You are not signed in.</p><h1>${esc(j.title)}</h1><p>${esc(j.location)}</p><pre>${esc(j.description)}</pre>
<input type="button" class="btn" value="Apply Online" onclick="location.href='${T}/jobapply.ftl?job=${j.id}'">`));
});

taleo.get("/careersection/ext/jobapply.ftl", (c) => {
  const id = c.req.query("job") ?? "";
  if (taleoSession(c)) return c.redirect(`${T}/flow.ftl?job=${id}&step=1`);
  return c.html(
    tshell(
      "Login",
      `<h1>Login</h1><p>Returning user? Sign in. New users: create an account.</p>
<form method="post" action="${T}/login.ftl?job=${id}"><div class="field"><label for="u">User Name</label><input type="text" id="u" name="user"></div>
<div class="field"><label for="p">Password</label><input type="password" id="p" name="password"></div><button type="submit">Login</button></form>
<p><a class="btn" href="${T}/register.ftl?job=${id}">New User</a></p>`,
    ),
  );
});

taleo.post("/careersection/ext/login.ftl", async (c) => {
  const b = await c.req.parseBody();
  const a = taleoAccounts.get(String(b.user ?? "").toLowerCase());
  if (!a || a.password !== b.password) return c.html(tshell("Login", `<div class="err">The user name or password is incorrect.</div>`), 401);
  const s = sid();
  taleoSessions.set(s, { user: String(b.user).toLowerCase(), data: {}, files: {} });
  setCookie(c, "taleo_session", s, { path: "/mock-ats/taleo", httpOnly: true, sameSite: "Lax" });
  return c.redirect(`${T}/flow.ftl?job=${c.req.query("job")}&step=1`);
});

taleo.get("/careersection/ext/register.ftl", (c) =>
  c.html(
    tshell(
      "New User Registration",
      `<h1>New User Registration</h1><p>Create an account to apply. All fields are required.</p>
<form method="post"><div class="field"><label for="ru">User Name</label><input type="text" id="ru" name="user" required></div>
<div class="field"><label for="rp">Password</label><input type="password" id="rp" name="password" required></div>
<div class="field"><label for="rp2">Re-enter Password</label><input type="password" id="rp2" name="password2" required></div>
<div class="field"><label for="re">Email Address</label><input type="text" id="re" name="email" required></div>
<div class="field"><label class="opt"><input type="checkbox" name="privacy" value="yes"> I have read and accept the privacy agreement</label></div>
<button type="submit">Register</button></form>`,
    ),
  ),
);

taleo.post("/careersection/ext/register.ftl", async (c) => {
  const b = await c.req.parseBody();
  const user = String(b.user ?? "").toLowerCase();
  if (!user || !b.email || b.password !== b.password2 || String(b.password).length < 8 || b.privacy !== "yes")
    return c.html(tshell("New User Registration", `<div class="err">Please complete all fields, match the passwords, and accept the privacy agreement.</div>`), 400);
  if (taleoAccounts.has(user)) return c.html(tshell("New User Registration", `<div class="err">This user name is already taken.</div>`), 400);
  taleoAccounts.set(user, { password: String(b.password), email: String(b.email).toLowerCase() });
  const s = sid();
  taleoSessions.set(s, { user, data: {}, files: {} });
  setCookie(c, "taleo_session", s, { path: "/mock-ats/taleo", httpOnly: true, sameSite: "Lax" });
  return c.redirect(`${T}/flow.ftl?job=${c.req.query("job")}&step=1`);
});

const TALEO_STEPS = ["Privacy Agreement", "Personal Information", "Attachments", "Questionnaire", "eSignature", "Review and Submit"];

taleo.get("/careersection/ext/flow.ftl", (c) => {
  const s = taleoSession(c);
  const id = c.req.query("job") ?? "";
  if (!s) return c.redirect(`${T}/jobapply.ftl?job=${id}`);
  const step = Number(c.req.query("step") ?? 1);
  const head = `<p class="muted">Step ${step} of ${TALEO_STEPS.length}: ${TALEO_STEPS[step - 1]}</p>`;
  const action = `${T}/flow.ftl?job=${id}&step=${step}`;
  const bodies: Record<number, string> = {
    1: `<h1>Privacy Agreement</h1><p>Acme Robotics will process your personal data to evaluate your application. Read the agreement and accept to continue.</p>
<form method="post" action="${action}"><input type="submit" class="btn" name="decision" value="Accept"> <input type="submit" name="decision" value="Decline"></form>`,
    2: `<h1>Personal Information</h1><form method="post" action="${action}">
<div class="field"><label for="fn">First Name</label><input type="text" id="fn" name="first" required></div>
<div class="field"><label for="ln">Last Name</label><input type="text" id="ln" name="last" required></div>
<div class="field"><label for="ph">Primary Number</label><input type="text" id="ph" name="phone" required></div>
<div class="field"><label for="ad">Address (line 1)</label><input type="text" id="ad" name="address" required></div>
<div class="field"><label for="ci">City</label><input type="text" id="ci" name="city" required></div>
<div class="field"><label for="st">State/Province</label><select id="st" name="state" required><option value="">Select</option><option>California</option><option>Massachusetts</option><option>New York</option><option>Texas</option></select></div>
<div class="field"><label for="zp">Zip/Postal Code</label><input type="text" id="zp" name="zip" required></div>
<input type="submit" class="btn" value="Save and Continue"></form>`,
    3: `<h1>Attachments</h1><form method="post" action="${action}" enctype="multipart/form-data">
<div class="field"><label for="cv">Attach a resume</label><input type="file" id="cv" name="resume" required></div>
<input type="submit" class="btn" value="Save and Continue"></form>`,
    4: `<h1>Questionnaire</h1><form method="post" action="${action}">
<div class="field"><span class="q">Are you at least 18 years of age?</span><label class="opt"><input type="radio" name="adult" value="Yes" required> Yes</label><label class="opt"><input type="radio" name="adult" value="No"> No</label></div>
<div class="field"><label for="pw">Have you ever worked for Acme Robotics?</label><select id="pw" name="previous" required><option value="">Select</option><option>Yes</option><option>No</option></select></div>
<input type="submit" class="btn" value="Save and Continue"></form>`,
    5: `<h1>eSignature</h1><p>By typing your full name you certify the information is accurate.</p><form method="post" action="${action}">
<div class="field"><label for="sg">Type your full legal name</label><input type="text" id="sg" name="signature" required></div>
<input type="submit" class="btn" value="Save and Continue"></form>`,
    6: `<h1>Review and Submit</h1><pre>${esc(JSON.stringify(s.data, null, 2))}</pre><form method="post" action="${action}"><input type="submit" class="btn" value="Submit"></form>`,
  };
  return c.html(tshell(TALEO_STEPS[step - 1] ?? "Done", head + (bodies[step] ?? "")));
});

taleo.post("/careersection/ext/flow.ftl", async (c) => {
  const s = taleoSession(c);
  const id = c.req.query("job") ?? "";
  if (!s) return c.redirect(`${T}/jobapply.ftl?job=${id}`);
  const step = Number(c.req.query("step") ?? 1);
  const b = await c.req.parseBody();
  const next = () => c.redirect(`${T}/flow.ftl?job=${id}&step=${step + 1}`);
  const err = (m: string) => c.html(tshell(TALEO_STEPS[step - 1], `<div class="err">${m}</div>`), 400);
  if (step === 1) return b.decision === "Accept" ? next() : err("You must accept the privacy agreement to apply.");
  if (step === 3) {
    const f = b.resume;
    if (!(f instanceof File) || !f.size) return err("Attach a resume.");
    s.files.resume = f.size;
    return next();
  }
  if (step === 6) {
    enterpriseSubmissions.push({ kind: "taleo", jobId: id, email: taleoAccounts.get(s.user)?.email ?? "", data: s.data, files: s.files, at: new Date().toISOString() });
    return c.html(tshell("Thank you", `<h1>Thank you for applying</h1><p>Your submission has been received.</p>`));
  }
  for (const [k, v] of Object.entries(b)) if (typeof v === "string") s.data[k] = v;
  const required: Record<number, string[]> = { 2: ["first", "last", "phone", "address", "city", "state", "zip"], 4: ["adult", "previous"], 5: ["signature"] };
  if ((required[step] ?? []).some((k) => !s.data[k])) return err("Please complete all required fields.");
  return next();
});

/** For tests: forget sandbox accounts and sessions. */
export function resetEnterpriseSandboxes() {
  taleoAccounts.clear();
  taleoSessions.clear();
  icimsAccounts.clear();
  icimsSessions.clear();
  orcSessions.clear();
  orcCodes.clear();
}
