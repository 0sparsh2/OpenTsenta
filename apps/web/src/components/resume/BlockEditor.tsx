import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Plus, Scissors, Trash2 } from "lucide-react";
import type { ResumeDoc, ResumeLayout, SectionKey } from "../../lib/types";
import { TagInput } from "../../pages/Onboarding";
import { cx, Input, Label } from "../ui";
import { sectionLabel } from "./FormatPanel";

const rid = () => Math.random().toString(16).slice(2, 10);
const BUILTIN_ORDER: SectionKey[] = ["summary", "experience", "education", "skills", "projects", "certifications", "coursework"];

/** Auto-growing single-paragraph text box. */
function GrowText({ value, onChange, placeholder, className, autoFocus, onKeyDown }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange(e.target.value)}
      className={cx("block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 text-[13.5px] leading-snug text-ink placeholder:text-faint hover:border-line focus:border-sea focus:bg-card focus:outline-none focus:ring-2 focus:ring-sea/15", className)}
    />
  );
}

function Mini({ label, value, onChange, placeholder, className }: { label: string; value?: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-0.5 block text-[11.5px] font-medium text-muted">{label}</span>
      <Input className="h-8 text-[13px]" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const iconBtn = "rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-30";

/** Bullets: Enter adds one below, Backspace on an empty one removes it. */
function Bullets({ bullets, onChange, cutIds, idFor, placeholder = "What you did and the result, with a number if you have one" }: { bullets: string[]; onChange: (b: string[]) => void; cutIds?: Set<string>; idFor?: (i: number) => string; placeholder?: string }) {
  const [focus, setFocus] = useState<number | null>(null);
  const set = (i: number, v: string) => onChange(bullets.map((b, j) => (j === i ? v : b)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...bullets];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-0.5">
      {bullets.map((b, i) => {
        const cut = idFor && cutIds?.has(idFor(i));
        return (
          <div key={i} className="group flex items-start gap-1">
            <span className="mt-[7px] w-3 shrink-0 text-center text-[13px] text-faint">•</span>
            <div className="min-w-0 flex-1">
              <GrowText
                value={b}
                autoFocus={focus === i}
                placeholder={placeholder}
                className={cx(cut && "text-faint line-through")}
                onChange={(v) => set(i, v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const next = [...bullets];
                    next.splice(i + 1, 0, "");
                    onChange(next);
                    setFocus(i + 1);
                  } else if (e.key === "Backspace" && !b && bullets.length > 1) {
                    e.preventDefault();
                    onChange(bullets.filter((_, j) => j !== i));
                    setFocus(Math.max(0, i - 1));
                  }
                }}
              />
              {cut && (
                <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber">
                  <Scissors className="h-3 w-3" /> cut to fit the page limit
                </span>
              )}
            </div>
            <div className="flex shrink-0 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" className={iconBtn} aria-label="Move bullet up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={iconBtn} aria-label="Move bullet down" disabled={i === bullets.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={iconBtn} aria-label="Delete bullet" onClick={() => onChange(bullets.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          onChange([...bullets, ""]);
          setFocus(bullets.length);
        }}
        className="ml-4 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12.5px] font-medium text-sea hover:bg-sea-soft"
      >
        <Plus className="h-3.5 w-3.5" /> Bullet
      </button>
    </div>
  );
}

/** One collapsible entry (a role, a degree, a project). */
function Entry({ title, meta, hidden, onHide, onUp, onDown, onDelete, children, open: openInit = false }: { title: string; meta?: string; hidden?: boolean; onHide?: () => void; onUp?: () => void; onDown?: () => void; onDelete: () => void; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  return (
    <div className={cx("rounded-xl border border-line bg-card", hidden && "opacity-60")}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-paper" aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
          <span className="truncate text-[13.5px] font-semibold">{title || "Untitled"}</span>
          {meta && <span className="truncate text-[12.5px] text-muted">{meta}</span>}
          {hidden && <span className="shrink-0 text-[11px] text-muted">hidden</span>}
        </button>
        {onUp && (
          <button type="button" className={iconBtn} aria-label="Move up" onClick={onUp}>
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        )}
        {onDown && (
          <button type="button" className={iconBtn} aria-label="Move down" onClick={onDown}>
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
        {onHide && (
          <button type="button" className={iconBtn} aria-label={hidden ? "Show on résumé" : "Hide from résumé"} title={hidden ? "Show on résumé" : "Hide from résumé"} onClick={onHide}>
            {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
        <button type="button" className={iconBtn} aria-label="Delete" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && <div className="space-y-2.5 border-t border-line px-3 pt-2.5 pb-3">{children}</div>}
    </div>
  );
}

function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-line-2 px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 hover:border-ink hover:text-ink">
      <Plus className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

function swap<T>(xs: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= xs.length) return xs;
  const next = [...xs];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

const datesOf = (s?: string, e?: string, current?: boolean) => [s, current ? "Present" : e].filter(Boolean).join(" – ");

/** Edit a résumé block by block. Sections follow the layout's order; hidden ones are marked. */
export function BlockEditor({ doc, onChange, layout, cut }: { doc: ResumeDoc; onChange: (d: ResumeDoc) => void; layout: ResumeLayout; cut?: string[] }) {
  const cutIds = new Set(cut ?? []);
  const edit = (fn: (d: ResumeDoc) => void) => {
    const next = structuredClone(doc);
    fn(next);
    onChange(next);
  };
  const customKeys = (doc.custom ?? []).map((c) => `custom:${c.id}` as SectionKey);
  const order = [...new Set([...layout.sectionOrder.filter((k) => !k.startsWith("custom:") || customKeys.includes(k)), ...BUILTIN_ORDER, ...customKeys])];

  const section = (k: SectionKey): ReactNode => {
    switch (k) {
      case "summary":
        return (
          <div className="space-y-2">
            <div>
              <Label hint="optional, under your name">Headline</Label>
              <Input value={doc.headline ?? ""} placeholder="Backend engineer · Go, Kubernetes, payments" onChange={(e) => edit((d) => void (d.headline = e.target.value || undefined))} />
            </div>
            <div className="rounded-lg border border-line">
              <GrowText value={doc.summary ?? ""} placeholder="Two or three sentences on who you are and what you do best." className="min-h-16 py-2" onChange={(v) => edit((d) => void (d.summary = v || undefined))} />
            </div>
          </div>
        );
      case "experience":
        return (
          <div className="space-y-2">
            {doc.experience.map((e, i) => (
              <Entry
                key={e.id}
                title={e.company}
                meta={[e.title, datesOf(e.start, e.end, e.current)].filter(Boolean).join(" · ")}
                hidden={e.hidden}
                open={i === 0}
                onHide={() => edit((d) => void (d.experience[i].hidden = !e.hidden || undefined))}
                onUp={i > 0 ? () => edit((d) => void (d.experience = swap(d.experience, i, -1))) : undefined}
                onDown={i < doc.experience.length - 1 ? () => edit((d) => void (d.experience = swap(d.experience, i, 1))) : undefined}
                onDelete={() => edit((d) => void d.experience.splice(i, 1))}
              >
                <div className="grid grid-cols-2 gap-2">
                  <Mini label="Company" value={e.company} onChange={(v) => edit((d) => void (d.experience[i].company = v))} />
                  <Mini label="Title" value={e.title} onChange={(v) => edit((d) => void (d.experience[i].title = v))} />
                  <Mini label="Location" value={e.location} onChange={(v) => edit((d) => void (d.experience[i].location = v || undefined))} />
                  <div className="grid grid-cols-2 gap-2">
                    <Mini label="Start" placeholder="2022-01" value={e.start} onChange={(v) => edit((d) => void (d.experience[i].start = v || undefined))} />
                    {e.current ? (
                      <div className="pt-5 text-[12.5px] text-muted">Present</div>
                    ) : (
                      <Mini label="End" placeholder="2024-06" value={e.end} onChange={(v) => edit((d) => void (d.experience[i].end = v || undefined))} />
                    )}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={Boolean(e.current)} onChange={(ev) => edit((d) => void (d.experience[i].current = ev.target.checked || undefined))} /> I work here now
                </label>
                <Bullets bullets={e.bullets} cutIds={cutIds} idFor={(b) => `exp:${e.id}:${b}`} onChange={(b) => edit((d) => void (d.experience[i].bullets = b))} />
              </Entry>
            ))}
            <AddButton onClick={() => edit((d) => void d.experience.unshift({ id: rid(), company: "", title: "", bullets: [""] }))}>Role</AddButton>
          </div>
        );
      case "education":
        return (
          <div className="space-y-2">
            {doc.education.map((e, i) => (
              <Entry
                key={e.id}
                title={e.school}
                meta={[[e.degree, e.field].filter(Boolean).join(", "), e.end].filter(Boolean).join(" · ")}
                hidden={e.hidden}
                onHide={() => edit((d) => void (d.education[i].hidden = !e.hidden || undefined))}
                onUp={i > 0 ? () => edit((d) => void (d.education = swap(d.education, i, -1))) : undefined}
                onDelete={() => edit((d) => void d.education.splice(i, 1))}
              >
                <div className="grid grid-cols-2 gap-2">
                  <Mini className="col-span-2" label="School" value={e.school} onChange={(v) => edit((d) => void (d.education[i].school = v))} />
                  <Mini label="Degree" placeholder="B.S." value={e.degree} onChange={(v) => edit((d) => void (d.education[i].degree = v || undefined))} />
                  <Mini label="Field" placeholder="Computer Science" value={e.field} onChange={(v) => edit((d) => void (d.education[i].field = v || undefined))} />
                  <Mini label="Start" placeholder="2015" value={e.start} onChange={(v) => edit((d) => void (d.education[i].start = v || undefined))} />
                  <Mini label="End / graduation" placeholder="2019" value={e.end} onChange={(v) => edit((d) => void (d.education[i].end = v || undefined))} />
                  <Mini label="GPA" value={e.gpa} onChange={(v) => edit((d) => void (d.education[i].gpa = v || undefined))} />
                  <Mini label="Honors" placeholder="Magna cum laude" value={e.honors} onChange={(v) => edit((d) => void (d.education[i].honors = v || undefined))} />
                </div>
              </Entry>
            ))}
            <AddButton onClick={() => edit((d) => void d.education.push({ id: rid(), school: "" }))}>Education</AddButton>
          </div>
        );
      case "skills":
        return doc.skillGroups?.length ? (
          <div className="space-y-2">
            {doc.skillGroups.map((g, i) => (
              <div key={g.id} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-start gap-2">
                <Input className="h-8 text-[13px] font-semibold" value={g.name} placeholder="Languages" onChange={(e) => edit((d) => void (d.skillGroups![i].name = e.target.value))} />
                <TagInput value={g.skills} onChange={(v) => edit((d) => void (d.skillGroups![i].skills = v))} placeholder="Add skills" />
                <button type="button" className={cx(iconBtn, "mt-1.5")} aria-label="Delete group" onClick={() => edit((d) => void d.skillGroups!.splice(i, 1))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <AddButton onClick={() => edit((d) => void d.skillGroups!.push({ id: rid(), name: "", skills: [] }))}>Group</AddButton>
              <button
                type="button"
                className="text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline"
                onClick={() =>
                  edit((d) => {
                    d.skills = [...new Set(d.skillGroups!.flatMap((g) => g.skills))];
                    d.skillGroups = undefined;
                  })
                }
              >
                Use one flat list
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <TagInput value={doc.skills} onChange={(v) => edit((d) => void (d.skills = v))} placeholder="Type a skill, press Enter" />
            <button
              type="button"
              className="text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline"
              onClick={() => edit((d) => void (d.skillGroups = [{ id: rid(), name: "Skills", skills: [...d.skills] }]))}
            >
              Group by category (Languages, Tools, …)
            </button>
          </div>
        );
      case "projects": {
        const projects = doc.projects ?? [];
        return (
          <div className="space-y-2">
            {projects.map((p, i) => (
              <Entry
                key={p.id}
                title={p.name}
                meta={p.description}
                hidden={p.hidden || cutIds.has(`proj:${p.id}`)}
                onHide={() => edit((d) => void (d.projects![i].hidden = !p.hidden || undefined))}
                onUp={i > 0 ? () => edit((d) => void (d.projects = swap(d.projects!, i, -1))) : undefined}
                onDelete={() => edit((d) => void d.projects!.splice(i, 1))}
              >
                <div className="grid grid-cols-2 gap-2">
                  <Mini label="Name" value={p.name} onChange={(v) => edit((d) => void (d.projects![i].name = v))} />
                  <Mini label="Link" placeholder="github.com/you/project" value={p.url} onChange={(v) => edit((d) => void (d.projects![i].url = v || undefined))} />
                  <Mini className="col-span-2" label="One-line description" value={p.description} onChange={(v) => edit((d) => void (d.projects![i].description = v || undefined))} />
                </div>
                {cutIds.has(`proj:${p.id}`) && (
                  <p className="flex items-center gap-1 text-[11.5px] text-amber">
                    <Scissors className="h-3 w-3" /> Whole project cut to fit the page limit
                  </p>
                )}
                <Bullets bullets={p.bullets} cutIds={cutIds} idFor={(b) => `proj:${p.id}:${b}`} onChange={(b) => edit((d) => void (d.projects![i].bullets = b))} />
              </Entry>
            ))}
            <AddButton onClick={() => edit((d) => void (d.projects = [...(d.projects ?? []), { id: rid(), name: "", bullets: [""] }]))}>Project</AddButton>
          </div>
        );
      }
      case "certifications": {
        const certs = doc.certifications ?? [];
        return (
          <div className="space-y-1.5">
            {certs.map((c, i) => (
              <div key={c.id} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_6rem_auto] items-end gap-2">
                <Mini label="Certification" value={c.name} onChange={(v) => edit((d) => void (d.certifications![i].name = v))} />
                <Mini label="Issuer" value={c.issuer} onChange={(v) => edit((d) => void (d.certifications![i].issuer = v || undefined))} />
                <Mini label="Date" placeholder="2023" value={c.date} onChange={(v) => edit((d) => void (d.certifications![i].date = v || undefined))} />
                <button type="button" className={cx(iconBtn, "mb-1.5")} aria-label="Delete certification" onClick={() => edit((d) => void d.certifications!.splice(i, 1))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <AddButton onClick={() => edit((d) => void (d.certifications = [...(d.certifications ?? []), { id: rid(), name: "" }]))}>Certification</AddButton>
          </div>
        );
      }
      case "coursework":
        return <TagInput value={doc.coursework ?? []} onChange={(v) => edit((d) => void (d.coursework = v.length ? v : undefined))} placeholder="Distributed Systems, Databases…" />;
      default: {
        const si = doc.custom?.findIndex((c) => `custom:${c.id}` === k) ?? -1;
        const s = si >= 0 ? doc.custom![si] : null;
        if (!s) return null;
        return (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <Mini className="flex-1" label="Section title" value={s.title} onChange={(v) => edit((d) => void (d.custom![si].title = v))} />
              <button type="button" className={cx(iconBtn, "mb-1.5")} aria-label="Delete section" onClick={() => edit((d) => void d.custom!.splice(si, 1))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {s.items.map((it, j) => (
              <Entry key={it.id} title={it.title ?? ""} meta={it.subtitle} onDelete={() => edit((d) => void d.custom![si].items.splice(j, 1))} open>
                <div className="grid grid-cols-2 gap-2">
                  <Mini label="Title (optional)" value={it.title} onChange={(v) => edit((d) => void (d.custom![si].items[j].title = v || undefined))} />
                  <Mini label="Subtitle" value={it.subtitle} onChange={(v) => edit((d) => void (d.custom![si].items[j].subtitle = v || undefined))} />
                </div>
                <Bullets bullets={it.bullets} placeholder="A line for this section" onChange={(b) => edit((d) => void (d.custom![si].items[j].bullets = b))} />
              </Entry>
            ))}
            <AddButton onClick={() => edit((d) => void d.custom![si].items.push({ id: rid(), bullets: [""] }))}>Item</AddButton>
          </div>
        );
      }
    }
  };

  return (
    <div className="space-y-5">
      {order.map((k) => {
        const hidden = layout.hiddenSections.includes(k);
        return (
          <section key={k}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">{sectionLabel(doc, k)}</h3>
              {hidden && <span className="rounded-full bg-ink/6 px-1.5 text-[11px] text-muted">hidden in Format</span>}
              {k === "certifications" && cutIds.has("sec:certifications") && <span className="text-[11px] text-amber">cut to fit</span>}
              {k === "coursework" && cutIds.has("sec:coursework") && <span className="text-[11px] text-amber">cut to fit</span>}
            </div>
            {section(k)}
          </section>
        );
      })}
      <AddButton onClick={() => edit((d) => void (d.custom = [...(d.custom ?? []), { id: rid(), title: "Awards", items: [{ id: rid(), bullets: [""] }] }]))}>Custom section (awards, volunteering, publications…)</AddButton>
    </div>
  );
}
