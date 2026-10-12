import { z } from "zod";
import { structured, withFallback } from "../llm.ts";
import { extractSkills } from "../match/keywords.ts";
import { resumeText } from "../match/score.ts";
import type { AtsScore, Job, OptimizationMode, ResumeChange, ResumeDoc } from "../types.ts";
import { truncate } from "../util/text.ts";
import { allSkills, plain, resolveLayout } from "./model.ts";

export interface TailorOptions {
  /** The profile's standing notes ("lead with infra work"). */
  notes?: string;
  /** One-off instructions from "Redo with instructions". */
  instructions?: string;
}

export interface TailorResult {
  tailored: ResumeDoc;
  changes: ResumeChange[];
  atsScore: AtsScore;
  keywords: string[];
  method: "llm" | "heuristic" | "off";
}

// ---------- ATS scoring ----------

/** Keywords a screener would look for: lexicon skills in the JD plus LLM-extracted must-haves. */
export function jdKeywords(job: Job, extra: string[] = []): string[] {
  const k = new Set([...extractSkills(`${job.title}\n${job.description}`), ...extra]);
  return [...k];
}

export function atsScore(doc: ResumeDoc, keywords: string[]): { score: number; matched: string[]; missing: string[] } {
  const text = resumeText(doc).toLowerCase();
  const has = (k: string) => text.includes(k.toLowerCase());
  const matched = keywords.filter(has);
  const missing = keywords.filter((k) => !has(k));
  const coverage = keywords.length ? matched.length / keywords.length : 1;
  const bullets = doc.experience.flatMap((e) => e.bullets);
  const quantified = bullets.length ? bullets.filter((b) => /\d/.test(b)).length / bullets.length : 0;
  let structure = 0;
  if (doc.summary) structure += 6;
  if (allSkills(doc).length >= 5) structure += 8;
  if (doc.experience.every((e) => e.title && e.company)) structure += 6;
  structure += Math.round(Math.min(1, quantified / 0.4) * 10);
  return { score: Math.round(coverage * 70 + structure), matched, missing };
}

// ---------- deterministic tailoring ----------

function relevance(text: string, keys: string[]) {
  const t = text.toLowerCase();
  return keys.reduce((n, k) => n + (t.includes(k.toLowerCase()) ? 1 : 0), 0) + (/\d/.test(text) ? 0.5 : 0);
}

export function heuristicTailor(doc: ResumeDoc, keys: string[]): { tailored: ResumeDoc; changes: ResumeChange[] } {
  const tailored = structuredClone(doc);
  const changes: ResumeChange[] = [];
  const reorder = (bullets: string[], section: string) => {
    const sorted = [...bullets].sort((a, b) => relevance(plain(b), keys) - relevance(plain(a), keys));
    if (sorted[0] !== bullets[0]) changes.push({ section, before: bullets[0], after: sorted[0], reason: "Moved the most role-relevant bullet to the top" });
    return sorted;
  };
  for (const e of tailored.experience) e.bullets = reorder(e.bullets, `${e.title} · ${e.company}`);
  for (const p of tailored.projects ?? []) p.bullets = reorder(p.bullets, `Project · ${p.name}`);
  const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));
  const byKey = (xs: string[]) => [...xs].sort((a, b) => Number(lowerKeys.has(b.toLowerCase())) - Number(lowerKeys.has(a.toLowerCase())));
  const skills = byKey(tailored.skills);
  if (skills.join() !== tailored.skills.join()) {
    changes.push({ section: "Skills", before: tailored.skills.slice(0, 6).join(", "), after: skills.slice(0, 6).join(", "), reason: "Listed skills the posting asks for first" });
    tailored.skills = skills;
  }
  for (const g of tailored.skillGroups ?? []) g.skills = byKey(g.skills);
  return { tailored, changes };
}

/** "Keep it to one page" → pageLimit 1. Applied before tailoring, whichever path runs. */
export function layoutFromInstructions(doc: ResumeDoc, text = ""): ResumeDoc {
  const t = text.toLowerCase();
  const limit = /\b(one|1|single)[- ]page\b/.test(t) ? 1 : /\b(two|2)[- ]pages?\b/.test(t) ? 2 : null;
  if (limit == null) return doc;
  const layout = resolveLayout(doc);
  return { ...doc, layout: { ...layout, style: { ...layout.style, pageLimit: limit } } };
}

/** Words worth boosting from free-text guidance ("emphasize Kubernetes and on-call"). */
function guidanceKeys(text = ""): string[] {
  return extractSkills(text);
}

// ---------- LLM tailoring ----------

const TailorSchema = z.object({
  must_have_keywords: z.array(z.string()).describe("Up to 15 concrete skills/tools/qualifications the posting requires, in the posting's wording"),
  headline: z.string().describe("Short headline under the name, or empty to keep none"),
  summary: z.string().describe("2-3 sentence summary aimed at this role"),
  experience: z.array(
    z.object({
      id: z.string(),
      bullets: z.array(z.object({ text: z.string(), original_index: z.number().int().describe("index of the source bullet, -1 if merged/new"), reason: z.string() })),
    }),
  ),
  projects: z.array(z.object({ id: z.string(), bullets: z.array(z.object({ text: z.string(), original_index: z.number().int(), reason: z.string() })) })).describe("Only projects you changed"),
  skills: z.array(z.string()).describe("The candidate's skills reordered for this role; may add a skill only if the résumé clearly shows it was used"),
  skill_groups: z.array(z.object({ id: z.string(), skills: z.array(z.string()) })).describe("If the résumé has skill groups: each group's skills reordered for this role"),
});

