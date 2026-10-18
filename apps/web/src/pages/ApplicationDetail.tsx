import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useSelector } from "react-redux";
import { ArrowLeft, Bot, Camera, Check, CircleAlert, Download, ExternalLink, FileText, ListChecks, Mail, MousePointerClick, RefreshCw, Send, SkipForward, Sparkles, TriangleAlert } from "lucide-react";
import {
  apiUrl,
  errorMessage,
  getToken,
  useAppActionMutation,
  useApplicationAccountQuery,
  useApplicationQuery,
  useAnswerApplicationMutation,
  useApproveMutation,
  useFinishedMyselfMutation,
  useMeQuery,
  useRevealApplicationAccountMutation,
  useSaveCoverLetterMutation,
} from "../lib/api";
import type { RootState } from "../lib/store";
import type { ApplicationDetail as App, FilledField, PipelineStatus, TraceStep } from "../lib/types";
import { toast } from "../components/toast";
import { TailoredPanel } from "../components/resume/TailoredPanel";
import { Badge, Button, Card, CompanyMark, cx, Input, Select, Spinner, StatusPill, Tabs, Textarea, timeAgo, TRACKED_META } from "../components/ui";

const STEPS: { label: string; done: (s: PipelineStatus) => boolean; active: PipelineStatus[] }[] = [
  { label: "Tailor", done: (s) => !["QUEUED", "OPTIMIZING", "OPTIMIZING_RESUME", "PENDING_RESUME_REVIEW"].includes(s), active: ["OPTIMIZING", "OPTIMIZING_RESUME", "PENDING_RESUME_REVIEW"] },
  { label: "Cover letter", done: (s) => !["QUEUED", "OPTIMIZING", "OPTIMIZING_RESUME", "PENDING_RESUME_REVIEW", "OPTIMIZING_CL", "PENDING_CL_REVIEW"].includes(s), active: ["OPTIMIZING_CL", "PENDING_CL_REVIEW"] },
  { label: "Fill form", done: (s) => ["PENDING_SUBMIT_REVIEW", "COMPLETED"].includes(s), active: ["READY", "RUNNING", "NEEDS_INPUT"] },
  { label: "Your review", done: (s) => s === "COMPLETED", active: ["PENDING_SUBMIT_REVIEW"] },
  { label: "Submitted", done: (s) => s === "COMPLETED", active: [] },
];

function Stepper({ status }: { status: PipelineStatus }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      {STEPS.map((st, i) => {
        const done = st.done(status);
        const active = st.active.includes(status);
        const failed = status === "FAILED" && !done && (i === 0 || STEPS[i - 1].done(status));
        return (
          <div key={st.label} className="flex shrink-0 items-center gap-1.5">
            <span
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
                done ? "border-kelp/30 bg-kelp-soft text-kelp" : active ? "border-sea/30 bg-sea-soft text-sea" : failed ? "border-coral/30 bg-coral-soft text-coral" : "border-line text-muted",
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : active ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" /> : null}
              {st.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-line-2" />}
          </div>
        );
      })}
    </div>
  );
}

const SOURCE_META: Record<FilledField["source"], { label: string; tone: "ink" | "sea" | "kelp" | "amber" | "signal" }> = {
  profile: { label: "Profile", tone: "ink" },
  resume: { label: "Document", tone: "ink" },
  memory: { label: "Memory", tone: "sea" },
  ai: { label: "AI draft", tone: "amber" },
  library: { label: "Your answer", tone: "kelp" },
  written: { label: "Written for this job", tone: "sea" },
  default: { label: "Default", tone: "ink" },
  user: { label: "You", tone: "kelp" },
  unanswered: { label: "Missing", tone: "signal" },
};

function FieldEditor({ f, value, onChange }: { f: FilledField; value: string; onChange: (v: string) => void }) {
  if (f.options?.length && (f.kind === "select" || f.kind === "radio" || f.kind === "combobox"))
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {f.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  if (f.kind === "textarea") return <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={5} placeholder="Your answer" />;
  if (f.kind === "checkbox" && !f.options?.length)
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option>Yes</option>
        <option>No</option>
      </Select>
    );
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Your answer" />;
}

