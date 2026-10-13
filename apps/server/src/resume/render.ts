import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getDocumentProxy } from "unpdf";
import { getRenderBrowser } from "../browser.ts";
import { paths } from "../config.ts";
import type { Profile, ResumeDoc, ResumeFont, ResumeLayout, ResumeTemplate, SectionKey } from "../types.ts";
import {
  allSkills,
  applyCuts,
  contactItems,
  dateRange,
  fmtDate,
  href,
  plain,
  resolveLayout,
  runs,
  sectionTitle,
  visibleSections,
} from "./model.ts";

// Single column, real text, no tables or images: every ATS parses it. Spacing and type size are
// CSS variables so a page-fit pass can tighten them in place, measure, and repeat without re-rendering.

const require = createRequire(import.meta.url);

export const FONTS: Record<ResumeFont, { family: string; pkg: string; docx: string; generic: "serif" | "sans-serif"; label: string }> = {
  arial: { family: "Arimo", pkg: "arimo", docx: "Arial", generic: "sans-serif", label: "Arial" },
  times: { family: "Tinos", pkg: "tinos", docx: "Times New Roman", generic: "serif", label: "Times New Roman" },
  calibri: { family: "Carlito", pkg: "carlito", docx: "Calibri", generic: "sans-serif", label: "Calibri" },
  georgia: { family: "Gelasio", pkg: "gelasio", docx: "Georgia", generic: "serif", label: "Georgia" },
  garamond: { family: "EB Garamond", pkg: "eb-garamond", docx: "Garamond", generic: "serif", label: "Garamond" },
};

export interface TemplateSpec {
  label: string;
  font: ResumeFont;
  /** inches: top, right, bottom, left */
  margins: [number, number, number, number];
  nameScale: number;
  nameAlign: "center" | "left";
  heading: "upper" | "smallcaps" | "title";
  accent: string;
  entry: "inline" | "stacked";
  spacing: { section: number; entry: number; bullet: number; lineHeight: number };
}

export const TEMPLATES: Record<ResumeTemplate, TemplateSpec> = {
  classic: { label: "Classic", font: "arial", margins: [0.4, 0.55, 0.4, 0.55], nameScale: 1.9, nameAlign: "center", heading: "upper", accent: "#000000", entry: "inline", spacing: { section: 11, entry: 7, bullet: 2, lineHeight: 1.3 } },
  serif: { label: "Serif", font: "times", margins: [0.5, 0.6, 0.5, 0.6], nameScale: 2.1, nameAlign: "center", heading: "smallcaps", accent: "#000000", entry: "stacked", spacing: { section: 10, entry: 6, bullet: 1.5, lineHeight: 1.25 } },
  modern: { label: "Modern", font: "calibri", margins: [0.5, 0.6, 0.5, 0.6], nameScale: 2.3, nameAlign: "left", heading: "title", accent: "#1f3a5f", entry: "stacked", spacing: { section: 12, entry: 7, bullet: 2, lineHeight: 1.28 } },
  compact: { label: "Compact", font: "arial", margins: [0.3, 0.4, 0.3, 0.4], nameScale: 1.7, nameAlign: "center", heading: "upper", accent: "#000000", entry: "inline", spacing: { section: 7, entry: 4, bullet: 1, lineHeight: 1.2 } },
};

/** Everything the fit pass is allowed to change. */
export interface FitVars {
  fontSize: number;
  lineHeight: number;
  section: number;
  entry: number;
  bullet: number;
  margins: [number, number, number, number];
}

export interface FitResult {
  step: number;
  vars: FitVars;
  /** Ids of blocks removed to meet the page limit (exp:<id>:<i>, proj:<id>, proj:<id>:<i>, sec:<key>). */
  cut: string[];
  pages: number;
  limit: number;
  /** Still longer than the limit after every reduction. */
  overflow: boolean;
}

const MIN_FONT = 9;

