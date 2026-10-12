import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Copy, Download, FileText, FileUp, Plus, Star, Trash2, X } from "lucide-react";
import {
  apiUrl,
  errorMessage,
  getToken,
  useDeleteResumeMutation,
  useDuplicateResumeMutation,
  useRematchMutation,
  useResumesQuery,
  useSetDefaultResumeMutation,
  useUpdateResumeMutation,
  useUploadResumeMutation,
} from "../lib/api";
import type { FitInfo, Resume, ResumeDoc, ResumeLayout } from "../lib/types";
import { PageHeader } from "../components/AppLayout";
import { BlockEditor } from "../components/resume/BlockEditor";
import { FormatPanel } from "../components/resume/FormatPanel";
import { PromptEdit } from "../components/resume/PromptEdit";
import { ResumePreview } from "../components/resume/ResumePreview";
import { toast } from "../components/toast";
import { Badge, Button, Card, cx, Empty, Input, Label, Select, Spinner, Tabs, Textarea } from "../components/ui";
import { TagInput } from "./Onboarding";

const fileUrl = (p: string) => apiUrl(`/api/v1${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(getToken() ?? "")}`);

export default function ProfilesPage() {
  const { data: profiles, isLoading } = useResumesQuery();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get("new") === "1");
  const selected = profiles?.find((p) => p.id === params.get("id")) ?? profiles?.find((p) => p.isDefault) ?? profiles?.[0];
  const select = (id: string) => setParams({ id }, { replace: true });

  if (isLoading) return <Spinner className="mx-auto mt-24 h-6 w-6" />;
  return (
    <>
      <PageHeader
        title="Résumé profiles"
        sub="One profile per kind of role. Ferry picks the best fit for each job, then tailors a copy of it for that application."
        action={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New profile
          </Button>
        }
      />
      {!profiles?.length ? (
        <Card className="p-8">
          <Empty
            icon={<FileText className="h-6 w-6" />}
            title="Import your résumé to create your first profile"
            sub="PDF, Word, or plain text. Ferry reads it into blocks you can edit, format, and fit to one page."
            action={
              <Button variant="primary" icon={<FileUp className="h-4 w-4" />} onClick={() => setCreating(true)}>
                Import a résumé
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="scroll-thin mb-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Profiles">
            {profiles.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === selected?.id}
                onClick={() => select(p.id)}
                className={cx(
                  "flex shrink-0 items-center gap-2 rounded-xl border px-3.5 py-2 text-left transition",
                  p.id === selected?.id ? "border-ink bg-card shadow-card" : "border-line bg-paper/40 hover:border-line-2",
                )}
              >
                {p.isDefault && <Star className="h-3.5 w-3.5 fill-amber text-amber" aria-label="Default" />}
                <span className="text-[14px] font-semibold">{p.name}</span>
                <span className="text-[12px] text-muted">{p.applications ? `${p.applications} applied` : "not used yet"}</span>
              </button>
            ))}
          </div>
          {selected && <ProfileWorkspace key={selected.id} profile={selected} profiles={profiles} onDeleted={() => setParams({}, { replace: true })} />}
        </>
      )}
      {creating && (
        <NewProfileDialog
          profiles={profiles ?? []}
          onClose={() => {
            setCreating(false);
            if (params.get("new")) setParams(selected ? { id: selected.id } : {}, { replace: true });
          }}
          onCreated={(id) => {
            setCreating(false);
            select(id);
          }}
        />
      )}
    </>
  );
}

