import { z } from "zod";
import { applyPageUrl, detectAts, parseJobUrl } from "../ats.ts";
import { all, one } from "../db.ts";
import { structured, withFallback } from "../llm.ts";
import { getJob, upsertJob, type JobInput } from "../store.ts";
import type { Job } from "../types.ts";
import { classifyWorkplace, decodeEntities, htmlToText, microdataProp, sponsorshipSignal, truncate } from "../util/text.ts";
import { greenhouseEmbed, extractSalary, FETCHERS, smartrecruitersDescription, workdayParts } from "./sources.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export interface CapturedJob {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  /** The user is on this page (the extension filling its form): take it as the job even if it doesn't read like a posting. */
  onPage?: boolean;
}

/**
 * Resolve any job URL (or a job captured by the browser extension) into a stored Job.
 * Order: ATS public API → schema.org JobPosting JSON-LD → page text (+ LLM extraction).
 */
export async function resolveJob(input: CapturedJob): Promise<Job> {
  const url = input.url.trim();
  const found = one<{ id: string }>("SELECT id FROM jobs WHERE url = ? OR apply_url = ?", url, url);
  if (found) return getJob(found.id)!;
  if (detectAts(url) === "linkedin") return resolveLinkedIn(url, input);
  const viaApi = await fromAtsApi(url).catch(() => null);
  if (viaApi) return upsertJob(viaApi).job;

  let html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    html = await res.text();
  } catch {
    /* page may block bots; fall back to whatever the extension captured */
  }
  // A company site that embeds Greenhouse (…?gh_jid=123): find the board in the page and use Greenhouse's API.
  const ghJid = (() => {
    try {
      return new URL(url).searchParams.get("gh_jid");
    } catch {
      return null;
    }
  })();
  if (ghJid) {
    // The board named in the page, else the obvious guesses from the domain (jobs.dropbox.com → "dropbox");
    // Greenhouse's API confirms which one owns this job id.
    const fromPage = html.match(/greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|embed\/job_app\?for=|v1\/boards\/)([\w-]+)/)?.[1];
    const host = (() => {
      try {
        return new URL(url).hostname.replace(/^(www|jobs|careers|boards|apply|life|about)\./, "");
      } catch {
        return "";
      }
    })();
    const guesses = [...new Set([fromPage, host.split(".")[0], host.replace(/\./g, ""), input.company?.toLowerCase().replace(/[^a-z0-9]/g, "")].filter(Boolean) as string[])];
    for (const board of guesses.slice(0, 4)) {
      const viaBoard = await fromAtsApi(`https://boards.greenhouse.io/${board}/jobs/${ghJid}`).catch(() => null);
      if (viaBoard) return upsertJob({ ...viaBoard, url }).job;
    }
  }
  const ld = html ? (fromJsonLd(html, url) ?? fromMicrodata(html, url)) : null;
  if (ld && (ld.description.length > 200 || !input.description)) return upsertJob(mergeCaptured(ld, input)).job;

  const pageText = input.description?.trim() || (html ? htmlToText(html.replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, "")) : "");
  const titleTag = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  // A page you captured from the extension is a job you're looking at; any other page has to read like a posting.
  const captured = Boolean(input.title || input.onPage);
  const fromPage = { title: input.title || titleTag.split(/[|\-–]/)[0].trim() || "Untitled role", company: input.company || hostCompany(url), location: input.location ?? "", description: pageText };
  const extracted = await withFallback(
    "jd-extract",
    async () => (await llmExtract(url, pageText)) ?? (captured ? fromPage : null),
    () => (captured || looksLikePosting(pageText) ? fromPage : null),
  );
  if (!extracted) throw new NotAJobPosting(`${url} doesn't look like a job posting`);
  const ats = detectAtsFromPage(url, html);
  return upsertJob({
    companyId: null,
    company: input.company || extracted.company,
    ats,
    externalId: `url:${url}`,
    title: input.title || extracted.title,
    location: input.location || extracted.location,
    workplace: classifyWorkplace(extracted.location, extracted.description.slice(0, 2000)),
    url,
    applyUrl: applyPageUrl(ats, url),
    description: extracted.description,
    salary: extractSalary(extracted.description),
    sponsorsVisa: sponsorshipSignal(extracted.description),
  }).job;
}