/** The compaction ladder: step n applies every reduction up to n. Spacing first, then leading, margins, then type. */
/** Spacing steps before the type gets smaller: section gaps, entry gaps, line height, then margins. */
const SPACING_STEPS = 9;
export function varsAt(layout: ResumeLayout, step: number): FitVars {
  const t = TEMPLATES[layout.style.template];
  const v: FitVars = { fontSize: layout.style.fontSize, lineHeight: t.spacing.lineHeight, section: t.spacing.section, entry: t.spacing.entry, bullet: t.spacing.bullet, margins: [...t.margins] };
  if (step >= 1) v.section = Math.min(v.section, 9);
  if (step >= 2) (v.entry = Math.min(v.entry, 5)), (v.bullet = Math.min(v.bullet, 1.5));
  if (step >= 3) v.section = Math.min(v.section, 7);
  if (step >= 4) v.lineHeight = Math.min(v.lineHeight, 1.22);
  if (step >= 5) (v.entry = Math.min(v.entry, 3)), (v.bullet = Math.min(v.bullet, 0.5));
  if (step >= 6) v.lineHeight = Math.min(v.lineHeight, 1.15);
  if (step >= 7) (v.margins[0] = Math.min(v.margins[0], 0.3)), (v.margins[2] = Math.min(v.margins[2], 0.3));
  if (step >= 8) (v.margins[1] = Math.min(v.margins[1], 0.45)), (v.margins[3] = Math.min(v.margins[3], 0.45)), (v.section = Math.min(v.section, 5));
  // Margins most one-page résumés use when they're full: about a third of an inch.
  if (step >= 9) (v.margins[0] = Math.min(v.margins[0], 0.25)), (v.margins[2] = Math.min(v.margins[2], 0.25)), (v.margins[1] = Math.min(v.margins[1], 0.35)), (v.margins[3] = Math.min(v.margins[3], 0.35));
  const fontSteps = fontStepsOf(layout);
  if (step > SPACING_STEPS) v.fontSize = Math.max(MIN_FONT, v.fontSize - Math.min(step - SPACING_STEPS, fontSteps) * 0.25);
  // Last resorts before anything is cut, one at a time: wider text, then tighter lines, then tighter gaps.
  const extra = step - SPACING_STEPS - fontSteps;
  if (extra >= 1) (v.margins[1] = Math.min(v.margins[1], 0.3)), (v.margins[3] = Math.min(v.margins[3], 0.3));
  if (extra >= 2) (v.lineHeight = Math.min(v.lineHeight, 1.12)), (v.bullet = 0);
  if (extra >= 3) (v.lineHeight = Math.min(v.lineHeight, 1.1)), (v.section = Math.min(v.section, 4)), (v.entry = Math.min(v.entry, 2));
  return v;
}
const fontStepsOf = (layout: ResumeLayout) => Math.max(0, Math.ceil((layout.style.fontSize - MIN_FONT) / 0.25));
export const maxStep = (layout: ResumeLayout) => SPACING_STEPS + fontStepsOf(layout) + 3;

// ---------- fonts ----------

const fontCache = new Map<string, string>();
function fontFile(font: ResumeFont, weight: 400 | 700, style: "normal" | "italic", subset: "latin" | "latin-ext") {
  const { pkg } = FONTS[font];
  return require.resolve(`@fontsource/${pkg}/files/${pkg}-${subset}-${weight}-${style}.woff2`);
}
export function fontFilePath(name: string): string | null {
  const m = name.match(/^([a-z-]+)-(latin|latin-ext)-(400|700)-(normal|italic)\.woff2$/);
  const font = m && (Object.keys(FONTS) as ResumeFont[]).find((f) => FONTS[f].pkg === m[1]);
  return font ? fontFile(font, Number(m![3]) as 400 | 700, m![4] as "normal" | "italic", m![2] as "latin" | "latin-ext") : null;
}

/** @font-face rules: embedded as data URIs for the PDF renderer, or linked (`/resume-fonts/…`) for previews. */
function fontFaces(font: ResumeFont, embed: boolean): string {
  const key = `${font}:${embed}`;
  const hit = fontCache.get(key);
  if (hit) return hit;
  const { family, pkg } = FONTS[font];
  const faces: string[] = [];
  for (const subset of ["latin", "latin-ext"] as const) {
    for (const weight of [400, 700] as const) {
      for (const style of ["normal", "italic"] as const) {
        const file = fontFile(font, weight, style, subset);
        const src = embed ? `data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}` : `/resume-fonts/${pkg}-${subset}-${weight}-${style}.woff2`;
        const range = subset === "latin" ? "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" : "U+0100-02AF,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
        faces.push(`@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(${src}) format('woff2');unicode-range:${range}}`);
      }
    }
  }
  const css = faces.join("\n");
  fontCache.set(key, css);
  return css;
}

