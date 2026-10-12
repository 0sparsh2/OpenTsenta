import JSZip from "jszip";
import type { Profile, ResumeDoc, ResumeLayout, SectionKey } from "../types.ts";
import { allSkills, applyCuts, contactItems, dateRange, fmtDate, href, plain, resolveLayout, runs, sectionTitle, visibleSections } from "./model.ts";
import { FONTS, TEMPLATES, type FitVars, varsAt } from "./render.ts";

// The same résumé as a Word document: same template, type size, spacing, margins and cuts as the PDF.
// Hand-written OOXML (no tables, real bullets, a right tab for dates), so ATS parsers and Word both read it cleanly.

const TWIP = 1440; // per inch
const pt20 = (pt: number) => Math.round(pt * 20);
const xml = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Ctx {
  layout: ResumeLayout;
  v: FitVars;
  font: string;
  accent: string;
  textWidth: number;
  links: string[];
}

function run(text: string, o: { bold?: boolean; italic?: boolean; size?: number; color?: string; caps?: boolean; smallCaps?: boolean } = {}) {
  const pr = [
    o.bold ? "<w:b/>" : "",
    o.italic ? "<w:i/>" : "",
    o.caps ? "<w:caps/>" : "",
    o.smallCaps ? "<w:smallCaps/>" : "",
    o.color ? `<w:color w:val="${o.color.replace("#", "")}"/>` : "",
    o.size ? `<w:sz w:val="${Math.round(o.size * 2)}"/><w:szCs w:val="${Math.round(o.size * 2)}"/>` : "",
  ].join("");
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}
const richRuns = (s: string, base: Parameters<typeof run>[1] = {}) => runs(s).map((r) => run(r.text, { ...base, bold: base.bold || r.bold, italic: base.italic || r.italic })).join("");
const tab = "<w:r><w:tab/></w:r>";

function para(c: Ctx, body: string, o: { before?: number; after?: number; jc?: "center" | "left" | "both"; keepNext?: boolean; bullet?: boolean; border?: boolean; tabs?: boolean } = {}) {
  const lineTw = pt20(c.v.fontSize * c.v.lineHeight);
  const pr = [
    o.keepNext ? "<w:keepNext/>" : "",
    o.border ? `<w:pBdr><w:bottom w:val="single" w:sz="${c.layout.style.template === "modern" ? 10 : 6}" w:space="1" w:color="${c.accent.replace("#", "")}"/></w:pBdr>` : "",
    o.bullet ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : "",
    o.tabs ? `<w:tabs><w:tab w:val="right" w:pos="${c.textWidth}"/></w:tabs>` : "",
    `<w:spacing w:before="${pt20(o.before ?? 0)}" w:after="${pt20(o.after ?? 0)}" w:line="${lineTw}" w:lineRule="atLeast"/>`,
    o.jc && o.jc !== "left" ? `<w:jc w:val="${o.jc}"/>` : "",
  ].join("");
  return `<w:p><w:pPr>${pr}</w:pPr>${body}</w:p>`;
}

function link(c: Ctx, text: string, url: string, o: Parameters<typeof run>[1] = {}) {
  c.links.push(url);
  return `<w:hyperlink r:id="rIdL${c.links.length}">${run(text, o)}</w:hyperlink>`;
}

function entryHeader(c: Ctx, left: string, right: string, opts: { keepNext?: boolean; before?: number } = {}) {
  return para(c, `${left}${right ? `${tab}${right}` : ""}`, { tabs: true, keepNext: opts.keepNext ?? true, before: opts.before });
}

function bullets(c: Ctx, items: string[]) {
  return items.map((b, i) => para(c, richRuns(b), { bullet: true, after: i === items.length - 1 ? 0 : c.v.bullet, jc: c.layout.style.align === "justify" ? "both" : "left" })).join("");
}

