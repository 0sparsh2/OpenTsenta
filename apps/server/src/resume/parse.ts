import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { structured, withFallback } from "../llm.ts";
import { extractSkills } from "../match/keywords.ts";
import JSZip from "jszip";
import type { Education, Experience, Profile, Project, ResumeDoc, ResumeFont } from "../types.ts";
import { truncate } from "../util/text.ts";

const rid = () => crypto.randomBytes(4).toString("hex");

export async function fileToText(filePath: string, fileName: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const laid = await pdfText(buf).catch(() => "");
    if (laid.trim()) return normalize(laid);
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

/** Anchor words whose link target is the real content ("link" after a project, "GitHub" in the header). */
const ANCHOR_WORDS = "link|links|github|git ?hub|linkedin|portfolio|website|site|demo|live|code|repo|paper|here|project";
const ANCHOR = new RegExp(`^(${ANCHOR_WORDS})$`, "i");

type PdfItem = { s: string; x: number; y: number; w: number; h: number };

/**
 * The x of a column gutter: a left edge in the middle of the page that many lines start at, several of them beside
 * text on the left (a sidebar next to the main column). Right-aligned dates start near the right edge at varying x.
 */
function columnGutter(lines: PdfItem[][], width: number): number | null {
  if (!lines.length) return null;
  const starts = new Map<number, { all: number; beside: number; top: number; bottom: number }>();
  const bump = (it: PdfItem, beside: boolean) => {
    if (it.x < width * 0.25 || it.x > width * 0.7) return;
    const k = Math.round(it.x / 6);
    const v = starts.get(k) ?? { all: 0, beside: 0, top: -Infinity, bottom: Infinity };
    v.all++;
    if (beside) v.beside++;
    v.top = Math.max(v.top, it.y);
    v.bottom = Math.min(v.bottom, it.y);
    starts.set(k, v);
  };
  for (const line of lines) {
    bump(line[0], false);
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1];
      if (line[i].x - (prev.x + prev.w) > Math.min(prev.h, line[i].h) * 2.5) bump(line[i], true);
    }
  }
  // A real second column runs down a good part of the page, not just a small table at the bottom.
  const height = lines[0][0].y - lines[lines.length - 1][0].y || 1;
  const best = [...starts.entries()].filter(([, v]) => v.all >= 4 && v.beside >= 3 && (v.top - v.bottom) / height >= 0.3).sort((a, b) => b[1].all - a[1].all)[0];
  return best ? best[0] * 6 - 4 : null;
}

/** Group items into lines (same baseline), left to right. */
function toLines(list: PdfItem[]): PdfItem[][] {
  const sorted = [...list].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: PdfItem[][] = [];
  for (const it of sorted) {
    const line = out[out.length - 1];
    if (line && Math.abs(line[0].y - it.y) <= Math.max(2, Math.min(line[0].h, it.h) * 0.4)) line.push(it);
    else out.push([it]);
  }
  out.forEach((l) => l.sort((a, b) => a.x - b.x));
  return out;
}

/** Swap an anchor word ("link", "GitHub") under a link annotation for the link's URL. */
function placeLink(items: PdfItem[], rect: number[], url: string) {
  const [x1, y1, x2, y2] = rect;
  const cx = (x1 + x2) / 2;
  for (const it of items) {
    if (it.y < y1 - 3 || it.y > y2 + 3 || it.x > x2 + 1 || it.x + it.w < x1 - 1) continue;
    if (ANCHOR.test(it.s.trim())) {
      it.s = it.s.replace(it.s.trim(), url);
      return;
    }
    // The anchor inside a longer run of text: the occurrence closest to the link's middle.
    const words = [...it.s.matchAll(new RegExp(`\\b(${ANCHOR_WORDS})\\b`, "gi"))];
    const at = (m: RegExpMatchArray) => it.x + ((m.index! + m[0].length / 2) / Math.max(1, it.s.length)) * it.w;
    const best = words.sort((a, b) => Math.abs(at(a) - cx) - Math.abs(at(b) - cx))[0];
    if (best && Math.abs(at(best) - cx) <= Math.max(12, (x2 - x1) * 1.5)) {
      it.s = it.s.slice(0, best.index) + url + it.s.slice(best.index! + best[0].length);
      return;
    }
  }
}

