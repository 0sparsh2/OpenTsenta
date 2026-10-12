import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, BadgeCheck, CircleSlash, ExternalLink, MapPin, Send, X } from "lucide-react";
import { errorMessage, useApplyMutation, useJobQuery, useResumesQuery, useSettingsQuery, useSkipJobMutation } from "../lib/api";
import type { JobCard } from "../lib/types";
import { toast } from "./toast";
import { Badge, Button, CompanyMark, cx, ScoreRing, Select, Spinner, timeAgo } from "./ui";

const WORKPLACE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site", unknown: "" };

export function JobRow({ job, onOpen, compact }: { job: JobCard; onOpen: (id: string) => void; compact?: boolean }) {
  const [apply, { isLoading }] = useApplyMutation();
  const [skip] = useSkipJobMutation();
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apply({ jobId: job.id }).unwrap();
      toast(`Queued: ${job.title} at ${job.company}`, "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(job.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(job.id)}
      className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-sea"
    >
      <CompanyMark name={job.company} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold">{job.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span className="text-ink-2">{job.company}</span>
          {job.location && (
            <span className="inline-flex items-center gap-0.5 truncate">
              <MapPin className="h-3 w-3" />
              {job.location.length > 38 ? `${job.location.slice(0, 38)}…` : job.location}
            </span>
          )}
          {!compact && WORKPLACE[job.workplace] && <span>· {WORKPLACE[job.workplace]}</span>}
          {!compact && job.salary && <span>· {job.salary}</span>}
          {!compact && <span className="text-faint">· {timeAgo(job.postedAt ?? job.firstSeenAt)}</span>}
        </p>
      </div>
      {job.match && <ScoreRing score={job.match.score} />}
      <div className="flex items-center gap-1">
        {!compact && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void skip(job.id);
            }}
            className="hidden rounded-md p-1.5 text-faint opacity-0 transition group-hover:opacity-100 hover:bg-ink/5 hover:text-ink sm:block"
            title="Not interested"
            aria-label="Skip job"
          >
            <CircleSlash className="h-4 w-4" />
          </button>
        )}
        {job.applicationId ? (
          <Link to={`/app/applications/${job.applicationId}`} onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="secondary" icon={<ArrowUpRight className="h-3.5 w-3.5" />}>
              {job.applicationStatus === "COMPLETED" ? "Applied" : "View"}
            </Button>
          </Link>
        ) : (
          <Button size="sm" variant="primary" onClick={go} loading={isLoading} icon={<Send className="h-3.5 w-3.5" />}>
            Apply
          </Button>
        )}
      </div>
    </div>
  );
}

export function JobDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: job, isFetching } = useJobQuery(id ?? "", { skip: !id });
  const { data: profiles } = useResumesQuery();
  const { data: settings } = useSettingsQuery();
  const [apply, { isLoading }] = useApplyMutation();
  const [profileId, setProfileId] = useState<string>("");
  const [preview, setPreview] = useState<boolean | null>(null);
  const previewFirst = preview ?? (settings ? !settings.autoApproveResume : false);
  useEffect(() => setProfileId(job?.match?.profileId ?? ""), [job?.id, job?.match?.profileId]);
  const matchedProfile = profiles?.find((p) => p.id === job?.match?.profileId);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!id) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-ink/25" onClick={onClose} />
      <aside className="slide-up absolute inset-y-0 right-0 flex w-full max-w-[640px] flex-col bg-card shadow-pop" aria-label="Job details">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          {job ? (
            <div className="flex min-w-0 gap-3">
              <CompanyMark name={job.company} size={44} />
              <div className="min-w-0">
                <h2 className="text-[17px] leading-snug font-semibold">{job.title}</h2>
                <p className="text-[13px] text-muted">
                  {job.company} · {job.location || "Location not listed"} {job.salary && `· ${job.salary}`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{job.atsName}</Badge>
                  {WORKPLACE[job.workplace] && <Badge tone="sea">{WORKPLACE[job.workplace]}</Badge>}
                  {job.sponsorsVisa === true && <Badge tone="kelp">Sponsors visas</Badge>}
                  {job.sponsorsVisa === false && <Badge tone="coral">No sponsorship</Badge>}
                  <Badge tone="ink">Seen {timeAgo(job.firstSeenAt)}</Badge>
                </div>
              </div>
            </div>
          ) : (
            <Spinner />
          )}
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink/5" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {job && (
          <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
            {job.match && (
              <div className="mb-5 rounded-xl border border-line bg-paper/60 p-4">
                <div className="flex items-center gap-3">
                  <ScoreRing score={job.match.score} size={48} />
                  <div>
                    <p className="text-sm font-semibold capitalize">{job.match.verdict} match</p>
                    <p className="text-[12px] text-muted">
                      {job.match.method === "llm" ? "Scored by Claude" : "Scored on title, skills, level, and location"}
                      {matchedProfile ? ` against your “${matchedProfile.name}” profile` : " against your résumé"}
                    </p>
                  </div>
                </div>
                {job.match.reasons.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {job.match.reasons.map((r) => (
                      <li key={r} className="flex gap-2 text-[13px]">
                        <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-kelp" />
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
                {job.match.gaps.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {job.match.gaps.map((r) => (
                      <li key={r} className="flex gap-2 text-[13px] text-muted">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                        {r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className={cx("text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2", isFetching && "opacity-60")}>{job.description || "No description available."}</div>
          </div>
        )}
        {job && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
            <a href={job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
              View posting <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {!job.applicationId && (
              <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-2">
                <input type="checkbox" checked={previewFirst} onChange={(e) => setPreview(e.target.checked)} /> Preview résumé first
              </label>
            )}
            {job.applicationId ? (
              <Link to={`/app/applications/${job.applicationId}`}>
                <Button variant="secondary" icon={<ArrowUpRight className="h-4 w-4" />}>
                  Open application
                </Button>
              </Link>
            ) : (
              <div className="flex items-center gap-2">
                {profiles && profiles.length > 1 && (
                  <Select aria-label="Apply with profile" className="h-9 w-auto max-w-[12rem] text-[13px]" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                    {!job.match?.profileId && <option value="">Best-fit profile</option>}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.id === job.match?.profileId ? " (best fit)" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              <Button
                variant="primary"
                loading={isLoading}
                icon={<Send className="h-4 w-4" />}
                onClick={async () => {
                  try {
                    const app = await apply({ jobId: job.id, resumeId: profileId || undefined, previewResume: previewFirst }).unwrap();
                    toast(previewFirst ? "Tailoring now. Ferry will pause so you can preview the résumé." : "Queued. Ferry is tailoring your résumé now.", "success");
                    if (previewFirst) navigate(`/app/applications/${app.id}`);
                    onClose();
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  }
                }}
              >
                Apply with Ferry
              </Button>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
