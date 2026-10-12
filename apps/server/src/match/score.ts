import { z } from "zod";
import { all, run } from "../db.ts";
import { structured, withFallback } from "../llm.ts";
import { getDefaultResume, listResumes, listUsers, toJob, type User } from "../store.ts";
import { profileUser } from "../resume/profiles.ts";
import { allSkills, plain } from "../resume/model.ts";
import type { Job, MatchResult, ResumeDoc } from "../types.ts";
import { truncate } from "../util/text.ts";
import { ensureDescription } from "../ingest/describe.ts";
import { extractSkills, seniorityDistance, seniorityFromYears, titleSeniority, titleTokens, type Seniority } from "./keywords.ts";

// ---------- deterministic scorer ----------

function yearsOfExperience(doc: ResumeDoc, fallback?: number): number {
  if (fallback != null) return fallback;
  let months = 0;
  for (const e of doc.experience) {
    const s = parseYm(e.start);
    const end = e.current || !e.end || /present|current|now/i.test(e.end) ? new Date() : parseYm(e.end);
    if (s && end) months += Math.max(0, (end.getFullYear() - s.getFullYear()) * 12 + end.getMonth() - s.getMonth());
  }
  return Math.round((months / 12) * 10) / 10;
}
function parseYm(s?: string): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{4})(?:[-/.](\d{1,2}))?/);
  if (m) return new Date(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, 1);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const hit = a.filter((x) => B.has(x)).length;
  return hit / Math.max(a.length, Math.min(b.length, 4));
};

const COUNTRY_HINTS: Record<string, RegExp> = {
  US: /\b(united states|usa|u\.s\.?|us|americas|north america|new york|nyc|san francisco|sf bay|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|washington,? dc|mountain view|palo alto|menlo park|sunnyvale|san jose|miami|portland|ca|ny|tx|wa|ma|co|il|ga)\b/i,
  CA: /\b(canada|toronto|vancouver|montreal|ottawa|north america)\b/i,
  GB: /\b(united kingdom|uk|england|london|manchester|edinburgh|emea|europe)\b/i,
  IE: /\b(ireland|dublin|emea|europe)\b/i,
  DE: /\b(germany|berlin|munich|emea|europe)\b/i,
  FR: /\b(france|paris|emea|europe)\b/i,
  NL: /\b(netherlands|amsterdam|emea|europe)\b/i,
  ES: /\b(spain|madrid|barcelona|emea|europe)\b/i,
  PL: /\b(poland|warsaw|krakow|emea|europe)\b/i,
  IN: /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|delhi|gurgaon|gurugram|noida|chennai|apac)\b/i,
  SG: /\b(singapore|apac)\b/i,
  AU: /\b(australia|sydney|melbourne|apac)\b/i,
  JP: /\b(japan|tokyo|apac)\b/i,
  BR: /\b(brazil|s[aã]o paulo|latam)\b/i,
  MX: /\b(mexico|latam)\b/i,
};
const ANYWHERE = /\b(anywhere|worldwide|global|international)\b/i;

/** Countries a posting's location string names (empty = unknown). */
export function jobCountries(location: string): string[] {
  if (!location || ANYWHERE.test(location)) return [];
  return Object.entries(COUNTRY_HINTS)
    .filter(([, re]) => re.test(location))
    .map(([c]) => c);
}

const skillCache = new Map<string, string[]>();
function jobSkills(job: Job): string[] {
  const key = `${job.id}:${job.description.length}`;
  let s = skillCache.get(key);
  if (!s) {
    s = extractSkills(`${job.title}\n${job.description}`);
    if (skillCache.size > 50000) skillCache.clear();
    skillCache.set(key, s);
  }
  return s;
}

