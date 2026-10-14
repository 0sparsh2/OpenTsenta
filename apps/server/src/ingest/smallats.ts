import type { JobInput } from "../store.ts";
import { classifyWorkplace, htmlToText } from "../util/text.ts";

// Discovery for smaller ATSes that publish an unauthenticated JSON job list behind each company's careers page:
// BambooHR, Rippling, Pinpoint and Breezy HR. Boards are the company's subdomain (or Rippling board slug).
// Descriptions come with the list for Pinpoint, and are fetched lazily for the others.

const UA = "Mozilla/5.0 (compatible; FerryJobWatcher/0.1; +https://github.com/)";
const MAX = Number(process.env.SMALL_ATS_MAX_JOBS ?? 300);

export interface SmallRef {
  id: string | null;
  name: string;
  board: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}
const iso = (s?: string | null) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${Math.round(n).toLocaleString("en-US")}`;
const range = (min?: number | null, max?: number | null, cur?: string | null, per?: string | null) =>
  min && max ? `${money(min, cur ?? "USD")} - ${money(max, cur ?? "USD")}${per && !/year|annual/i.test(per) ? ` per ${per.toLowerCase().replace(/ly$/, "")}` : ""}` : undefined;

// ---------- BambooHR: https://{board}.bamboohr.com/careers ----------
interface BambooJob {
  id: string;
  jobOpeningName: string;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  location?: { city?: string | null; state?: string | null } | null;
  atsLocation?: { city?: string | null; state?: string | null; country?: string | null } | null;
  isRemote?: boolean | null;
  /** "0" on-site, "1" remote, "2" hybrid */
  locationType?: string | null;
}
async function bamboohr(c: SmallRef): Promise<JobInput[]> {
  const d = await getJson<{ result?: BambooJob[] }>(`https://${c.board}.bamboohr.com/careers/list`);
  return (d.result ?? []).slice(0, MAX).map((j) => {
    const location = [j.location?.city ?? j.atsLocation?.city, j.location?.state ?? j.atsLocation?.state, j.atsLocation?.country].filter(Boolean).join(", ");
    const url = `https://${c.board}.bamboohr.com/careers/${j.id}`;
    return {
      companyId: c.id,
      company: c.name,
      ats: "bamboohr",
      externalId: `${c.board}:${j.id}`,
      title: (j.jobOpeningName ?? "").trim(),
      location,
      workplace: j.isRemote || j.locationType === "1" ? "remote" : j.locationType === "2" ? "hybrid" : classifyWorkplace(location),
      department: j.departmentLabel ?? undefined,
      employmentType: j.employmentStatusLabel ?? undefined,
      url,
      applyUrl: url,
      description: "",
      sponsorsVisa: null,
    };
  });
}
async function bamboohrDescription(externalId: string): Promise<string> {
  const [board, id] = externalId.split(":");
  const d = await getJson<{ result?: { jobOpening?: { description?: string; compensation?: string | null } } }>(`https://${board}.bamboohr.com/careers/${id}/detail`);
  const o = d.result?.jobOpening;
  return htmlToText(`${o?.description ?? ""}${o?.compensation ? `\n\nCompensation: ${o.compensation}` : ""}`);
}

// ---------- Rippling: https://ats.rippling.com/{board}/jobs ----------
interface RipplingJob {
  uuid: string;
  name: string;
  department?: { label?: string } | null;
  url: string;
  workLocation?: { label?: string } | null;
}
async function rippling(c: SmallRef): Promise<JobInput[]> {
  const list = await getJson<RipplingJob[]>(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(c.board)}/jobs`);
  // One row per location: keep one per posting.
  const seen = new Map<string, JobInput>();
  for (const j of list) {
    const prev = seen.get(j.uuid);
    const loc = j.workLocation?.label ?? "";
    if (prev) {
      if (loc && !prev.location.includes(loc)) prev.location = `${prev.location} / ${loc}`;
      continue;
    }
    if (seen.size >= MAX) break;
    seen.set(j.uuid, {
      companyId: c.id,
      company: c.name,
      ats: "rippling",
      externalId: `${c.board}:${j.uuid}`,
      title: (j.name ?? "").trim(),
      location: loc,
      workplace: classifyWorkplace(loc),
      department: j.department?.label,
      url: j.url,
      applyUrl: j.url,
      description: "",
      sponsorsVisa: null,
    });
  }
  return [...seen.values()];
}
async function ripplingDescription(externalId: string): Promise<string> {
  const [board, uuid] = externalId.split(":");
  const d = await getJson<{ description?: string | Record<string, string>; payRangeDetails?: { currency?: string; frequency?: string; rangeStart?: number; rangeEnd?: number }[] }>(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs/${uuid}`,
  );
  const body = typeof d.description === "string" ? d.description : Object.values(d.description ?? {}).join("\n");
  const pay = d.payRangeDetails?.[0];
  const salary = pay ? range(pay.rangeStart, pay.rangeEnd, pay.currency, pay.frequency) : undefined;
  return htmlToText(`${body}${salary ? `\n\nPay range: ${salary}` : ""}`);
}

