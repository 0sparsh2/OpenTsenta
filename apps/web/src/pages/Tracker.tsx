import { useState } from "react";
import { Link } from "react-router";
import { KanbanSquare } from "lucide-react";
import { useMoveTrackedMutation, useTrackerQuery } from "../lib/api";
import { TRACKED, type TrackedStatus } from "../lib/types";
import { PageHeader } from "../components/AppLayout";
import { Card, CompanyMark, cx, Empty, Spinner, timeAgo, TRACKED_META } from "../components/ui";

export default function Tracker() {
  const { data, isLoading } = useTrackerQuery();
  const [move] = useMoveTrackedMutation();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TrackedStatus | null>(null);
  if (isLoading || !data) return <Spinner className="mx-auto mt-24 h-6 w-6" />;
  const total = TRACKED.reduce((n, s) => n + data.columns[s].length, 0);
  const reached = (s: TrackedStatus) => data.columns[s].length + (s === "APPLIED" ? TRACKED.slice(1).reduce((n, x) => n + data.columns[x].length, 0) : 0);

  return (
    <>
      <PageHeader title="Tracker" sub="Every submitted application, from applied to offer. Recruiter emails move cards automatically; drag to move one yourself." />
      {total === 0 ? (
        <Card>
          <Empty icon={<KanbanSquare className="h-5 w-5" />} title="Nothing submitted yet" sub="Once Ferry sends an application, it shows up here and moves as replies come in." />
        </Card>
      ) : (
        <>
          <Card className="mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-5">
            {TRACKED.map((s) => (
              <div key={s} className="bg-card px-4 py-3">
                <p className="text-[12px] font-medium text-muted">{TRACKED_META[s].label}</p>
                <p className="mt-0.5 text-[24px] leading-tight font-semibold tabular-nums">{data.columns[s].length}</p>
                {s !== "APPLIED" && total > 0 && <p className="text-[11px] text-faint">{Math.round((data.columns[s].length / Math.max(1, reached("APPLIED"))) * 100)}% of applied</p>}
              </div>
            ))}
          </Card>
          <div className="scroll-thin -mx-4 overflow-x-auto px-4 pb-2">
            <div className="grid min-w-[1000px] grid-cols-5 gap-3">
              {TRACKED.map((s) => (
                <div
                  key={s}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(s);
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={() => {
                    if (dragging) void move({ id: dragging, status: s });
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cx("rounded-2xl border bg-paper/60 p-2 transition-colors", over === s ? "border-sea bg-sea-soft/50" : "border-line")}
                >
                  <div className="flex items-center gap-2 px-1.5 py-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: TRACKED_META[s].hex }} />
                    <span className="text-[13px] font-semibold">{TRACKED_META[s].label}</span>
                    <span className="ml-auto text-[12px] text-muted tabular-nums">{data.columns[s].length}</span>
                  </div>
                  <div className="mt-1 space-y-2">
                    {data.columns[s].map((a) => (
                      <Link
                        key={a.id}
                        to={`/app/applications/${a.id}`}
                        draggable
                        onDragStart={() => setDragging(a.id)}
                        className="block rounded-xl border border-line bg-card p-2.5 shadow-card hover:border-line-2"
                      >
                        <div className="flex items-center gap-2">
                          <CompanyMark name={a.job?.company ?? "?"} size={24} />
                          <p className="truncate text-[12px] font-medium text-muted">{a.job?.company}</p>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug font-semibold">{a.job?.title}</p>
                        <p className="mt-1 text-[11px] text-faint">
                          {a.confirmation?.dryRun ? "dry run · " : ""}
                          {timeAgo(a.submittedAt)}
                        </p>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
