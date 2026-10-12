import { ArrowDown, ArrowUp, Eye, EyeOff, Minus, Plus } from "lucide-react";
import { useResumeCatalogQuery } from "../../lib/api";
import type { HeaderLink, ResumeDoc, ResumeLayout, ResumeStyle, SectionKey } from "../../lib/types";
import { cx, Label, Segmented, Select, Toggle } from "../ui";

const SECTION_LABEL: Record<string, string> = {
  summary: "Summary",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certifications: "Certifications",
  coursework: "Relevant coursework",
};
export const sectionLabel = (doc: ResumeDoc, k: SectionKey) => (k.startsWith("custom:") ? (doc.custom?.find((c) => `custom:${c.id}` === k)?.title ?? "Custom section") : SECTION_LABEL[k]);

/** Does the section have anything to print? Empty ones are listed but dimmed. */
export function sectionHasContent(doc: ResumeDoc, k: SectionKey) {
  switch (k) {
    case "summary":
      return Boolean(doc.summary?.trim());
    case "experience":
      return doc.experience.length > 0;
    case "education":
      return doc.education.length > 0;
    case "skills":
      return doc.skills.length > 0 || Boolean(doc.skillGroups?.length);
    case "projects":
      return Boolean(doc.projects?.length);
    case "certifications":
      return Boolean(doc.certifications?.length);
    case "coursework":
      return Boolean(doc.coursework?.length);
    default:
      return Boolean(doc.custom?.find((c) => `custom:${c.id}` === k)?.items.length);
  }
}

const LINKS: { key: HeaderLink; label: string }[] = [
  { key: "location", label: "Location" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "github", label: "GitHub" },
  { key: "website", label: "Website" },
];

const TEMPLATE_SAMPLE: Record<ResumeStyle["template"], { font: string; blurb: string }> = {
  classic: { font: "Arial, sans-serif", blurb: "Company | Role on one line, uppercase headings" },
  serif: { font: "'Times New Roman', serif", blurb: "Small-caps headings, role over company" },
  modern: { font: "Calibri, 'Segoe UI', sans-serif", blurb: "Left-aligned name, navy accents" },
  compact: { font: "Arial, sans-serif", blurb: "Tight spacing for dense résumés" },
};

