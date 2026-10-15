// Real-model QA (issue #12): run every AI feature against the configured provider (NVIDIA NIM / Anthropic) on the
// sample persona and sandbox jobs, and check the outputs for the failures that matter, not just that they parse:
// invented employers or numbers in a tailored résumé, answers that don't name the company, placeholders left in,
// scores that don't rank a good fit above a bad one, misfiled emails. Uses a throwaway database.
//   npx tsx scripts/qa-llm.ts            (needs NVIDIA_NIM_API_KEY or ANTHROPIC_API_KEY in .env)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-qa-llm-"));
process.env.LLM_DISABLED = "false";

const { llmEnabled, llmLabel } = await import("../src/llm.ts");
const { parseResume, heuristicParse } = await import("../src/resume/parse.ts");
const { normalizeDoc } = await import("../src/resume/model.ts");
const { llmMatch } = await import("../src/match/score.ts");
const { tailorResume, borrowedClaims, groundingFor, roleWords } = await import("../src/resume/tailor.ts");
const { writeCoverLetter } = await import("../src/resume/cover.ts");
const { writeAnswers } = await import("../src/apply/library.ts");
const { modifyResume, newNumbers } = await import("../src/resume/edit.ts");
const { ingestEmail } = await import("../src/track/inbox.ts");
const { createUser, getUser, updateProfile, saveResume, upsertJob } = await import("../src/store.ts");
const { all } = await import("../src/db.ts");

if (!llmEnabled()) {
  console.error("No model configured: set NVIDIA_NIM_API_KEY or ANTHROPIC_API_KEY in .env.");
  process.exit(1);
}
console.log(`Model: ${llmLabel()}\n`);

// A feature that quietly fell back to rules didn't test the model: count that as a failure.
const fellBack: string[] = [];
const warn = console.warn;
console.warn = (...a: unknown[]) => {
  const m = a.map(String).join(" ");
  if (/fell back/.test(m)) fellBack.push(m);
  warn(...a);
};

