import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, HelpCircle, Plus, Search, SearchX } from "lucide-react";
import { errorMessage, useAddSourceMutation, useSearchJobsQuery } from "../lib/api";
import { PageHeader } from "../components/AppLayout";
import { JobDrawer, JobRow } from "../components/jobs";
import { LocationFilter } from "../components/LocationFilter";
import { toast } from "../components/toast";
import { Button, Card, Empty, Input, Segmented, Select, Spinner } from "../components/ui";

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Filters survive switching pages (kept in this browser only). */
function usePersistent<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`ferry.jobs.${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`ferry.jobs.${key}`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  }, [key, v]);
  return [v, setV] as const;
}

const SYNTAX: [string, string][] = [
  ["machine learning", "both words"],
  ['"machine learning"', "the exact phrase"],
  ["python OR golang", "either one"],
  ["-intern", "leave out"],
  ["(staff OR principal) engineer", "group alternatives"],
  ["kube*", "words starting with"],
];

export default function Jobs() {
  const [mode, setMode] = usePersistent<"matches" | "all">("mode", "matches");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = usePersistent("q", "");
  const [scope, setScope] = usePersistent<"title" | "all">("scope", "title");
  const [places, setPlaces] = usePersistent<string[]>("places", []);
  const [workplace, setWorkplace] = usePersistent("workplace", "any");
  const [posted, setPosted] = usePersistent("posted", "");
  const [sponsors, setSponsors] = usePersistent("sponsors", false);
  const [minScore, setMinScore] = usePersistent("minScore", 60);
  const [sort, setSort] = usePersistent<"match" | "newest" | "relevance">("sort", "match");
  const [limit, setLimit] = useState(40);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const dq = useDebounced(q);
  const effectiveSort = sort === "relevance" && !dq.trim() ? "match" : sort;

  const params = useMemo(() => {
    const p: Record<string, string> = { q: dq, in: scope, workplace, limit: String(limit), sort: effectiveSort };
    if (places.length) p.places = places.join(",");
    if (posted) p.posted = posted;
    if (sponsors) p.sponsors = "1";
    if (mode === "matches") Object.assign(p, { forYou: "1", minScore: String(minScore) });
    return p;
  }, [dq, scope, workplace, limit, effectiveSort, places, posted, sponsors, mode, minScore]);

  const { data, isFetching: loading } = useSearchJobsQuery(params);
  useEffect(() => setLimit(40), [mode, dq, scope, workplace, posted, sponsors, minScore, places, sort]);

  return (
    <>
      <PageHeader
        title="Browse jobs"
        sub={mode === "matches" ? "Roles that fit your résumé and preferences, best first." : "Everything Ferry watches, ranked by fit."}
        action={
          <div className="flex items-center gap-2">
            <Button onClick={() => setAdding((a) => !a)}>
              <Plus className="h-4 w-4" /> Add a company
            </Button>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "matches", label: "For you" },
                { value: "all", label: "All jobs" },
              ]}
            />
          </div>
        }
      />
      {adding && <AddCompany onDone={() => setAdding(false)} />}
      <Card className="mb-4 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-[2]">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input className="pr-9 pl-9" placeholder='Keywords: "data scientist" OR "ml engineer" -intern' value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" />
            <button className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:text-ink" aria-label="Search syntax" onClick={() => setHelp((h) => !h)}>
              <HelpCircle className="h-4 w-4" />
            </button>
            {help && (
              <div className="absolute top-full right-0 z-30 mt-1 w-[320px] rounded-xl border border-line bg-card p-3 text-[13px] shadow-lg">
                <p className="mb-2 font-semibold">Search like Gmail or LinkedIn</p>
                <table className="w-full">
                  <tbody>
                    {SYNTAX.map(([ex, what]) => (
                      <tr key={ex}>
                        <td className="py-0.5 pr-3">
                          <button className="font-mono text-[12.5px] text-sea hover:underline" onClick={() => setQ(ex)}>
                            {ex}
                          </button>
                        </td>
                        <td className="py-0.5 text-muted">{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-faint">Words match their forms too: “engineer” finds “engineering”.</p>
              </div>
            )}
          </div>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: "title", label: "Titles" },
              { value: "all", label: "Titles & descriptions" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LocationFilter value={places} onChange={setPlaces} />
          <Select value={workplace} onChange={(e) => setWorkplace(e.target.value)} className="w-auto" aria-label="Workplace">
            <option value="any">Any workplace</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </Select>
          <Select value={posted} onChange={(e) => setPosted(e.target.value)} className="w-auto" aria-label="Posted">
            <option value="">Any time</option>
            <option value="1">Past 24h</option>
            <option value="7">Past week</option>
            <option value="30">Past month</option>
          </Select>
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-card px-3 text-[13px]">
            <input type="checkbox" checked={sponsors} onChange={(e) => setSponsors(e.target.checked)} className="accent-ink" /> Sponsors visas
          </label>
          <Select value={effectiveSort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-auto" aria-label="Sort">
            <option value="match">Best fit</option>
            <option value="newest">Newest</option>
            <option value="relevance" disabled={!dq.trim()}>
              Most relevant
            </option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          {mode === "matches" && (
            <>
              <span className="text-muted">Minimum fit</span>
              <input type="range" min={40} max={95} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-40 accent-ink" aria-label="Minimum fit score" />
              <span className="w-10 font-semibold tabular-nums">{minScore}%</span>
            </>
          )}
          {data?.query?.reading && (
            <span className="text-muted">
              Searching {data.query.scope === "all" ? "titles and descriptions" : "titles"} for <span className="text-ink">{data.query.reading}</span>
            </span>
          )}
          {(q || places.length > 0 || workplace !== "any" || posted || sponsors) && (
            <button
              className="text-[12.5px] text-sea hover:underline"
              onClick={() => {
                setQ("");
                setPlaces([]);
                setWorkplace("any");
                setPosted("");
                setSponsors(false);
              }}
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto text-muted tabular-nums">{data ? `${(data.total ?? data.items.length).toLocaleString()} roles` : ""}</span>
        </div>
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
          <Empty
            icon={<SearchX className="h-5 w-5" />}
            title="No roles match those filters"
            sub={mode === "matches" ? "Lower the minimum fit, widen the search, or switch to All jobs." : "Try fewer words, OR between alternatives, or another place. Missing a company? Add it above."}
          />
        )}
      </Card>
      <JobDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Watch a company Ferry doesn't know yet: paste any careers or job link. */
function AddCompany({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [add, { isLoading }] = useAddSourceMutation();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const co = await add({ url: url.trim() }).unwrap();
      toast(`Watching ${co.name}: ${co.openJobs ?? 0} open roles. They'll show up here in a minute.`, "success");
      setUrl("");
      onDone();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <Card className="mb-4 p-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Building2 className="h-4 w-4 text-faint" />
        <Input ref={input} className="min-w-[280px] flex-1" placeholder="Paste a careers page or job link (Greenhouse, Lever, Ashby, Workday, iCIMS…)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Company careers link" />
        <Button type="submit" loading={isLoading} disabled={!url.trim()}>
          Watch this company
        </Button>
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
      </form>
    </Card>
  );
}