/** Lines of one column as text: " | " at wide gaps; "◦ " before indented lines when list bullets are drawn, not typed. */
function linesToText(lines: PdfItem[][], markIndent: boolean): string[] {
  const left0 = Math.min(...lines.map((l) => l[0].x));
  const right = Math.max(...lines.map((l) => l[l.length - 1].x + l[l.length - 1].w));
  // Centered lines (name, section headings) have about the same space on both sides.
  const isCentered = (l: PdfItem[]) => {
    const a = l[0].x - left0;
    const b = right - (l[l.length - 1].x + l[l.length - 1].w);
    return a > 20 && Math.abs(a - b) < 10;
  };
  const body = lines.filter((l) => !isCentered(l));
  const left = body.length ? Math.min(...body.map((l) => l[0].x)) : left0;
  return lines.map((line) => {
    let out = line[0].s;
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1];
      const gap = line[i].x - (prev.x + prev.w);
      const h = Math.min(prev.h, line[i].h) || 9;
      out += prev.w && gap > h * 2.5 ? " | " : gap > h * 0.12 || !prev.w ? " " : "";
      out += line[i].s;
    }
    const centered = !body.includes(line);
    return markIndent && !centered && line[0].x - left > 6 && !/^[•●▪‣⁃◦\-*]/.test(out.trim()) ? `◦ ${out}` : out;
  });
}

/**
 * PDF text line by line from the page layout, which plain extraction flattens:
 * - " | " where a wide gap separates columns (a right-aligned date or location after the company and title);
 * - the URL in place of an anchor word that links somewhere ("link" → https://github.com/you/project);
 * - two-column layouts read one column at a time.
 */
async function pdfText(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pages: { items: PdfItem[]; width: number }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: it.height || Math.abs(it.transform[3]) || 10 });
    }
    const annots = (await page.getAnnotations().catch(() => [])) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[];
    for (const a of annots) {
      const url = a.url ?? a.unsafeUrl;
      if (a.subtype === "Link" && url && /^https?:/i.test(url) && a.rect) placeLink(items, a.rect, url);
    }
    pages.push({ items, width: page.getViewport({ scale: 1 }).width });
  }
  // Bullets drawn as shapes leave no "•" in the text; then indentation is the only sign of a list item.
  const typedBullets = pages.some((p) => p.items.some((i) => /^\s*[•●▪‣⁃◦]/.test(i.s)));
  const out: string[] = [];
  for (const { items, width } of pages) {
    let chunks = [toLines(items)];
    const gutter = columnGutter(chunks[0], width);
    if (gutter) {
      const all = chunks[0];
      const crosses = (i: PdfItem) => i.x < gutter && i.x + i.w > gutter + 2;
      const firstSplit = all.findIndex((l) => l.some((i) => i.x >= gutter) && !l.some(crosses));
      const top = firstSplit > 0 ? all.slice(0, firstSplit).flat() : [];
      const rest = items.filter((i) => !top.includes(i));
      chunks = [toLines(top), toLines(rest.filter((i) => i.x < gutter)), toLines(rest.filter((i) => i.x >= gutter))];
    }
    for (const c of chunks) if (c.length) out.push(...linesToText(c, !typedBullets));
  }
  return out.join("\n");
}

const FONT_MAP: [RegExp, ResumeFont][] = [
  [/calibri|carlito/i, "calibri"],
  [/arial|helvetica|arimo|liberation ?sans/i, "arial"],
  [/times|tinos|liberation ?serif/i, "times"],
  [/georgia|gelasio/i, "georgia"],
  [/garamond/i, "garamond"],
];
const fontOf = (name?: string | null) => (name ? FONT_MAP.find(([re]) => re.test(name))?.[1] : undefined);

