import { z } from "zod";
import { applyPageUrl, detectAts, parseJobUrl } from "../ats.ts";
import { one } from "../db.ts";
import { structured, withFallback } from "../llm.ts";
import { getJob, upsertJob, type JobInput } from "../store.ts";
import type { Job } from "../types.ts";
import { classifyWorkplace, decodeEntities, htmlToText, sponsorshipSignal, truncate } from "../util/text.ts";
import { extractSalary, FETCHERS, smartrecruitersDescription, workdayParts } from "./sources.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export interface CapturedJob {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}

/**
 * Resolve any job URL (or a job captured by the browser extension) into a stored Job.
 * Order: ATS public API → schema.org JobPosting JSON-LD → page text (+ LLM extraction).
 */
export async function resolveJob(input: CapturedJob): Promise<Job> {
  const url = input.url.trim();
  const found = one<{ id: string }>("SELECT id FROM jobs WHERE url = ? OR apply_url = ?", url, url);
  if (found) return getJob(found.id)!;
  const viaApi = await fromAtsApi(url).catch(() => null);
  if (viaApi) return upsertJob(viaApi).job;

  let html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    html = await res.text();
  } catch {
    /* page may block bots; fall back to whatever the extension captured */
  }
  const ld = html ? fromJsonLd(html, url) : null;
  if (ld && (ld.description.length > 200 || !input.description)) return upsertJob(mergeCaptured(ld, input)).job;

  const pageText = input.description?.trim() || (html ? htmlToText(html.replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, "")) : "");
  const titleTag = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const extracted = await withFallback(
    "jd-extract",
    () => llmExtract(url, pageText),
    () => ({ title: input.title || titleTag.split(/[|\-–]/)[0].trim() || "Untitled role", company: input.company || hostCompany(url), location: input.location ?? "", description: pageText }),
  );
  const ats = detectAts(url);
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
      applyUrl: j.absolute_url,
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
    const ats = detectAts(url);
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
  if (!out.is_job_posting) throw new Error("not a job posting");
  return out;
}
