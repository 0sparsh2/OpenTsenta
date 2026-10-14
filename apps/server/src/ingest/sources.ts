import { classifyWorkplace, htmlToText, sponsorshipSignal } from "../util/text.ts";
import type { JobInput } from "../store.ts";

// Public job-board APIs. These are the same unauthenticated JSON feeds that power each
// company's own careers page, so polling them is how a "watch 50k career pages" agent scales.

const UA = "Mozilla/5.0 (compatible; FerryJobWatcher/0.1; +https://github.com/)";

async function getJson<T>(url: string, timeoutMs = 45000): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export interface CompanyRef {
  id: string | null;
  name: string;
  ats: string;
  board: string;
}

type Fetcher = (c: CompanyRef) => Promise<JobInput[]>;

import { ENTERPRISE_FETCHERS, enterpriseDescription } from "./enterprise.ts";
import { SMALL_FETCHERS, smallDescription } from "./smallats.ts";

// ---------- Greenhouse ----------
interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  updated_at?: string;
  first_published?: string;
  departments?: { name: string }[];
  company_name?: string;
}
export const greenhouseEmbed = (board: string, id: string | number) => `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${id}`;

const greenhouse: Fetcher = async (c) => {
  const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${c.board}/jobs?content=true`);
  return data.jobs.map((j) => {
    const description = htmlToText(j.content ?? "");
    const location = j.location?.name ?? "";
    return {
      companyId: c.id,
      company: j.company_name || c.name,
      ats: "greenhouse",
      externalId: `${c.board}:${j.id}`,
      title: (j.title ?? "").trim(),
      location,
      workplace: classifyWorkplace(location, j.title),
      department: j.departments?.[0]?.name,
      url: j.absolute_url,
      // Company-site listings (jobs.dropbox.com/…?gh_jid=) wrap the form in custom pages; the hosted embed is always the form.
      applyUrl: /greenhouse\.io\//.test(j.absolute_url) ? j.absolute_url : greenhouseEmbed(c.board, j.id),
      description,
      salary: extractSalary(description),
      postedAt: j.first_published ?? j.updated_at,
      sponsorsVisa: sponsorshipSignal(description),
    };
  });
};

// ---------- Lever ----------
interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  categories?: { location?: string; team?: string; department?: string; commitment?: string; allLocations?: string[] };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  createdAt?: number;
  workplaceType?: string;
  salaryRange?: { min: number; max: number; currency: string; interval: string };
}
const lever: Fetcher = async (c) => {
  const data = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${c.board}?mode=json`);
  return data.map((j) => {
    const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
    const description = [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n").trim();
    const location = j.categories?.allLocations?.join(" / ") || j.categories?.location || "";
    return {
      companyId: c.id,
      company: c.name,
      ats: "lever",
      externalId: `${c.board}:${j.id}`,
      title: (j.text ?? "").trim(),
      location,
      workplace: classifyWorkplace(j.workplaceType, location),
      department: j.categories?.department ?? j.categories?.team,
      employmentType: j.categories?.commitment,
      url: j.hostedUrl,
      applyUrl: j.applyUrl,
      description,
      salary: j.salaryRange ? fmtRange(j.salaryRange.min, j.salaryRange.max, j.salaryRange.currency, j.salaryRange.interval) : extractSalary(description),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      sponsorsVisa: sponsorshipSignal(description),
    };
  });
};

// ---------- Ashby ----------
interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  publishedAt?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string | null; scrapeableCompensationSalarySummary?: string | null };
}
const ashby: Fetcher = async (c) => {
  const data = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${c.board}?includeCompensation=true`);
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const description = (j.descriptionPlain ?? "").trim();
      const location = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join(" / ");
      return {
        companyId: c.id,
        company: c.name,
        ats: "ashby",
        externalId: `${c.board}:${j.id}`,
        title: (j.title ?? "").trim(),
        location,
        workplace: j.isRemote ? "remote" : classifyWorkplace(j.workplaceType, location),
        department: j.department ?? j.team,
        employmentType: j.employmentType,
        url: j.jobUrl,
        applyUrl: j.applyUrl,
        description,
        salary: j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary ?? extractSalary(description),
        postedAt: j.publishedAt,
        sponsorsVisa: sponsorshipSignal(description),
      };
    });
};

// ---------- SmartRecruiters ----------
interface SrJob {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; country?: string; remote?: boolean; hybrid?: boolean };
  department?: { label?: string };
  typeOfEmployment?: { label?: string };
  company?: { name?: string; identifier?: string };
}
const smartrecruiters: Fetcher = async (c) => {
  const data = await getJson<{ content: SrJob[] }>(`https://api.smartrecruiters.com/v1/companies/${c.board}/postings?limit=100`);
  return data.content.map((j) => {
    const location = j.location?.fullLocation ?? [j.location?.city, j.location?.country].filter(Boolean).join(", ");
    const url = `https://jobs.smartrecruiters.com/${c.board}/${j.id}`;
    return {
      companyId: c.id,
      company: j.company?.name ?? c.name,
      ats: "smartrecruiters",
      externalId: `${c.board}:${j.id}`,
      title: (j.name ?? "").trim(),
      location,
      workplace: j.location?.remote ? "remote" : j.location?.hybrid ? "hybrid" : "onsite",
      department: j.department?.label,
      employmentType: j.typeOfEmployment?.label,
      url,
      applyUrl: url,
      // Descriptions need one request per posting; fetched lazily when the job is opened or matched.
      description: "",
      postedAt: j.releasedDate,
      sponsorsVisa: null,
    };
  });
};

