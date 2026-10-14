// Grow the watch list from public job lists: pull every company job-board link out of them, check each board live on
// its ATS's public API, and add the ones with open jobs to src/ingest/boards.json (existing entries are kept as is).
//
//   npx tsx scripts/mine-boards.ts                       (the default public lists, fetched fresh)
//   npx tsx scripts/mine-boards.ts listings.json list.md (local files: SimplifyJobs listings.json or markdown tables)
//   flags: --concurrency 16  --dry (report only, don't write)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FETCHERS } from "../src/ingest/sources.ts";

const DEFAULT_SOURCES = [
  "SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
  "SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
  "vanshb03/Summer2026-Internships/dev/.github/scripts/listings.json",
  "vanshb03/New-Grad-2026/dev/.github/scripts/listings.json",
  "speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_USA.md",
  "speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_INTL.md",
  "speedyapply/2026-SWE-College-Jobs/main/INTERN_INTL.md",
  "speedyapply/2026-AI-College-Jobs/main/README.md",
  "speedyapply/2026-AI-College-Jobs/main/NEW_GRAD_USA.md",
].map((p) => `https://raw.githubusercontent.com/${p}`);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true") : undefined;
};
const sources = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--concurrency"));
const concurrency = Number(flag("concurrency") ?? 16);
const dry = flag("dry") === "true";

/** ATS → how to read a board out of a job link. */
const PATTERNS: [string, RegExp, (m: RegExpMatchArray) => string | null][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_app\?for=)?([A-Za-z0-9_-]+)/g, (m) => m[1].toLowerCase()],
  ["lever", /jobs\.lever\.co\/([A-Za-z0-9_.-]+)/g, (m) => m[1].toLowerCase()],
  ["ashby", /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g, (m) => decodeURIComponent(m[1]).toLowerCase()],
  ["workable", /apply\.workable\.com\/(?!api\/|j\/)([A-Za-z0-9_-]+)/g, (m) => m[1].toLowerCase()],
  ["smartrecruiters", /jobs\.smartrecruiters\.com\/(?!oneclick-ui)([A-Za-z0-9_-]+)\//g, (m) => m[1]],
  [
    "workday",
    /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g,
    (m) => (/^(job|details|login|wday)$/i.test(m[3]) ? null : `${m[1]}.${m[2]}.myworkdayjobs.com|${m[3]}`),
  ],
  ["rippling", /ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)\/jobs/g, (m) => m[1].toLowerCase()],
  ["bamboohr", /https?:\/\/([a-z0-9-]+)\.bamboohr\.com/g, (m) => m[1]],
  ["pinpoint", /https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/g, (m) => m[1]],
  ["breezyhr", /https?:\/\/([a-z0-9-]+)\.breezy\.hr/g, (m) => m[1]],
  ["recruitee", /https?:\/\/([a-z0-9-]+)\.recruitee\.com/g, (m) => m[1]],
  ["icims", /https?:\/\/([a-z0-9-]+\.icims\.com)/g, (m) => (/^(www|careers)\.icims\.com$/.test(m[1]) ? null : m[1])],
  ["oraclecloud", /https?:\/\/([a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-zA-Z-]+\/sites\/([A-Za-z0-9_-]+)/g, (m) => `${m[1]}|${m[2]}`],
];
const SKIP = new Set(["embed", "jobs", "www", "api", "app", "v1", "boards", "careers", "search"]);

const cleanName = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s.&'’,()+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const found = new Map<string, { ats: string; board: string; name: string }>();
function scan(text: string, company: string) {
  for (const [ats, re, toBoard] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const board = toBoard(m);
      if (!board || SKIP.has(board.toLowerCase())) continue;
      const key = `${ats}:${board.toLowerCase()}`;
      if (!found.has(key)) found.set(key, { ats, board, name: cleanName(company) });
    }
  }
}

for (const src of sources.length ? sources : DEFAULT_SOURCES) {
  const text = /^https?:/.test(src) ? await fetch(src, { signal: AbortSignal.timeout(60000) }).then((r) => (r.ok ? r.text() : "")) : fs.readFileSync(src, "utf8");
  if (!text) {
    console.warn(`skip ${src}: not found`);
    continue;
  }
  if (text.trimStart().startsWith("[")) {
    for (const it of JSON.parse(text) as { url?: string; company_name?: string; company?: string }[]) scan(it.url ?? "", it.company_name ?? it.company ?? "");
  } else {
    // Markdown or HTML tables: the company is the first cell; "↳" rows continue the company above.
    let last = "";
    const rows = [...text.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
    rows.push(...text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1)));
    for (const cells of rows) {
      if (!cells.length) continue;
      const name = cleanName(cells[0]);
      const company = !name || name.startsWith("↳") ? last : (last = name);
      scan(cells.join(" "), company);
    }
  }
}

const boardsFile = fileURLToPath(new URL("../src/ingest/boards.json", import.meta.url));
const existing = JSON.parse(fs.readFileSync(boardsFile, "utf8")) as { name: string; ats: string; board: string }[];
const have = new Set(existing.map((b) => `${b.ats}:${b.board.toLowerCase()}`));
// One Workday site per tenant is enough when several spellings point at the same one.
const seenSite = new Set<string>();
const candidates = [...found.values()].filter((c) => {
  if (have.has(`${c.ats}:${c.board.toLowerCase()}`) || !FETCHERS[c.ats]) return false;
  if (c.ats === "workday") {
    const k = c.board.toLowerCase();
    if (seenSite.has(k)) return false;
    seenSite.add(k);
  }
  return true;
});
console.log(`${found.size} boards in the lists, ${candidates.length} new to check`);

/** Does the board have open jobs? Workday: one small page instead of the whole board. */
async function live(c: { ats: string; board: string; name: string }): Promise<number> {
  if (c.ats === "workday") {
    const [host, site] = c.board.split("|");
    const tenant = host.split(".")[0];
    const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; FerryJobWatcher/0.1)" },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return 0;
    return ((await res.json()) as { total?: number }).total ?? 0;
  }
  return (await FETCHERS[c.ats]({ id: null, name: c.name, ats: c.ats, board: c.board })).length;
}

const added: { name: string; ats: string; board: string; jobs: number }[] = [];
let i = 0;
let done = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let c = candidates[i++]; c; c = candidates[i++]) {
      const n = await live(c).catch(() => 0);
      if (n > 0) added.push({ ...c, name: c.name || c.board, jobs: n });
      if (++done % 100 === 0) console.log(`  checked ${done}/${candidates.length}, ${added.length} live`);
    }
  }),
);

const byAts = added.reduce<Record<string, number>>((m, r) => ((m[r.ats] = (m[r.ats] ?? 0) + 1), m), {});
console.log(`${added.length} live boards added`, byAts, "open jobs:", added.reduce((s, r) => s + r.jobs, 0));
if (!dry) {
  const merged = [...existing, ...added.map(({ jobs: _j, ...r }) => r)].sort((a, b) => a.ats.localeCompare(b.ats) || a.name.localeCompare(b.name));
  fs.writeFileSync(boardsFile, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`boards.json: ${existing.length} → ${merged.length}`);
}