export function FormatPanel({ doc, layout, onChange, hasDocx, compact }: { doc: ResumeDoc; layout: ResumeLayout; onChange: (l: ResumeLayout) => void; hasDocx?: boolean; compact?: boolean }) {
  const { data: catalog } = useResumeCatalogQuery();
  const s = layout.style;
  const setStyle = (p: Partial<ResumeStyle>) => onChange({ ...layout, style: { ...s, ...p } });
  const move = (i: number, d: -1 | 1) => {
    const order = [...layout.sectionOrder];
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    onChange({ ...layout, sectionOrder: order });
  };
  const toggleSection = (k: SectionKey) =>
    onChange({ ...layout, hiddenSections: layout.hiddenSections.includes(k) ? layout.hiddenSections.filter((x) => x !== k) : [...layout.hiddenSections, k] });
  const toggleLink = (k: HeaderLink) => onChange({ ...layout, hiddenLinks: layout.hiddenLinks.includes(k) ? layout.hiddenLinks.filter((x) => x !== k) : [...layout.hiddenLinks, k] });
  const original = s.output === "original" && hasDocx;

  return (
    <div className="space-y-5">
      {hasDocx && (
        <div>
          <Label hint="this profile came from a Word file">Design</Label>
          <Segmented
            value={original ? "original" : "template"}
            onChange={(v) => setStyle({ output: v })}
            options={[
              { value: "template", label: "Ferry template" },
              { value: "original", label: "Keep my Word design" },
            ]}
          />
          {original && (
            <p className="mt-1.5 text-[12px] text-muted">
              Tailored wording goes into your own .docx (uploaded as Word where the form accepts it). The template settings below still shape the PDF fallback.
            </p>
          )}
        </div>
      )}

      <div>
        <Label>Template</Label>
        <div className={cx("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
          {(catalog?.templates ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setStyle({ template: t.id, fontSize: { classic: 10.5, serif: 11, modern: 10.5, compact: 9.5 }[t.id], font: undefined })}
              className={cx("rounded-xl border p-2.5 text-left transition", s.template === t.id ? "border-ink bg-card shadow-card ring-2 ring-ink/10" : "border-line bg-paper/40 hover:border-line-2")}
            >
              <span className="block text-[15px] font-semibold" style={{ fontFamily: TEMPLATE_SAMPLE[t.id].font, fontVariant: t.id === "serif" ? "small-caps" : undefined }}>
                {t.label}
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{TEMPLATE_SAMPLE[t.id].blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label>Typeface</Label>
          <Select value={s.font ?? ""} onChange={(e) => setStyle({ font: (e.target.value || undefined) as ResumeStyle["font"] })}>
            <option value="">Template default</option>
            {catalog?.fonts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label hint="the page limit may go smaller">Body size</Label>
          <div className="flex h-9 items-center gap-1">
            <button type="button" aria-label="Smaller" onClick={() => setStyle({ fontSize: Math.max(8.5, s.fontSize - 0.5) })} className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:bg-paper">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-14 text-center text-sm tabular-nums">{s.fontSize}pt</span>
            <button type="button" aria-label="Larger" onClick={() => setStyle({ fontSize: Math.min(12.5, s.fontSize + 0.5) })} className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:bg-paper">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div>
        <Label>Page limit</Label>
        <Segmented
          value={String(s.pageLimit) as "0" | "1" | "2"}
          onChange={(v) => setStyle({ pageLimit: Number(v) as 0 | 1 | 2 })}
          options={[
            { value: "1", label: "1 page" },
            { value: "2", label: "2 pages" },
            { value: "0", label: "No limit" },
          ]}
        />
        {s.pageLimit > 0 && (
          <Toggle
            checked={s.trimToFit}
            onChange={(v) => setStyle({ trimToFit: v })}
            label="Cut the least relevant lines if it still doesn't fit"
            sub="First Ferry tightens spacing and type (never below 9pt). Your first bullet per role is always kept."
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label>Text alignment</Label>
          <Segmented value={s.align} onChange={(v) => setStyle({ align: v })} options={[{ value: "left", label: "Left" }, { value: "justify", label: "Justified" }]} />
        </div>
        <div>
          <Label>Profile links</Label>
          <Segmented value={s.links} onChange={(v) => setStyle({ links: v })} options={[{ value: "url", label: "linkedin.com/in/…" }, { value: "label", label: "LinkedIn" }]} />
        </div>
      </div>

      <div>
        <Label hint="reorder with the arrows; the eye hides a section">Sections</Label>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {layout.sectionOrder.map((k, i) => {
            const hidden = layout.hiddenSections.includes(k);
            const empty = !sectionHasContent(doc, k);
            return (
              <li key={k} className="flex items-center gap-2 px-3 py-1.5">
                <span className={cx("flex-1 text-[13px]", hidden || empty ? "text-faint" : "text-ink")}>
                  {sectionLabel(doc, k)}
                  {empty && <span className="ml-1.5 text-[11px]">(empty)</span>}
                </span>
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-30">
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label="Move down" disabled={i === layout.sectionOrder.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-30">
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label={hidden ? "Show section" : "Hide section"} onClick={() => toggleSection(k)} className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
                  {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <Label hint="from your contact details">Header shows</Label>
        <div className="flex flex-wrap gap-1.5">
          {LINKS.map((l) => {
            const on = !layout.hiddenLinks.includes(l.key);
            return (
              <button
                key={l.key}
                type="button"
                onClick={() => toggleLink(l.key)}
                aria-pressed={on}
                className={cx("rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition", on ? "border-ink bg-ink text-paper" : "border-line text-muted hover:text-ink")}
              >
                {l.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