const fmtValue = (f: FilledField) => {
  if (f.value == null || f.value === "") return null;
  if (f.kind === "file") return String(f.value).split("/").pop();
  return Array.isArray(f.value) ? f.value.join(", ") : String(f.value);
};

function FieldsPanel({ app, editable, edits, setEdits }: { app: App; editable: boolean; edits: Record<string, string>; setEdits: (e: Record<string, string>) => void }) {
  if (!app.fields.length) return <p className="py-10 text-center text-[13px] text-muted">The form hasn't been opened yet.</p>;
  const pages = [...new Set(app.fields.map((f) => f.page ?? 1))];
  return (
    <div className="space-y-5">
      {pages.map((p) => (
        <div key={p}>
          {pages.length > 1 && <p className="mb-2 font-mono text-[11px] tracking-wide text-faint uppercase">Page {p}</p>}
          <div className="divide-y divide-line rounded-xl border border-line">
            {app.fields
              .filter((f) => (f.page ?? 1) === p)
              .map((f) => {
                const missing = f.required && (f.value == null || f.value === "");
                const v = fmtValue(f);
                const canEdit = editable && f.kind !== "file";
                return (
                  <div key={f.id} className={cx("grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]", missing && "bg-signal-soft/40")}>
                    <div className="min-w-0">
                      <p className="text-[13px] leading-snug font-medium">
                        {f.label || <span className="text-faint">(unlabeled)</span>}
                        {f.required && <span className="text-signal"> *</span>}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={SOURCE_META[f.source].tone} className="text-[11px]">
                          {SOURCE_META[f.source].label}
                        </Badge>
                        <span className="font-mono text-[11px] text-faint">{f.kind}</span>
                        {f.note && <span className="text-[11px] text-signal">{f.note}</span>}
                      </div>
                    </div>
                    <div className="min-w-0 text-[13px]">
                      {canEdit && (missing || edits[f.id] !== undefined || f.source === "ai") ? (
                        <FieldEditor f={f} value={edits[f.id] ?? (v ?? "")} onChange={(val) => setEdits({ ...edits, [f.id]: val })} />
                      ) : v ? (
                        <div className="flex items-start gap-2">
                          <p className={cx("min-w-0 flex-1 break-words whitespace-pre-wrap", f.kind === "file" && "font-mono text-[12px]")}>{v}</p>
                          {canEdit && (
                            <button className="shrink-0 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setEdits({ ...edits, [f.id]: v })}>
                              Edit
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-faint">Left blank</span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

function TracePanel({ trace }: { trace: TraceStep[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const icon = (k: TraceStep["kind"]) =>
    k === "action" ? <MousePointerClick className="h-3.5 w-3.5" /> : k === "screenshot" ? <Camera className="h-3.5 w-3.5" /> : k === "error" ? <TriangleAlert className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />;
  return (
    <>
      <ol className="relative space-y-3 border-l border-line pl-5">
        {trace.map((s, i) => (
          <li key={i} className="relative">
            <span className={cx("absolute top-0.5 -left-[27px] grid h-5 w-5 place-items-center rounded-full border bg-card", s.kind === "error" ? "border-coral/40 text-coral" : s.kind === "action" ? "border-sea/40 text-sea" : "border-line text-muted")}>
              {icon(s.kind)}
            </span>
            <p className={cx("text-[13px]", s.kind === "error" && "text-coral")}>{s.text}</p>
            <p className="font-mono text-[11px] text-faint">{new Date(s.t).toLocaleTimeString()}</p>
            {s.image && (
              <button onClick={() => setZoom(s.image!)} className="mt-2 block overflow-hidden rounded-lg border border-line hover:border-line-2">
                <img src={apiUrl(s.image)} alt={s.text} loading="lazy" className="max-h-56 w-auto object-cover object-top" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {zoom && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4" onClick={() => setZoom(null)}>
          <img src={apiUrl(zoom)} alt="Screenshot" className="max-h-full max-w-full rounded-lg shadow-pop" />
        </div>
      )}
    </>
  );
}

/** An emailed code Ferry is waiting on, with the employer's page held open: type it here (or let Claude or muse). */
function CodePrompt({ app }: { app: App }) {
  const [value, setValue] = useState("");
  const [answer, { isLoading }] = useAnswerApplicationMutation();
  const ask = app.asks;
  if (!ask) return null;
  const link = ask.kind === "verification_link";
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await answer({ id: app.id, answers: [{ field_id: ask.field_id, value: value.trim() }] }).unwrap();
      setValue("");
      toast(link ? "Sent. Ferry is opening the link." : "Sent. Ferry is entering the code.", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <form onSubmit={send} className="mt-3 rounded-lg bg-signal-soft px-3 py-2.5 text-[13px] text-ink">
      <p className="flex items-start gap-2 font-medium">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
        {ask.question}
      </p>
      <p className="mt-1 pl-6 text-muted">Ferry is holding the page open until {new Date(ask.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Claude or muse can answer this too.</p>
      <div className="mt-2 flex gap-2 pl-6">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={link ? "https://…" : "123456"} autoComplete="one-time-code" className={link ? "w-full" : "w-40"} aria-label={link ? "Verification link" : "Verification code"} />
        <Button type="submit" variant="signal" loading={isLoading} disabled={!value.trim()} icon={<Send className="h-4 w-4" />}>
          Send
        </Button>
      </div>
    </form>
  );
}

export default function ApplicationDetail() {
  const { id = "" } = useParams();
  const { data: app, isLoading } = useApplicationQuery(id, { pollingInterval: 4000 });
  const { data: me } = useMeQuery();
  const live = useSelector((s: RootState) => s.live.runs[id]);
  const [approve, { isLoading: approving }] = useApproveMutation();
  const [act, { isLoading: acting }] = useAppActionMutation();
  const [saveCl, { isLoading: savingCl }] = useSaveCoverLetterMutation();
  const [tab, setTab] = useState("fields");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [cl, setCl] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    if (app.status === "PENDING_RESUME_REVIEW") setTab("resume");
    else if (app.status === "PENDING_CL_REVIEW") setTab("cover");
    else if (["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW", "COMPLETED"].includes(app.status)) setTab((t) => (t === "trace" ? t : "fields"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.status]);

  const missing = useMemo(() => (app ? app.fields.filter((f) => f.required && (f.value == null || f.value === "") && f.kind !== "file" && !edits[f.id]?.trim()) : []), [app, edits]);

  if (isLoading || !app) return <Spinner className="mx-auto mt-24 h-6 w-6" />;
  const editable = ["NEEDS_INPUT", "PENDING_SUBMIT_REVIEW"].includes(app.status);
  const running = ["QUEUED", "OPTIMIZING", "OPTIMIZING_RESUME", "OPTIMIZING_CL", "READY", "RUNNING"].includes(app.status);
  const thought = live?.status === "running" ? live.thought : app.lastThought;

  const doApprove = async () => {
    try {
      await approve({
        id: app.id,
        fields: Object.entries(edits).map(([fid, value]) => ({ id: fid, value })),
        coverLetter: cl ?? undefined,
      }).unwrap();
      setEdits({});
      toast(app.status === "PENDING_SUBMIT_REVIEW" || app.status === "NEEDS_INPUT" ? "Approved. Ferry is sending it now." : "Approved. Continuing.", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const action = async (a: "retry" | "skip" | "regenerate") => {
    try {
      await act({ id: app.id, action: a }).unwrap();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const approveLabel =
    app.status === "PENDING_RESUME_REVIEW" ? "Approve résumé" : app.status === "PENDING_CL_REVIEW" ? "Approve cover letter" : app.status === "NEEDS_INPUT" ? "Save answers & continue" : "Approve & send";

  return (
    <>
      <Link to="/app/applications" className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Applications
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3.5">
          <CompanyMark name={app.job?.company ?? "?"} size={52} />
          <div className="min-w-0">
            <h1 className="text-[22px] leading-tight font-semibold">{app.job?.title}</h1>
            <p className="mt-0.5 text-[14px] text-muted">
              {app.job?.company} · {app.job?.location} · via {app.job?.atsName}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill status={app.status} dryRun={app.confirmation?.dryRun} />
              {app.profile && (
                <Link to={`/app/profiles?id=${app.profile.id}`} className="inline-flex">
                  <Badge tone="ink">
                    <FileText className="h-3 w-3" /> {app.profile.name} profile
                  </Badge>
                </Link>
              )}
              {app.trackedStatus && <Badge tone={TRACKED_META[app.trackedStatus].tone}>{TRACKED_META[app.trackedStatus].label}</Badge>}
              <span className="text-[12px] text-faint">updated {timeAgo(app.updatedAt)}</span>
              {app.job?.url && (
                <a href={app.job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
                  Posting <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!["COMPLETED", "SKIPPED"].includes(app.status) && !running && (
            <Button variant="ghost" onClick={() => action("skip")} loading={acting} icon={<SkipForward className="h-4 w-4" />}>
              Skip
            </Button>
          )}
          {["FAILED", "NEEDS_INPUT", "SKIPPED"].includes(app.status) && (
            <Button onClick={() => action("retry")} loading={acting} icon={<RefreshCw className="h-4 w-4" />}>
              Retry
            </Button>
          )}
          {["PENDING_RESUME_REVIEW", "PENDING_CL_REVIEW", "PENDING_SUBMIT_REVIEW", "NEEDS_INPUT"].includes(app.status) && (
            <Button variant="signal" loading={approving} disabled={app.status === "NEEDS_INPUT" && missing.length > 0} onClick={doApprove} icon={<Send className="h-4 w-4" />}>
              {approveLabel}
            </Button>
          )}
        </div>
      </div>

      <Card className="mb-5 px-4 py-3">
        <Stepper status={app.status} />
        {running && thought && (
          <p className="mt-2 flex items-center gap-2 font-mono text-[12.5px] text-sea">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-sea" />
            {thought}
            {(live?.currentPage ?? app.currentPage) ? <span className="text-faint">· page {live?.currentPage ?? app.currentPage}</span> : null}
          </p>
        )}
        <CodePrompt app={app} />
        {app.status === "NEEDS_INPUT" && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-signal-soft px-3 py-2.5 text-[13px] text-ink">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
            <div>
              <p className="font-medium">{app.error ?? "A few answers need you."}</p>
              {missing.length > 0 && <p className="text-muted">Answer the highlighted questions below, then continue. Your answers are remembered for future applications.</p>}
            </div>
          </div>
        )}
        {app.status === "PENDING_SUBMIT_REVIEW" && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-soft px-3 py-2.5 text-[13px]">
            <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
            <p>
              Everything is filled in and nothing has been sent. Check the answers, edit anything, then approve.
              {me && !me.allowRealSubmit && !app.job?.url.includes("/mock-ats/") && <span className="text-muted"> Real submission is off on this server, so approving runs a dry run.</span>}
            </p>
          </div>
        )}
        {app.status === "FAILED" && app.error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-coral-soft px-3 py-2.5 text-[13px] text-coral">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {app.error}
          </div>
        )}
        {app.status === "COMPLETED" && app.confirmation && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-kelp-soft px-3 py-2.5 text-[13px]">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-kelp" />
            <p>
              {app.confirmation.dryRun ? "Dry run complete: the form was filled and stopped before Submit." : `Submitted ${timeAgo(app.submittedAt)}. ${app.confirmation.text ?? ""}`}
            </p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <div className="px-2 pt-1">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "fields", label: "Form answers", count: app.fields.length || undefined },
                { id: "resume", label: "Résumé", count: app.changes.length || undefined },
                { id: "cover", label: "Cover letter" },
                { id: "trace", label: "Agent trace", count: app.trace.length || undefined },
                { id: "job", label: "Job description" },
              ]}
            />
          </div>
          <div className="p-4">
            {tab === "fields" && <FieldsPanel app={app} editable={editable} edits={edits} setEdits={setEdits} />}
            {tab === "resume" && <TailoredPanel applicationId={app.id} company={app.job?.company ?? "this role"} />}
            {tab === "cover" && (
              <div>
                {app.coverLetter == null && cl == null ? (
                  <p className="py-10 text-center text-[13px] text-muted">{running ? "Drafting…" : "Cover letters are off for this application."}</p>
                ) : (
                  <>
                    <Textarea rows={16} value={cl ?? app.coverLetter ?? ""} onChange={(e) => setCl(e.target.value)} className="font-serif text-[15px]" />
                    {cl != null && cl !== app.coverLetter && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          loading={savingCl}
                          onClick={async () => {
                            await saveCl({ id: app.id, text: cl }).unwrap();
                            toast("Cover letter saved", "success");
                          }}
                        >
                          Save changes
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {tab === "trace" && (app.trace.length ? <TracePanel trace={app.trace} /> : <p className="py-10 text-center text-[13px] text-muted">The agent hasn't started yet.</p>)}
            {tab === "job" && <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2">{app.job?.description}</div>}
          </div>
        </Card>

        <div className="space-y-4">
          {["FAILED", "SKIPPED", "NEEDS_INPUT"].includes(app.status) && app.error && <FinishYourself app={app} />}
          <AccountCard appId={app.id} sent={app.status === "COMPLETED"} />
          <Card className="p-4">
            <p className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
              <Sparkles className="h-4 w-4 text-signal" /> ATS keyword score
            </p>
            {app.atsScore ? (
              <>
                <div className="flex items-end gap-2">
                  <span className="text-[34px] leading-none font-semibold tabular-nums">{app.atsScore.after}</span>
                  {app.atsScore.after > app.atsScore.before && <span className="mb-1 text-[13px] font-medium text-kelp">+{app.atsScore.after - app.atsScore.before} from {app.atsScore.before}</span>}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-kelp" style={{ width: `${app.atsScore.after}%` }} />
                </div>
                {app.atsScore.matched.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-[11px] font-medium text-muted uppercase">Matched</p>
                    <div className="flex flex-wrap gap-1">
                      {app.atsScore.matched.slice(0, 14).map((k) => (
                        <Badge key={k} tone="kelp" className="text-[11px]">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {app.atsScore.missing.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-[11px] font-medium text-muted uppercase">Not on your résumé</p>
                    <div className="flex flex-wrap gap-1">
                      {app.atsScore.missing.slice(0, 10).map((k) => (
                        <Badge key={k} className="text-[11px]">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[13px] text-muted">Scored after tailoring.</p>
            )}
          </Card>
          <Card className="p-4">
            <p className="mb-2 text-[13px] font-semibold">Documents</p>
            <div className="space-y-2">
              <a href={apiUrl(`/api/v1/applications/${app.id}/resume.pdf?token=${encodeURIComponent(getToken() ?? "")}`)} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-paper">
                <FileText className="h-4 w-4 text-muted" /> <span className="flex-1">Tailored résumé (PDF)</span> <Download className="h-3.5 w-3.5 text-muted" />
              </a>
              <a href={apiUrl(`/api/v1/applications/${app.id}/resume.docx?token=${encodeURIComponent(getToken() ?? "")}`)} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-paper">
                <FileText className="h-4 w-4 text-muted" /> <span className="flex-1">Tailored résumé (Word)</span> <Download className="h-3.5 w-3.5 text-muted" />
              </a>
              {app.coverLetter && (
                <button onClick={() => setTab("cover")} className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-[13px] hover:bg-paper">
                  <Mail className="h-4 w-4 text-muted" /> <span className="flex-1">Cover letter</span>
                </button>
              )}
            </div>
          </Card>
          {app.statusHistory.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 text-[13px] font-semibold">History</p>
              <ul className="space-y-1.5 text-[12.5px]">
                {app.statusHistory.map((h, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">{h.status.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="shrink-0 text-faint">{timeAgo(h.at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {app.confirmation?.screenshot && (
            <Card className="overflow-hidden">
              <p className="px-4 pt-3 text-[13px] font-semibold">{app.confirmation.dryRun ? "Final form (not sent)" : "Confirmation page"}</p>
              <a href={apiUrl(app.confirmation.screenshot)} target="_blank" rel="noreferrer">
                <img src={apiUrl(app.confirmation.screenshot)} alt="Confirmation" className="mt-2 max-h-64 w-full border-t border-line object-cover object-top" />
              </a>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** Which email (and employer account) this application uses; the account password can be revealed. */
function AccountCard({ appId, sent }: { appId: string; sent: boolean }) {
  const { data } = useApplicationAccountQuery(appId);
  const [reveal, { isLoading }] = useRevealApplicationAccountMutation();
  const [pw, setPw] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!data) return null;
  return (
    <Card className="p-4 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted">{sent ? "Applied using" : "Applying as"}</span>
        <span className="font-medium break-all">{data.email}</span>
      </div>
      {data.account && (
        <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
            <span className="text-muted">Account</span>
            <span className="flex items-center gap-1.5">
              <span className="font-medium break-all">{data.account.host}</span>
              <Badge tone={data.account.status === "active" ? "kelp" : data.account.status === "failed" ? "coral" : "amber"}>{data.account.status}</Badge>
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
            <span className="text-muted">{data.account.passwordKind === "application" ? "Your application password" : "Generated password"}</span>
            <span className="flex items-center gap-2">
              {pw && <code className="rounded bg-paper px-1.5 py-0.5 text-[12px]">{pw}</code>}
              <button
                type="button"
                disabled={isLoading}
                className="text-[12px] font-medium text-ink-2 hover:text-ink disabled:opacity-50"
                onClick={async () => {
                  if (pw) return setPw(null);
                  try {
                    setFailed(false);
                    setPw((await reveal(appId).unwrap()).password);
                  } catch {
                    setFailed(true);
                  }
                }}
              >
                {isLoading ? "Loading…" : pw ? "Hide" : "View"}
              </button>
            </span>
          </div>
          {failed && <p className="mt-1 text-[12px] text-coral">Couldn't load this password.</p>}
        </>
      )}
    </Card>
  );
}

/** When the agent hands an application back: finish it on the employer's site with everything prepared. */
function FinishYourself({ app }: { app: App }) {
  const [finished, { isLoading }] = useFinishedMyselfMutation();
  return (
    <Card className="border-amber/40 bg-amber-soft/40 p-4 text-[13px]">
      <p className="mb-1 flex items-center gap-1.5 font-semibold">
        <MousePointerClick className="h-4 w-4 text-amber" /> Finish it yourself
      </p>
      <p className="text-ink-2">{app.error}</p>
      <p className="mt-1.5 text-muted">Your tailored résumé, cover letter, and answers are ready. Open the posting, use the account below if it asks you to sign in, and mark it done here.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {app.job?.url && (
          <a href={app.job.url} target="_blank" rel="noreferrer">
            <Button size="sm" icon={<ExternalLink className="h-3.5 w-3.5" />}>
              Open posting
            </Button>
          </a>
        )}
        <a href={apiUrl(`/api/v1/applications/${app.id}/resume.pdf?token=${encodeURIComponent(getToken() ?? "")}`)} target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />}>
            Résumé
          </Button>
        </a>
        <Button
          size="sm"
          variant="primary"
          loading={isLoading}
          icon={<Check className="h-3.5 w-3.5" />}
          onClick={async () => {
            try {
              await finished(app.id).unwrap();
              toast("Marked as applied", "success");
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          I finished it
        </Button>
      </div>
    </Card>
  );
}
