import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Element as XElement } from "@xmldom/xmldom";
import type { ResumeDoc } from "../types.ts";
import { allSkills, runs } from "./model.ts";

// "Keep my design": put the tailored wording into the user's own uploaded .docx instead of a Ferry template.
// Paragraphs are matched to the résumé the profile was parsed from, then rewritten in place, so fonts,
// numbering, indentation and everything else in the original stays untouched.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const BULLET_ONLY = /^[\s•·▪‣◦●○■□➢►\-–—*]*$/;

const normText = (s: string) =>
  s
    .replace(/[•·▪‣◦●○■□➢►]/g, " ")
    .replace(/\*\*|\*/g, "")
    .replace(/^[\s\-–—]+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9%$+#. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function similarity(a: string, b: string) {
  const A = normText(a);
  const B = normText(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length > 25 && (A.includes(B) || B.includes(A))) return 0.95;
  const wa = new Set(A.split(" "));
  const wb = new Set(B.split(" "));
  let i = 0;
  for (const w of wa) if (wb.has(w)) i++;
  return (2 * i) / (wa.size + wb.size);
}

const children = (el: XElement, local: string) => {
  const out: XElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as XElement).localName === local && (n as XElement).namespaceURI === W) out.push(n as XElement);
  return out;
};
const runText = (r: XElement) => {
  let t = "";
  for (let n = r.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const e = n as XElement;
    if (e.localName === "t") t += e.textContent ?? "";
    else if (e.localName === "tab") t += "\t";
  }
  return t;
};
const paraText = (p: XElement) => [...children(p, "r"), ...children(p, "hyperlink").flatMap((h) => children(h, "r"))].map(runText).join("");

