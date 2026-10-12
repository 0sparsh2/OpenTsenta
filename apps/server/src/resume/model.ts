import crypto from "node:crypto";
import {
  BUILTIN_SECTIONS,
  HEADER_LINKS,
  RESUME_FONTS,
  RESUME_TEMPLATES,
  type BuiltinSection,
  type HeaderLink,
  type Profile,
  type ResumeDoc,
  type ResumeLayout,
  type ResumeStyle,
  type SectionKey,
} from "../types.ts";

export const rid = () => crypto.randomBytes(4).toString("hex");

export const SECTION_TITLES: Record<BuiltinSection, string> = {
  summary: "Summary",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certifications: "Certifications",
  coursework: "Relevant Coursework",
};

export const TEMPLATE_FONT_SIZE: Record<ResumeStyle["template"], number> = { classic: 10.5, serif: 11, modern: 10.5, compact: 9.5 };

function yearsOf(doc: ResumeDoc): number {
  let months = 0;
  for (const e of doc.experience) {
    const s = ym(e.start);
    const t = e.current || !e.end ? ym(new Date().toISOString().slice(0, 7)) : ym(e.end);
    if (s != null && t != null && t > s) months += t - s;
  }
  return months / 12;
}
function ym(s?: string): number | null {
  const m = s?.match(/^(\d{4})(?:-(\d{2}))?/);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
}

/** Sensible starting layout: one page under ten years of experience, two above; education first with no experience. */
export function defaultLayout(doc: ResumeDoc): ResumeLayout {
  const years = yearsOf(doc);
  const order: SectionKey[] = doc.experience.length
    ? ["summary", "experience", "projects", "education", "skills", "certifications", "coursework"]
    : ["summary", "education", "projects", "skills", "experience", "certifications", "coursework"];
  return {
    style: { template: "classic", fontSize: TEMPLATE_FONT_SIZE.classic, align: "left", links: "url", pageLimit: years > 10 ? 2 : 1, trimToFit: true, output: "template" },
    sectionOrder: [...order, ...(doc.custom ?? []).map((c) => `custom:${c.id}` as SectionKey)],
    hiddenSections: [],
    hiddenLinks: [],
  };
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Fill defaults and drop anything unknown so stored or client-sent layouts are always renderable. */
export function resolveLayout(doc: ResumeDoc, input?: Partial<ResumeLayout> | null): ResumeLayout {
  const base = defaultLayout(doc);
  const l = input ?? doc.layout ?? {};
  const s = (l.style ?? {}) as Partial<ResumeStyle>;
  const template = RESUME_TEMPLATES.includes(s.template as never) ? s.template! : base.style.template;
  const style: ResumeStyle = {
    template,
    font: RESUME_FONTS.includes(s.font as never) ? s.font : undefined,
    fontSize: num(s.fontSize, 8, 13, TEMPLATE_FONT_SIZE[template]),
    align: s.align === "justify" ? "justify" : "left",
    links: s.links === "label" ? "label" : "url",
    pageLimit: s.pageLimit === 0 || s.pageLimit === 1 || s.pageLimit === 2 ? s.pageLimit : base.style.pageLimit,
    trimToFit: s.trimToFit ?? base.style.trimToFit,
    output: s.output === "original" ? "original" : "template",
  };
  const customKeys = (doc.custom ?? []).map((c) => `custom:${c.id}` as SectionKey);
  const valid = new Set<string>([...BUILTIN_SECTIONS, ...customKeys]);
  const seen = new Set<string>();
  const order: SectionKey[] = [];
  for (const k of [...(l.sectionOrder ?? []), ...base.sectionOrder, ...customKeys]) {
    if (valid.has(k) && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  return {
    style,
    sectionOrder: order,
    hiddenSections: (l.hiddenSections ?? []).filter((k) => valid.has(k)),
    hiddenLinks: (l.hiddenLinks ?? []).filter((k): k is HeaderLink => HEADER_LINKS.includes(k as never)),
  };
}

/** Give every block an id and every list a value, whatever shape it arrived in. */
export function normalizeDoc(input: Partial<ResumeDoc> | null | undefined): ResumeDoc {
  const d = input ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? undefined : String(v));
  const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter((x) => x.trim()) : []);
  const doc: ResumeDoc = {
    headline: str(d.headline) || undefined,
    summary: str(d.summary) || undefined,
    experience: (d.experience ?? []).map((e) => ({ ...e, id: e.id || rid(), company: str(e.company) ?? "", title: str(e.title) ?? "", bullets: strs(e.bullets) })),
    education: (d.education ?? []).map((e) => ({ ...e, id: e.id || rid(), school: str(e.school) ?? "" })),
    skills: strs(d.skills),
    skillGroups: d.skillGroups?.length ? d.skillGroups.map((g) => ({ id: g.id || rid(), name: str(g.name) ?? "", skills: strs(g.skills) })).filter((g) => g.skills.length || g.name) : undefined,
    projects: d.projects?.length ? d.projects.map((p) => ({ ...p, id: p.id || rid(), name: str(p.name) ?? "", bullets: strs(p.bullets) })) : undefined,
    certifications: d.certifications?.length ? d.certifications.map((c) => ({ ...c, id: c.id || rid(), name: str(c.name) ?? "" })) : undefined,
    coursework: d.coursework?.length ? strs(d.coursework) : undefined,
    custom: d.custom?.length
      ? d.custom.map((s) => ({ id: s.id || rid(), title: str(s.title) ?? "", items: (s.items ?? []).map((i) => ({ ...i, id: i.id || rid(), bullets: strs(i.bullets) })) }))
      : undefined,
    layout: d.layout,
  };
  if (doc.skillGroups && !doc.skills.length) doc.skills = doc.skillGroups.flatMap((g) => g.skills);
  return doc;
}

/** Every skill on the résumé, grouped or not, de-duplicated. */
export function allSkills(doc: ResumeDoc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...doc.skills, ...(doc.skillGroups ?? []).flatMap((g) => g.skills)]) {
    const k = s.toLowerCase().trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(s.trim());
    }
  }
  return out;
}

