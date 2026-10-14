import type { JobInput } from "../store.ts";
import { classifyWorkplace, decodeEntities, htmlToText, microdataProp } from "../util/text.ts";

// Discovery for the enterprise ATSes: Oracle Recruiting Cloud, iCIMS, Taleo and SuccessFactors career sites.
// Lists come from each site's public search (JSON where there is one, the search page otherwise); descriptions
// are fetched lazily when a job is opened, scored, or applied to. Each source stops at MAX jobs per board.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAX = Number(process.env.ENTERPRISE_MAX_JOBS ?? 300);

export interface EnterpriseRef {
  id: string | null;
  name: string;
  board: string;
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, "Accept-Language": "en-US", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
}
const text = (s: string) => decodeEntities(htmlToText(s)).replace(/\s+/g, " ").trim();
const dateOf = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// ---------- Oracle Recruiting Cloud: board "host|siteNumber" ----------

interface OrcReq {
  Id: string;
  Title: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceType?: string;
}

export async function oraclecloud(c: EnterpriseRef): Promise<JobInput[]> {
  const [host, site] = c.board.split("|");
  const out: JobInput[] = [];
  for (let offset = 0; offset < MAX; offset += 25) {
    const res = await get(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${site},limit=25,offset=${offset},sortBy=POSTING_DATES_DESC`,
      { headers: { Accept: "application/json" } },
    );
    const d = (await res.json()) as { items?: { TotalJobsCount?: number; requisitionList?: OrcReq[] }[] };
    const list = d.items?.[0]?.requisitionList ?? [];
    for (const r of list) {
      const url = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`;
      out.push({
        companyId: c.id,
        company: c.name,
        ats: "oraclecloud",
        externalId: `${c.board}:${r.Id}`,
        title: (r.Title ?? "").trim(),
        location: r.PrimaryLocation ?? "",
        workplace: classifyWorkplace(r.WorkplaceType, r.PrimaryLocation),
        url,
        applyUrl: url,
        description: "",
        postedAt: dateOf(r.PostedDate),
        sponsorsVisa: null,
      });
    }
    if (list.length < 25 || offset + 25 >= (d.items?.[0]?.TotalJobsCount ?? 0)) break;
  }
  return out;
}

async function oracleDescription(externalId: string): Promise<string> {
  const [board, id] = [externalId.slice(0, externalId.lastIndexOf(":")), externalId.slice(externalId.lastIndexOf(":") + 1)];
  const [host, site] = board.split("|");
  const res = await get(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`, {
    headers: { Accept: "application/json" },
  });
  const it = ((await res.json()) as { items?: Record<string, string>[] }).items?.[0] ?? {};
  return htmlToText([it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr].filter(Boolean).join("\n"));
}

// ---------- iCIMS: board "careers-<org>.icims.com" ----------

export async function icims(c: EnterpriseRef): Promise<JobInput[]> {
  const out: JobInput[] = [];
  const seen = new Set<string>();
  for (let pr = 0; out.length < MAX && pr < 20; pr++) {
    const html = await (await get(`https://${c.board}/jobs/search?ss=1&in_iframe=1&pr=${pr}`)).text();
    const cards = html.split(/<li class="iCIMS_JobCardItem"/).slice(1);
    if (!cards.length) break;
    let added = 0;
    for (const card of cards) {
      const link = card.match(/href="(https:\/\/[^"]+\/jobs\/(\d+)\/[^"]*?\/job)[^"]*"[^>]*class="iCIMS_Anchor"/) ?? card.match(/href="(https:\/\/[^"]+\/jobs\/(\d+)\/[^"]*?\/job)/);
      if (!link || seen.has(link[2])) continue;
      seen.add(link[2]);
      const title = text(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
      const locRaw = text(card.match(/Job Locations<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
      // "US-VA-Reston" → "Reston, VA, US"
      const location = /^[A-Z]{2}-/.test(locRaw) ? locRaw.split("-").reverse().join(", ") : locRaw;
      const posted = card.match(/<span title="(\d{1,2}\/\d{1,2}\/\d{4}[^"]*)"/)?.[1];
      const remote = text(card.match(/Telecommute Options[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
      if (!title) continue;
      out.push({
        companyId: c.id,
        company: c.name,
        ats: "icims",
        externalId: `${c.board}:${link[2]}`,
        title,
        location,
        workplace: classifyWorkplace(/no remote/i.test(remote) ? "onsite" : remote, location),
        url: link[1],
        applyUrl: link[1],
        description: "",
        postedAt: dateOf(posted),
        sponsorsVisa: null,
      });
      added++;
    }
    if (!added || !/iCIMS_Paginator|Page \d+ of \d+/.test(html) || new RegExp(`Page ${pr + 1} of ${pr + 1}\\b`).test(html)) break;
  }
  return out;
}

async function icimsDescription(externalId: string, url?: string): Promise<string> {
  const [board, id] = externalId.split(":");
  const page = url ? `${url}${url.includes("?") ? "&" : "?"}in_iframe=1` : `https://${board}/jobs/${id}/job?in_iframe=1`;
  const html = await (await get(page)).text();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]) as { "@type"?: string; description?: string };
      if (d["@type"] === "JobPosting" && d.description) return htmlToText(d.description);
    } catch {
      /* next */
    }
  }
  return text(html.match(/class="iCIMS_JobContent"[^>]*>([\s\S]*?)<div class="iCIMS_Footer/)?.[1] ?? "");
}

// ---------- Taleo: board "<org>.taleo.net|<careersection>" ----------

interface TaleoReq {
  jobId: string;
  contestNo: string;
  column: string[];
}

export async function taleo(c: EnterpriseRef): Promise<JobInput[]> {
  const [host, section] = c.board.split("|");
  const page = await (await get(`https://${host}/careersection/${section}/jobsearch.ftl?lang=en`)).text();
  const portal = page.match(/portal=(\d+)/)?.[1] ?? page.match(/portalNo:\s*'(\d+)'/)?.[1];
  if (!portal) throw new Error(`no Taleo portal on ${host}/${section}`);
  const out: JobInput[] = [];
  for (let pageNo = 1; out.length < MAX && pageNo <= 20; pageNo++) {
    const res = await get(`https://${host}/careersection/rest/jobboard/searchjobs?lang=en&portal=${portal}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", tz: "GMT-05:00" },
      body: JSON.stringify({
        multilineEnabled: false,
        sortingSelection: { sortBySelectionParam: "3", ascendingSortingOrder: "false" },
        fieldData: { fields: { KEYWORD: "", LOCATION: "" }, valid: true },
        filterSelectionParam: { searchFilterSelections: [] },
        advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
        pageNo,
      }),
    });
    const d = (await res.json()) as { requisitionList?: TaleoReq[]; pagingData?: { totalCount?: number; pageSize?: number } };
    const list = d.requisitionList ?? [];
    for (const r of list) {
      const [title = "", locJson = "[]", posted] = r.column ?? [];
      let location = "";
      try {
        location = (JSON.parse(locJson) as string[]).map((l) => l.split("-").reverse().join(", ")).join(" / ");
      } catch {
        location = locJson;
      }
      const url = `https://${host}/careersection/${section}/jobdetail.ftl?job=${r.contestNo}&lang=en`;
      out.push({
        companyId: c.id,
        company: c.name,
        ats: "taleo",
        externalId: `${c.board}:${r.contestNo}`,
        title: (title ?? "").trim(),
        location,
        workplace: classifyWorkplace(location, title),
        url,
        applyUrl: url,
        description: "",
        postedAt: dateOf(posted),
        sponsorsVisa: null,
      });
    }
    const size = d.pagingData?.pageSize ?? 25;
    if (list.length < size || pageNo * size >= (d.pagingData?.totalCount ?? 0)) break;
  }
  return out;
}

async function taleoDescription(externalId: string): Promise<string> {
  const [board, contest] = [externalId.slice(0, externalId.lastIndexOf(":")), externalId.slice(externalId.lastIndexOf(":") + 1)];
  const [host, section] = board.split("|");
  const html = await (await get(`https://${host}/careersection/${section}/jobdetail.ftl?job=${contest}&lang=en`)).text();
  const v = html.match(/id="initialHistory"[^>]*value="([^"]*)"/)?.[1];
  if (!v) return "";
  // "!*!"-separated, URL-encoded fields; the long ones are the description and qualifications.
  const parts = decodeEntities(v)
    .split("!*!")
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    })
    .filter((p) => p.length > 200)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  return htmlToText(parts.join("\n").replace(/\\:/g, ":"));
}

