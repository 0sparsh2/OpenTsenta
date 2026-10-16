// Grow the watch list: pull every company job-board link out of public sources, check each board live on its ATS's
// public API, and add the ones with open jobs to src/ingest/boards.json (existing entries are kept as is). When the
// local database exists, new boards go straight into it too, so a running Ferry watches them from its next poll.
//
//   npx tsx scripts/mine-boards.ts                  job lists (SimplifyJobs, speedyapply…) and company directories
//   npx tsx scripts/mine-boards.ts --commoncrawl    every board address in Common Crawl's latest URL index
//   npx tsx scripts/mine-boards.ts --aidevboard     AI Dev Jobs' public API (its jobs' apply links)
//   npx tsx scripts/mine-boards.ts --probe-sites    also open the careers pages the directories name, for the board behind them
//   npx tsx scripts/mine-boards.ts --all            all of the above
//   npx tsx scripts/mine-boards.ts a.json b.md      local files instead (listings.json, markdown/HTML tables or link lists)
//   flags: --concurrency 16  --dry (report only, don't write)  --crawl CC-MAIN-2026-39  --max-pages 40
//
// Everything read here is public: GitHub lists, Common Crawl's index (fetched one request at a time, retrying when
// it's busy), AI Dev Jobs' open API within its hourly limit, and one page per company careers site.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FETCHERS } from "../src/ingest/sources.ts";