// ---------- markup ----------

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rich = (s = "") => runs(s).map((r) => (r.bold ? `<strong>${esc(r.text)}</strong>` : r.italic ? `<em>${esc(r.text)}</em>` : esc(r.text))).join("");
const attr = (cut?: string, rank?: number) => (cut ? ` data-cut="${esc(cut)}" data-rank="${rank ?? 0}"` : "");

export interface RenderOptions {
  /** Job keywords: bullets that mention them are the last to be cut. */
  keywords?: string[];
  /** Embed fonts (PDF) or link them (preview iframe). */
  embedFonts?: boolean;
  /** Show the page-break guides and mark cut blocks instead of removing them (editor preview). */
  preview?: boolean;
}

interface Ranker {
  (text: string, roleIndex: number, bulletIndex: number, kind: "exp" | "proj"): number;
}
function ranker(keywords: string[] = []): Ranker {
  const keys = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 1);
  return (text, roleIndex, bulletIndex, kind) => {
    const t = plain(text).toLowerCase();
    const hits = keys.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    // Higher = keep longer. Keyword hits and numbers matter most, then recency, then original order.
    return (kind === "proj" ? 0 : 100) + hits * 12 + (/\d/.test(t) ? 6 : 0) - roleIndex * 8 - bulletIndex * 2;
  };
}

function bulletList(items: { html: string; cut?: string; rank?: number }[]): string {
  if (!items.length) return "";
  return `<ul>${items.map((b) => `<li${attr(b.cut, b.rank)}>${b.html}</li>`).join("")}</ul>`;
}

function row(left: string, right: string, cls = "") {
  return `<div class="row ${cls}"><span class="l">${left}</span>${right ? `<span class="r">${right}</span>` : ""}</div>`;
}

