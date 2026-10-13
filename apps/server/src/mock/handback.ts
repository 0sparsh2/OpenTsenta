import { Hono } from "hono";

// Sandboxes for the two kinds of site Ferry's own browser can't apply on, so the extension's "Fill this form"
// path can be tested end to end without touching a real employer:
// - /mock-ats/smartr: a SmartRecruiters-style one-click form built from web components (fields inside shadow roots,
//   a city autocomplete, a button dropdown, a résumé dropzone) behind a DataDome-style wall for automated browsers.
// - /mock-ats/linkedin: a LinkedIn-style posting whose Easy Apply modal has four steps (contact info, résumé,
//   additional questions, review), re-rendered per step.

export const HANDBACK_JOBS: { kind: "smartr" | "linkedin"; id: string; title: string; location: string; description: string }[] = [
  {
    kind: "smartr",
    id: "9001",
    title: "Robotics Software Engineer",
    location: "Boston, MA (Onsite)",
    description: `Write the motion and fleet software that runs on Acme's warehouse robots.

• TypeScript and Go services, gRPC, PostgreSQL
• Kubernetes on AWS, observability, on-call
• 3+ years of professional software engineering

Salary $145,000 - $185,000.`,
  },
  {
    kind: "linkedin",
    id: "4001234567",
    title: "Fleet Reliability Engineer",
    location: "Remote (US)",
    description: `Keep Acme's robot fleets online across hundreds of warehouses.

• Incident response, SLOs, Prometheus and Grafana
• TypeScript or Go tooling for fleet operations
• 3+ years in SRE or backend engineering

Salary $140,000 - $175,000.`,
  },
];

export const handbackSubmissions: { kind: "smartr" | "linkedin"; jobId: string; data: Record<string, string>; files: Record<string, number>; at: string }[] = [];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const job = (kind: string, id: string) => HANDBACK_JOBS.find((j) => j.kind === kind && j.id === id);
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const handbackUrls = (base: string, j: (typeof HANDBACK_JOBS)[number]) =>
  j.kind === "smartr" ? `${base}/mock-ats/smartr/AcmeRobotics/${j.id}-${slug(j.title)}` : `${base}/mock-ats/linkedin/jobs/view/${j.id}`;

async function record(kind: "smartr" | "linkedin", jobId: string, body: Record<string, string | File>) {
  const data: Record<string, string> = {};
  const files: Record<string, number> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v instanceof File) files[k] = v.size;
    else data[k] = String(v);
  }
  handbackSubmissions.push({ kind, jobId, data, files, at: new Date().toISOString() });
}

// ---------- SmartRecruiters-style ----------

export const smartr = new Hono();