const JOB_LISTS = [
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

/** Company directories: names with careers links (most are the company's own site; --probe-sites looks behind them). */
const DIRECTORIES = [
  "https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/companies.json",
  "https://raw.githubusercontent.com/poteto/hiring-without-whiteboards/main/README.md",
  "https://raw.githubusercontent.com/CSwala/awesome-career-pages/main/README.md",
  "https://raw.githubusercontent.com/Kaustubh-Natuskar/moreThanFAANGM/main/README.md",
  "https://careerslist.pages.dev/",
  "github-tree:remoteintech/remote-jobs/main/src/companies/",
];

/** Common Crawl URL-index queries: one per board host (domain = every subdomain). */
const CC_QUERIES = [
  "url=job-boards.greenhouse.io/*",
  "url=boards.greenhouse.io/*",
  "url=jobs.lever.co/*",
  "url=jobs.ashbyhq.com/*",
  "url=apply.workable.com/*",
  "url=jobs.smartrecruiters.com/*",
  "url=ats.rippling.com/*",
  "url=myworkdayjobs.com&matchType=domain",
  "url=bamboohr.com&matchType=domain",
  "url=breezy.hr&matchType=domain",
  "url=recruitee.com&matchType=domain",
  "url=pinpointhq.com&matchType=domain",
];

const UA = "Mozilla/5.0 (compatible; FerryJobWatcher/0.1; +https://github.com/0sparsh2/OpenTsenta)";
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true") : undefined;
};
const VALUED = new Set(["--concurrency", "--crawl", "--max-pages"]);
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(args[i - 1])));
const concurrency = Number(flag("concurrency") ?? 16);
const dry = flag("dry") === "true";
const everything = flag("all") === "true";
const useCrawl = everything || flag("commoncrawl") === "true";
const useAidev = everything || flag("aidevboard") === "true";
const probe = everything || flag("probe-sites") === "true";
const maxPages = Number(flag("max-pages") ?? 40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ATS → how to read a board out of a job link. */
const PATTERNS: [string, RegExp, (m: RegExpMatchArray) => string | null][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_(?:app|board)(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/g, (m) => m[1].toLowerCase()],
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
const SKIP = new Set(["embed", "jobs", "www", "api", "app", "v1", "boards", "careers", "search", "robots.txt", "sitemap.xml", "favicon.ico", "static", "assets", "cdn"]);

const cleanName = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s.&'’,()+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const found = new Map<string, { ats: string; board: string; name: string }>();
/** Record every board in the text; returns how many it named. */
function scan(text: string, company: string): number {
  let n = 0;
  for (const [ats, re, toBoard] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const board = toBoard(m);
      if (!board || SKIP.has(board.toLowerCase())) continue;
      n++;
      const key = `${ats}:${board.toLowerCase()}`;
      if (!found.has(key)) found.set(key, { ats, board, name: cleanName(company) });
    }
  }
  return n;
}

/** Careers pages that aren't a board themselves: --probe-sites opens each one and looks for the board behind it. */
const sites = new Map<string, string>();
const NOT_A_CAREERS_PAGE = /github\.com|githubusercontent|shields\.io|twitter\.com|x\.com\/|linkedin\.com|youtube|wikipedia|medium\.com|glassdoor|reddit|t\.me|discord|fonts\.g|w3schools|cloudflare|gstatic|google\.com\/(?!about\/careers)|apple\.com\/(?!careers)|mailto:|^#/i;
function site(name: string, url: string) {
  const n = cleanName(name);
  if (!n || n.length > 60 || /^(apply|link|careers?|jobs?|website|here|view|open|↳)$/i.test(n) || NOT_A_CAREERS_PAGE.test(url)) return;
  if (!/^https?:\/\//.test(url) || scan(url, n)) return;
  const key = url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  if (!sites.has(key)) sites.set(key, n);
}

async function getText(url: string, timeoutMs = 60000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  return res.ok ? res.text() : "";
}

const BOARD_URL: Record<string, string> = {
  greenhouse: "https://job-boards.greenhouse.io/",
  lever: "https://jobs.lever.co/",
  ashby: "https://jobs.ashbyhq.com/",
  workable: "https://apply.workable.com/",
  smartrecruiters: "https://jobs.smartrecruiters.com/",
};

/** One list: SimplifyJobs-style JSON, open-jobs-data JSON, markdown/HTML tables, or plain link lists. */
function readList(text: string) {
  if (text.trimStart().startsWith("[")) {
    type Item = { url?: string; company_name?: string; company?: string; name?: string; platform?: string; slug?: string; workday?: { tenant: string; shard: string; site: string } };
    for (const it of JSON.parse(text) as Item[]) {
      if (it.platform) {
        // open-jobs-data: { name, platform, slug | workday }
        const w = it.workday;
        const host = BOARD_URL[it.platform];
        const url = w ? `https://${w.tenant}.${w.shard}.myworkdayjobs.com/${w.site}` : host ? `${host}${it.slug}/` : `https://${it.slug}.${it.platform}.com`;
        scan(url, it.name ?? "");
      } else scan(it.url ?? "", it.company_name ?? it.company ?? it.name ?? "");
    }
    return;
  }
  // Tables: the company is the first cell; "↳" rows continue the company above.
  let last = "";
  const rows = [...text.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
  rows.push(...text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1)));
  for (const cells of rows) {
    if (!cells.length) continue;
    const name = cleanName(cells[0]);
    const company = !name || name.startsWith("↳") ? last : (last = name);
    scan(cells.join(" "), company);
    for (const m of cells.join(" ").matchAll(/https?:\/\/[^\s)"'<>|]+/g)) site(company, m[0]);
  }
  // Link lists: [Company](url) and <a href="url">Company</a>.
  for (const m of text.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)) scan(m[2], m[1]) || site(m[1], m[2]);
  for (const m of text.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{1,200}?)<\/a>/g)) scan(m[1], m[2]) || site(m[2], m[1]);
}