function sectionHtml(key: SectionKey, doc: ResumeDoc, layout: ResumeLayout, rank: Ranker): string {
  const t = TEMPLATES[layout.style.template];
  const title = esc(sectionTitle(doc, key));
  const wrap = (body: string, cut?: string, r?: number) => `<section class="sec" data-sec="${esc(key)}"${attr(cut, r)}><h2>${title}</h2>${body}</section>`;
  const sep = ` <span class="bar">|</span> `;
  switch (key) {
    case "summary":
      return wrap(`<p class="text">${rich(doc.summary)}</p>`);
    case "experience": {
      const roles = doc.experience.filter((e) => !e.hidden);
      return wrap(
        roles
          .map((e, ri) => {
            const dates = esc(dateRange(e.start, e.end, e.current));
            const head =
              t.entry === "inline"
                ? row(`<strong>${esc(e.company)}</strong>${e.title ? `${sep}${esc(e.title)}` : ""}${e.location ? `${sep}${esc(e.location)}` : ""}`, dates)
                : row(`<strong>${esc(e.title)}</strong>`, dates) + (e.company || e.location ? row(`<em>${esc(e.company)}</em>`, e.location ? `<em>${esc(e.location)}</em>` : "", "sub") : "");
            // The first bullet of every role (first two of the latest) are never cut.
            const keep = ri === 0 ? 2 : 1;
            const items = e.bullets.map((b, i) => ({ html: rich(b), cut: i >= keep ? `exp:${e.id}:${i}` : undefined, rank: rank(b, ri, i, "exp") }));
            return `<div class="entry">${head}${e.summary ? `<div class="esum">${rich(e.summary)}</div>` : ""}${bulletList(items)}</div>`;
          })
          .join(""),
      );
    }
    case "education":
      return wrap(
        doc.education
          .filter((e) => !e.hidden)
          .map((e) => {
            const degree = [e.degree, e.field].filter(Boolean).join(", ");
            const extras = [e.minor ? `Minor: ${esc(e.minor)}` : "", e.honors ? esc(e.honors) : "", e.gpa ? `GPA: ${esc(e.gpa)}` : ""].filter(Boolean).join(" · ");
            const dates = esc(e.start ? dateRange(e.start, e.end, e.current) : fmtDate(e.end));
            const head =
              t.entry === "inline"
                ? row(`<strong>${esc(e.school)}</strong>${degree ? `${sep}${esc(degree)}` : ""}${e.location ? `${sep}${esc(e.location)}` : ""}`, dates)
                : row(`<strong>${esc(e.school)}</strong>`, e.location ? esc(e.location) : "") + (degree || dates ? row(`<em>${esc(degree)}</em>`, `<em>${dates}</em>`, "sub") : "");
            return `<div class="entry">${head}${extras ? `<div class="text">${extras}</div>` : ""}</div>`;
          })
          .join(""),
      );
    case "skills": {
      const groups = doc.skillGroups?.filter((g) => g.skills.length);
      const body = groups?.length
        ? groups.map((g) => `<div class="text skl">${g.name ? `<strong>${esc(g.name)}:</strong> ` : ""}${g.skills.map(esc).join(", ")}</div>`).join("")
        : `<div class="text skl">${allSkills(doc).map(esc).join(", ")}</div>`;
      return wrap(body);
    }
    case "projects": {
      const projects = (doc.projects ?? []).filter((p) => !p.hidden);
      return wrap(
        projects
          .map((p, pi) => {
            const name = p.url ? `<a href="${esc(href(p.url))}">${esc(p.name)}</a>` : esc(p.name);
            const head = row(`<strong>${name}</strong>${p.description ? ` <span class="desc">— ${rich(p.description)}</span>` : ""}`, esc(dateRange(p.start, p.end)));
            const items = p.bullets.map((b, i) => ({ html: rich(b), cut: i >= 1 ? `proj:${p.id}:${i}` : undefined, rank: rank(b, pi, i, "proj") }));
            // Whole projects after the first can go once their extra bullets have.
            return `<div class="entry"${pi > 0 ? attr(`proj:${p.id}`, rank(p.bullets.join(" "), pi, 0, "proj") - 30) : ""}>${head}${bulletList(items)}</div>`;
          })
          .join(""),
      );
    }
    case "certifications":
      return wrap(
        bulletList(
          (doc.certifications ?? [])
            .filter((c) => !c.hidden)
            .map((c) => ({ html: `<span class="row inline"><span class="l">${esc(c.name)}${c.issuer ? ` — ${esc(c.issuer)}` : ""}</span><span class="r">${esc([fmtDate(c.date), c.expires ? `exp. ${fmtDate(c.expires)}` : ""].filter(Boolean).join(" · "))}</span></span>` })),
        ),
        "sec:certifications",
        -60,
      );
    case "coursework":
      return wrap(`<div class="text">${(doc.coursework ?? []).map(esc).join(", ")}</div>`, "sec:coursework", -80);
    default: {
      const s = doc.custom?.find((c) => `custom:${c.id}` === key);
      if (!s) return "";
      return wrap(
        s.items
          .map((i) => {
            const head = i.title || i.subtitle ? row(`<strong>${rich(i.title)}</strong>${i.subtitle ? `, <em>${rich(i.subtitle)}</em>` : ""}`, esc(dateRange(i.start, i.end))) : "";
            return `<div class="entry">${head}${bulletList(i.bullets.map((b) => ({ html: rich(b) })))}</div>`;
          })
          .join(""),
      );
    }
  }
}