// ---------- Pinpoint: https://{board}.pinpointhq.com ----------
interface PinpointJob {
  id: string;
  title: string;
  url: string;
  description?: string;
  key_responsibilities?: string;
  key_responsibilities_header?: string;
  skills_knowledge_expertise?: string;
  skills_knowledge_expertise_header?: string;
  benefits?: string;
  benefits_header?: string;
  employment_type_text?: string;
  workplace_type?: string;
  compensation_minimum?: number | null;
  compensation_maximum?: number | null;
  compensation_currency?: string | null;
  compensation_frequency?: string | null;
  compensation_visible?: boolean;
  location?: { city?: string; name?: string; province?: string } | null;
  job?: { department?: { name?: string } } | null;
}
async function pinpoint(c: SmallRef): Promise<JobInput[]> {
  const d = await getJson<{ data?: PinpointJob[] }>(`https://${c.board}.pinpointhq.com/postings.json`);
  return (d.data ?? []).slice(0, MAX).map((j) => {
    const section = (head: string | undefined, html: string | undefined) => (html ? `${head ? `<h3>${head}</h3>` : ""}${html}` : "");
    const description = htmlToText(
      [j.description, section(j.key_responsibilities_header, j.key_responsibilities), section(j.skills_knowledge_expertise_header, j.skills_knowledge_expertise), section(j.benefits_header, j.benefits)].filter(Boolean).join("\n"),
    );
    const location = j.location?.name ?? [j.location?.city, j.location?.province].filter(Boolean).join(", ");
    return {
      companyId: c.id,
      company: c.name,
      ats: "pinpoint",
      externalId: `${c.board}:${j.id}`,
      title: (j.title ?? "").trim(),
      location,
      workplace: j.workplace_type === "remote" ? "remote" : j.workplace_type === "hybrid" ? "hybrid" : j.workplace_type === "onsite" ? "onsite" : classifyWorkplace(location),
      department: j.job?.department?.name,
      employmentType: j.employment_type_text,
      url: j.url,
      applyUrl: j.url,
      description,
      salary: j.compensation_visible ? range(j.compensation_minimum, j.compensation_maximum, j.compensation_currency, j.compensation_frequency) : undefined,
      sponsorsVisa: null,
    };
  });
}

// ---------- Breezy HR: https://{board}.breezy.hr ----------
interface BreezyJob {
  id: string;
  friendly_id: string;
  name: string;
  url: string;
  published_date?: string;
  type?: { name?: string } | null;
  location?: { city?: string; state?: { name?: string }; country?: { name?: string }; is_remote?: boolean } | null;
  department?: string | null;
  salary?: string | null;
}
async function breezyhr(c: SmallRef): Promise<JobInput[]> {
  const list = await getJson<BreezyJob[]>(`https://${c.board}.breezy.hr/json`);
  return list.slice(0, MAX).map((j) => {
    const location = [j.location?.city, j.location?.state?.name, j.location?.country?.name].filter(Boolean).join(", ");
    return {
      companyId: c.id,
      company: c.name,
      ats: "breezyhr",
      externalId: `${c.board}:${j.friendly_id}`,
      title: (j.name ?? "").trim(),
      location,
      workplace: j.location?.is_remote ? "remote" : classifyWorkplace(location),
      department: j.department ?? undefined,
      employmentType: j.type?.name,
      url: j.url,
      applyUrl: `${j.url.replace(/\/$/, "")}/apply`,
      description: "",
      salary: j.salary || undefined,
      postedAt: iso(j.published_date),
      sponsorsVisa: null,
    };
  });
}
async function breezyDescription(externalId: string): Promise<string> {
  const [board, friendly] = externalId.split(":");
  const res = await fetch(`https://${board}.breezy.hr/p/${friendly}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`${res.status} for breezy ${externalId}`);
  const html = await res.text();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1].trim()) as { "@type"?: string; description?: string };
      if (d["@type"] === "JobPosting" && d.description) return htmlToText(d.description);
    } catch {
      /* not JSON */
    }
  }
  const div = html.match(/<div class="description"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1];
  return div ? htmlToText(div) : "";
}

export const SMALL_FETCHERS = { bamboohr, rippling, pinpoint, breezyhr };
/** ATSes here whose list omits descriptions. */
export const SMALL_LAZY = ["bamboohr", "rippling", "breezyhr"];

export async function smallDescription(ats: string, externalId: string): Promise<string | null> {
  if (ats === "bamboohr") return bamboohrDescription(externalId);
  if (ats === "rippling") return ripplingDescription(externalId);
  if (ats === "breezyhr") return breezyDescription(externalId);
  return null;
}