const RULES = {
  honest: `Rephrase and reorder only. Keep every fact (employers, titles, dates, numbers, scope) exactly true to the source.
Use the posting's terminology where the candidate's work genuinely matches it. Do not add metrics that are not in the source.`,
  aggressive: `Write the strongest truthful version: lead with outcomes, mirror the posting's language, and surface skills the work clearly implies.
You may merge or split bullets. Never invent employers, titles, dates, credentials, or numbers that are not in the source.`,
};

async function llmTailor(doc: ResumeDoc, job: Job, mode: "honest" | "aggressive", opts: TailorOptions) {
  const { layout: _layout, ...content } = doc;
  const guidance = [opts.notes && `Standing notes from the candidate for roles like this: ${opts.notes}`, opts.instructions && `Instructions for this version (follow them): ${opts.instructions}`]
    .filter(Boolean)
    .join("\n");
  const out = await structured({
    system: `You tailor résumés to a specific job so they pass ATS keyword screens and read well to recruiters.\n${RULES[mode]}\nKeep each bullet under 30 words, start with a strong verb, and keep the same roles. Bullets may use **bold** sparingly for a key result.`,
    effort: "medium",
    schema: TailorSchema,
    prompt: `<job title="${job.title}" company="${job.company}">\n${truncate(job.description, 12000)}\n</job>\n\n<resume_json>\n${JSON.stringify(content)}\n</resume_json>${guidance ? `\n\n<guidance>\n${guidance}\n</guidance>` : ""}`,
  });
  const tailored = structuredClone(doc);
  const changes: ResumeChange[] = [];
  if (out.summary && out.summary !== doc.summary) {
    changes.push({ section: "Summary", before: doc.summary ?? "", after: out.summary, reason: "Re-aimed at this role" });
    tailored.summary = out.summary;
  }
  if (doc.headline && out.headline && out.headline !== doc.headline) {
    changes.push({ section: "Headline", before: doc.headline, after: out.headline, reason: "Matched the role's title" });
    tailored.headline = out.headline;
  }
  const applyBullets = (target: { bullets: string[] } | undefined, src: { bullets: string[] } | undefined, next: { text: string; original_index: number; reason: string }[], section: string) => {
    if (!target || !src || !next.length) return;
    target.bullets = next.map((b) => b.text);
    for (const b of next) {
      const before = b.original_index >= 0 ? (src.bullets[b.original_index] ?? "") : "";
      if (b.text.trim() !== before.trim()) changes.push({ section, before, after: b.text, reason: b.reason });
    }
    const kept = new Set(next.map((b) => b.original_index));
    src.bullets.forEach((b, i) => kept.has(i) || changes.push({ section, before: b, after: "", reason: "Dropped as least relevant to this role" }));
  };
  for (const role of out.experience) {
    const src = doc.experience.find((x) => x.id === role.id);
    applyBullets(tailored.experience.find((x) => x.id === role.id), src, role.bullets, src ? `${src.title} · ${src.company}` : "");
  }
  for (const p of out.projects) {
    const src = doc.projects?.find((x) => x.id === p.id);
    applyBullets(tailored.projects?.find((x) => x.id === p.id), src, p.bullets, src ? `Project · ${src.name}` : "");
  }
  if (out.skills.length) tailored.skills = out.skills;
  for (const g of out.skill_groups) {
    const tg = tailored.skillGroups?.find((x) => x.id === g.id);
    if (tg && g.skills.length) tg.skills = g.skills;
  }
  return { tailored, changes, mustHaves: out.must_have_keywords };
}

export async function tailorResume(source: ResumeDoc, job: Job, mode: OptimizationMode, opts: TailorOptions = {}): Promise<TailorResult> {
  const doc = layoutFromInstructions(source, `${opts.notes ?? ""}\n${opts.instructions ?? ""}`);
  const baseKeys = jdKeywords(job);
  if (mode === "off") {
    const s = atsScore(doc, baseKeys);
    return { tailored: doc, changes: [], atsScore: { before: s.score, after: s.score, matched: s.matched, missing: s.missing }, keywords: baseKeys, method: "off" };
  }
  const boost = guidanceKeys(`${opts.notes ?? ""} ${opts.instructions ?? ""}`);
  const result = await withFallback<{ tailored: ResumeDoc; changes: ResumeChange[]; mustHaves: string[]; method: "llm" | "heuristic" }>(
    "tailor",
    async () => ({ ...(await llmTailor(doc, job, mode, opts)), method: "llm" as const }),
    () => ({ ...heuristicTailor(doc, [...boost, ...baseKeys]), mustHaves: [] as string[], method: "heuristic" as const }),
  );
  const keys = jdKeywords(job, result.mustHaves);
  const before = atsScore(source, keys);
  const after = atsScore(result.tailored, keys);
  return {
    tailored: result.tailored,
    changes: result.changes,
    atsScore: { before: before.score, after: Math.max(after.score, before.score), matched: after.matched, missing: after.missing },
    keywords: keys,
    method: result.method,
  };
}