export function heuristicMatch(user: User, doc: ResumeDoc, job: Job): MatchResult {
  const p = user.profile;
  const reasons: string[] = [];
  const gaps: string[] = [];

  if (p.preferences.excludeCompanies.some((c) => c && job.company.toLowerCase().includes(c.toLowerCase()))) {
    return { score: 0, verdict: "poor", reasons: [], gaps: ["Company is on your exclude list"], method: "heuristic" };
  }

  // Title (40)
  const jobTitle = titleTokens(job.title);
  const targets = p.preferences.titles.length ? p.preferences.titles : doc.experience.slice(0, 2).map((e) => e.title);
  const titleSim = Math.max(0, ...targets.map((t) => overlap(titleTokens(t), jobTitle)));
  const titlePts = Math.round(Math.min(1, titleSim * 1.15) * 40);
  if (titleSim >= 0.6) reasons.push(`Title lines up with "${targets.find((t) => overlap(titleTokens(t), jobTitle) === titleSim)}"`);

  // Skills (30)
  const jdSkills = jobSkills(job);
  const mine = new Set([...allSkills(doc), ...extractSkills(resumeText(doc), false)].map((s) => s.toLowerCase()));
  const matched = jdSkills.filter((s) => mine.has(s.toLowerCase()));
  const missing = jdSkills.filter((s) => !mine.has(s.toLowerCase()));
  const skillRatio = jdSkills.length ? matched.length / Math.min(jdSkills.length, 10) : 0.5;
  const skillPts = Math.round(Math.min(1, skillRatio) * 30);
  if (matched.length) reasons.push(`Skills overlap: ${matched.slice(0, 5).join(", ")}`);
  if (missing.length > 2) gaps.push(`Not on your résumé: ${missing.slice(0, 4).join(", ")}`);

  // Seniority (15)
  const jobLevel = titleSeniority(job.title);
  const years = yearsOfExperience(doc, p.logistics.yearsOfExperience);
  const wanted = (p.preferences.seniority as Seniority[]).length ? (p.preferences.seniority as Seniority[]) : [seniorityFromYears(years)];
  const dist = Math.min(...wanted.map((w) => seniorityDistance(w, jobLevel)));
  let senPts = dist === 0 ? 15 : dist === 1 ? 8 : 0;
  if (jobLevel === "intern" && !wanted.includes("intern")) senPts = -30;
  if (dist >= 2) gaps.push(`Level looks ${jobLevel}; you're targeting ${wanted.join("/")}`);

  // Location / workplace (15)
  let sponsorPts = 0;
  let locPts = 7;
  const pref = p.preferences.workplace;
  const loc = `${job.location}`.toLowerCase();
  const prefLocs = p.preferences.locations.map((l) => l.toLowerCase()).filter(Boolean);
  if (job.workplace === "remote" && (pref === "remote" || pref === "any")) {
    locPts = 15;
    reasons.push("Remote");
  } else if (prefLocs.some((l) => loc.includes(l.split(",")[0].trim()))) {
    locPts = 15;
    reasons.push(`In ${job.location}`);
  } else if (pref === "remote" && job.workplace !== "remote") {
    locPts = 0;
    gaps.push(`${job.workplace === "unknown" ? "Not marked remote" : job.workplace}: ${job.location || "location unlisted"}`);
  } else if (prefLocs.length && job.location) {
    locPts = 3;
  }
  // Remote roles are usually restricted to a country too ("Remote - Ireland"), so check them as well.
  const authorized = p.workAuth.authorizedCountries;
  const countries = jobCountries(job.location);
  if (countries.length && !countries.some((c) => authorized.includes(c))) {
    locPts = 0;
    sponsorPts -= 25;
    if (reasons.at(-1) === "Remote") reasons.pop();
    gaps.push(`Hiring in ${countries.slice(0, 3).join("/")}; you're authorized in ${authorized.join(", ") || "—"}`);
  }

  // Sponsorship
  if (p.workAuth.needsSponsorship) {
    if (job.sponsorsVisa === false) {
      sponsorPts -= 25;
      gaps.push("Posting says it does not sponsor visas");
    } else if (job.sponsorsVisa === true) {
      sponsorPts += 5;
      reasons.push("Mentions visa sponsorship");
    }
  }

  // Keywords bonus
  const kw = p.preferences.keywords.filter((k) => k && job.description.toLowerCase().includes(k.toLowerCase()));
  const kwPts = Math.min(5, kw.length * 2);
  if (kw.length) reasons.push(`Mentions ${kw.slice(0, 3).join(", ")}`);

  const score = Math.max(0, Math.min(100, titlePts + skillPts + senPts + locPts + sponsorPts + kwPts));
  return { score, verdict: verdictFor(score), reasons: reasons.slice(0, 4), gaps: gaps.slice(0, 3), method: "heuristic" };
}