/** A GitHub folder of company profiles with front matter (title, careers_url / website). */
async function readGithubTree(spec: string) {
  const [owner, repo, branch, ...rest] = spec.slice("github-tree:".length).split("/");
  const prefix = rest.join("/");
  const tree = (await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers: { "User-Agent": UA } }).then((r) => r.json())) as { tree?: { path: string }[] };
  const paths = (tree.tree ?? []).map((t) => t.path).filter((p) => p.startsWith(prefix) && p.endsWith(".md"));
  let i = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let p = paths[i++]; p; p = paths[i++]) {
        const t = await getText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`, 20000).catch(() => "");
        const name = t.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
        const url = t.match(/^careers_url:\s*(\S+)/m)?.[1] ?? t.match(/^website:\s*(\S+)/m)?.[1] ?? "";
        if (name && url) scan(url, name) || site(name, url);
      }
    }),
  );
  return paths.length;
}

/** Common Crawl's URL index: every captured address on each board host. Gentle: one request at a time. */
async function readCommonCrawl() {
  const crawl = flag("crawl") ?? ((await fetch("https://index.commoncrawl.org/collinfo.json").then((r) => r.json())) as { id: string }[])[0].id;
  const base = `https://index.commoncrawl.org/${crawl}-index`;
  const get = async (url: string) => {
    for (const wait of [0, 10, 30, 60, 120]) {
      if (wait) await sleep(wait * 1000);
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000) });
        if (res.status === 404) return ""; // no captures
        if (res.ok) return await res.text();
      } catch {
        // Busy, or the connection dropped mid-download: try again after a pause.
      }
    }
    return null; // still busy: skipped this run
  };
  /** The URLs on one index page; a page cut off mid-transfer is fetched again (once), else its whole lines are used. */
  const page = async (url: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await get(url);
      if (text === null) return null;
      const urls: string[] = [];
      let broken = 0;
      for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          urls.push((JSON.parse(line) as { url?: string }).url ?? "");
        } catch {
          broken++;
        }
      }
      if (!broken || attempt === 1) return urls;
      await sleep(5000);
    }
    return [];
  };
  let missed = 0;
  for (const q of CC_QUERIES) {
    try {
      const info = await get(`${base}?${q}&output=json&showNumPages=true`);
      const pages = info ? Math.min(Number((JSON.parse(info) as { pages?: number }).pages ?? 0), maxPages) : 0;
      const before = found.size;
      for (let p = 0; p < pages; p++) {
        const urls = await page(`${base}?${q}&output=json&fl=url&page=${p}`);
        if (urls === null) missed++;
        else for (const u of urls) scan(u, "");
        await sleep(1000);
      }
      console.log(`  Common Crawl ${q.replace(/^url=/, "")}: ${pages} index pages, ${found.size - before} boards`);
    } catch (e) {
      missed++;
      console.warn(`  Common Crawl ${q}: ${(e as Error).message}`);
    }
  }
  console.log(`Common Crawl ${crawl}: ${missed ? `${missed} index pages still busy after retries (run again later)` : "read in full"}`);
}

/** AI Dev Jobs' open API: each job's apply link is the company's own posting. */
async function readAidevboard() {
  let jobs = 0;
  for (let page = 1; ; page++) {
    const res = await fetch(`https://aidevboard.com/api/v1/jobs?limit=50&page=${page}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res?.ok) break;
    const d = (await res.json()) as { jobs?: { apply_url?: string; company_name?: string }[]; has_next?: boolean };
    for (const j of d.jobs ?? []) scan(j.apply_url ?? "", j.company_name ?? "") || site(j.company_name ?? "", j.apply_url ?? "");
    jobs += d.jobs?.length ?? 0;
    // Stay well inside its hourly limit.
    if (!d.has_next || Number(res.headers.get("x-ratelimit-remaining") ?? 99) < 10) break;
    await sleep(1000);
  }
  console.log(`AI Dev Jobs: ${jobs} jobs read`);
}

/** One page per careers site: the board link is usually in it (an embed, an "Open roles" link, a redirect). */
async function probeSites(watched: Set<string>) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const todo = [...sites].filter(([, name]) => !watched.has(norm(name)));
  let i = 0;
  let hits = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let s = todo[i++]; s; s = todo[i++]) {
        const [url, name] = s;
        const res = await fetch(url.startsWith("http") ? url : `https://${url}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000), redirect: "follow" }).catch(() => null);
        if (!res?.ok) continue;
        const html = (await res.text().catch(() => "")).slice(0, 1_000_000);
        if (scan(`${res.url} ${html}`, name)) hits++;
      }
    }),
  );
  console.log(`careers pages: ${todo.length} opened, ${hits} led to a board`);
}

// ---------- read the sources ----------

if (files.length) for (const f of files) readList(fs.readFileSync(f, "utf8"));
else {
  for (const src of [...JOB_LISTS, ...DIRECTORIES]) {
    if (src.startsWith("github-tree:")) {
      console.log(`${src}: ${await readGithubTree(src).catch(() => 0)} profiles`);
      continue;
    }
    const text = await getText(src).catch(() => "");
    if (!text) console.warn(`skip ${src}: not found`);
    else readList(text);
  }
  if (useAidev) await readAidevboard().catch((e) => console.warn(`AI Dev Jobs: ${(e as Error).message}`));
  if (useCrawl) await readCommonCrawl().catch((e) => console.warn(`Common Crawl: ${(e as Error).message}`));
}