function css(layout: ResumeLayout, v: FitVars, opts: RenderOptions): string {
  const t = TEMPLATES[layout.style.template];
  const f = FONTS[layout.style.font ?? t.font];
  const heading =
    t.heading === "upper" ? "text-transform:uppercase;letter-spacing:.04em;" : t.heading === "smallcaps" ? "font-variant:small-caps;letter-spacing:.02em;" : "";
  return `${fontFaces(layout.style.font ?? t.font, opts.embedFonts ?? true)}
:root{--fs:${v.fontSize}pt;--lh:${v.lineHeight};--sec:${v.section}pt;--entry:${v.entry}pt;--bullet:${v.bullet}pt;--mt:${v.margins[0]}in;--mr:${v.margins[1]}in;--mb:${v.margins[2]}in;--ml:${v.margins[3]}in;--accent:${t.accent}}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:${opts.preview ? "#eef0f3" : "#fff"};color:#000}
.sheet{width:8.5in;min-height:11in;margin:${opts.preview ? "24px auto" : "0"};padding:var(--mt) var(--mr) var(--mb) var(--ml);background:#fff;position:relative;
  font-family:'${f.family}',${f.generic};font-size:var(--fs);line-height:var(--lh);${opts.preview ? "box-shadow:0 1px 18px rgba(15,20,30,.12);" : ""}}
.measure{position:absolute;visibility:hidden;left:0;top:0;padding:0!important;min-height:0!important;margin:0!important;box-shadow:none!important}
header{text-align:${t.nameAlign};margin-bottom:calc(var(--sec) * .6)}
h1{font-size:calc(var(--fs) * ${t.nameScale});line-height:1.05;font-weight:700;${t.heading === "smallcaps" ? "font-variant:small-caps;" : ""}color:${t.heading === "title" ? "var(--accent)" : "#000"};margin-bottom:3pt}
.headline{font-size:calc(var(--fs) + .5pt);margin-bottom:2pt}
.contact{font-size:calc(var(--fs) - .5pt);display:flex;flex-wrap:wrap;gap:0 .45em;justify-content:${t.nameAlign === "center" ? "center" : "flex-start"}}
.contact a{color:inherit;text-decoration:none}
.contact .bar,.bar{color:#555}
.sec{margin-top:var(--sec)}
.sec:first-of-type{margin-top:0}
h2{font-size:calc(var(--fs) + .5pt);font-weight:700;${heading}color:var(--accent);border-bottom:${t.heading === "title" ? "1.5px" : "1px"} solid var(--accent);padding-bottom:1.5pt;margin-bottom:4pt;break-after:avoid}
.entry{margin-bottom:var(--entry);break-inside:avoid}
.entry:last-child{margin-bottom:0}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:1em}
.row .l{min-width:0}
.row .r{flex-shrink:0;white-space:nowrap}
.row.inline{display:flex;width:100%}
.row.sub{margin-top:.5pt}
.esum{font-style:italic;margin-top:1pt}
.text{${layout.style.align === "justify" ? "text-align:justify;" : ""}}
.skl{margin-bottom:1pt}
.desc{font-weight:400}
a{color:inherit;text-decoration:none}
ul{list-style:none;margin-top:1.5pt}
li{position:relative;padding-left:1.15em;margin-bottom:var(--bullet);${layout.style.align === "justify" ? "text-align:justify;" : ""}break-inside:avoid}
li:last-child{margin-bottom:0}
li::before{content:"•";position:absolute;left:.3em}
.cut{opacity:.35;text-decoration:line-through}
.pbreak{position:absolute;left:0;right:0;border-top:1.5px dashed #e0a100;pointer-events:none}
.pbreak span{position:absolute;right:8px;top:-9px;background:#fff7e0;color:#8a6200;font:600 9px/1 system-ui,sans-serif;padding:3px 6px;border-radius:9px}
@media print{body{background:#fff}.sheet{width:auto;min-height:0;padding:0;margin:0;box-shadow:none}.pbreak{display:none}}`;
}

/** The résumé as an HTML document. Pure: no measuring. */
export function resumeHtml(p: Profile["personal"], doc: ResumeDoc, layoutIn?: ResumeLayout | null, vars?: FitVars, opts: RenderOptions = {}): string {
  const layout = resolveLayout(doc, layoutIn);
  const v = vars ?? varsAt(layout, 0);
  const rank = ranker(opts.keywords);
  const contact = contactItems(p, layout)
    .map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.text)}</a>` : `<span>${esc(c.text)}</span>`))
    .join(`<span class="bar">|</span>`);
  const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Your Name";
  const body = visibleSections(doc, layout)
    .map((k) => sectionHtml(k, doc, layout, rank))
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} — Résumé</title><style>${css(layout, v, opts)}</style></head><body>
<div class="sheet" id="sheet"><header><h1>${esc(name)}</h1>${doc.headline ? `<div class="headline">${esc(plain(doc.headline))}</div>` : ""}<div class="contact">${contact}</div></header>${body}</div>
</body></html>`;
}

// ---------- page fit ----------

const PX_PER_IN = 96;

