import { useState } from "react";
import { Link } from "react-router";
import { useSelector } from "react-redux";
import { ArrowRight, Link2, Radar, Rocket, Sparkles } from "lucide-react";
import { errorMessage, useApplicationsQuery, useApplyBulkMutation, useBootstrapQuery, useFetchJobMutation, useMeQuery } from "../lib/api";
import type { RootState } from "../lib/store";
import { PageHeader } from "../components/AppLayout";
import { ApplicationsTable } from "../components/applications";
import { JobDrawer, JobRow } from "../components/jobs";
import { toast } from "../components/toast";
import { Button, Card, Empty, Input, SectionTitle, Spinner, Tabs, timeAgo } from "../components/ui";

function Stat({ label, value, tone, to }: { label: string; value: React.ReactNode; tone?: string; to?: string }) {
  const body = (
    <Card className="px-4 py-3.5 transition hover:border-line-2">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className={`mt-1 text-[26px] leading-none font-semibold tabular-nums ${tone ?? ""}`}>{value}</p>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function LivePanel() {
  const runs = useSelector((s: RootState) => Object.values(s.live.runs).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4));
  if (!runs.length) return null;
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-line bg-ink px-4 py-2.5 text-paper">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <span className="pulse-dot h-2 w-2 rounded-full bg-signal" /> Agent activity
        </p>
        <span className="font-mono text-[11px] text-paper/60">live</span>
      </div>
      <ul className="divide-y divide-line font-mono text-[12.5px]">
        {runs.map((r) => (
          <li key={r.applicationId} className="flex items-center gap-3 px-4 py-2.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.status === "running" ? "pulse-dot bg-sea" : r.status === "completed" ? "bg-kelp" : "bg-coral"}`} />
            <Link to={`/app/applications/${r.applicationId}`} className="min-w-0 flex-1 truncate hover:underline">
              {r.thought}
            </Link>
            {r.currentPage ? <span className="text-faint">p{r.currentPage}</span> : null}
            <span className="shrink-0 text-faint">{timeAgo(r.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Dashboard() {
  const { data: me } = useMeQuery();
  const { data: boot, isLoading } = useBootstrapQuery();
  const [tab, setTab] = useState("all");
  const { data: apps } = useApplicationsQuery({ tab });
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [fetchJob, { isLoading: fetching }] = useFetchJobMutation();
  const [bulk, { isLoading: bulking }] = useApplyBulkMutation();

  if (isLoading || !boot) return <Spinner className="mx-auto mt-24 h-6 w-6" />;
  const first = (me?.name ?? "").split(" ")[0];
  const strong = boot.topMatches.filter((j) => (j.match?.score ?? 0) >= 80);

  return (
    <>
      <PageHeader
        title={first ? `Good to see you, ${first}.` : "Your job search, on autopilot."}
        sub={
          <>
            Watching <b className="text-ink">{boot.totals.companies}</b> companies · <b className="text-ink">{boot.totals.jobs.toLocaleString()}</b> open roles
            {boot.poller.lastRun && <> · last sweep {timeAgo(boot.poller.lastRun.at)}</>}
          </>
        }
        action={
          strong.length > 0 && (
            <Button
              variant="signal"
              loading={bulking}
              icon={<Rocket className="h-4 w-4" />}
              onClick={async () => {
                const r = await bulk({ jobIds: strong.map((j) => j.id) }).unwrap();
                toast(`Queued ${r.queued.length} strong matches`, "success");
              }}
            >
              Apply to top {strong.length}
            </Button>
          )
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="New matches" value={boot.topMatches.length ? `${boot.topMatches.length}+` : 0} to="/app/jobs" />
        <Stat label="In flight" value={boot.counts.in_flight ?? 0} tone="text-sea" to="/app/applications" />
        <Stat label="Needs you" value={boot.counts.needs ?? 0} tone={boot.counts.needs ? "text-signal" : ""} to="/app/applications" />
        <Stat label="Submitted" value={boot.counts.submitted ?? 0} tone="text-kelp" to="/app/tracker" />
        <Stat label="Credits left" value={boot.user.credits} to="/app/settings" />
      </div>

      <LivePanel />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <SectionTitle
            title="Top job matches"
            sub={boot.llm ? "Scored by Claude against your résumé" : "Scored on title, skills, level, and location"}
            action={
              <Link to="/app/jobs" className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink">
                Browse all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {boot.topMatches.length ? (
            <div className="-mx-2">
              {boot.topMatches.map((j) => (
                <JobRow key={j.id} job={j} onOpen={setOpen} compact />
              ))}
            </div>
          ) : (
            <Empty icon={<Radar className="h-5 w-5" />} title="Scoring roles against your résumé" sub="Matches appear here as soon as the first sweep finishes. Usually under a minute." />
          )}
        </Card>

        <div className="space-y-6">
          <Card className="p-4">
            <SectionTitle title="Add any job by URL" sub="Greenhouse, Lever, Ashby, Workday, or a company careers page" />
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const j = await fetchJob({ url }).unwrap();
                  setUrl("");
                  setOpen(j.id);
                } catch (err) {
                  toast(errorMessage(err), "error");
                }
              }}
            >
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
                <Input className="pl-9" type="url" required placeholder="https://jobs.lever.co/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <Button type="submit" variant="primary" loading={fetching}>
                Add
              </Button>
            </form>
          </Card>
          <Card className="p-4">
            <SectionTitle title="How Ferry works" />
            <ol className="space-y-3 text-[13px]">
              {[
                ["Find", "Polls every watched career page; new roles get scored against your résumé."],
                ["Prep", "Rewrites your résumé and cover letter for the role and shows every change."],
                ["Apply", "Opens the real form in a browser, fills it, and pauses before submit until you approve."],
                ["Track", "Reads recruiter replies and moves each application along on its own."],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-ink/6 font-mono text-[11px] font-semibold">0{i + 1}</span>
                  <span>
                    <b className="font-semibold">{t}.</b> <span className="text-muted">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-[15px] font-semibold">Applications</h2>
          <Link to="/app/applications" className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink">
            Open all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="px-2">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "all", label: "All", count: boot.counts.all },
              { id: "in_flight", label: "In flight", count: boot.counts.in_flight },
              { id: "needs", label: "Needs you", count: boot.counts.needs },
              { id: "submitted", label: "Submitted", count: boot.counts.submitted },
              { id: "failed", label: "Failed", count: boot.counts.failed },
            ]}
          />
        </div>
        <ApplicationsTable
          rows={(apps ?? []).slice(0, 10)}
          empty={<Empty icon={<Sparkles className="h-5 w-5" />} title="No applications here yet" sub="Hit Apply on a match and Ferry takes it from there." />}
        />
      </Card>
      <JobDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
