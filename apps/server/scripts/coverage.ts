// Job-site coverage sweep: run real postings through the apply agent in dry-run mode and report, per ATS,
// how far it got and what it couldn't fill. Safe by construction:
//   - real submission is forced off (forms are filled, uploads skipped, Submit never clicked);
//   - employer account creation is off (account walls are reported, not passed);
//   - a throwaway database and a fictional persona (example.com email, 555 phone number).
//
//   npx tsx scripts/coverage.ts --ats greenhouse,ashby,lever --per 6
//   npx tsx scripts/coverage.ts --urls postings.txt          (one URL per line; "#" comments ok)
//   flags: --llm (use Claude if ANTHROPIC_API_KEY is set) --concurrency 2 --out report.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true") : fallback;
};
const atsList = (flag("ats", "") ?? "").split(",").filter(Boolean);
const per = Number(flag("per", "5"));
const urlsFile = flag("urls");
const concurrency = Number(flag("concurrency", "2"));
const outFile = flag("out", path.join(os.tmpdir(), `ferry-coverage-${Date.now()}.json`))!;
if (!atsList.length && !urlsFile) {
  console.error("Pass --ats greenhouse,ashby,... and/or --urls file.txt");
  process.exit(1);
}

Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ferry-coverage-")),
  ALLOW_REAL_SUBMIT: "false",
  HEADLESS: process.env.HEADLESS ?? "true",
  POLL_ON_BOOT: "false",
});
if (flag("llm") !== "true") process.env.LLM_DISABLED = "true";

const { createUser, createApplication, getApplication, saveResume, updateProfile, updateSettings, upsertJob, getUser } = await import("../src/store.ts");
const { parseResume } = await import("../src/resume/parse.ts");
const { normalizeDoc } = await import("../src/resume/model.ts");
const { FETCHERS } = await import("../src/ingest/sources.ts");
const { resolveJob } = await import("../src/ingest/jd.ts");
const { processApplication } = await import("../src/apply/engine.ts");
const { closeBrowsers } = await import("../src/browser.ts");
const { detectAts } = await import("../src/ats.ts");
type Job = Awaited<ReturnType<typeof resolveJob>>;

// ---------- persona ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(here, "../../../samples/alex_morgan_resume.txt"), "utf8");
const user = createUser("alex.morgan.coverage@example.com", "Alex Morgan");
const parsed = await parseResume(sample);
saveResume({ userId: user.id, name: "Software Engineer", filePath: null, fileName: null, text: sample, doc: normalizeDoc(parsed.doc), isDefault: true });
const p = getUser(user.id)!.profile;
updateProfile(user.id, {
  ...p,
  personal: { ...p.personal, firstName: "Alex", lastName: "Morgan", email: "alex.morgan.coverage@example.com", phone: "(415) 555-0142", address1: "500 Howard St", city: "San Francisco", region: "CA", postalCode: "94105", country: "US", linkedin: "linkedin.com/in/alex-morgan-example", github: "github.com/alex-morgan-example" },
  workAuth: { authorizedCountries: ["US"], needsSponsorship: false, citizenship: "US" },
  logistics: { yearsOfExperience: 6, salaryExpectation: "$180,000", noticePeriod: "2 weeks", earliestStart: "2 weeks after offer", willingToRelocate: false },
  preferences: { ...p.preferences, titles: ["Software Engineer"] },
});
updateSettings(user.id, { allowAccountCreation: false, autoApproveResume: true, autoApproveCoverLetter: true, coverLetterMode: "off", autoSubmitApplication: false, optimizationMode: "honest" });

// ---------- postings ----------
const shuffle = <T,>(xs: T[]) => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const US = /united states|remote|usa|\bus\b|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|, (ca|ny|wa|tx|ma|il|co)\b/i;

async function pickFromBoards(ats: string, n: number): Promise<Job[]> {
  const fetcher = FETCHERS[ats];
  if (!fetcher) return [];
  const boards = shuffle((JSON.parse(fs.readFileSync(path.join(here, "../src/ingest/boards.json"), "utf8")) as { name: string; ats: string; board: string }[]).filter((b) => b.ats === ats));
  const out: Job[] = [];
  for (const b of boards) {
    if (out.length >= n) break;
    try {
      const jobs = (await fetcher({ id: null, name: b.name, ats, board: b.board })).filter((j) => US.test(j.location) || /remote/i.test(j.workplace));
      const pick = shuffle(jobs)[0];
      if (pick) out.push(upsertJob(pick).job);
    } catch (e) {
      console.warn(`  ${ats}/${b.board}: ${(e as Error).message}`);
    }
  }
  return out;
}