const results: { check: string; ok: boolean; ms: number; detail: string; output?: unknown }[] = [];
async function check<T>(name: string, run: () => Promise<T>, verify: (v: T) => string | null) {
  const t0 = Date.now();
  fellBack.length = 0;
  try {
    const v = await run();
    const problem = fellBack.length ? `fell back to rules: ${fellBack.join("; ")}` : verify(v);
    results.push({ check: name, ok: !problem, ms: Date.now() - t0, detail: problem ?? "", output: v });
    console.log(`${problem ? "✖" : "✔"} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${problem ? `: ${problem}` : ""}`);
    return v;
  } catch (e) {
    results.push({ check: name, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
    console.log(`✖ ${name}: threw ${(e as Error).message}`);
    return null;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(here, "../../../samples/alex_morgan_resume.txt"), "utf8");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const PLACEHOLDER = /\[[A-Z][^\]]{2,40}\]|\{[a-z_]+\}|<[A-Z ]{3,}>|Lorem|XX+/;

// 1. Résumé parsing: same employers as the rule-based parse, nothing invented.
const parsed = await check(
  "résumé parse",
  () => parseResume(text),
  (p) => {
    if (p.method !== "llm") return `fell back to rules (${p.method})`;
    const want = heuristicParse(text).doc.experience.map((e) => e.company).sort();
    const got = p.doc.experience.map((e) => e.company).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) return `employers ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`;
    if (!p.doc.experience.every((e) => e.bullets.length)) return "a role lost its bullets";
    if (!p.contact.email?.includes("@")) return "no email";
    return null;
  },
);
const doc = normalizeDoc(parsed?.doc ?? heuristicParse(text).doc);

const user = createUser("qa@ferry.local", "Alex Morgan");
const p = getUser(user.id)!.profile;
updateProfile(user.id, {
  ...p,
  personal: { ...p.personal, firstName: "Alex", lastName: "Morgan", email: "qa@example.com", city: "San Francisco", region: "CA", country: "US" },
  workAuth: { authorizedCountries: ["US"], needsSponsorship: false, citizenship: "US" },
  logistics: { ...p.logistics, yearsOfExperience: 6 },
  preferences: { ...p.preferences, titles: ["Senior Software Engineer"], workplace: "any" },
});
saveResume({ userId: user.id, name: "Software Engineer", filePath: null, fileName: null, text, doc, isDefault: true });
const u = getUser(user.id)!;

const job = (title: string, company: string, description: string) =>
  upsertJob({ companyId: null, company, ats: "mock", externalId: `${company}:${title}`, title, location: "San Francisco, CA", workplace: "hybrid", url: `https://example.com/${encodeURIComponent(title)}`, applyUrl: `https://example.com/${encodeURIComponent(title)}`, description, sponsorsVisa: null }).job;
const good = job(
  "Senior Software Engineer, Platform",
  "Acme Robotics",
  `Acme Robotics builds fleet software for warehouse robots.
What you'll do: build distributed services in TypeScript and Go; own REST and GraphQL APIs; run PostgreSQL, Redis and Kafka on AWS with Kubernetes and Terraform; improve observability.
What we're looking for: 5+ years building backend systems; TypeScript or Go; distributed systems; CI/CD. Nice to have: React.`,
);
const bad = job("Registered Nurse, ICU", "Mercy Health", "Provide direct patient care in the ICU. Requires an active RN license, BLS and ACLS certification, and 2+ years of critical care nursing.");

// 2. Matching: a strong fit scores well above an unrelated role, with reasons.
await check(
  "match scoring",
  async () => [await llmMatch(u, doc, good), await llmMatch(u, doc, bad)] as const,
  ([g, b]) => {
    if (g.score < 70) return `good fit scored ${g.score}`;
    if (b.score > 30) return `nursing role scored ${b.score}`;
    if (!g.reasons.length) return "no reasons";
    return null;
  },
);

// 3. Tailoring: rewritten for the job, same history, no invented numbers.
const tailored = await check(
  "tailoring (honest)",
  () => tailorResume(doc, good, "honest"),
  (t) => {
    const key = (d: typeof doc) => d.experience.map((e) => `${e.company}|${e.title}|${e.start}|${e.end ?? ""}`).join("\n");
    if (key(t.tailored) !== key(doc)) return `history changed:\n${key(t.tailored)}`;
    const invented = newNumbers(doc, t.tailored, "");
    if (invented.length) return `new numbers: ${invented.join(", ")}`;
    // Nothing the posting says and the résumé doesn't ("Improved observability of fleet services").
    const g = groundingFor(doc, good);
    const lines: [string, Set<string> | undefined][] = [
      [t.tailored.headline ?? "", undefined],
      [t.tailored.summary ?? "", undefined],
      ...t.tailored.experience.flatMap((e) => e.bullets.map((b): [string, Set<string>] => [b, roleWords(doc.experience.find((x) => x.id === e.id)!)])),
    ];
    const claims = lines.flatMap(([l, role]) => {
      const c = borrowedClaims(l, g.source, g.job, "honest", role);
      return c.length ? [`"${l}" (${c.join(", ")})`] : [];
    });
    if (claims.length) return `claims from the posting: ${claims.join("; ")}`;
    const skills = t.tailored.skills.filter((k) => !g.text.toLowerCase().includes(k.toLowerCase()));
    if (skills.length) return `skills the résumé doesn't show: ${skills.join(", ")}`;
    if (t.method !== "llm") return `method ${t.method}`;
    if (!t.changes.length) return "nothing changed";
    return null;
  },
);
if (tailored) console.log(`   ${tailored.changes.length} changes, ${tailored.held?.length ?? 0} rewrites refused for borrowing from the posting; ATS keyword score ${tailored.atsScore.before} → ${tailored.atsScore.after}`);

// 4. Cover letter: names the company, sensible length, no placeholders.
await check(
  "cover letter",
  () => writeCoverLetter(u.profile, doc, good, "honest"),
  (l) => {
    if (!l) return "empty";
    if (!/Acme Robotics/.test(l)) return "doesn't name the company";
    if (PLACEHOLDER.test(l)) return `placeholder: ${l.match(PLACEHOLDER)![0]}`;
    if (words(l) < 70 || words(l) > 300) return `${words(l)} words`;
    return null;
  },
);

// 5. Written answers: company-specific, no placeholders, within length.
await check(
  "written answers",
  () =>
    writeAnswers({ profile: u.profile, doc, job: good, notes: "" }, [
      { field: { id: "why", label: "Why do you want to work at Acme Robotics?", kind: "textarea", required: true }, entry: null },
      { field: { id: "proud", label: "Tell us about a project you're proud of.", kind: "textarea", required: true, maxLength: 1000 }, entry: null },
    ]),
  (w) => {
    const why = w.find((x) => x.id === "why");
    const proud = w.find((x) => x.id === "proud");
    if (!why?.value || why.method !== "llm") return `why: ${why?.method ?? "missing"}`;
    if (!/Acme/.test(why.value)) return "the why-answer doesn't name Acme";
    if (proud && proud.value.length > 1000) return `proud: ${proud.value.length} chars > 1000`;
    // "A project you're proud of" is about the candidate's own work.
    if (proud && !doc.experience.some((e) => proud.value.includes(e.company))) return "the proud-answer names none of the candidate's employers";
    for (const x of w) if (PLACEHOLDER.test(x.value)) return `placeholder in ${x.id}`;
    return null;
  },
);

// 6. Prompt-to-modify: turns a request into edits.
await check(
  "prompt to modify",
  () => modifyResume(doc, "Keep it to one page and put skills before experience"),
  (r) => {
    if (r.method !== "llm") return `method ${r.method}`;
    if (!r.changes.length) return `no edits: ${r.reply}`;
    const order = r.doc.layout.sectionOrder;
    if (order.indexOf("skills") > order.indexOf("experience")) return `skills still after experience: ${order.join(", ")}`;
    return r.warnings.length ? `warnings: ${r.warnings.join("; ")}` : null;
  },
);

// 7. Inbox: categories for typical recruiter email.
await check(
  "email classification",
  async () => {
    const mails = [
      { fromAddr: "recruiting@acmerobotics.com", fromName: "Acme Recruiting", subject: "Interview invitation: Senior Software Engineer", body: "Hi Alex, we'd like to schedule a 45-minute technical interview next week. Please pick a time from the link below." },
      { fromAddr: "no-reply@greenhouse.io", fromName: "Acme Robotics", subject: "Thank you for applying to Acme Robotics", body: "We received your application for Senior Software Engineer, Platform. Our team will review it." },
      { fromAddr: "talent@globex.com", fromName: "Globex Talent", subject: "Update on your application", body: "Thank you for your interest. After careful consideration we have decided to move forward with other candidates." },
      { fromAddr: "newsletter@jobsdigest.com", fromName: "Jobs Digest", subject: "10 hot jobs this week", body: "Check out this week's trending roles in tech." },
    ];
    for (const m of mails) await ingestEmail(u.id, m);
    return all<{ subject: string; category: string }>("SELECT subject, category FROM inbox_messages WHERE user_id = ? ORDER BY rowid", u.id);
  },
  (rows) => {
    const cat = (s: string) => rows.find((r) => r.subject.startsWith(s))?.category;
    const want: [string, RegExp][] = [
      ["Interview", /interview/],
      ["Thank you for applying", /confirm|applied|received/],
      ["Update on", /reject/],
    ];
    const wrong = want.filter(([s, re]) => !re.test(cat(s) ?? "")).map(([s]) => `${s} → ${cat(s)}`);
    if (rows.some((r) => r.subject.startsWith("10 hot jobs"))) wrong.push("newsletter kept as job mail");
    return wrong.length ? wrong.join("; ") : null;
  },
);

const ok = results.filter((r) => r.ok).length;
console.log(`\n${ok}/${results.length} passed with ${llmLabel()}; total ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(0)}s`);
// Every output, for reading: passing the checks isn't the same as reading well.
const report = process.env.QA_REPORT ?? path.join(process.env.DATA_DIR!, "qa-report.json");
fs.writeFileSync(report, JSON.stringify({ model: llmLabel(), results }, null, 2));
console.log(`Outputs: ${report}`);
process.exit(ok === results.length ? 0 : 1);
