import { all } from "../db.ts";
import type { PlaceKind } from "./places.ts";

// Suggestions for the jobs page's location filter. Place counts for open jobs are cached briefly (thousands of places,
// tens of thousands of jobs); typing filters them in memory.

export interface PlaceCount {
  key: string;
  kind: PlaceKind;
  label: string;
  n: number;
}

let cache: { at: number; rows: PlaceCount[] } | null = null;
function placeCounts(): PlaceCount[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  // job_places holds open jobs only, so this is a scan of one index.
  const rows = all<PlaceCount>("SELECT key, kind, MIN(label) AS label, COUNT(*) AS n FROM job_places GROUP BY key, kind ORDER BY n DESC");
  cache = { at: Date.now(), rows };
  return rows;
}
export const invalidateLocations = () => (cache = null);

/** Nicknames people type. */
const NICKNAMES: Record<string, string> = { nyc: "new york", sf: "san francisco", "bay area": "san francisco bay area", la: "los angeles", dc: "washington", usa: "united states", us: "united states", uk: "united kingdom", wfh: "remote" };

const PER_KIND: Record<PlaceKind, number> = { remote: 4, metro: 5, city: 8, region: 5, country: 5 };
const ORDER: PlaceKind[] = ["remote", "metro", "city", "region", "country"];

/** Places matching what's typed (a word of the name starts with it), grouped by kind, biggest first. */
export function locationSuggestions(q: string, selected: Set<string> = new Set()) {
  const rows = placeCounts();
  const needle = (NICKNAMES[q] ?? q).toLowerCase();
  const matches = (label: string) => {
    if (!needle) return true;
    const l = label.toLowerCase();
    return l.startsWith(needle) || l.includes(` ${needle}`) || l.includes(`(${needle}`) || l.split(/[\s,()–-]+/).some((w) => w.startsWith(needle));
  };
  const groups = ORDER.map((kind) => ({
    kind,
    items: rows
      .filter((r) => r.kind === kind && !selected.has(r.key) && matches(r.label))
      // Without a query: the useful defaults (remote buckets, big metros and countries), not every city.
      .slice(0, needle ? PER_KIND[kind] : kind === "city" || kind === "region" ? 0 : PER_KIND[kind])
      .map(({ key, label, n }) => ({ key, label, n })),
  })).filter((g) => g.items.length);
  // Labels for places already picked (chips), even if they have no open jobs right now.
  const chips = [...selected].map((key) => rows.find((r) => r.key === key) ?? { key, label: key, n: 0, kind: "city" as PlaceKind }).map(({ key, label, n }) => ({ key, label, n }));
  return { groups, selected: chips };
}