const targets: Job[] = [];
for (const ats of atsList) {
  const jobs = await pickFromBoards(ats, per);
  console.log(`${ats}: ${jobs.length} postings`);
  targets.push(...jobs);
}
if (urlsFile) {
  const urls = fs.readFileSync(urlsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const url of urls) {
    try {
      targets.push(await resolveJob({ url }));
    } catch (e) {
      console.warn(`  ${url}: ${(e as Error).message}`);
    }
  }
  console.log(`urls: ${urls.length} postings`);
}

// ---------- run ----------
interface Row {
  ats: string;
  company: string;
  title: string;
  url: string;
  status: string;
  error: string | null;
  pages: number | null;
  fields: number;
  filled: number;
  required: number;
  requiredFilled: number;
  unfilled: string[];
  files: number;
  failed: string[];
  missing: string[];
  accountWall: boolean;
  captcha: boolean;
  seconds: number;
}
const rows: Row[] = [];
const TIMEOUT = 5 * 60_000;

async function runOne(job: Job) {
  const t0 = Date.now();
  const { app } = createApplication(user.id, job.id, "coverage");
  await Promise.race([processApplication(app.id), new Promise((r) => setTimeout(r, TIMEOUT))]);
  const a = getApplication(app.id)!;
  const real = a.fields.filter((f) => f.kind !== "file");
  const trace = a.trace.map((t) => t.text).join("\n");
  const row: Row = {
    ats: job.ats === "unknown" ? detectAts(job.applyUrl) : job.ats,
    company: job.company,
    title: job.title,
    url: job.url,
    status: a.status,
    error: a.error,
    pages: a.totalPages ?? a.currentPage,
    fields: real.length,
    filled: real.filter((f) => f.value != null && f.value !== "" && !(f.note ?? "").startsWith("Could not fill")).length,
    required: real.filter((f) => f.required).length,
    requiredFilled: real.filter((f) => f.required && f.value != null && f.value !== "" && !(f.note ?? "").startsWith("Could not fill")).length,
    unfilled: real.filter((f) => f.value == null || f.value === "").map((f) => `${f.required ? "*" : " "} ${f.kind}: ${f.label.slice(0, 80)}`),
    files: a.fields.filter((f) => f.kind === "file").length,
    failed: real.filter((f) => (f.note ?? "").startsWith("Could not fill")).map((f) => `${f.kind}: ${f.label.slice(0, 80)}`),
    missing: real.filter((f) => f.required && (f.value == null || f.value === "")).map((f) => `${f.kind}: ${f.label.slice(0, 80)}${f.options?.length ? ` [${f.options.slice(0, 4).join(" | ")}]` : ""}`),
    accountWall: /account|sign in|log in|password/i.test(a.error ?? "") || /Creating your candidate account|Signing in to/.test(trace),
    captcha: /captcha/i.test(`${a.error ?? ""}\n${trace}`),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  rows.push(row);
  console.log(`  ${row.status.padEnd(22)} ${row.ats.padEnd(15)} ${row.company.slice(0, 22).padEnd(23)} required ${String(row.requiredFilled).padStart(2)}/${String(row.required).padEnd(3)} all ${String(row.filled).padStart(3)}/${String(row.fields).padEnd(3)} ${(row.error ?? "").slice(0, 60)}`);
}

const queue = [...targets];
await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runOne(job).catch((e) => console.error("  run failed:", job.url, (e as Error).message));
  }),
);

// ---------- report ----------
const byAts = new Map<string, Row[]>();
for (const r of rows) byAts.set(r.ats, [...(byAts.get(r.ats) ?? []), r]);
console.log("\nATS              postings  reached review  needs input  blocked/failed  required filled  all fields");
for (const [ats, rs] of byAts) {
  const review = rs.filter((r) => r.status === "PENDING_SUBMIT_REVIEW" || r.status === "COMPLETED").length;
  const needs = rs.filter((r) => r.status === "NEEDS_INPUT").length;
  const bad = rs.filter((r) => ["FAILED", "SKIPPED"].includes(r.status)).length;
  const f = rs.reduce((n, r) => n + r.fields, 0);
  const fl = rs.reduce((n, r) => n + r.filled, 0);
  const rq = rs.reduce((n, r) => n + r.required, 0);
  const rqf = rs.reduce((n, r) => n + r.requiredFilled, 0);
  console.log(`${ats.padEnd(17)}${String(rs.length).padEnd(10)}${String(review).padEnd(16)}${String(needs).padEnd(13)}${String(bad).padEnd(16)}${(rq ? `${Math.round((rqf / rq) * 100)}%` : "-").padEnd(17)}${f ? Math.round((fl / f) * 100) : 0}%`);
}
const missing = new Map<string, number>();
for (const r of rows) for (const m of [...r.missing, ...r.failed]) missing.set(m, (missing.get(m) ?? 0) + 1);
console.log("\nMost common unanswered or failed fields:");
for (const [m, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(2)}× ${m}`);
fs.writeFileSync(outFile, JSON.stringify(rows, null, 1));
console.log(`\nReport: ${outFile}`);
await closeBrowsers();
process.exit(0);