interface FitInput {
  ladder: { vars: FitVars; widthPx: number; pageHeightPx: number }[];
  limit: number;
  trim: boolean;
  /** With trimming on, shrink only this far before cutting content; smaller type comes after. */
}

/** Runs inside Chromium: walk the ladder to a readable floor, cut by rank, shrink further only if needed, then relax back. */
function fitInPage(input: FitInput) {
  const sheet = document.getElementById("sheet")!;
  sheet.classList.add("measure");
  const root = document.documentElement.style;
  const apply = (i: number) => {
    const s = input.ladder[i];
    root.setProperty("--fs", `${s.vars.fontSize}pt`);
    root.setProperty("--lh", String(s.vars.lineHeight));
    root.setProperty("--sec", `${s.vars.section}pt`);
    root.setProperty("--entry", `${s.vars.entry}pt`);
    root.setProperty("--bullet", `${s.vars.bullet}pt`);
    sheet.style.width = `${s.widthPx}px`;
  };
  const height = () => sheet.getBoundingClientRect().height;
  // Small slack: break-inside:avoid can push an entry to the next page a few px early.
  const fits = (i: number) => height() <= input.limit * input.ladder[i].pageHeightPx - 6;
  const last = input.ladder.length - 1;
  const walk = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      apply(i);
      if (fits(i)) return i;
    }
    apply(to);
    return -1;
  };
  // Content first: shrink all the way before cutting anything (cuts only when even the tightest layout overflows).
  let step = walk(0, last);
  const cut: string[] = [];
  if (step < 0) {
    step = last;
    if (input.trim) {
      const candidates = [...document.querySelectorAll<HTMLElement>("[data-cut]")].sort((a, b) => Number(a.dataset.rank) - Number(b.dataset.rank));
      for (const el of candidates) {
        if (fits(step)) break;
        if (el.closest("[data-gone]")) continue;
        el.style.display = "none";
        el.dataset.gone = "1";
        cut.push(el.dataset.cut!);
      }
      // The last cut may have freed more room than needed: give back spacing while it still fits.
      while (step > 0 && fits(step)) {
        apply(step - 1);
        if (!fits(step - 1)) {
          apply(step);
          break;
        }
        step--;
      }
    }
  }
  const pages = Math.max(1, Math.ceil((height() - 6) / input.ladder[step].pageHeightPx));
  return { step, cut, pages, overflow: !fits(step) };
}

const fitCache = new Map<string, FitResult>();