// ---------- inline markup: **bold**, *italic* ----------

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export function runs(s: string): Run[] {
  const out: Run[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  for (let m; (m = re.exec(s)); ) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push(m[1] != null ? { text: m[1], bold: true } : { text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((r) => r.text);
}

export const plain = (s?: string) => (s ? runs(s).map((r) => r.text).join("") : "");

// ---------- dates and contact line ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(s?: string): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return s;
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}

export function dateRange(start?: string, end?: string, current?: boolean): string {
  const a = fmtDate(start);
  const b = current ? "Present" : fmtDate(end);
  return a && b ? `${a} – ${b}` : a || b;
}

const bare = (u: string) => u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
export const href = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

export interface ContactItem {
  key: HeaderLink;
  text: string;
  href?: string;
}

export function contactItems(p: Profile["personal"], layout: ResumeLayout): ContactItem[] {
  const hide = new Set(layout.hiddenLinks);
  const label = layout.style.links === "label";
  const items: ContactItem[] = [];
  const loc = [p.city, p.region].filter(Boolean).join(", ") || p.country;
  if (loc && !hide.has("location")) items.push({ key: "location", text: loc });
  if (p.email && !hide.has("email")) items.push({ key: "email", text: p.email, href: `mailto:${p.email}` });
  if (p.phone && !hide.has("phone")) items.push({ key: "phone", text: p.phone, href: `tel:${p.phone.replace(/[^\d+]/g, "")}` });
  if (p.linkedin && !hide.has("linkedin")) items.push({ key: "linkedin", text: label ? "LinkedIn" : bare(p.linkedin), href: href(p.linkedin) });
  if (p.github && !hide.has("github")) items.push({ key: "github", text: label ? "GitHub" : bare(p.github), href: href(p.github) });
  if (p.website && !hide.has("website")) items.push({ key: "website", text: label ? "Portfolio" : bare(p.website), href: href(p.website) });
  return items;
}

export function sectionTitle(doc: ResumeDoc, key: SectionKey): string {
  if (key.startsWith("custom:")) return doc.custom?.find((c) => `custom:${c.id}` === key)?.title ?? "";
  return SECTION_TITLES[key as BuiltinSection];
}

/** Sections that will actually print, in order. */
export function visibleSections(doc: ResumeDoc, layout: ResumeLayout): SectionKey[] {
  const hidden = new Set(layout.hiddenSections);
  return layout.sectionOrder.filter((k) => {
    if (hidden.has(k)) return false;
    switch (k) {
      case "summary":
        return Boolean(doc.summary?.trim());
      case "experience":
        return doc.experience.some((e) => !e.hidden);
      case "education":
        return doc.education.some((e) => !e.hidden);
      case "skills":
        return allSkills(doc).length > 0;
      case "projects":
        return (doc.projects ?? []).some((p) => !p.hidden);
      case "certifications":
        return (doc.certifications ?? []).some((c) => !c.hidden);
      case "coursework":
        return (doc.coursework ?? []).length > 0;
      default:
        return Boolean(doc.custom?.find((c) => `custom:${c.id}` === k)?.items.length);
    }
  });
}

/** Remove the blocks a page-fit pass cut (ids from render.ts: exp:<id>:<i>, proj:<id>, proj:<id>:<i>, sec:<key>). */
export function applyCuts(doc: ResumeDoc, cut: string[]): ResumeDoc {
  if (!cut.length) return doc;
  const set = new Set(cut);
  const out = structuredClone(doc);
  out.experience = out.experience.map((e) => ({ ...e, bullets: e.bullets.filter((_, i) => !set.has(`exp:${e.id}:${i}`)) }));
  out.projects = out.projects
    ?.filter((p) => !set.has(`proj:${p.id}`))
    .map((p) => ({ ...p, bullets: p.bullets.filter((_, i) => !set.has(`proj:${p.id}:${i}`)) }));
  if (set.has("sec:coursework")) out.coursework = undefined;
  if (set.has("sec:certifications")) out.certifications = undefined;
  return out;
}
