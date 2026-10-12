import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { structured, withFallback } from "../llm.ts";
import { extractSkills } from "../match/keywords.ts";
import type { Education, Experience, Profile, ResumeDoc } from "../types.ts";
import { truncate } from "../util/text.ts";

const rid = () => crypto.randomBytes(4).toString("hex");

export async function fileToText(filePath: string, fileName: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return normalize(text);
  }
  if (lower.endsWith(".docx")) {
    // HTML, not raw text: Word bullets are list numbering, which raw text drops.
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return normalize(htmlToText(value));
  }
  return normalize(buf.toString("utf8"));
}

function htmlToText(html: string) {
  return html
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|li|h[1-6]|tr|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const normalize = (s: string) =>
  s
    .replace(/\r/g, "")
    .replace(/[•●▪‣⁃]/g, "•")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export interface ParsedResume {
  doc: ResumeDoc;
  contact: Partial<Profile["personal"]>;
}

// ---------- LLM parser ----------

const ParseSchema = z.object({
  contact: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string(),
    city: z.string(),
    region: z.string(),
    country: z.string().describe("ISO 3166 alpha-2 if inferable, else empty"),
    linkedin: z.string(),
    github: z.string(),
    website: z.string(),
  }),
  headline: z.string(),
  summary: z.string(),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      start: z.string().describe("YYYY-MM or YYYY"),
      end: z.string().describe("YYYY-MM, YYYY, or empty if current"),
      current: z.boolean(),
      bullets: z.array(z.string()),
    }),
  ),
  education: z.array(z.object({ school: z.string(), degree: z.string(), field: z.string(), start: z.string(), end: z.string(), gpa: z.string() })),
  projects: z.array(z.object({ name: z.string(), description: z.string(), bullets: z.array(z.string()), url: z.string() })),
  skills: z.array(z.string()),
});

async function llmParse(text: string): Promise<ParsedResume> {
  const o = await structured({
    system:
      "You convert résumé text into structured data. Copy wording exactly; never invent employers, dates, or achievements. Use empty strings for unknown fields.",
    effort: "low",
    schema: ParseSchema,
    prompt: `<resume_text>\n${truncate(text, 40000)}\n</resume_text>`,
  });
  const doc: ResumeDoc = {
    headline: o.headline || undefined,
    summary: o.summary || undefined,
    experience: o.experience.map((e) => ({ id: rid(), ...e, location: e.location || undefined, end: e.end || undefined })),
    education: o.education.map((e) => ({ id: rid(), school: e.school, degree: e.degree || undefined, field: e.field || undefined, start: e.start || undefined, end: e.end || undefined, gpa: e.gpa || undefined })),
    projects: o.projects.map((p) => ({ id: rid(), name: p.name, description: p.description || undefined, bullets: p.bullets, url: p.url || undefined })),
    skills: o.skills,
  };
  const c = o.contact;
  return { doc, contact: Object.fromEntries(Object.entries(c).filter(([, v]) => v)) as Partial<Profile["personal"]> };
}

// ---------- heuristic parser ----------

const SECTION_RE: [keyof typeof SECTIONS, RegExp][] = [
  ["experience", /^(professional |work |relevant )?(experience|employment|work history)$/i],
  ["education", /^(education|academics?)$/i],
  ["skills", /^(technical |core )?(skills|technologies|tech stack|tools)( & tools| and tools)?$/i],
  ["projects", /^(projects|selected projects|personal projects)$/i],
  ["summary", /^(summary|profile|about|about me|objective|professional summary)$/i],
];
const SECTIONS = { header: [] as string[], experience: [] as string[], education: [] as string[], skills: [] as string[], projects: [] as string[], summary: [] as string[], other: [] as string[] };

const DATE_RANGE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}|present|current|now)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function toYm(s: string): string | undefined {
  const t = s.toLowerCase().trim();
  if (/present|current|now/.test(t)) return undefined;
  const mY = t.match(/([a-z]+)\.?\s+(\d{4})/);
  if (mY) {
    const mi = MONTHS.indexOf(mY[1].slice(0, 3));
    return mi >= 0 ? `${mY[2]}-${String(mi + 1).padStart(2, "0")}` : mY[2];
  }
  const sl = t.match(/(\d{1,2})\/(\d{4})/);
  if (sl) return `${sl[2]}-${sl[1].padStart(2, "0")}`;
  return t.match(/\d{4}/)?.[0];
}