/** Find the gentlest layout that meets the page limit; verified against the real PDF page count. */
export async function fitResume(p: Profile["personal"], doc: ResumeDoc, layoutIn?: ResumeLayout | null, opts: RenderOptions = {}): Promise<FitResult> {
  const layout = resolveLayout(doc, layoutIn);
  const limit = layout.style.pageLimit;
  const key = crypto.createHash("sha1").update(JSON.stringify([p, doc, layout, opts.keywords ?? []])).digest("hex");
  const hit = fitCache.get(key);
  if (hit) return hit;

  const browser = await getRenderBrowser();
  const page = await browser.newPage();
  try {
    let result: FitResult;
    if (!limit) {
      const vars = varsAt(layout, 0);
      result = { step: 0, vars, cut: [], pages: 0, limit: 0, overflow: false };
    } else {
      const ladder = Array.from({ length: maxStep(layout) + 1 }, (_, i) => {
        const vars = varsAt(layout, i);
        return { vars, widthPx: (8.5 - vars.margins[1] - vars.margins[3]) * PX_PER_IN, pageHeightPx: (11 - vars.margins[0] - vars.margins[2]) * PX_PER_IN };
      });
      await page.setContent(resumeHtml(p, doc, layout, ladder[0].vars, { ...opts, embedFonts: true, preview: false }), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      // tsx compiles named inner functions with a __name helper that doesn't exist in the page.
      await page.evaluate("globalThis.__name = globalThis.__name || ((t) => t)");
      const r = await page.evaluate(fitInPage, { ladder, limit, trim: layout.style.trimToFit });
      result = { step: r.step, vars: ladder[r.step].vars, cut: r.cut, pages: r.pages, limit, overflow: r.overflow };
    }
    // Ground truth: count pages in the PDF Chromium actually prints; tighten further if the estimate was optimistic.
    for (let guard = 0; guard < 4; guard++) {
      const pdf = await printPdf(page, p, applyCuts(doc, result.cut), layout, result.vars, opts);
      const pages = await pdfPages(pdf);
      result.pages = pages;
      if (!limit || pages <= limit || result.step >= maxStep(layout)) {
        result.overflow = Boolean(limit) && pages > limit;
        break;
      }
      const next = result.step + 1;
      result = { ...result, step: next, vars: varsAt(layout, next) };
    }
    if (fitCache.size > 200) fitCache.delete(fitCache.keys().next().value!);
    fitCache.set(key, result);
    return result;
  } finally {
    await page.close();
  }
}

type RenderPage = Awaited<ReturnType<Awaited<ReturnType<typeof getRenderBrowser>>["newPage"]>>;

async function printPdf(page: RenderPage, p: Profile["personal"], doc: ResumeDoc, layout: ResumeLayout, v: FitVars, opts: RenderOptions): Promise<Buffer> {
  await page.setContent(resumeHtml(p, doc, layout, v, { ...opts, embedFonts: true, preview: false }), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const [mt, mr, mb, ml] = v.margins;
  return page.pdf({ format: "Letter", printBackground: true, margin: { top: `${mt}in`, right: `${mr}in`, bottom: `${mb}in`, left: `${ml}in` } });
}

export async function pdfPages(buf: Buffer | Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  return pdf.numPages;
}

/** Editor preview: exactly what prints (fitted vars, cut blocks removed) plus page-break guides. */
export async function previewResume(p: Profile["personal"], doc: ResumeDoc, layoutIn?: ResumeLayout | null, opts: RenderOptions = {}) {
  const layout = resolveLayout(doc, layoutIn);
  const fit = await fitResume(p, doc, layout, opts);
  const html = resumeHtml(p, applyCuts(doc, fit.cut), layout, fit.vars, { ...opts, embedFonts: false, preview: true });
  const pageH = (11 - fit.vars.margins[0] - fit.vars.margins[2]) * PX_PER_IN;
  const guides = Array.from({ length: Math.max(0, (fit.pages || 1) - 1) }, (_, i) => `<div class="pbreak" style="top:calc(var(--mt) + ${Math.round(pageH * (i + 1))}px)"><span>Page ${i + 2}</span></div>`).join("");
  return { html: html.replace(`<div class="sheet" id="sheet">`, `<div class="sheet" id="sheet">${guides}`), fit, layout };
}

export interface Rendered {
  file: string;
  fit: FitResult;
  layout: ResumeLayout;
}

/** The PDF that gets uploaded: fitted to the page limit, cut blocks removed. */
export async function renderResume(p: Profile["personal"], doc: ResumeDoc, fileStem: string, opts: RenderOptions = {}): Promise<Rendered> {
  const layout = resolveLayout(doc);
  const fit = await fitResume(p, doc, layout, opts);
  const browser = await getRenderBrowser();
  const page = await browser.newPage();
  try {
    const buf = await printPdf(page, p, applyCuts(doc, fit.cut), layout, fit.vars, opts);
    const out = path.join(paths.artifacts, `${fileStem.replace(/[^\w.-]+/g, "_")}.pdf`);
    fs.writeFileSync(out, buf);
    return { file: out, fit, layout };
  } finally {
    await page.close();
  }
}

export async function renderResumePdf(p: Profile["personal"], doc: ResumeDoc, fileStem: string, opts: RenderOptions = {}): Promise<string> {
  return (await renderResume(p, doc, fileStem, opts)).file;
}

export async function renderTextPdf(title: string, body: string, fileStem: string): Promise<string> {
  const browser = await getRenderBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${fontFaces("arial", true)}@page{size:Letter;margin:0.9in}body{font-family:'Arimo',Arial,sans-serif;font-size:11pt;line-height:1.5;white-space:pre-wrap;color:#111}</style></head><body>${esc(body)}</body></html>`,
      { waitUntil: "load" },
    );
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(paths.artifacts, `${fileStem.replace(/[^\w.-]+/g, "_")}.pdf`);
    await page.pdf({ path: out, format: "Letter" });
    return out;
  } finally {
    await page.close();
  }
}