const boardsFile = fileURLToPath(new URL("../src/ingest/boards.json", import.meta.url));
const existing = JSON.parse(fs.readFileSync(boardsFile, "utf8")) as { name: string; ats: string; board: string }[];
const have = new Set(existing.map((b) => `${b.ats}:${b.board.toLowerCase()}`));
if (probe && sites.size) await probeSites(new Set(existing.map((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, ""))));

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
console.log(`${found.size} boards found, ${candidates.length} new to check`);

// ---------- check each new board live ----------

/** Open jobs on the board. Workday: one small page instead of the whole board. */
async function live(c: { ats: string; board: string; name: string }): Promise<number> {
  if (c.ats === "workday") {
    const [host, site] = c.board.split("|");
    const tenant = host.split(".")[0];
    const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return 0;
    return ((await res.json()) as { total?: number }).total ?? 0;
  }
  return (await FETCHERS[c.ats]({ id: null, name: c.name, ats: c.ats, board: c.board })).length;
}

/** A readable company name when the source only gave a slug: Greenhouse knows it; otherwise tidy the slug. */
async function nameFor(c: { ats: string; board: string; name: string }): Promise<string> {
  if (c.name && c.name.toLowerCase() !== c.board.toLowerCase()) return c.name;
  if (c.ats === "greenhouse") {
    const n = await fetch(`https://boards-api.greenhouse.io/v1/boards/${c.board}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : {}))
      .then((d) => (d as { name?: string }).name?.trim())
      .catch(() => "");
    if (n) return n;
  }
  const slug = (c.ats === "workday" ? c.board.split(".")[0] : c.board.split("|")[0]).replace(/\.(icims|fa)\..*$/, "");
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b(inc|llc|ltd|careers|jobs|hiring)\b/gi, "")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Busy or rate-limited providers get fewer requests at once (the same caps the poller uses).
const CAP: Record<string, number> = { workable: 2, workday: 4, smartrecruiters: 3, icims: 3, oraclecloud: 3, successfactors: 2, taleo: 2 };
const added: { name: string; ats: string; board: string; jobs: number }[] = [];
let done = 0;
let unchecked = 0;
const byAtsQueue = new Map<string, typeof candidates>();
for (const c of candidates) byAtsQueue.set(c.ats, [...(byAtsQueue.get(c.ats) ?? []), c]);
await Promise.all(
  [...byAtsQueue].map(([ats, queue]) =>
    Promise.all(
      Array.from({ length: Math.min(CAP[ats] ?? concurrency, concurrency) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          let n = 0;
          try {
            n = await live(c);
          } catch {
            // Busy (429) or slow: one more try after a pause, then leave it for the next run.
            await sleep(5000);
            n = await live(c).catch(() => -1);
          }
          if (n < 0) unchecked++;
          else if (n > 0) added.push({ ...c, name: await nameFor(c), jobs: n });
          if (++done % 200 === 0) console.log(`  checked ${done}/${candidates.length}, ${added.length} live`);
        }
      }),
    ),
  ),
);

const byAts = added.reduce<Record<string, number>>((m, r) => ((m[r.ats] = (m[r.ats] ?? 0) + 1), m), {});
console.log(`${added.length} live boards ${dry ? "found" : "added"}`, byAts, "open jobs:", added.reduce((s, r) => s + r.jobs, 0), unchecked ? `(${unchecked} couldn't be checked; run again later)` : "");
if (!dry && added.length) {
  const merged = [...existing, ...added.map(({ jobs: _j, ...r }) => r)].sort((a, b) => a.ats.localeCompare(b.ats) || a.name.localeCompare(b.name));
  fs.writeFileSync(boardsFile, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`boards.json: ${existing.length} → ${merged.length}`);
  // A running Ferry reads boards.json at startup; put the new ones in its database so the next poll picks them up.
  const { paths } = await import("../src/config.ts");
  if (fs.existsSync(paths.db)) {
    const { addCompany } = await import("../src/ingest/companies.ts");
    for (const r of added) addCompany(r.name, r.ats, r.board);
    console.log(`database: ${added.length} boards added (watched from the next poll)`);
  }
}