/** The typeface most of an uploaded résumé is set in, when Ferry has it (Calibri, Arial, Times, Georgia, Garamond). */
export async function detectFont(filePath: string, fileName: string): Promise<ResumeFont | undefined> {
  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)));
      const tally = new Map<ResumeFont, number>();
      for (let n = 1; n <= Math.min(pdf.numPages, 2); n++) {
        const page = await pdf.getPage(n);
        await page.getOperatorList(); // loads the fonts, so their real names are known
        const content = await page.getTextContent();
        for (const it of content.items as { str?: string; fontName?: string }[]) {
          if (!it.str?.trim() || !it.fontName) continue;
          let name: string | undefined;
          try {
            name = (page.commonObjs.get(it.fontName) as { name?: string } | undefined)?.name;
          } catch {
            /* font not loaded */
          }
          const f = fontOf(name);
          if (f) tally.set(f, (tally.get(f) ?? 0) + it.str.length);
        }
      }
      return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    if (lower.endsWith(".docx")) {
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const doc = (await zip.file("word/document.xml")?.async("string")) ?? "";
      const styles = (await zip.file("word/styles.xml")?.async("string")) ?? "";
      const counts = new Map<string, number>();
      for (const m of doc.matchAll(/<w:rFonts [^>]*w:ascii="([^"]+)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      const named = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? styles.match(/<w:docDefaults>[\s\S]*?w:ascii="([^"]+)"/)?.[1];
      return fontOf(named);
    }
  } catch {
    /* unreadable: keep the template's font */
  }
  return undefined;
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
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "") // zero-width marks Google Docs leaves at tab stops
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
// Used when Claude isn't configured. Handles the common layouts: "Company | Title | Location   Dates" headers,
// wrapped bullets, "Label: a, b, c" skill groups, project lines with links, and one-line education entries.

type Bucket = "header" | "experience" | "education" | "skills" | "projects" | "summary" | "certifications" | "other";
const SECTION_RE: [Bucket, RegExp][] = [
  ["experience", /^(professional |work |relevant |industry )?(experience|employment( history)?|work history|career history)$/i],
  ["education", /^(education|academics?|academic background)$/i],
  ["skills", /^(technical |core |key )?(skills|technologies|tech stack|tools|competencies)( (&|and) (tools|technologies|interests))?$/i],
  ["projects", /^((selected |personal |side |academic |open[- ]source )?projects|open[- ]source( work| contributions)?)( ?(\/|&|and) ?(volunteer(ing)?|activities|leadership|open[- ]source|research))?$/i],
  ["summary", /^(summary|profile|about|about me|objective|(professional|career) (summary|profile))$/i],
  ["certifications", /^(certifications?|certificates|licenses?( (&|and) certifications)?)$/i],
  ["other", /^(awards?|honors?( (&|and) awards)?|publications|volunteer(ing| experience| work)?|leadership|activities|interests|languages|achievements)$/i],
];
const sectionOf = (line: string): Bucket | null => {
  const bare = line.replace(/[:|\s]+$/, "").trim();
  return bare.length <= 45 ? (SECTION_RE.find(([, re]) => re.test(bare))?.[0] ?? null) : null;
};

const DATE_RANGE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}|present|current|now)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const BULLET = /^[•\-*▪◦]\s*/;
const URL_RE = /\bhttps?:\/\/[^\s|·,)]+|\b(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co)\/[^\s|·,)]+/i;
const bareUrl = (u?: string) => u?.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

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

const looksTitle = (s: string) =>
  /engineer|developer|manager|designer|analyst|scientist|intern|lead|director|consultant|associate|specialist|founder|researcher|architect|officer|assistant|fellow|administrator|programmer|head of|vp\b/i.test(s);
