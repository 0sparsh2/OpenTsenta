import { useEffect, useMemo, useState } from "react";
import { Search, SearchX } from "lucide-react";
import { useRecommendationsQuery, useSearchJobsQuery } from "../lib/api";
import { PageHeader } from "../components/AppLayout";
import { JobDrawer, JobRow } from "../components/jobs";
import { Button, Card, Empty, Input, Segmented, Select, Spinner } from "../components/ui";

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function Jobs() {
  const [mode, setMode] = useState<"matches" | "all">("matches");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [workplace, setWorkplace] = useState("any");
  const [posted, setPosted] = useState("");
  const [sponsors, setSponsors] = useState(false);
  const [minScore, setMinScore] = useState(60);
  const [limit, setLimit] = useState(40);
  const dq = useDebounced(q);

  const params = useMemo(() => {
    const p: Record<string, string> = { q: dq, workplace, limit: String(limit), sort: "match" };
    if (posted) p.posted = posted;
    if (sponsors) p.sponsors = "1";
    return p;
  }, [dq, workplace, posted, sponsors, limit]);

  const recs = useRecommendationsQuery({ limit, minScore }, { skip: mode !== "matches" });
  const search = useSearchJobsQuery(params, { skip: mode !== "all" });
  const data = mode === "matches" ? recs.data : search.data;
  const loading = mode === "matches" ? recs.isFetching : search.isFetching;

  useEffect(() => setLimit(40), [mode, dq, workplace, posted, sponsors, minScore]);

  return (
    <>
      <PageHeader
        title="Browse jobs"
        sub={mode === "matches" ? "Roles that fit your résumé and preferences, best first." : "Everything the watcher has found, ranked by fit."}
        action={
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "matches", label: "For you" },
              { value: "all", label: "All jobs" },
            ]}
          />
        }
      />
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        {mode === "all" ? (
          <>
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
              <Input className="pl-9" placeholder="Search title, company, or location" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select value={workplace} onChange={(e) => setWorkplace(e.target.value)} className="w-auto">
              <option value="any">Any workplace</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
            </Select>
            <Select value={posted} onChange={(e) => setPosted(e.target.value)} className="w-auto">
              <option value="">Any time</option>
              <option value="1">Past 24h</option>
              <option value="7">Past week</option>
              <option value="30">Past month</option>
            </Select>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-card px-3 text-[13px]">
              <input type="checkbox" checked={sponsors} onChange={(e) => setSponsors(e.target.checked)} className="accent-ink" /> Sponsors visas
            </label>
          </>
        ) : (
          <div className="flex flex-1 flex-wrap items-center gap-3 text-[13px]">
            <span className="text-muted">Minimum fit</span>
            <input type="range" min={40} max={95} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-48 accent-ink" aria-label="Minimum fit score" />
            <span className="w-10 font-semibold tabular-nums">{minScore}%</span>
          </div>
        )}
        <span className="ml-auto text-[13px] text-muted tabular-nums">{data ? `${data.total?.toLocaleString() ?? data.items.length} roles` : ""}</span>
      </Card>
      <Card className="p-2">
        {!data && loading ? (
          <Spinner className="mx-auto my-16 h-6 w-6" />
        ) : data?.items.length ? (
          <>
            {data.items.map((j) => (
              <JobRow key={j.id} job={j} onOpen={setOpen} />
            ))}
            {data.items.length < (data.total ?? 0) && (
              <div className="flex justify-center p-3">
                <Button loading={loading} onClick={() => setLimit((l) => l + 40)}>
                  Load more
                </Button>
              </div>
            )}
          </>
        ) : (
          <Empty icon={<SearchX className="h-5 w-5" />} title="No roles match those filters" sub={mode === "matches" ? "Lower the minimum fit, or widen your preferences in Profile." : "Try a broader search."} />
        )}
      </Card>
      <JobDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