function mergeCaptured(j: JobInput, c: CapturedJob): JobInput {
  return { ...j, title: j.title || c.title || "Untitled role", company: j.company || c.company || hostCompany(c.url), description: j.description || c.description || "" };
}

const hostCompany = (url: string) => {
  try {
    const h = new URL(url).hostname.replace(/^(www|jobs|careers|boards|apply)\./, "");
    const name = h.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Unknown company";
  }
};

async function fromAtsApi(url: string): Promise<JobInput | null> {
  const { ats, board, jobId } = parseJobUrl(url);
  if (!board || !jobId) return null;
  if (ats === "greenhouse") {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { id: number; title: string; absolute_url: string; location?: { name?: string }; content?: string; company_name?: string; first_published?: string };
    const description = htmlToText(j.content ?? "");
    return {
      companyId: null,
      company: j.company_name ?? board,
      ats,
      externalId: `${board}:${j.id}`,
      title: j.title,
      location: j.location?.name ?? "",
      workplace: classifyWorkplace(j.location?.name),
      url: j.absolute_url,
      applyUrl: /greenhouse\.io\//.test(j.absolute_url) ? j.absolute_url : greenhouseEmbed(board, j.id),
      description,
      salary: extractSalary(description),
      postedAt: j.first_published,
      sponsorsVisa: sponsorshipSignal(description),
    };
  }
  if (ats === "workday") {
    const { host, site, tenant } = workdayParts(board);
    const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}${jobId}`, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { jobPostingInfo?: { title: string; jobDescription?: string; location?: string; externalUrl?: string; startDate?: string; remoteType?: string } };
    const i = d.jobPostingInfo;
    if (!i) return null;
    const description = htmlToText(i.jobDescription ?? "");
    const companyName = tenant.charAt(0).toUpperCase() + tenant.slice(1);
    return {
      companyId: null,
      company: companyName,
      ats,
      externalId: `${board}:${jobId}`,
      title: i.title,
      location: i.location ?? "",
      workplace: classifyWorkplace(i.remoteType, i.location),
      url: i.externalUrl ?? url,
      applyUrl: i.externalUrl ?? url,
      description,
      salary: extractSalary(description),
      postedAt: i.startDate,
      sponsorsVisa: sponsorshipSignal(description),
    };
  }
  if (ats === "lever" || ats === "ashby" || ats === "workable") {
    const all = await FETCHERS[ats]({ id: null, name: board, ats, board });
    return all.find((j) => j.externalId === `${board}:${jobId}`) ?? null;
  }
  if (ats === "smartrecruiters") {
    const description = await smartrecruitersDescription(board, jobId);
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${board}/postings/${jobId}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { id: string; name: string; company?: { name?: string }; location?: { fullLocation?: string; remote?: boolean }; releasedDate?: string };
    return {
      companyId: null,
      company: j.company?.name ?? board,
      ats,
      externalId: `${board}:${j.id}`,
      title: j.name,
      location: j.location?.fullLocation ?? "",
      workplace: j.location?.remote ? "remote" : classifyWorkplace(j.location?.fullLocation),
      url,
      applyUrl: url,
      description,
      postedAt: j.releasedDate,
      sponsorsVisa: sponsorshipSignal(description),
    };
  }
  return null;
}

interface LdPosting {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } } | { address?: unknown }[];
  jobLocationType?: string;
  datePosted?: string;
  employmentType?: string | string[];
  identifier?: { value?: string } | string;
}

function fromJsonLd(html: string, url: string): JobInput | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes: LdPosting[] = (Array.isArray(data) ? data : [(data as { "@graph"?: unknown[] })["@graph"] ?? data]).flat() as LdPosting[];
    const p = nodes.find((n) => n && (n["@type"] === "JobPosting" || (Array.isArray(n["@type"]) && n["@type"].includes("JobPosting"))));
    if (!p?.title) continue;
    const locs = (Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation]).filter(Boolean) as { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } }[];
    const location = locs
      .map((l) => {
        const a = l.address ?? {};
        const country = typeof a.addressCountry === "string" ? a.addressCountry : a.addressCountry?.name;
        return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(", ");
      })
      .filter(Boolean)
      .join(" / ");
    const description = htmlToText(p.description ?? "");
    const ats = detectAtsFromPage(url, html);
    return {
      companyId: null,
      company: typeof p.hiringOrganization === "string" ? p.hiringOrganization : (p.hiringOrganization?.name ?? hostCompany(url)),
      ats,
      externalId: `url:${url}`,
      title: decodeEntities(p.title),
      location,
      workplace: p.jobLocationType === "TELECOMMUTE" ? "remote" : classifyWorkplace(location),
      employmentType: Array.isArray(p.employmentType) ? p.employmentType.join(", ") : p.employmentType,
      url,
      applyUrl: applyPageUrl(ats, url),
      description,
      salary: extractSalary(description),
      postedAt: p.datePosted,
      sponsorsVisa: sponsorshipSignal(description),
    };
  }
  return null;
}

const ExtractSchema = z.object({
  is_job_posting: z.boolean(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  description: z.string().describe("The full job description, cleaned of navigation and boilerplate, as plain text"),
});

async function llmExtract(url: string, pageText: string) {
  const out = await structured({
    system: "You extract job postings from raw web page text. Copy the description faithfully; do not summarize or invent details.",
    effort: "low",
    schema: ExtractSchema,
    prompt: `URL: ${url}\n\n<page_text>\n${truncate(pageText, 30000)}\n</page_text>`,
  });
  // "Not a job" is an answer, not a failure: the caller must not fall back to treating the page as one.
  return out.is_job_posting ? out : null;
}

export class NotAJobPosting extends Error {}

/** Without the model: does the page text read like a job posting (several of the usual sections or phrases)? */
export function looksLikePosting(text: string): boolean {
  const signals = [
    /responsibilit/i,
    /qualifications?|requirements/i,
    /apply|application/i,
    /job description|about the (role|job|position)|the role/i,
    /what you('|’)ll (do|bring)|you will/i,
    /years of (professional |relevant )?experience/i,
    /full[- ]time|part[- ]time|contract|internship/i,
    /benefits|salary|compensation|pay range|equity/i,
    /we('|’)re (hiring|looking for)|join (our|the) team/i,
  ];
  return text.length >= 400 && signals.filter((re) => re.test(text)).length >= 3;
}

/** URL first, then markers in the page for career sites on the company's own domain. */
export function detectAtsFromPage(url: string, html = ""): string {
  const byUrl = detectAts(url);
  if (byUrl !== "unknown") return byUrl;
  if (/rmkcdn\.successfactors\.com|jobs2web|career\d*\.successfactors\./i.test(html)) return "successfactors";
  if (/\.icims\.com/i.test(html)) return "icims";
  if (/\.taleo\.net/i.test(html)) return "taleo";
  if (/myworkdayjobs\.com|myworkdaysite\.com/i.test(html)) return "workday";
  if (/oraclecloud\.com\/hcmUI\/CandidateExperience/i.test(html)) return "oraclecloud";
  return "unknown";
}

/** schema.org JobPosting as microdata (itemprop=…), used by SuccessFactors career sites and many others. */
function fromMicrodata(html: string, url: string): JobInput | null {
  if (!/itemtype=["']https?:\/\/schema\.org\/JobPosting/i.test(html) && !/itemprop=["']title["']/i.test(html)) return null;
  const prop = (name: string) => microdataProp(html, name);
  const title = decodeEntities(htmlToText(prop("title"))).trim();
  if (!title) return null;
  const description = htmlToText(prop("description"));
  const location = [prop("addressLocality"), prop("addressRegion"), prop("addressCountry")].map((x) => decodeEntities(htmlToText(x)).trim()).filter(Boolean).join(", ");
  const org = decodeEntities(htmlToText(prop("hiringOrganization"))).trim();
  const ats = detectAtsFromPage(url, html);
  return {
    companyId: null,
    company: org && org.length < 80 ? org : hostCompany(url),
    ats,
    externalId: `url:${url}`,
    title,
    location,
    workplace: classifyWorkplace(location),
    url,
    applyUrl: applyPageUrl(ats, url),
    description,
    salary: extractSalary(description),
    postedAt: prop("datePosted") || undefined,
    sponsorsVisa: sponsorshipSignal(description),
  };
}

// ---------- LinkedIn ----------
// LinkedIn shows the company's own apply link only to signed-in members, and Ferry never uses a LinkedIn login.
// So: read the one public posting the user pasted, then look for the same role among the jobs Ferry already
// watches on the company's ATS. Found → apply there. Not found → the job is kept with LinkedIn as its source,
// and applying hands it back with what to do.

export const linkedInJobId = (url: string) => url.match(/currentJobId=(\d{6,})/)?.[1] ?? url.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/)?.[1] ?? null;

const tagText = (html: string, cls: string) => {
  const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:a|h1|h2|h3|span|div)>`, "i"));
  return m ? decodeEntities(htmlToText(m[1])).trim() : "";
};