function section(c: Ctx, doc: ResumeDoc, key: SectionKey, first: boolean): string {
  const t = TEMPLATES[c.layout.style.template];
  const heading = para(c, run(sectionTitle(doc, key), { bold: true, size: c.v.fontSize + 0.5, color: c.accent, caps: t.heading === "upper", smallCaps: t.heading === "smallcaps" }), {
    before: first ? 0 : c.v.section,
    after: 4,
    border: true,
    keepNext: true,
  });
  const sep = " | ";
  const gap = c.v.entry;
  const out: string[] = [heading];
  const textJc = c.layout.style.align === "justify" ? "both" : "left";
  switch (key) {
    case "summary":
      out.push(para(c, richRuns(doc.summary ?? ""), { jc: textJc }));
      break;
    case "experience":
      doc.experience
        .filter((e) => !e.hidden)
        .forEach((e, i) => {
          const dates = dateRange(e.start, e.end, e.current);
          const before = i ? gap : 0;
          if (t.entry === "inline") {
            out.push(entryHeader(c, run(e.company, { bold: true }) + (e.title ? run(`${sep}${e.title}`) : "") + (e.location ? run(`${sep}${e.location}`) : ""), run(dates), { before }));
          } else {
            out.push(entryHeader(c, run(e.title, { bold: true }), run(dates), { before }));
            if (e.company || e.location) out.push(entryHeader(c, run(e.company, { italic: true }), e.location ? run(e.location, { italic: true }) : ""));
          }
          if (e.summary) out.push(para(c, richRuns(e.summary, { italic: true }), { keepNext: true }));
          out.push(bullets(c, e.bullets));
        });
      break;
    case "education":
      doc.education
        .filter((e) => !e.hidden)
        .forEach((e, i) => {
          const degree = [e.degree, e.field].filter(Boolean).join(", ");
          const dates = e.start ? dateRange(e.start, e.end, e.current) : fmtDate(e.end);
          const before = i ? gap : 0;
          if (t.entry === "inline") {
            out.push(entryHeader(c, run(e.school, { bold: true }) + (degree ? run(`${sep}${degree}`) : "") + (e.location ? run(`${sep}${e.location}`) : ""), run(dates), { before }));
          } else {
            out.push(entryHeader(c, run(e.school, { bold: true }), e.location ? run(e.location) : "", { before }));
            if (degree || dates) out.push(entryHeader(c, run(degree, { italic: true }), run(dates, { italic: true })));
          }
          const extras = [e.minor ? `Minor: ${e.minor}` : "", e.honors ?? "", e.gpa ? `GPA: ${e.gpa}` : ""].filter(Boolean).join(" · ");
          if (extras) out.push(para(c, run(extras)));
        });
      break;
    case "skills": {
      const groups = doc.skillGroups?.filter((g) => g.skills.length);
      if (groups?.length) for (const g of groups) out.push(para(c, (g.name ? run(`${g.name}: `, { bold: true }) : "") + run(g.skills.join(", ")), { after: 1 }));
      else out.push(para(c, run(allSkills(doc).join(", "))));
      break;
    }
    case "projects":
      (doc.projects ?? [])
        .filter((p) => !p.hidden)
        .forEach((p, i) => {
          const name = p.url ? link(c, p.name, href(p.url), { bold: true }) : run(p.name, { bold: true });
          out.push(entryHeader(c, name + (p.description ? run(` — ${plain(p.description)}`) : ""), run(dateRange(p.start, p.end)), { before: i ? gap : 0 }));
          out.push(bullets(c, p.bullets));
        });
      break;
    case "certifications":
      for (const cert of (doc.certifications ?? []).filter((x) => !x.hidden)) {
        const when = [fmtDate(cert.date), cert.expires ? `exp. ${fmtDate(cert.expires)}` : ""].filter(Boolean).join(" · ");
        out.push(para(c, run(`${cert.name}${cert.issuer ? ` — ${cert.issuer}` : ""}`) + (when ? `${tab}${run(when)}` : ""), { bullet: true, tabs: true }));
      }
      break;
    case "coursework":
      out.push(para(c, run((doc.coursework ?? []).join(", "))));
      break;
    default: {
      const s = doc.custom?.find((x) => `custom:${x.id}` === key);
      s?.items.forEach((item, i) => {
        if (item.title || item.subtitle) out.push(entryHeader(c, richRuns(item.title ?? "", { bold: true }) + (item.subtitle ? run(`, `) + richRuns(item.subtitle, { italic: true }) : ""), run(dateRange(item.start, item.end)), { before: i ? gap : 0 }));
        out.push(bullets(c, item.bullets));
      });
    }
  }
  return out.join("");
}

export interface DocxInput {
  personal: Profile["personal"];
  doc: ResumeDoc;
  layout?: ResumeLayout | null;
  /** Fitted spacing and cuts from fitResume(); without it the template's defaults are used. */
  fit?: { vars: FitVars; cut: string[] };
}

export async function buildDocx({ personal: p, doc: source, layout: layoutIn, fit }: DocxInput): Promise<Buffer> {
  const layout = resolveLayout(source, layoutIn);
  const doc = applyCuts(source, fit?.cut ?? []);
  const v = fit?.vars ?? varsAt(layout, 0);
  const t = TEMPLATES[layout.style.template];
  const font = FONTS[layout.style.font ?? t.font].docx;
  const [mt, mr, mb, ml] = v.margins;
  const c: Ctx = { layout, v, font, accent: t.accent, textWidth: Math.round((8.5 - ml - mr) * TWIP), links: [] };

  const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Your Name";
  const contact = contactItems(p, layout)
    .map((ci) => (ci.href ? link(c, ci.text, ci.href) : run(ci.text)))
    .join(run("  |  ", { color: "#555555" }));
  const header = [
    para(c, run(name, { bold: true, size: v.fontSize * t.nameScale, color: t.heading === "title" ? t.accent : undefined, smallCaps: t.heading === "smallcaps" }), { jc: t.nameAlign, after: 3 }),
    doc.headline ? para(c, run(plain(doc.headline), { size: v.fontSize + 0.5 }), { jc: t.nameAlign, after: 2 }) : "",
    para(c, contact, { jc: t.nameAlign, after: v.section * 0.6 }),
  ].join("");
  const body = visibleSections(doc, layout)
    .map((k, i) => section(c, doc, k, i === 0))
    .join("");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${header}${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${Math.round(mt * TWIP)}" w:right="${Math.round(mr * TWIP)}" w:bottom="${Math.round(mb * TWIP)}" w:left="${Math.round(ml * TWIP)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xml(font)}" w:hAnsi="${xml(font)}" w:cs="${xml(font)}" w:eastAsia="${xml(font)}"/><w:sz w:val="${Math.round(v.fontSize * 2)}"/><w:szCs w:val="${Math.round(v.fontSize * 2)}"/><w:color w:val="000000"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

  const indent = Math.round(v.fontSize * 1.15 * 20);
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="${Math.round(indent * 0.75)}"/></w:pPr><w:rPr><w:rFonts w:ascii="${xml(font)}" w:hAnsi="${xml(font)}"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${c.links
    .map((u, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(u)}" TargetMode="External"/>`)
    .join("")}</Relationships>`;

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file("word/document.xml", document);
  zip.file("word/styles.xml", styles);
  zip.file("word/numbering.xml", numbering);
  zip.file("word/settings.xml", settings);
  zip.file("word/_rels/document.xml.rels", rels);
  const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(`${name} — Résumé`)}</dc:title><dc:creator>${xml(name)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ferry</Application></Properties>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