export async function smartrecruitersDescription(board: string, id: string): Promise<string> {
  const d = await getJson<{ jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(
    `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}`,
  );
  const sections = d.jobAd?.sections ?? {};
  return Object.values(sections)
    .map((s) => `${s.title ?? ""}\n${htmlToText(s.text ?? "")}`.trim())
    .join("\n\n");
}

// ---------- Recruitee ----------
interface RecruiteeOffer {
  id: number;
  title: string;
  location?: string;
  remote?: boolean;
  careers_url: string;
  careers_apply_url?: string;
  description?: string;
  requirements?: string;
  created_at?: string;
  department?: string;
  employment_type_code?: string;
  company_name?: string;
}
const recruitee: Fetcher = async (c) => {
  const data = await getJson<{ offers: RecruiteeOffer[] }>(`https://${c.board}.recruitee.com/api/offers/`);
  return data.offers.map((j) => {
    const description = htmlToText(`${j.description ?? ""}\n${j.requirements ?? ""}`);
    return {
      companyId: c.id,
      company: j.company_name ?? c.name,
      ats: "recruitee",
      externalId: `${c.board}:${j.id}`,
      title: (j.title ?? "").trim(),
      location: j.location ?? "",
      workplace: j.remote ? "remote" : classifyWorkplace(j.location),
      department: j.department,
      employmentType: j.employment_type_code,
      url: j.careers_url,
      applyUrl: j.careers_apply_url ?? j.careers_url,
      description,
      salary: extractSalary(description),
      postedAt: j.created_at,
      sponsorsVisa: sponsorshipSignal(description),
    };
  });
};

// ---------- Workday (candidate-site JSON API) ----------
// board = "{host}|{site}", e.g. "nvidia.wd5.myworkdayjobs.com|NVIDIAExternalCareerSite"
interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  remoteType?: string;
}
const WORKDAY_MAX = Number(process.env.WORKDAY_MAX_JOBS ?? 300);

export function workdayParts(board: string) {
  const [host, site] = board.split("|");
  return { host, site, tenant: host.split(".")[0] };
}

/** "Posted Today" / "Posted Yesterday" / "Posted 6 Days Ago" / "Posted 30+ Days Ago" → ISO date. */
export function workdayPostedOn(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  const d = /today/.test(t) ? 0 : /yesterday/.test(t) ? 1 : Number(t.match(/(\d+)\+?\s*days?/)?.[1] ?? NaN);
  // To the day: "Posted 3 days ago" names a day, and a stable value lets unchanged jobs skip rewriting.
  return Number.isFinite(d) ? `${new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10)}T00:00:00.000Z` : undefined;
}

const workday: Fetcher = async (c) => {
  const { host, site, tenant } = workdayParts(c.board);
  const out: JobInput[] = [];
  for (let offset = 0; offset < WORKDAY_MAX; offset += 20) {
    const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`${res.status} for ${host}`);
    const d = (await res.json()) as { total?: number; jobPostings?: WdPosting[] };
    for (const p of d.jobPostings ?? []) {
      const url = `https://${host}/${site}${p.externalPath}`;
      out.push({
        companyId: c.id,
        company: c.name,
        ats: "workday",
        externalId: `${c.board}:${p.externalPath}`,
        title: (p.title ?? "").trim(),
        location: p.locationsText ?? "",
        workplace: classifyWorkplace(p.remoteType, p.locationsText),
        url,
        applyUrl: url,
        description: "",
        postedAt: workdayPostedOn(p.postedOn),
        sponsorsVisa: null,
      });
    }
    if (!d.jobPostings?.length || offset + 20 >= (d.total ?? 0)) break;
  }
  return out;
};