/** "Seattle, WA, USA", "Remote, India", "Remote", "New York, NY". */
const isLocation = (s: string) =>
  !looksTitle(s) &&
  (/^(remote|hybrid|on-?site)\b[\w ,.()-]{0,30}$/i.test(s) || /^[A-Z][a-zA-Z .'-]{1,30},\s*([A-Z]{2}|[A-Z][a-zA-Z .'-]{2,30})(,\s*[A-Z][a-zA-Z .'-]{1,30})?$/.test(s));
/** Split an entry header on its separators ("Company | Title | Location", "Title – Company"). */
const headParts = (s: string) =>
  s
    .split(/\s+\|\s+|\s+[–—-]\s+|\s+·\s+|\s+@\s+|\s+at\s+(?=[A-Z])/)
    .map((x) => x.replace(/^[|,–—-\s]+|[|,–—-\s]+$/g, "").trim())
    .filter(Boolean);

/** A line that continues the bullet before it (a wrapped line), rather than starting a new entry. */
const continues = (line: string, prev: string) =>
  !DATE_RANGE.test(line) && !/\s\|\s/.test(line) && (!/[.!?]["')\]]?$/.test(prev) || /^[a-z(]/.test(line) || /[.!?]$/.test(line) || line.length > 60);

/** Split on commas/semicolons that aren't inside parentheses: "AgentCore (Runtime, Memory), MCP" → 2 items. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if ((ch === ")" || ch === "]") && depth) depth--;
    if (!depth && /[,;•|]/.test(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim()).filter((x) => x && x.length < 80);
}

/** "Master of Science in Data Science" → Master of Science / Data Science; "B.S. in CS, 2019" → B.S. / CS. */
function degreeField(s: string): { degree: string; field?: string } {
  const clean = s.replace(/[,|].*$/, "").trim();
  const m = clean.match(/^(.+?)\s+in\s+(.+)$/i) ?? clean.match(/^((?:bachelor|master|doctor|associate)'?s?)\s+of\s+(.+)$/i);
  return m ? { degree: m[1].trim(), field: m[2].trim() } : { degree: clean };
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : s);

export function heuristicParse(text: string): ParsedResume {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const buckets: Record<Bucket, string[]> = { header: [], experience: [], education: [], skills: [], projects: [], summary: [], certifications: [], other: [] };
  let cur: Bucket = "header";
  for (const line of lines) {
    const hit = sectionOf(line);
    if (hit) {
      cur = hit;
      continue;
    }
    buckets[cur].push(line);
  }

  // ---- contact and summary (the header) ----
  const header = buckets.header.join("\n");
  const email = header.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = (header.match(/(\+?\(?\d[\d\s().-]{8,}\d)/) ?? text.match(/(\+?\(?\d[\d\s().-]{8,}\d)/))?.[1];
  const loc = header.match(/(?:^|[·|•\n]\s*)([A-Z][a-zA-Z .'-]+),\s*([A-Z]{2})\b(?!\w)/);
  const linkedin = bareUrl(text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i)?.[0]);
  const github = bareUrl(header.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i)?.[0] ?? text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+(?=[\s|]|$)/im)?.[0]);
  const nameLine = buckets.header.find((l) => /^[A-Za-z][A-Za-z.'-]+(\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(l)) ?? "";
  const [firstName = "", ...rest] = titleCase(nameLine).split(/\s+/);
  // An unlabeled paragraph under the contact line is the summary.
  const prose = buckets.header.filter((l) => l !== nameLine && l.length > 50 && !/@|linkedin\.com|github\.com|\+?\d[\d\s().-]{8,}\d|\s\|\s.*\s\|\s/.test(l));
  const summary = [...buckets.summary, ...(buckets.summary.length ? [] : prose)].join(" ").replace(/\s+/g, " ").trim() || undefined;

  // ---- experience ----
  const experience: Experience[] = [];
  let curExp: Experience | null = null;
  const pending: string[] = [];
  for (const line of buckets.experience) {
    const isBullet = BULLET.test(line);
    const dr = line.match(DATE_RANGE);
    const last = curExp?.bullets[curExp.bullets.length - 1];
    if (dr && !isBullet) {
      const parts = [...pending, line.replace(DATE_RANGE, "")].flatMap(headParts);
      pending.length = 0;
      let location: string | undefined;
      for (let i = parts.length - 1; i > 0; i--)
        if (isLocation(parts[i])) {
          location = parts.splice(i, 1)[0];
          break;
        }
      const [a = "", b = ""] = parts;
      const [title, company] = looksTitle(a) || !looksTitle(b) ? [a, b] : [b, a];
      curExp = { id: rid(), title, company, location, start: toYm(dr[1]), end: toYm(dr[2]), current: /present|current|now/i.test(dr[2]), bullets: [] };
      experience.push(curExp);
    } else if (isBullet && curExp && last && line.startsWith("◦") && /^[a-z(]/.test(line.replace(BULLET, ""))) {
      curExp.bullets[curExp.bullets.length - 1] = `${last} ${line.replace(BULLET, "")}`; // a wrapped line of a drawn bullet
    } else if (isBullet && curExp) {
      curExp.bullets.push(line.replace(BULLET, ""));
    } else if (curExp && last && continues(line, last)) {
      curExp.bullets[curExp.bullets.length - 1] = `${last} ${line}`;
    } else {
      pending.push(line);
      if (pending.length > 2) pending.shift();
    }
  }

  // ---- projects ----
  const projects: Project[] = [];
  let curProj: Project | null = null;
  const extra: string[] = []; // "Additional: A (…) link · B (…) link", possibly wrapped
  for (const line of buckets.projects) {
    if (extra.length && !BULLET.test(line) && !DATE_RANGE.test(line)) {
      extra.push(line);
      continue;
    }
    if (/^(additional|other|more)( projects)?\s*:/i.test(line)) {
      extra.push(line.replace(/^[^:]+:\s*/, ""));
      curProj = null;
      continue;
    }
    const last = curProj?.bullets[curProj.bullets.length - 1];
    if (curProj && last && line.startsWith("◦") && /^[a-z(]/.test(line.replace(BULLET, ""))) curProj.bullets[curProj.bullets.length - 1] = `${last} ${line.replace(BULLET, "")}`;
    else if (BULLET.test(line) && curProj) curProj.bullets.push(line.replace(BULLET, ""));
    else if (curProj && last && continues(line, last)) curProj.bullets[curProj.bullets.length - 1] = `${last} ${line}`;
    else {
      const dr = line.match(DATE_RANGE);
      const url = line.match(URL_RE)?.[0];
      const stars = line.match(/(\d+)\s*★/)?.[1];
      const forks = line.match(/(\d+)\s*forks?\b/i)?.[1];
      const head = line.replace(DATE_RANGE, "").replace(URL_RE, "").replace(/\d+\s*★|★|\d+\s*forks?\b/gi, "");
      const [name = line, ...desc] = headParts(head);
      const social = [stars && `${stars} ★`, forks && `${forks} forks`].filter(Boolean).join(", ");
      curProj = {
        id: rid(),
        name: name.replace(BULLET, ""),
        description: [desc.join(" – "), social].filter(Boolean).join(" · ") || undefined,
        url: bareUrl(url),
        start: dr ? toYm(dr[1]) : undefined,
        end: dr ? toYm(dr[2]) : undefined,
        bullets: [],
      };
      projects.push(curProj);
    }
  }
  for (const item of extra.join(" ").split(/\s+·\s+/)) {
    const url = item.match(URL_RE)?.[0];
    const m = item.replace(URL_RE, "").trim().match(/^([^()]+?)\s*(?:\((.+)\))?\s*$/);
    if (m?.[1]) projects.push({ id: rid(), name: m[1].trim(), description: m[2]?.trim(), url: bareUrl(url), bullets: [] });
  }

  // ---- education ----
  const education: Education[] = [];
  const eduLines: string[] = [];
  for (const raw of buckets.education) {
    const line = raw.replace(BULLET, "");
    const prev = eduLines[eduLines.length - 1];
    if (prev && /(\s(in|of|and|&)|[-–,])$/i.test(prev)) eduLines[eduLines.length - 1] = `${prev} ${line}`;
    else eduLines.push(line);
  }
  for (const line of eduLines) {
    const only = line.match(/^(?:\|\s*)?((?:[a-z]+\.?\s+)?\d{4})\s*(?:-|–|—|to)\s*((?:[a-z]+\.?\s+)?\d{4}|present|current)$/i) ?? line.match(/^((?:[a-z]+\.?\s+)?\d{4})$/i);
    if (only && education.length && !education[education.length - 1].start) {
      const e = education[education.length - 1];
      if (only[2]) {
        e.start = toYm(only[1]);
        e.end = toYm(only[2]);
      } else e.end = toYm(only[1]);
      continue;
    }
    const dr = line.match(DATE_RANGE);
    const rest = line.replace(DATE_RANGE, "");
    const parts = rest.split(/\s+\|\s+/).map((x) => x.replace(/^[|,\s]+|[|,\s]+$/g, "").trim()).filter(Boolean);
    const location = parts.length > 1 ? parts.slice(1).find(isLocation) : undefined;
    const main = parts.filter((x) => x !== location).join(", ");
    const degreeRe = /bachelor|master|associate|doctor|ph\.?d|\bb\.?s\.?\b|\bm\.?s\.?\b|b\.?tech|m\.?tech|\bb\.?a\.?\b|\bm\.?a\.?\b|b\.?e\.?\b|m\.?eng|mba|degree|diploma/i;
    if (/university|college|institute|school|academy|polytechnic/i.test(main)) {
      const [schoolPart, ...more] = main.split(/\s+[–—-]\s+/);
      const year = dr ? undefined : main.match(/\b(19|20)\d{2}\b/)?.[0];
      const e: Education = { id: rid(), school: schoolPart.replace(/\b(19|20)\d{2}\b/g, "").replace(/[|,–—-]\s*$/, "").trim(), location, start: dr ? toYm(dr[1]) : undefined, end: dr ? toYm(dr[2]) : year };
      const deg = more.join(" – ");
      if (deg && degreeRe.test(deg)) {
        const { degree, field } = degreeField(deg);
        e.degree = degree;
        e.field = field;
      }
      education.push(e);
    } else if (education.length && degreeRe.test(line)) {
      const e = education[education.length - 1];
      const yr = line.match(/\b(19|20)\d{2}\b/)?.[0];
      if (yr && !e.end) e.end = yr;
      const { degree, field } = degreeField(line);
      e.degree = degree;
      e.field = field;
      const gpa = line.match(/gpa[:\s]*([\d.]+)/i)?.[1];
      if (gpa) e.gpa = gpa;
    }
  }

  // ---- skills: "Label: a, b, c" groups; a wrapped line continues the group above it ----
  const groups: { name: string; text: string }[] = [];
  for (const raw of buckets.skills) {
    const line = raw.replace(BULLET, "");
    const m = line.match(/^([A-Za-z][A-Za-z0-9 &/+.()-]{1,40}):\s*(.*)$/);
    if (m) groups.push({ name: m[1].trim(), text: m[2] });
    else if (groups.length && groups[groups.length - 1].name) groups[groups.length - 1].text += ` ${line}`;
    else if (groups.length) groups[groups.length - 1].text += `, ${line}`;
    else groups.push({ name: "", text: line });
  }
  const skillGroups = groups.filter((g) => g.name).map((g) => ({ id: rid(), name: g.name, skills: splitTop(g.text) }));
  const listed = groups.flatMap((g) => splitTop(g.text));
  // Without a skills section, fall back to well-known skills named in the bullets (used for matching).
  const skills = listed.length ? [...new Set(listed)] : extractSkills(experience.flatMap((e) => e.bullets).join("\n"), true);

  // ---- certifications: "Name – Issuer, 2024" ----
  const certifications = buckets.certifications.map((l) => {
    const line = l.replace(BULLET, "");
    const date = line.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\b(19|20)\d{2}\b/i)?.[0];
    const [name, issuer] = headParts(line.replace(date ?? "", "")).concat(line.split(/,\s+/).slice(1, 2));
    return { id: rid(), name: name ?? line, issuer: issuer && issuer !== name ? issuer : undefined, date: date ? toYm(date) : undefined };
  });

  return {
    doc: {
      summary,
      experience,
      education,
      skills,
      skillGroups: skillGroups.length >= 2 ? skillGroups : undefined,
      projects,
      certifications: certifications.length ? certifications : undefined,
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