export function heuristicParse(text: string): ParsedResume {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const buckets = structuredClone(SECTIONS);
  let cur: keyof typeof SECTIONS = "header";
  for (const line of lines) {
    const bare = line.replace(/[:\s]+$/, "");
    const hit = bare.length < 40 ? SECTION_RE.find(([, re]) => re.test(bare)) : undefined;
    if (hit) {
      cur = hit[0];
      continue;
    }
    buckets[cur].push(line);
  }

  const header = buckets.header.join("\n");
  const email = header.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = (header.match(/(\+?\(?\d[\d\s().-]{8,}\d)/) ?? text.match(/(\+?\(?\d[\d\s().-]{8,}\d)/))?.[1];
  const loc = header.match(/(?:^|[·|•\n]\s*)([A-Z][a-zA-Z .'-]+),\s*([A-Z]{2})\b(?!\w)/);
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i)?.[0];
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i)?.[0];
  const nameLine = buckets.header.find((l) => /^[A-Za-z][A-Za-z.'-]+(\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(l)) ?? "";
  const [firstName = "", ...rest] = nameLine.split(/\s+/);

  // Experience: a block starts at a line carrying a date range or after a blank-ish header line.
  const experience: Experience[] = [];
  let curExp: Experience | null = null;
  const pending: string[] = [];
  for (const line of buckets.experience) {
    const isBullet = /^[•\-*▪◦]\s*/.test(line);
    const dr = line.match(DATE_RANGE);
    if (dr && !isBullet) {
      const head = [...pending, line.replace(DATE_RANGE, "").replace(/[|,–—-]\s*$/, "").trim()].filter(Boolean);
      pending.length = 0;
      const [a = "", b = ""] = head.length >= 2 ? [head[0], head[1]] : (head[0] ?? "").split(/\s+(?:at|@|\||–|—|-|,)\s+/);
      const looksTitle = (s: string) => /engineer|developer|manager|designer|analyst|scientist|intern|lead|director|consultant|associate|specialist|founder|researcher/i.test(s);
      const [title, company] = looksTitle(a) || !looksTitle(b) ? [a, b] : [b, a];
      curExp = { id: rid(), title: title.trim(), company: company.trim(), start: toYm(dr[1]), end: toYm(dr[2]), current: /present|current|now/i.test(dr[2]), bullets: [] };
      experience.push(curExp);
    } else if (isBullet && curExp) {
      curExp.bullets.push(line.replace(/^[•\-*▪◦]\s*/, ""));
    } else if (curExp && curExp.bullets.length && line.length > 60) {
      curExp.bullets[curExp.bullets.length - 1] += ` ${line}`;
    } else {
      pending.push(line);
      if (pending.length > 2) pending.shift();
    }
  }

  const education: Education[] = [];
  for (const line of buckets.education) {
    if (/university|college|institute|school|academy/i.test(line)) {
      const dr = line.match(DATE_RANGE) ?? line.match(/(\d{4})/);
      education.push({ id: rid(), school: line.replace(DATE_RANGE, "").replace(/\d{4}/g, "").replace(/[|,–—-]\s*$/, "").trim() });
      if (dr) education[education.length - 1].end = toYm(dr[2] ?? dr[1]);
    } else if (education.length && /bachelor|master|b\.?s\.?|m\.?s\.?|ph\.?d|b\.?tech|m\.?tech|b\.?a\.?|degree/i.test(line)) {
      const e = education[education.length - 1];
      const yr = line.match(/\b(19|20)\d{2}\b/)?.[0];
      if (yr && !e.end) e.end = yr;
      const [deg, field] = line.split(/\s+(?:in|of)\s+/i);
      e.degree = deg.replace(/[,|].*$/, "").trim();
      e.field = field?.replace(/[,|].*$/, "").trim();
      const gpa = line.match(/gpa[:\s]*([\d.]+)/i)?.[1];
      if (gpa) e.gpa = gpa;
    }
  }

  const skillsRaw = buckets.skills.join(", ").replace(/^[A-Za-z &]+:\s*/gm, "");
  const listed = skillsRaw
    .split(/[,;|•\n]/)
    .map((s) => s.replace(/^[A-Za-z &/]+:\s*/, "").trim())
    .filter((s) => s && s.length < 40);
  // Lexicon skills from bullets only (company names like "X Analytics" would add noise).
  const bulletText = experience.flatMap((e) => e.bullets).join("\n");
  const skills = [...new Set([...listed, ...extractSkills(bulletText, true)])];

  return {
    doc: {
      summary: buckets.summary.join(" ") || undefined,
      experience,
      education,
      skills,
      projects: buckets.projects.length ? [{ id: rid(), name: "Projects", bullets: buckets.projects.map((l) => l.replace(/^[•\-*]\s*/, "")) }] : [],
    },
    contact: { firstName, lastName: rest.join(" "), email, phone: phone?.trim(), linkedin, github, city: loc?.[1]?.trim(), region: loc?.[2], country: loc ? "US" : undefined },
  };
}

export async function parseResume(text: string): Promise<ParsedResume & { method: "llm" | "heuristic" }> {
  return withFallback<ParsedResume & { method: "llm" | "heuristic" }>(
    "resume-parse",
    async () => ({ ...(await llmParse(text)), method: "llm" as const }),
    () => ({ ...heuristicParse(text), method: "heuristic" as const }),
  );
}
