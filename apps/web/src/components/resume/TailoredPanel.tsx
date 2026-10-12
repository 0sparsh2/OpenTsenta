import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Download, Eye, FileText, RotateCcw, Wand2 } from "lucide-react";
import { apiUrl, errorMessage, getToken, useApproveMutation, useRedoResumeMutation, useSaveTailoredMutation, useSwitchProfileMutation, useTailoredResumeQuery } from "../../lib/api";
import type { FitInfo, ResumeDoc, ResumeLayout } from "../../lib/types";
import { toast } from "../toast";
import { Badge, Button, cx, Select, Spinner, Textarea } from "../ui";
import { BlockEditor } from "./BlockEditor";
import { FormatPanel } from "./FormatPanel";
import { PromptEdit } from "./PromptEdit";
import { ResumePreview } from "./ResumePreview";

// ---------- word diff ----------
function wordDiff(a: string, b: string): { t: string; k: "same" | "add" | "del" }[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const dp = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: string; k: "same" | "add" | "del" }[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push({ t: A[i], k: "same" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: A[i++], k: "del" });
    else out.push({ t: B[j++], k: "add" });
  }
  while (i < A.length) out.push({ t: A[i++], k: "del" });
  while (j < B.length) out.push({ t: B[j++], k: "add" });
  return out;
}

/** Inline word diff for rephrasings; separate before/after lines when the text was replaced or reordered. */
function ChangeBody({ before, after }: { before: string; after: string }) {
  if (!after) return <p className="text-[13.5px] leading-relaxed text-muted line-through decoration-coral/40">{before}</p>;
  const parts = wordDiff(before, after);
  const words = parts.filter((p) => p.t.trim());
  const same = words.filter((p) => p.k === "same").length;
  const similar = before && words.length ? same / Math.max(1, words.filter((p) => p.k !== "add").length) >= 0.5 : false;
  if (!similar)
    return (
      <div className="space-y-1 text-[13.5px] leading-relaxed">
        {before && <p className="text-muted line-through decoration-coral/40">{before}</p>}
        <p className="rounded-md bg-kelp-soft/60 px-1.5 py-0.5 text-ink">{after}</p>
      </div>
    );
  return (
    <p className="text-[13.5px] leading-relaxed">
      {parts.map((w, j) =>
        w.k === "same" ? (
          <span key={j}>{w.t}</span>
        ) : w.k === "add" ? (
          <span key={j} className="rounded-sm bg-kelp-soft text-kelp">
            {w.t}
          </span>
        ) : (
          <span key={j} className="text-coral line-through decoration-coral/50">
            {w.t}
          </span>
        ),
      )}
    </p>
  );
}

const fileUrl = (p: string) => apiUrl(`/api/v1${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(getToken() ?? "")}`);