async function workdayDescription(externalId: string): Promise<string> {
  const [board, path] = [externalId.slice(0, externalId.indexOf(":")), externalId.slice(externalId.indexOf(":") + 1)];
  const { host, site, tenant } = workdayParts(board);
  const d = await getJson<{ jobPostingInfo?: { jobDescription?: string } }>(`https://${host}/wday/cxs/${tenant}/${site}${path}`);
  return htmlToText(d.jobPostingInfo?.jobDescription ?? "");
}

// ---------- Workable ----------
interface WorkableJob {
  shortcode: string;
  title: string;
  remote?: boolean;
  location?: { city?: string; country?: string; region?: string | null };
  published?: string;
  department?: string[];
  type?: string;
  workplace?: string;
}
const workable: Fetcher = async (c) => {
  // Ten jobs a page; nextPage is the token for the following one.
  const all: WorkableJob[] = [];
  let token: string | undefined;
  for (let page = 0; page < 30; page++) {
    const res = await fetch(`https://apply.workable.com/api/v3/accounts/${c.board}/jobs`, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [], ...(token ? { token } : {}) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`${res.status} for workable ${c.board}`);
    const d = (await res.json()) as { results?: WorkableJob[]; nextPage?: string };
    all.push(...(d.results ?? []));
    if (!d.nextPage || !d.results?.length) break;
    token = d.nextPage;
  }
  return all.map((j) => {
    const location = [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", ");
    const url = `https://apply.workable.com/${c.board}/j/${j.shortcode}/`;
    return {
      companyId: c.id,
      company: c.name,
      ats: "workable",
      externalId: `${c.board}:${j.shortcode}`,
      title: (j.title ?? "").trim(),
      location,
      workplace: j.remote ? "remote" : classifyWorkplace(j.workplace, location),
      department: j.department?.[0],
      employmentType: j.type,
      url,
      applyUrl: `${url}apply/`,
      description: "",
      postedAt: j.published,
      sponsorsVisa: null,
    };
  });
};

async function workableDescription(externalId: string): Promise<string> {
  const [acct, code] = externalId.split(":");
  const d = await getJson<{ description?: string; requirements?: string; benefits?: string }>(`https://apply.workable.com/api/v2/accounts/${acct}/jobs/${code}`);
  return htmlToText(`${d.description ?? ""}\n${d.requirements ?? ""}\n${d.benefits ?? ""}`);
}

export const FETCHERS: Record<string, Fetcher> = { greenhouse, lever, ashby, smartrecruiters, recruitee, workday, workable, ...ENTERPRISE_FETCHERS, ...SMALL_FETCHERS };

/** Sources whose list APIs omit descriptions; fetched on demand (opening, scoring, applying). */
export async function fetchDescription(ats: string, externalId: string, url?: string): Promise<string> {
  const enterprise = await enterpriseDescription(ats, externalId, url);
  if (enterprise != null) return enterprise;
  const small = await smallDescription(ats, externalId);
  if (small != null) return small;
  if (ats === "smartrecruiters") {
    const [board, id] = externalId.split(":");
    return smartrecruitersDescription(board, id);
  }
  if (ats === "workday") return workdayDescription(externalId);
  if (ats === "workable") return workableDescription(externalId);
  return "";
}

// ---------- helpers ----------

function fmtRange(min: number, max: number, currency = "USD", interval = "") {
  const f = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  const per = interval.includes("year") ? "/yr" : interval.includes("hour") ? "/hr" : interval.includes("month") ? "/mo" : "";
  return min === max ? `${sym}${f(min)}${per}` : `${sym}${f(min)} – ${sym}${f(max)}${per}`;
}

/** Pull a salary range out of free text ("$150,000 - $210,000", "$150K–$210K"). */
export function extractSalary(text: string): string | undefined {
  const m = text.match(/([$£€])\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])\s*(?:-|–|—|to)\s*\1?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])/);
  if (!m) return undefined;
  const norm = (s: string) => {
    const v = s.toLowerCase().includes("k") ? parseFloat(s) * 1000 : parseInt(s.replace(/,/g, ""), 10);
    return v;
  };
  const lo = norm(m[2]);
  const hi = norm(m[3]);
  if (!(lo > 10000 && hi >= lo)) return undefined;
  return fmtRange(lo, hi, m[1] === "$" ? "USD" : m[1] === "€" ? "EUR" : "GBP", "per-year-salary");
}