/** Rewrite a paragraph's text, keeping its paragraph properties, any leading bullet runs, and the first text run's formatting. */
function setText(p: XElement, text: string) {
  const doc = p.ownerDocument!;
  const content = [...Array.from({ length: p.childNodes.length }, (_, i) => p.childNodes[i] as XElement)].filter(
    (n) => n.nodeType === 1 && (n.localName === "r" || n.localName === "hyperlink") && n.namespaceURI === W,
  );
  let i = 0;
  while (i < content.length && content[i].localName === "r" && BULLET_ONLY.test(runText(content[i])) && runText(content[i]) !== "") i++;
  const rest = content.slice(i);
  const template = rest.find((n) => n.localName === "r" && runText(n).trim()) ?? rest.find((n) => n.localName === "r");
  const rPr = template ? children(template, "rPr")[0] : undefined;
  const insertBefore = rest.length ? rest[rest.length - 1].nextSibling : null;
  for (const n of rest) p.removeChild(n);
  for (const seg of runs(text)) {
    const r = doc.createElementNS(W, "w:r");
    const pr = rPr ? (rPr.cloneNode(true) as XElement) : doc.createElementNS(W, "w:rPr");
    for (const tag of ["b", "i"] as const) for (const old of children(pr, tag)) pr.removeChild(old);
    if (seg.bold) pr.insertBefore(doc.createElementNS(W, "w:b"), pr.firstChild);
    if (seg.italic) pr.insertBefore(doc.createElementNS(W, "w:i"), pr.firstChild);
    if (pr.childNodes.length) r.appendChild(pr);
    const t = doc.createElementNS(W, "w:t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(seg.text));
    r.appendChild(t);
    p.insertBefore(r, insertBefore && insertBefore.parentNode === p ? insertBefore : null);
  }
}

export interface Projection {
  buffer: Buffer;
  /** Share of the source résumé's bullets found in the file (low = the design couldn't be matched reliably). */
  coverage: number;
  replaced: number;
}

/** Project `tailored` into the original .docx that `base` was parsed from. */
export async function projectDocx(originalPath: string, base: ResumeDoc, tailored: ResumeDoc): Promise<Projection> {
  const zip = await JSZip.loadAsync(fs.readFileSync(originalPath));
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("Not a Word document");
  const dom = new DOMParser().parseFromString(await file.async("string"), "text/xml");
  const paras = Array.from(dom.getElementsByTagNameNS(W, "p")) as unknown as XElement[];
  const texts = paras.map(paraText);
  const used = new Set<number>();
  let found = 0;
  let total = 0;
  let replaced = 0;

  const locate = (s: string, min = 0.8) => {
    let best = -1;
    let score = min;
    texts.forEach((t, i) => {
      if (used.has(i)) return;
      const sc = similarity(t, s);
      if (sc >= score) (best = i), (score = sc);
    });
    if (best >= 0) used.add(best);
    return best;
  };

  /** Swap one entry's bullet paragraphs for the tailored list: rewrite, add (cloning the last), or remove. */
  const swapList = (srcBullets: string[], next: string[]) => {
    total += srcBullets.length;
    const idx = srcBullets.map((b) => locate(b)).filter((i) => i >= 0).sort((a, b) => a - b);
    found += idx.length;
    if (!idx.length) return;
    const nodes = idx.map((i) => paras[i]);
    next.forEach((text, k) => {
      if (k < nodes.length) {
        if (normText(texts[idx[k]]) !== normText(text)) replaced++;
        setText(nodes[k], text);
      } else {
        const last = nodes[nodes.length - 1];
        const copy = last.cloneNode(true) as XElement;
        last.parentNode!.insertBefore(copy, last.nextSibling);
        setText(copy, text);
        nodes.push(copy);
        replaced++;
      }
    });
    for (const n of nodes.slice(next.length)) {
      n.parentNode?.removeChild(n);
      replaced++;
    }
  };

  for (const e of base.experience) {
    const t = tailored.experience.find((x) => x.id === e.id);
    if (t) swapList(e.bullets, t.hidden ? [] : t.bullets);
  }
  for (const p of base.projects ?? []) {
    const t = tailored.projects?.find((x) => x.id === p.id);
    if (t) swapList(p.bullets, t.hidden ? [] : t.bullets);
  }

  if (base.summary && tailored.summary && normText(base.summary) !== normText(tailored.summary)) {
    const i = locate(base.summary, 0.6);
    if (i >= 0) {
      setText(paras[i], tailored.summary);
      replaced++;
    }
  }
  if (base.headline && tailored.headline && normText(base.headline) !== normText(tailored.headline)) {
    const i = locate(base.headline, 0.9);
    if (i >= 0) {
      setText(paras[i], tailored.headline);
      replaced++;
    }
  }

  // Skill lines ("Languages: Go, Python, SQL"): same skills, reordered by the tailored priority.
  const order = allSkills(tailored).map((s) => s.toLowerCase());
  const known = new Set(allSkills(base).map((s) => s.toLowerCase()));
  texts.forEach((text, i) => {
    if (used.has(i)) return;
    const colon = text.indexOf(":");
    const label = colon > 0 && colon < 40 ? text.slice(0, colon + 1) : "";
    const items = text.slice(label.length).split(/\s*[,|;•·]\s*/).map((s) => s.trim()).filter(Boolean);
    if (items.length < 3 || items.filter((s) => known.has(s.toLowerCase())).length < Math.ceil(items.length * 0.6)) return;
    const rank = (s: string) => {
      const k = order.indexOf(s.toLowerCase());
      return k < 0 ? order.length : k;
    };
    const sorted = [...items].sort((a, b) => rank(a) - rank(b));
    if (sorted.join() === items.join()) return;
    used.add(i);
    replaced++;
    // Keep a bold "Label:" run intact when the label is its own run.
    const p = paras[i];
    const rs = children(p, "r");
    let acc = "";
    let k = 0;
    for (; k < rs.length && acc.length < label.length; k++) acc += runText(rs[k]);
    if (label && acc.trim() === label.trim()) {
      const tail = p.ownerDocument!.createElementNS(W, "w:p");
      for (const r of rs.slice(k)) {
        p.removeChild(r);
        tail.appendChild(r);
      }
      setText(tail, ` ${sorted.join(", ")}`);
      while (tail.firstChild) {
        const n = tail.firstChild;
        tail.removeChild(n);
        if ((n as XElement).localName !== "pPr") p.appendChild(n);
      }
    } else setText(p, `${label}${label ? " " : ""}${sorted.join(", ")}`);
  });

  zip.file("word/document.xml", new XMLSerializer().serializeToString(dom));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, coverage: total ? found / total : 0, replaced };
}