async function resolveLinkedIn(url: string, input: CapturedJob): Promise<Job> {
  const id = linkedInJobId(url);
  let html = "";
  if (id) {
    try {
      const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, { headers: { "User-Agent": UA, "Accept-Language": "en-US" }, signal: AbortSignal.timeout(15000) });
      if (res.ok) html = await res.text();
      else console.warn(`[linkedin] posting ${id}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[linkedin] posting ${id}: ${(e as Error).message}`); // fall back to what the user or extension gave us
    }
  }
  const title = tagText(html, "topcard__title") || input.title || "LinkedIn job";
  const company = tagText(html, "topcard__org-name-link") || input.company || "";
  const location = tagText(html, "topcard__flavor--bullet") || input.location || "";
  const descM = html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const description = descM ? htmlToText(descM[1]) : (input.description ?? "");
  const easyApply = Boolean(html) && !/offsite-apply/.test(html);

  // Same role on the company's own ATS, from the boards Ferry watches?
  if (company) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const want = new Set(norm(title).split(" "));
    const rows = all<{ id: string; title: string }>("SELECT id, title FROM jobs WHERE closed_at IS NULL AND ats != 'linkedin' AND lower(company) = lower(?) LIMIT 400", company);
    let best: { id: string; s: number } | null = null;
    for (const r of rows) {
      const have = new Set(norm(r.title).split(" "));
      let inter = 0;
      for (const w of want) if (have.has(w)) inter++;
      const s = inter / Math.max(want.size, have.size);
      if (s >= 0.8 && (!best || s > best.s)) best = { id: r.id, s };
    }
    if (best) return getJob(best.id)!;
  }

  return upsertJob({
    companyId: null,
    company: company || "Unknown company",
    ats: "linkedin",
    externalId: `linkedin:${id ?? url}`,
    title,
    location,
    workplace: classifyWorkplace(location, description.slice(0, 2000)),
    url,
    applyUrl: url,
    description: easyApply ? `${description}\n\n[LinkedIn Easy Apply]` : description,
    salary: extractSalary(description),
    sponsorsVisa: sponsorshipSignal(description),
  }).job;
}