const srShell = (title: string, body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">${head}
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f6f8;color:#1c2b39}
header{background:#fff;border-bottom:1px solid #dde3e8;padding:14px 28px;font-weight:700;color:#0d7a5f}
main{max-width:720px;margin:28px auto;padding:0 20px}.card{background:#fff;border-radius:10px;padding:24px 28px;margin-bottom:18px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:0 0 14px}.muted{color:#5b6b79}pre{white-space:pre-wrap;font:inherit}
a.btn,button.btn{display:inline-block;background:#0d7a5f;color:#fff;border:0;border-radius:6px;padding:11px 20px;font-weight:600;text-decoration:none;cursor:pointer;font-size:15px}
.badge{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:99px;padding:2px 10px;font-size:12px;margin-bottom:12px}#sr-error{color:#b3261e;margin-top:10px}</style>
</head><body><header>SmartRecruiters <span class="muted" style="font-weight:400">· Acme Robotics (sandbox)</span></header><main><div class="badge">Sandbox employer · nothing leaves your machine</div>${body}</main></body></html>`;

smartr.get("/AcmeRobotics/:idSlug", (c) => {
  const j = job("smartr", c.req.param("idSlug").split("-")[0]);
  if (!j) return c.text("Not found", 404);
  const ld = { "@context": "https://schema.org", "@type": "JobPosting", title: j.title, description: j.description, hiringOrganization: { "@type": "Organization", name: "Acme Robotics (sandbox)" }, jobLocation: { "@type": "Place", address: { addressLocality: "Boston", addressRegion: "MA" } }, datePosted: new Date().toISOString().slice(0, 10) };
  return c.html(
    srShell(
      `${j.title} - Acme Robotics`,
      `<div class="card"><h1>${esc(j.title)}</h1><div class="muted">Acme Robotics (sandbox) · ${esc(j.location)}</div><pre>${esc(j.description)}</pre>
<a class="btn" href="/mock-ats/smartr/oneclick-ui/company/AcmeRobotics/publication/${j.id}">I'm interested</a></div>`,
      `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
    ),
  );
});

// The bot check automated browsers get instead of the form (its frame URL is what bot-wall detection looks for).
smartr.get("/datadome/captcha", (c) => c.html(`<!doctype html><title>Verification</title><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>Please verify you are a human</h2><p>Slide right to complete the puzzle.</p></body>`));

// Client side of the one-click form: small web components with open shadow roots, like the real design system.
const SR_COMPONENTS = String.raw`
const STYLE = '.f{margin:14px 0}label,.q{display:block;font-weight:600;font-size:14px;margin-bottom:6px}input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],textarea,button.dd{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c4ced6;border-radius:6px;font:inherit;background:#fff;text-align:left}textarea{min-height:90px}[role=listbox]{list-style:none;margin:2px 0 0;padding:0;border:1px solid #c4ced6;border-radius:6px;background:#fff;max-height:180px;overflow:auto}[role=option]{padding:8px 10px;cursor:pointer}[role=option]:hover{background:#eef3f6}.dz{border:1px dashed #9fb0bd;border-radius:8px;padding:18px;text-align:center;color:#5b6b79}.dz b{color:#0d7a5f;cursor:pointer}.opt{display:flex;gap:8px;align-items:center;font-weight:400;margin:4px 0}';
class SrField extends HTMLElement {
  constructor() { super(); this.root = this.attachShadow({ mode: 'open' }); }
  get labelText() { return (this.getAttribute('label') || '') + (this.hasAttribute('required') ? ' *' : ''); }
  render(html) { this.root.innerHTML = '<style>' + STYLE + '</style><div class="f">' + html + '</div>'; const l = this.root.querySelector('label,.q'); if (l) l.prepend(document.createTextNode(this.labelText)); }
  changed() { this.dispatchEvent(new Event('change', { bubbles: true })); }
}
customElements.define('sr-input', class extends SrField {
  connectedCallback() { this.render('<label for="i"></label><input id="i" type="' + (this.getAttribute('type') || 'text') + '"' + (this.hasAttribute('required') ? ' aria-required="true"' : '') + '>'); this.root.querySelector('input').addEventListener('input', () => this.changed()); }
  get value() { return this.root.querySelector('input').value.trim(); }
});
customElements.define('sr-textarea', class extends SrField {
  connectedCallback() { this.render('<label for="t"></label><textarea id="t"></textarea>'); }
  get value() { return this.root.querySelector('textarea').value.trim(); }
});
const CITIES = ['San Francisco, CA, United States', 'San Jose, CA, United States', 'Boston, MA, United States', 'Austin, TX, United States', 'New York, NY, United States', 'Seattle, WA, United States'];
customElements.define('sr-autocomplete', class extends SrField {
  connectedCallback() {
    this.render('<label for="a"></label><input id="a" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cities" autocomplete="off" aria-required="true"><ul role="listbox" id="cities" hidden></ul>');
    const input = this.root.querySelector('input'), list = this.root.querySelector('ul');
    const show = () => {
      const q = input.value.trim().toLowerCase();
      const hits = CITIES.filter((c) => !q || c.toLowerCase().startsWith(q.split(',')[0]));
      list.innerHTML = '';
      for (const c of hits) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = c; li.addEventListener('mousedown', (e) => { e.preventDefault(); this.picked = c; input.value = c; list.hidden = true; this.changed(); }); list.appendChild(li); }
      list.hidden = !hits.length; input.setAttribute('aria-expanded', String(!list.hidden));
    };
    input.addEventListener('input', () => { this.picked = ''; show(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') show(); });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  }
  // Like the real one: typed text doesn't count until a suggestion is picked.
  get value() { return this.picked || ''; }
});
customElements.define('sr-select', class extends SrField {
  connectedCallback() {
    const opts = (this.getAttribute('options') || '').split('|');
    this.render('<span class="q" id="q"></span><button type="button" class="dd" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="q" aria-controls="lb">Select</button><ul role="listbox" id="lb" hidden>' + opts.map((o) => '<li role="option">' + o + '</li>').join('') + '</ul>');
    const btn = this.root.querySelector('button'), list = this.root.querySelector('ul');
    btn.addEventListener('click', () => { list.hidden = !list.hidden; btn.setAttribute('aria-expanded', String(!list.hidden)); });
    for (const li of list.children) li.addEventListener('click', () => { this.v = li.textContent; btn.textContent = li.textContent; list.hidden = true; btn.setAttribute('aria-expanded', 'false'); this.changed(); });
  }
  get value() { return this.v || ''; }
});
customElements.define('sr-radio-group', class extends SrField {
  connectedCallback() {
    const opts = (this.getAttribute('options') || '').split('|');
    this.render('<div role="radiogroup" aria-labelledby="q"><span class="q" id="q"></span>' + opts.map((o) => '<label class="opt"><input type="radio" name="r" value="' + o + '"> ' + o + '</label>').join('') + '</div>');
    this.root.addEventListener('change', () => this.changed());
  }
  get value() { return this.root.querySelector('input:checked')?.value || ''; }
});
customElements.define('sr-checkbox', class extends SrField {
  connectedCallback() { this.root.innerHTML = '<style>' + STYLE + '</style><div class="f"><label class="opt"><input type="checkbox" id="c"><span>' + this.labelText.replace('Privacy Policy', '<a href="#">Privacy Policy</a>') + '</span></label></div>'; this.root.addEventListener('change', () => this.changed()); }
  get value() { return this.root.querySelector('input').checked ? 'yes' : ''; }
});
customElements.define('sr-dropzone', class extends SrField {
  connectedCallback() {
    this.render('<label for="file"></label><div class="dz"><span class="name">Drop your resume here or <b>choose a file</b></span></div><input id="file" type="file" accept=".pdf,.doc,.docx,.odt,.rtf" hidden>');
    const input = this.root.querySelector('input');
    this.root.querySelector('.dz b').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { this.file = input.files[0] || null; this.root.querySelector('.name').textContent = this.file ? this.file.name : ''; this.changed(); });
  }
  get value() { return this.file ? this.file.name : ''; }
});
`;

const SR_FORM = (j: (typeof HANDBACK_JOBS)[number]) => `
<div class="card"><h1>${esc(j.title)}</h1><div class="muted">Acme Robotics (sandbox) · ${esc(j.location)}</div></div>
<form id="sr-form" class="card" novalidate>
  <h2>Personal information</h2>
  <sr-input name="firstName" label="First name" required></sr-input>
  <sr-input name="lastName" label="Last name" required></sr-input>
  <sr-input name="email" label="Email" type="email" required></sr-input>
  <sr-input name="confirmEmail" label="Confirm your email" type="email" required></sr-input>
  <sr-autocomplete name="location" label="City" required></sr-autocomplete>
  <sr-input name="phone" label="Phone number" type="tel" required></sr-input>
  <h2>Experience</h2>
  <sr-dropzone name="resume" label="Resume" required></sr-dropzone>
  <sr-input name="linkedin" label="LinkedIn profile" type="url"></sr-input>
  <sr-input name="website" label="Website" type="url"></sr-input>
  <sr-textarea name="message" label="Message to the Hiring Team"></sr-textarea>
  <h2>Questions from Acme Robotics</h2>
  <sr-radio-group name="authorized" label="Are you legally authorized to work in the United States?" options="Yes|No" required></sr-radio-group>
  <sr-select name="sponsorship" label="Will you now or in the future require sponsorship for employment visa status?" options="Yes|No" required></sr-select>
  <sr-input name="years" label="How many years of professional software engineering experience do you have?" type="number" required></sr-input>
  <sr-checkbox name="privacy" label="I have read and agree to the Privacy Policy" required></sr-checkbox>
  <button class="btn" type="submit">Submit</button>
  <div id="sr-error" role="alert"></div>
</form>
<script>${SR_COMPONENTS}
if (navigator.webdriver) {
  // Automated browsers get the bot check instead of the form.
  document.querySelector('main').innerHTML = '<iframe src="/mock-ats/smartr/datadome/captcha?initialCid=sandbox" title="DataDome CAPTCHA" style="width:100%;height:420px;border:0;background:#fff"></iframe>';
} else {
  document.getElementById('sr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = [...e.target.querySelectorAll('[name]')];
    const missing = fields.filter((f) => f.hasAttribute('required') && !f.value).map((f) => f.getAttribute('label'));
    const err = document.getElementById('sr-error');
    if (missing.length) { err.textContent = 'Please complete: ' + missing.join('; '); return; }
    const v = (n) => e.target.querySelector('[name=' + n + ']').value;
    if (v('email').toLowerCase() !== v('confirmEmail').toLowerCase()) { err.textContent = 'Emails do not match'; return; }
    const fd = new FormData();
    for (const f of fields) fd.set(f.getAttribute('name'), f.value);
    fd.set('resume', e.target.querySelector('[name=resume]').file);
    const r = await fetch(location.pathname + '/submit', { method: 'POST', body: fd });
    if (r.ok) document.querySelector('main').innerHTML = '<div class="card"><h1>Thank you for applying!</h1><p>Your application was sent to Acme Robotics (sandbox).</p></div>';
    else err.textContent = await r.text();
  });
}
</script>`;

smartr.get("/oneclick-ui/company/AcmeRobotics/publication/:id", (c) => {
  const j = job("smartr", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  return c.html(srShell(`Apply: ${j.title}`, SR_FORM(j)));
});

smartr.post("/oneclick-ui/company/AcmeRobotics/publication/:id/submit", async (c) => {
  const j = job("smartr", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  const body = (await c.req.parseBody()) as Record<string, string | File>;
  const resume = body.resume;
  if (!(resume instanceof File) || !resume.size) return c.text("Attach your resume", 400);
  for (const k of ["firstName", "lastName", "email", "location", "phone", "authorized", "sponsorship", "years", "privacy"]) if (!body[k]) return c.text(`Missing ${k}`, 400);
  await record("smartr", j.id, body);
  return c.json({ ok: true });
});

// ---------- LinkedIn-style ----------

export const linkedin = new Hono();

const LI_APP = String.raw`
const STEPS = ['Contact info', 'Resume', 'Additional questions', 'Review your application'];
const state = { step: 0, data: { email: 'member@example.com', phoneCountry: 'United States (+1)', follow: 'on' }, file: null };
const modal = () => document.getElementById('easy-apply');
const field = (id, label, html) => '<div class="fe"><label for="' + id + '">' + label + '</label>' + html + '<div class="err" id="' + id + '-error"></div></div>';
const sel = (id, opts) => '<select id="' + id + '" name="' + id + '" required><option value="">Select an option</option>' + opts.map((o) => '<option>' + o + '</option>').join('') + '</select>';
const radios = (id, q) => '<fieldset class="fe"><legend><span>' + q + '</span> <span class="req">Required</span></legend>' + ['Yes', 'No'].map((o) => '<label class="opt"><input type="radio" name="' + id + '" value="' + o + '" required> ' + o + '</label>').join('') + '<div class="err" id="' + id + '-error"></div></fieldset>';
function body() {
  switch (state.step) {
    case 0: return field('firstName', 'First name', '<input id="firstName" name="firstName" type="text" required>') + field('lastName', 'Last name', '<input id="lastName" name="lastName" type="text" required>') +
      field('email', 'Email address', sel('email', ['member@example.com'])) + field('phoneCountry', 'Phone country code', sel('phoneCountry', ['United States (+1)', 'Canada (+1)', 'United Kingdom (+44)', 'India (+91)'])) +
      field('phone', 'Mobile phone number', '<input id="phone" name="phone" type="text" required>');
    case 1: return '<h3>Resume</h3><p class="muted">Be sure to include an updated resume *</p><div class="chip" id="chip">' + (state.file ? state.file.name : 'No resume uploaded') + '</div>' +
      '<label class="upload" for="upload-resume">Upload resume</label><input id="upload-resume" name="file" type="file" accept=".pdf,.doc,.docx" class="visually-hidden"><div class="err" id="file-error"></div>';
    case 2: return field('tsYears', 'How many years of work experience do you have with TypeScript?', '<input id="tsYears" name="tsYears" type="text" required>') +
      radios('authorized', 'Are you legally authorized to work in the United States?') +
      field('sponsorship', 'Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B visa status)?', sel('sponsorship', ['Yes', 'No'])) +
      radios('bachelors', "Have you completed the following level of education: Bachelor's Degree?");
    default: return '<h3>Review your application</h3><dl>' + Object.entries(state.data).map(([k, v]) => '<dt>' + k + '</dt><dd>' + String(v).replace(/</g, '&lt;') + '</dd>').join('') + '<dt>resume</dt><dd>' + (state.file ? state.file.name : '') + '</dd></dl>' +
      '<label class="opt"><input type="checkbox" id="follow-company" name="follow"' + (state.data.follow ? ' checked' : '') + '> Follow Acme Robotics (sandbox) to stay up to date with their page.</label>';
  }
}
function render() {
  const last = state.step === STEPS.length - 1;
  modal().querySelector('.content').innerHTML = '<div class="progress"><span style="width:' + Math.round((state.step / (STEPS.length - 1)) * 100) + '%"></span></div><h3>' + STEPS[state.step] + '</h3><form id="step" novalidate>' + body() + '</form>';
  modal().querySelector('.next').textContent = last ? 'Submit application' : state.step === STEPS.length - 2 ? 'Review' : 'Next';
  modal().querySelector('.back').hidden = state.step === 0;
  const form = modal().querySelector('#step');
  for (const el of form.querySelectorAll('input,select')) {
    if (el.type === 'file') { el.addEventListener('change', () => { state.file = el.files[0] || null; document.getElementById('chip').textContent = state.file ? state.file.name : ''; }); continue; }
    const saved = state.data[el.name];
    if (el.type === 'radio') el.checked = saved === el.value; else if (el.type === 'checkbox') el.checked = Boolean(saved); else if (saved != null) el.value = saved;
    el.addEventListener('change', () => { state.data[el.name] = el.type === 'checkbox' ? (el.checked ? 'on' : '') : el.value; });
    el.addEventListener('input', () => { if (el.type !== 'radio' && el.type !== 'checkbox') state.data[el.name] = el.value; });
  }
}
function valid() {
  let ok = true;
  const form = modal().querySelector('#step');
  form.querySelectorAll('.err').forEach((e) => (e.textContent = ''));
  const names = new Set([...form.querySelectorAll('[required]')].map((e) => e.name));
  for (const n of names) {
    const v = state.data[n];
    let msg = !v ? 'Please enter a valid answer' : '';
    if (!msg && n === 'tsYears' && !/^\d{1,2}$/.test(String(v))) msg = 'Enter a whole number between 0 and 99';
    if (msg) { ok = false; const e = document.getElementById(n + '-error'); if (e) e.textContent = msg; }
  }
  if (state.step === 1 && !state.file) { ok = false; document.getElementById('file-error').textContent = 'A resume is required'; }
  return ok;
}
document.querySelector('.jobs-apply-button').addEventListener('click', () => { modal().hidden = false; render(); });
modal().querySelector('.dismiss').addEventListener('click', () => { modal().hidden = true; });
modal().querySelector('.back').addEventListener('click', () => { state.step--; render(); });
modal().querySelector('.next').addEventListener('click', async () => {
  if (!valid()) return;
  if (state.step < STEPS.length - 1) { state.step++; render(); return; }
  const fd = new FormData();
  for (const [k, v] of Object.entries(state.data)) fd.set(k, v);
  fd.set('resume', state.file);
  const r = await fetch(location.pathname + '/apply', { method: 'POST', body: fd });
  modal().querySelector('.content').innerHTML = r.ok ? '<h3>Your application was sent to Acme Robotics (sandbox)!</h3>' : '<div class="err">' + (await r.text()) + '</div>';
  modal().querySelector('.next').hidden = true;
  modal().querySelector('.back').hidden = true;
});
`;

linkedin.get("/jobs/view/:id", (c) => {
  const j = job("linkedin", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  // Signed-in LinkedIn pages carry no JobPosting JSON-LD: the title and company come from the page itself.
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(j.title)} | Acme Robotics (sandbox) | LinkedIn</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f2ee;color:#1d2226}nav{background:#fff;border-bottom:1px solid #e0dfdc;padding:12px 28px;font-weight:700;color:#0a66c2}
main{max-width:760px;margin:24px auto;padding:0 20px}.card{background:#fff;border-radius:8px;padding:24px;border:1px solid #e0dfdc}h1{font-size:24px;margin:6px 0}.muted{color:#666}pre{white-space:pre-wrap;font:inherit}
.jobs-apply-button{background:#0a66c2;color:#fff;border:0;border-radius:24px;padding:10px 22px;font-weight:600;font-size:15px;cursor:pointer;margin:12px 0}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:grid;place-items:center}.overlay[hidden]{display:none}.dialog{background:#fff;border-radius:8px;width:min(560px,94vw);max-height:88vh;display:flex;flex-direction:column}
.dialog header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid #e0dfdc}.content{padding:8px 20px 16px;overflow:auto}.dialog footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #e0dfdc}
.dialog footer button{border-radius:20px;padding:7px 18px;font-weight:600;cursor:pointer;border:1px solid #0a66c2;background:#fff;color:#0a66c2}.dialog footer .next{background:#0a66c2;color:#fff}
.fe{margin:12px 0;border:0;padding:0}.fe label,legend{display:block;font-size:14px;margin-bottom:4px}.fe input[type=text],select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #888;border-radius:4px;font:inherit}
.opt{display:flex;gap:8px;align-items:center;margin:4px 0}.err{color:#cc1016;font-size:13px}.req{font-size:12px;color:#666}.progress{height:6px;background:#e0dfdc;border-radius:3px;margin:8px 0}.progress span{display:block;height:6px;background:#0a66c2;border-radius:3px}
.upload{display:inline-block;border:1px solid #0a66c2;color:#0a66c2;border-radius:20px;padding:6px 16px;font-weight:600;cursor:pointer;margin-top:8px}.visually-hidden{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}.chip{padding:10px;border:1px solid #e0dfdc;border-radius:6px;margin:6px 0}
.badge{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:99px;padding:2px 10px;font-size:12px}</style></head><body>
<nav>in <span class="muted" style="font-weight:400">Jobs</span></nav>
<main><div class="badge">Sandbox employer · nothing leaves your machine</div><div class="card">
<div class="job-details-jobs-unified-top-card__company-name"><a href="#">Acme Robotics (sandbox)</a></div>
<h1 class="t-24 job-details-jobs-unified-top-card__job-title">${esc(j.title)}</h1><div class="muted">${esc(j.location)} · Over 100 applicants</div>
<button class="jobs-apply-button" aria-label="Easy Apply to ${esc(j.title)} at Acme Robotics (sandbox)">Easy Apply</button>
<h2>About the job</h2><pre>${esc(j.description)}</pre></div></main>
<div class="overlay" id="easy-apply" role="dialog" aria-labelledby="jobs-apply-header" hidden><div class="dialog">
<header><h2 id="jobs-apply-header" style="font-size:18px;margin:0">Apply to Acme Robotics (sandbox)</h2><button class="dismiss" aria-label="Dismiss" style="border:0;background:none;font-size:22px;cursor:pointer">×</button></header>
<div class="content"></div><footer><button class="back" type="button">Back</button><button class="next" type="button">Next</button></footer></div></div>
<script>${LI_APP}</script></body></html>`);
});

linkedin.post("/jobs/view/:id/apply", async (c) => {
  const j = job("linkedin", c.req.param("id"));
  if (!j) return c.text("Not found", 404);
  const body = (await c.req.parseBody()) as Record<string, string | File>;
  if (!(body.resume instanceof File) || !body.resume.size) return c.text("A resume is required", 400);
  for (const k of ["firstName", "lastName", "email", "phone", "tsYears", "authorized", "sponsorship", "bachelors"]) if (!body[k]) return c.text(`Missing ${k}`, 400);
  await record("linkedin", j.id, body);
  return c.json({ ok: true });
});