// ---------- SuccessFactors career sites (RMK): board "<career site host>" ----------

export async function successfactors(c: EnterpriseRef): Promise<JobInput[]> {
  const out: JobInput[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < MAX; start += 25) {
    const html = await (await get(`https://${c.board}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${start}`)).text();
    const rows = html.split(/class="data-row/).slice(1);
    if (!rows.length) break;
    for (const r of rows) {
      const a = r.match(/<a[^>]*class="jobTitle-link"[^>]*>/)?.[0] ?? "";
      const href = a.match(/href="([^"]+)"/)?.[1];
      if (!href) continue;
      const url = new URL(decodeEntities(href), `https://${c.board}`).toString();
      const id = url.match(/\/(\d{6,})\/?$/)?.[1] ?? url;
      if (seen.has(id)) continue;
      seen.add(id);
      const title = text(r.match(/class="jobTitle-link"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
      const location = text(r.match(/class="jobLocation"[^>]*>([\s\S]*?)<\/span>\s*<\/span>|class="jobLocation"[^>]*>([\s\S]*?)<\/span>/)?.slice(1).find(Boolean) ?? "");
      const posted = text(r.match(/class="jobDate"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
      if (!title) continue;
      out.push({
        companyId: c.id,
        company: c.name,
        ats: "successfactors",
        externalId: `${c.board}:${id}`,
        title,
        location,
        workplace: classifyWorkplace(location, title),
        url,
        applyUrl: url,
        description: "",
        postedAt: dateOf(posted),
        sponsorsVisa: null,
      });
    }
    if (rows.length < 25) break;
  }
  return out;
}

async function successfactorsDescription(externalId: string, url?: string): Promise<string> {
  const [host, id] = externalId.split(":");
  const html = await get(url ?? `https://${host}/job/${id}/`)
    .then((r) => r.text())
    .catch(() => "");
  return htmlToText(microdataProp(html, "description"));
}

export const ENTERPRISE_FETCHERS = { oraclecloud, icims, taleo, successfactors };

export async function enterpriseDescription(ats: string, externalId: string, url?: string): Promise<string | null> {
  if (ats === "oraclecloud") return oracleDescription(externalId);
  if (ats === "icims") return icimsDescription(externalId, url);
  if (ats === "taleo") return taleoDescription(externalId);
  if (ats === "successfactors") return successfactorsDescription(externalId, url);
  return null;
}