export const verdictFor = (s: number): MatchResult["verdict"] => (s >= 80 ? "strong" : s >= 65 ? "good" : s >= 45 ? "stretch" : "poor");

export function resumeText(doc: ResumeDoc): string {
  const visible = <T extends { hidden?: boolean }>(xs: T[] = []) => xs.filter((x) => !x.hidden);
  return [
    plain(doc.headline),
    plain(doc.summary),
    ...visible(doc.experience).flatMap((e) => [`${e.title} at ${e.company} (${e.start ?? ""} – ${e.current ? "present" : (e.end ?? "")})`, plain(e.summary), ...e.bullets.map(plain)]),
    ...visible(doc.education).map((e) => `${e.degree ?? ""} ${e.field ?? ""}, ${e.school}`),
    ...visible(doc.projects).flatMap((p) => [p.name, plain(p.description), ...p.bullets.map(plain)]),
    ...visible(doc.certifications).map((c) => [c.name, c.issuer].filter(Boolean).join(", ")),
    ...(doc.custom ?? []).flatMap((c) => [c.title, ...c.items.flatMap((i) => [plain(i.title), plain(i.subtitle), ...i.bullets.map(plain)])]),
    (doc.coursework ?? []).join(", "),
    allSkills(doc).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- LLM scorer ----------

const MatchSchema = z.object({
  score: z.number().int().describe("0-100 fit score. 85+ = clearly qualified, 65-84 = qualified with minor gaps, 45-64 = stretch, <45 = poor fit"),
  reasons: z.array(z.string()).describe("Up to 4 short, specific reasons this candidate fits, citing résumé evidence"),
  gaps: z.array(z.string()).describe("Up to 3 short, specific gaps or disqualifiers"),
});

const MATCH_SYSTEM = `You are a senior technical recruiter screening candidates for a role.
Score how well the candidate fits the job using only the evidence in the résumé and preferences.
Hard disqualifiers (wrong level by 2+ steps, missing a required license/clearance, location or work authorization that cannot work, explicitly no sponsorship when the candidate needs it) cap the score at 40.
Be concrete and brief; each reason or gap under 15 words.`;

export async function llmMatch(user: User, doc: ResumeDoc, job: Job): Promise<MatchResult> {
  const p = user.profile;
  const out = await structured({
    system: MATCH_SYSTEM,
    effort: "low",
    maxTokens: 4000,
    schema: MatchSchema,
    prompt: `<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location} (${job.workplace})
Salary: ${job.salary ?? "n/a"}
Description:
${truncate(job.description, 9000)}
</job>

<candidate_preferences>
Target titles: ${p.preferences.titles.join(", ") || "n/a"}
Locations: ${p.preferences.locations.join(", ") || "any"}; workplace: ${p.preferences.workplace}
Seniority: ${p.preferences.seniority.join(", ") || "n/a"}
Work authorization: ${p.workAuth.authorizedCountries.join(", ")}; needs sponsorship: ${p.workAuth.needsSponsorship ? "yes" : "no"}
</candidate_preferences>

<resume>
${truncate(resumeText(doc), 9000)}
</resume>`,
  });
  const score = Math.max(0, Math.min(100, Math.round(out.score)));
  return { score, verdict: verdictFor(score), reasons: out.reasons.slice(0, 4), gaps: out.gaps.slice(0, 3), method: "llm" };
}

// ---------- persistence + fan-out ----------

export function saveMatch(userId: string, jobId: string, m: MatchResult) {
  run(
    `INSERT INTO matches(user_id, job_id, score, verdict, reasons, gaps, method, profile_id) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, job_id) DO UPDATE SET score=excluded.score, verdict=excluded.verdict, reasons=excluded.reasons,
     gaps=excluded.gaps, method=excluded.method, profile_id=excluded.profile_id`,
    userId,
    jobId,
    m.score,
    m.verdict,
    JSON.stringify(m.reasons),
    JSON.stringify(m.gaps),
    m.method,
    m.profileId ?? null,
  );
}

type MatchedHook = (user: User, job: Job, m: MatchResult) => void;
const hooks: MatchedHook[] = [];
export const onMatched = (fn: MatchedHook) => hooks.push(fn);

/** Score jobs for one user against each of their profiles. Heuristic for all, then an LLM pass on the most promising. */
export async function matchJobsForUser(user: User, jobs: Job[], opts: { llmBudget?: number; minStore?: number } = {}) {
  const profiles = listResumes(user.id);
  if (!profiles.length) return [];
  const views = profiles.map((p) => ({ p, u: profileUser(user, p) }));
  const minStore = opts.minStore ?? 40;
  // Score in chunks, yielding between them so a full rematch doesn't stall the server.
  const scored: { job: Job; m: MatchResult; view: (typeof views)[number] }[] = [];
  for (let i = 0; i < jobs.length; i += 300) {
    for (const job of jobs.slice(i, i + 300)) {
      let best: (typeof scored)[number] | null = null;
      for (const view of views) {
        const m = heuristicMatch(view.u, view.p.doc, job);
        if (!best || m.score > best.m.score) best = { job, m: { ...m, profileId: view.p.id }, view };
      }
      scored.push(best!);
    }
    if (jobs.length > 300) await new Promise((r) => setImmediate(r));
  }
  scored.sort((a, b) => b.m.score - a.m.score);

  const budget = opts.llmBudget ?? 25;
  const refine = scored.filter((s) => s.m.score >= 50).slice(0, budget);
  await Promise.all(
    refine.map(async (s) => {
      s.m = await withFallback(
        "match",
        async () => {
          s.job = await ensureDescription(s.job);
          return { ...(await llmMatch(s.view.u, s.view.p.doc, s.job)), profileId: s.view.p.id };
        },
        () => s.m,
      );
    }),
  );

  const kept = scored.filter((s) => s.m.score >= minStore);
  for (const s of kept) {
    saveMatch(user.id, s.job.id, s.m);
    for (const h of hooks) h(user, s.job, s.m);
  }
  return kept.sort((a, b) => b.m.score - a.m.score);
}

/** Called after a discovery poll with newly seen job ids. */
export async function matchNewJobs(jobIds: string[]) {
  if (!jobIds.length) return;
  const placeholders = jobIds.map(() => "?").join(",");
  const jobs = all(`SELECT * FROM jobs WHERE id IN (${placeholders})`, ...jobIds).map(toJob);
  for (const user of listUsers()) {
    if (!getDefaultResume(user.id)) continue;
    await matchJobsForUser(user, jobs);
  }
}

/** Full rescore of every open job for a user (after onboarding or a profile change). */
export async function rematchUser(user: User, llmBudget = 30) {
  const jobs = all("SELECT * FROM jobs WHERE closed_at IS NULL ORDER BY first_seen_at DESC LIMIT 20000").map(toJob);
  run("DELETE FROM matches WHERE user_id = ? AND status = 'new'", user.id);
  return matchJobsForUser(user, jobs, { llmBudget });
}