/** The résumé for one application: which profile it came from, what changed, and an editable copy. */
export function TailoredPanel({ applicationId, company }: { applicationId: string; company: string }) {
  const { data, isLoading, refetch } = useTailoredResumeQuery(applicationId);
  const [save] = useSaveTailoredMutation();
  const [approve, { isLoading: approving }] = useApproveMutation();
  const [redo, { isLoading: redoing }] = useRedoResumeMutation();
  const [switchProfile, { isLoading: switching }] = useSwitchProfileMutation();
  const [view, setView] = useState<"preview" | "changes" | "edit" | "format">("preview");
  const [draft, setDraft] = useState<ResumeDoc | null>(null);
  const [fit, setFit] = useState<FitInfo | null>(null);
  const [instructions, setInstructions] = useState("");
  const [future, setFuture] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const synced = useRef<string>("");

  // Adopt the server's version when it changes (first load, redo, profile switch).
  useEffect(() => {
    if (data?.tailored) {
      const key = JSON.stringify(data.tailored);
      if (key !== synced.current) {
        synced.current = key;
        setDraft(data.tailored);
        setSaveState("saved");
      }
    }
  }, [data?.tailored]);

  // Autosave edits (blocks, format, or prompt changes) shortly after they stop.
  const draftKey = draft ? JSON.stringify(draft) : "";
  useEffect(() => {
    if (!draft || draftKey === synced.current) return;
    setSaveState("dirty");
    const t = setTimeout(async () => {
      setSaveState("saving");
      try {
        await save({ id: applicationId, tailored: draft, layout: draft.layout }).unwrap();
        synced.current = draftKey;
        setSaveState("saved");
      } catch (e) {
        toast(errorMessage(e), "error");
        setSaveState("dirty");
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // While the agent is tailoring, keep checking.
  useEffect(() => {
    if (data && !data.tailored) {
      const t = setInterval(() => void refetch(), 4000);
      return () => clearInterval(t);
    }
  }, [data, refetch]);

  if (isLoading || !data) return <Spinner className="mx-auto my-10 h-5 w-5" />;
  const doc = draft ?? data.tailored ?? data.base;
  const layout = doc?.layout;
  const pending = data.status === "PENDING_RESUME_REVIEW";
  const setLayout = (l: ResumeLayout) => draft && setDraft({ ...draft, layout: l });

  const doApprove = async () => {
    try {
      if (draft && draftKey !== synced.current) await save({ id: applicationId, tailored: draft, layout: draft.layout }).unwrap();
      await approve({ id: applicationId }).unwrap();
      toast("Résumé approved. Ferry is applying now.", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const doRedo = async () => {
    try {
      const r = await redo({ id: applicationId, instructions, applyToFuture: future }).unwrap();
      if (r.tailored) {
        synced.current = JSON.stringify(r.tailored);
        setDraft(r.tailored);
      }
      setInstructions("");
      setView("changes");
      toast(future && instructions ? "Re-tailored. Your instructions are saved to the profile too." : "Re-tailored", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const doSwitch = async (profileId: string) => {
    if (profileId === data.profile?.id) return;
    if (!confirm("Use a different profile for this application? Ferry re-tailors from it and discards edits made here.")) return;
    try {
      await switchProfile({ id: applicationId, profileId }).unwrap();
      setDraft(null);
      synced.current = "";
      toast("Switched profile. Re-tailoring now.", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="space-y-4">
      {pending && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sea/30 bg-sea-soft px-3.5 py-3 text-[13px]">
          <Eye className="h-4 w-4 shrink-0 text-sea" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">Preview your tailored résumé.</span> Nothing has been filled in yet. Change anything below (or ask Ferry to), then approve and Ferry applies with this version.
          </p>
          <Button variant="signal" loading={approving} onClick={doApprove} icon={<Check className="h-4 w-4" />}>
            Approve résumé & apply
          </Button>
        </div>
      )}

      {/* Where this résumé came from */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-line bg-paper/50 px-3 py-2.5 text-[13px]">
        <span className="text-muted">Profile</span>
        {data.profiles.length > 1 && data.editable ? (
          <Select aria-label="Profile used" className="h-8 w-auto max-w-[14rem] py-0 text-[13px] font-semibold" value={data.profile?.id ?? ""} disabled={switching} onChange={(e) => doSwitch(e.target.value)}>
            {data.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : (
          <Link to={`/app/profiles?id=${data.profile?.id ?? ""}`} className="font-semibold hover:underline">
            {data.profile?.name ?? "—"}
          </Link>
        )}
        <ArrowRight className="h-3.5 w-3.5 text-faint" />
        <span>
          tailored for <span className="font-semibold">{company}</span>
        </span>
        {data.changes.length > 0 && <Badge tone="kelp">{data.changes.length} edits</Badge>}
        {data.instructions && <Badge tone="sea">redo: “{data.instructions.slice(0, 40)}{data.instructions.length > 40 ? "…" : ""}”</Badge>}
        <span className="ml-auto flex gap-1.5">
          <a href={fileUrl(`/applications/${applicationId}/resume.pdf`)} target="_blank" rel="noreferrer">
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>
              PDF
            </Button>
          </a>
          <a href={fileUrl(`/applications/${applicationId}/resume.docx`)}>
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>
              Word
            </Button>
          </a>
          {data.profile?.hasDocx && (
            <a href={fileUrl(`/applications/${applicationId}/resume.docx?original=1`)} title="The tailored wording inside your own Word design">
              <Button size="sm" variant="ghost" icon={<FileText className="h-3.5 w-3.5" />}>
                My design
              </Button>
            </a>
          )}
        </span>
      </div>

      {!data.tailored ? (
        <p className="py-10 text-center text-[13px] text-muted">
          <Spinner className="mr-2 inline h-4 w-4" />
          Tailoring your “{data.profile?.name}” profile for this role…
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-line bg-paper p-0.5">
              {(
                [
                  ["preview", "Preview"],
                  ["changes", `What changed${data.changes.length ? ` (${data.changes.length})` : ""}`],
                  ["edit", "Edit"],
                  ["format", "Format & length"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setView(id)} className={cx("h-7 rounded-md px-3 text-[13px] font-medium transition", view === id ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink")}>
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-muted" aria-live="polite">
              {saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : "Saved for this application"}
            </span>
          </div>

          {(view === "preview" || view === "edit") && doc && <PromptEdit doc={doc} onApply={setDraft} applicationId={applicationId} />}

          {view === "changes" &&
            (data.changes.length ? (
              <div className="space-y-2.5">
                {data.changes.map((c, i) => (
                  <div key={i} className="rounded-xl border border-line p-3.5">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12px] font-semibold text-ink-2">{c.section}</p>
                      <p className="text-[12px] text-muted">{c.reason}</p>
                    </div>
                    <ChangeBody before={c.before} after={c.after} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-[13px] text-muted">No wording changes: your profile already fits this role.</p>
            ))}
          {view === "preview" && doc && <ResumePreview doc={doc} layout={layout} applicationId={applicationId} onFit={setFit} />}
          {(view === "edit" || view === "format") && doc && layout && (
            <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
              <div className="min-w-0">
                {!data.editable && <p className="mb-2 text-[12.5px] text-muted">This application was already sent; edits here only change the downloads.</p>}
                {view === "edit" ? (
                  <BlockEditor doc={doc} onChange={setDraft} layout={layout} cut={fit?.cut} />
                ) : (
                  <FormatPanel doc={doc} layout={layout} onChange={setLayout} hasDocx={data.profile?.hasDocx} compact />
                )}
              </div>
              <ResumePreview doc={doc} layout={layout} applicationId={applicationId} onFit={setFit} />
            </div>
          )}

          {data.editable && (
            <div className="rounded-xl border border-line p-3.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
                <Wand2 className="h-4 w-4 text-signal" /> Re-tailor from scratch
                <span className="font-normal text-muted">
                  · {data.redos.remaining} of {data.redos.max} left · replaces the edits above
                </span>
              </p>
              <Textarea
                rows={2}
                className="min-h-0"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder='Instructions for a fresh tailoring pass, e.g. "Aim it at the platform side of the role"'
                disabled={!data.redos.remaining}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={future} onChange={(e) => setFuture(e.target.checked)} /> Also use for future roles with the “{data.profile?.name}” profile
                </label>
                <Button size="sm" loading={redoing} disabled={!data.redos.remaining} onClick={doRedo} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                  Re-tailor
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
