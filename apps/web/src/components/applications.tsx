import { useSelector } from "react-redux";
import { useNavigate } from "react-router";
import { FileText, Mail } from "lucide-react";
import type { RootState } from "../lib/store";
import type { ApplicationRow } from "../lib/types";
import { Badge, CompanyMark, StatusPill, timeAgo, TRACKED_META } from "./ui";

export function LiveLine({ app }: { app: ApplicationRow }) {
  const run = useSelector((s: RootState) => s.live.runs[app.id]);
  const thought = run?.status === "running" ? run.thought : app.lastThought;
  if (!thought || !["RUNNING", "READY", "OPTIMIZING", "OPTIMIZING_RESUME", "OPTIMIZING_CL", "QUEUED"].includes(app.status)) return null;
  return (
    <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-sea">
      <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-sea" />
      <span className="truncate">{thought}</span>
      {run?.currentPage ? <span className="shrink-0 text-faint">· page {run.currentPage}</span> : null}
    </p>
  );
}

export function ApplicationsTable({ rows, empty }: { rows: ApplicationRow[]; empty?: React.ReactNode }) {
  const nav = useNavigate();
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead className="text-[12px] text-muted">
          <tr className="border-b border-line">
            <th className="py-2.5 pr-3 pl-4 font-medium">Position</th>
            <th className="px-3 py-2.5 font-medium">Résumé</th>
            <th className="px-3 py-2.5 font-medium">Cover letter</th>
            <th className="px-3 py-2.5 font-medium">Status</th>
            <th className="px-3 py-2.5 font-medium">Pipeline</th>
            <th className="py-2.5 pr-4 pl-3 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} onClick={() => nav(`/app/applications/${a.id}`)} className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-paper/70">
              <td className="py-2.5 pr-3 pl-4">
                <div className="flex items-center gap-2.5">
                  <CompanyMark name={a.job?.company ?? "?"} size={30} />
                  <div className="min-w-0">
                    <p className="max-w-[280px] truncate font-semibold">{a.job?.title}</p>
                    <p className="text-[12px] text-muted">
                      {a.job?.company} · {a.job?.atsName}
                    </p>
                    <LiveLine app={a} />
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5">
                {a.profile ? (
                  <span className="block max-w-[180px]">
                    <span className="inline-flex max-w-full items-center gap-1 font-medium text-ink-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <span className="truncate">{a.profile.name}</span>
                    </span>
                    <span className="block text-[11.5px] text-faint tabular-nums">
                      {a.atsScore ? `${a.changesCount ? `${a.changesCount} edits` : "as is"} · ATS ${a.atsScore.after}` : "not tailored yet"}
                    </span>
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="px-3 py-2.5">{a.hasCoverLetter ? <span className="inline-flex items-center gap-1 text-ink-2"><Mail className="h-3.5 w-3.5 text-muted" />Ready</span> : <span className="text-faint">Off</span>}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={a.status} dryRun={a.confirmation?.dryRun} />
                {a.status === "NEEDS_INPUT" && a.needs.length > 0 && <p className="mt-1 max-w-[200px] truncate text-[11px] text-muted">{a.needs[0]}</p>}
                {a.status === "FAILED" && a.error && <p className="mt-1 max-w-[220px] truncate text-[11px] text-coral">{a.error}</p>}
              </td>
              <td className="px-3 py-2.5">{a.trackedStatus ? <Badge tone={TRACKED_META[a.trackedStatus].tone}>{TRACKED_META[a.trackedStatus].label}</Badge> : <span className="text-faint">—</span>}</td>
              <td className="py-2.5 pr-4 pl-3 text-right text-muted">{timeAgo(a.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