function ProfileWorkspace({ profile, profiles, onDeleted }: { profile: Resume; profiles: Resume[]; onDeleted: () => void }) {
  const [update] = useUpdateResumeMutation();
  const [setDefault] = useSetDefaultResumeMutation();
  const [del, { isLoading: deleting }] = useDeleteResumeMutation();
  const [rematch] = useRematchMutation();
  const [tab, setTab] = useState("content");
  const [doc, setDoc] = useState<ResumeDoc>(profile.doc);
  const [layout, setLayout] = useState<ResumeLayout>(profile.layout);
  const [name, setName] = useState(profile.name);
  const [targets, setTargets] = useState(profile.targets);
  const [notes, setNotes] = useState(profile.notes);
  const [fit, setFit] = useState<FitInfo | null>(null);
  const [state, setState] = useState<"saved" | "dirty" | "saving">("saved");
  const first = useRef(true);
  const targetsChanged = useRef(false);

  // Autosave a moment after edits stop.
  const payload = JSON.stringify({ doc, layout, name, targets, notes });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setState("dirty");
    const t = setTimeout(async () => {
      setState("saving");
      try {
        await update({ id: profile.id, doc, layout, name: name.trim() || profile.name, targets, notes }).unwrap();
        setState("saved");
      } catch (e) {
        toast(errorMessage(e), "error");
        setState("dirty");
      }
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // Re-score jobs when what this profile targets changes (once editing settles).
  useEffect(() => {
    if (!targetsChanged.current || state !== "saved") return;
    targetsChanged.current = false;
    void rematch();
  }, [state, rematch]);

  const remove = async () => {
    if (!confirm(`Delete the "${profile.name}" profile? Applications already sent keep their résumé.`)) return;
    try {
      await del(profile.id).unwrap();
      onDeleted();
      toast("Profile deleted", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="min-w-0">
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Profile name" className="h-9 max-w-xs flex-1 text-[15px] font-semibold" value={name} onChange={(e) => setName(e.target.value)} />
            {profile.isDefault ? (
              <Badge tone="amber">
                <Star className="h-3 w-3 fill-current" /> Default
              </Badge>
            ) : (
              <Button size="sm" variant="ghost" icon={<Star className="h-3.5 w-3.5" />} onClick={() => setDefault(profile.id)}>
                Make default
              </Button>
            )}
            <span className="ml-auto text-[12px] text-muted" aria-live="polite">
              {state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : "All changes saved"}
            </span>
          </div>
          <p className="mt-2 text-[12.5px] text-muted">
            {profile.origin === "duplicate" ? "Copied from another profile" : profile.fileName ? `Imported from ${profile.fileName}` : "Imported from pasted text"}
            {" · "}
            {profiles.length > 1 ? "Used for jobs that match its target titles best." : "Used for every job until you add another profile."}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <a href={fileUrl(`/resumes/${profile.id}/pdf`)} target="_blank" rel="noreferrer">
              <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>
                PDF
              </Button>
            </a>
            <a href={fileUrl(`/resumes/${profile.id}/docx`)}>
              <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>
                Word
              </Button>
            </a>
            {profile.fileName && (
              <a href={fileUrl(`/resumes/${profile.id}/original`)}>
                <Button size="sm" variant="ghost" icon={<FileText className="h-3.5 w-3.5" />}>
                  Original file
                </Button>
              </a>
            )}
            {!profile.isDefault && (
              <Button size="sm" variant="ghost" className="ml-auto" loading={deleting} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
                Delete
              </Button>
            )}
          </div>
        </Card>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "content", label: "Content" },
            { id: "format", label: "Format & length" },
            { id: "targeting", label: "Targeting & notes" },
          ]}
        />
        <div className="pt-4">
          {tab === "content" && (
            <>
              <PromptEdit
                className="mb-4"
                doc={{ ...doc, layout }}
                onApply={(d) => {
                  setDoc(d);
                  if (d.layout) setLayout(d.layout);
                }}
              />
              <BlockEditor doc={doc} onChange={setDoc} layout={layout} cut={fit?.cut} />
            </>
          )}
          {tab === "format" && <FormatPanel doc={doc} layout={layout} onChange={setLayout} hasDocx={profile.hasDocx} />}
          {tab === "targeting" && (
            <div className="space-y-4">
              <div>
                <Label hint="jobs with these titles use this profile">Target titles</Label>
                <TagInput
                  value={targets.titles}
                  onChange={(titles) => {
                    targetsChanged.current = true;
                    setTargets({ ...targets, titles });
                  }}
                  placeholder="Backend Engineer, Platform Engineer…"
                />
              </div>
              <div>
                <Label hint="boost jobs mentioning these">Keywords</Label>
                <TagInput
                  value={targets.keywords}
                  onChange={(keywords) => {
                    targetsChanged.current = true;
                    setTargets({ ...targets, keywords });
                  }}
                  placeholder="Go, Kubernetes, payments…"
                />
              </div>
              <div>
                <Label hint="used when tailoring and writing answers for this profile">Notes for Ferry</Label>
                <Textarea
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Lead with infrastructure work. Mention I'm open to on-call. Don't mention the startup I left after 3 months."
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <ResumePreview doc={doc} layout={layout} onFit={setFit} />
      </div>
    </div>
  );
}

function NewProfileDialog({ profiles, onClose, onCreated }: { profiles: Resume[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<"import" | "duplicate">("import");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState(profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "");
  const [drag, setDrag] = useState(false);
  const [upload, { isLoading: uploading }] = useUploadResumeMutation();
  const [duplicate, { isLoading: copying }] = useDuplicateResumeMutation();
  const input = useRef<HTMLInputElement>(null);
  const busy = uploading || copying;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const create = async () => {
    try {
      if (mode === "import") {
        if (!file) return toast("Choose a résumé file", "error");
        const fd = new FormData();
        fd.set("file", file);
        if (name.trim()) fd.set("name", name.trim());
        const r = await upload(fd).unwrap();
        toast(`Created "${r.resume.name}": ${r.resume.doc.experience.length} roles, ${r.resume.doc.skills.length} skills`, "success");
        onCreated(r.resume.id);
      } else {
        if (!name.trim()) return toast("Name the new profile", "error");
        const r = await duplicate({ sourceId: source, name: name.trim() }).unwrap();
        toast(`Created "${r.name}"`, "success");
        onCreated(r.id);
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="np-title" className="w-full max-w-lg rounded-2xl border border-line bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="np-title" className="text-[17px] font-semibold">
              New profile
            </h2>
            <p className="text-[13px] text-muted">Make one per kind of role, like "Backend Engineer" and "Data Engineer".</p>
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <Label hint={mode === "import" ? "optional; read from the résumé" : undefined}>Profile name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Software Engineer, Data Scientist" autoFocus />
          </div>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Start from</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  ["import", "Import a résumé", "Read a PDF, Word, or text file"],
                  ["duplicate", "Copy a profile", "Start from one you already have"],
                ] as const
              )
                .filter(([m]) => m === "import" || profiles.length)
                .map(([m, title, sub]) => (
                  <label key={m} className={cx("cursor-pointer rounded-xl border p-3 transition", mode === m ? "border-ink bg-paper/60 ring-2 ring-ink/10" : "border-line hover:border-line-2")}>
                    <input type="radio" name="np-mode" className="sr-only" checked={mode === m} onChange={() => setMode(m)} />
                    <span className="block text-[14px] font-semibold">{title}</span>
                    <span className="block text-[12.5px] text-muted">{sub}</span>
                  </label>
                ))}
            </div>
          </fieldset>

          {mode === "import" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              className={cx("rounded-xl border-2 border-dashed p-5 text-center transition", drag ? "border-sea bg-sea-soft" : "border-line")}
            >
              <FileUp className="mx-auto mb-2 h-6 w-6 text-muted" />
              {file ? <p className="text-[14px] font-medium">{file.name}</p> : <p className="text-[13.5px] text-ink-2">Drop your résumé here</p>}
              <Button size="sm" className="mt-2" onClick={() => input.current?.click()}>
                {file ? "Choose another" : "Choose file"}
              </Button>
              <input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <p className="mt-2 text-[12px] text-muted">Imported from Word? You can keep your own design for tailored versions.</p>
            </div>
          ) : (
            <div>
              <Label>Copy from</Label>
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {busy && <span className="mr-auto text-[12.5px] text-muted">{uploading ? "Reading your résumé…" : "Copying…"}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create} icon={mode === "duplicate" ? <Copy className="h-4 w-4" /> : undefined}>
            Create profile
          </Button>
        </div>
      </div>
    </div>
  );
}
