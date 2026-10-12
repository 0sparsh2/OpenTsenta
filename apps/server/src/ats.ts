// ATS detection by URL. The table follows the shape recovered from the reference dashboard's
// `ats` chunk (id, name, urlPatterns, supported) — see docs/RESEARCH.md §3.

export interface AtsInfo {
  id: string;
  name: string;
  urlPatterns: string[];
  /** We can discover jobs from a public JSON API for this ATS. */
  discovery: boolean;
  /** The apply engine has a tuned adapter; everything else uses the generic form agent. */
  tuned: boolean;
}

export const ATS_LIST: AtsInfo[] = [
  { id: "greenhouse", name: "Greenhouse", urlPatterns: ["greenhouse.io", "gh_jid=", "greenhouse_jid="], discovery: true, tuned: true },
  { id: "lever", name: "Lever", urlPatterns: ["lever.co"], discovery: true, tuned: true },
  { id: "ashby", name: "Ashby", urlPatterns: ["ashbyhq.com", "ashby_jid="], discovery: true, tuned: true },
  { id: "smartrecruiters", name: "SmartRecruiters", urlPatterns: ["smartrecruiters.com"], discovery: true, tuned: false },
  { id: "recruitee", name: "Recruitee", urlPatterns: [".recruitee.com"], discovery: true, tuned: false },
  { id: "workday", name: "Workday", urlPatterns: ["myworkdayjobs.com", "myworkdaysite.com", "workday.com"], discovery: true, tuned: true },
  { id: "rippling", name: "Rippling", urlPatterns: ["rippling-ats.com", "ats.rippling.com"], discovery: false, tuned: false },
  { id: "icims", name: "iCIMS", urlPatterns: ["icims.com", "jibeapply.com"], discovery: true, tuned: false },
  { id: "bamboohr", name: "BambooHR", urlPatterns: [".bamboohr.com"], discovery: false, tuned: false },
  { id: "workable", name: "Workable", urlPatterns: ["workable.com"], discovery: true, tuned: false },
  { id: "jazzhr", name: "JazzHR", urlPatterns: [".applytojob.com"], discovery: false, tuned: false },
  { id: "jobvite", name: "Jobvite", urlPatterns: ["jobvite.com"], discovery: false, tuned: false },
  { id: "breezyhr", name: "BreezyHR", urlPatterns: [".breezy.hr"], discovery: false, tuned: false },
  { id: "taleo", name: "Taleo", urlPatterns: ["taleo.net"], discovery: true, tuned: false },
  { id: "oraclecloud", name: "Oracle Recruiting", urlPatterns: [".oraclecloud.com"], discovery: true, tuned: false },
  { id: "paylocity", name: "Paylocity", urlPatterns: [".paylocity.com/recruiting"], discovery: false, tuned: false },
  { id: "ultipro", name: "UKG", urlPatterns: ["recruiting.ultipro.com", "recruiting2.ultipro.com", ".rec.pro.ukg.net"], discovery: false, tuned: false },
  { id: "successfactors", name: "SAP SuccessFactors", urlPatterns: [".successfactors.com", ".successfactors.eu", ".sapsf.com", "jobs.hr.cloud.sap"], discovery: true, tuned: false },
  { id: "teamtailor", name: "Teamtailor", urlPatterns: [".teamtailor.com"], discovery: false, tuned: false },
  { id: "pinpoint", name: "Pinpoint", urlPatterns: [".pinpointhq.com"], discovery: false, tuned: false },
  { id: "dover", name: "Dover", urlPatterns: ["app.dover.com/apply/"], discovery: false, tuned: false },
  { id: "gem", name: "Gem", urlPatterns: ["jobs.gem.com"], discovery: false, tuned: false },
  { id: "dayforce", name: "Dayforce", urlPatterns: ["dayforcehcm.com"], discovery: false, tuned: false },
  { id: "zohorecruit", name: "Zoho Recruit", urlPatterns: [".zohorecruit."], discovery: false, tuned: false },
  { id: "adp", name: "ADP", urlPatterns: ["workforcenow.adp.com"], discovery: false, tuned: false },
  { id: "linkedin", name: "LinkedIn", urlPatterns: ["linkedin.com/jobs", "linkedin.com/comm/jobs"], discovery: false, tuned: false },
  { id: "mock", name: "Mock ATS", urlPatterns: ["/mock-ats/"], discovery: false, tuned: false },
];

export function detectAts(url: string): string {
  const u = url.toLowerCase();
  for (const a of ATS_LIST) if (a.urlPatterns.some((p) => u.includes(p))) return a.id;
  return "unknown";
}

export const atsName = (id: string) => ATS_LIST.find((a) => a.id === id)?.name ?? (id === "unknown" ? "Company site" : id);

/** Parse a posting URL into the identifiers its public API needs. */
export function parseJobUrl(raw: string): { ats: string; board?: string; jobId?: string } {
  const ats = detectAts(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ats };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (ats === "greenhouse") {
    // boards.greenhouse.io/{board}/jobs/{id} | job-boards.greenhouse.io/{board}/jobs/{id} | ?gh_jid={id}&for={board}
    const ghJid = url.searchParams.get("gh_jid") ?? url.searchParams.get("token");
    const board = url.searchParams.get("for") ?? (parts[0] !== "embed" ? parts[0] : undefined);
    const i = parts.indexOf("jobs");
    return { ats, board, jobId: i >= 0 ? parts[i + 1] : (ghJid ?? undefined) };
  }
  if (ats === "lever") return { ats, board: parts[0], jobId: parts[1] };
  if (ats === "ashby") return { ats, board: parts[0], jobId: parts[1] };
  if (ats === "smartrecruiters") return { ats, board: parts[0], jobId: parts[1]?.split("-")[0] };
  if (ats === "workday") {
    // https://{host}/{locale?}/{site}/job/... → board "{host}|{site}"
    const segs = parts.filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    const jobIdx = segs.indexOf("job");
    const site = jobIdx > 0 ? segs[jobIdx - 1] : segs[0];
    return { ats, board: site ? `${url.host}|${site}` : undefined, jobId: jobIdx >= 0 ? `/${segs.slice(jobIdx).join("/")}` : undefined };
  }
  if (ats === "workable") {
    // https://apply.workable.com/{account}/j/{shortcode}/
    const j = parts.indexOf("j");
    return { ats, board: url.host.startsWith("apply.") ? parts[0] : url.host.split(".")[0], jobId: j >= 0 ? parts[j + 1] : undefined };
  }
  return { ats };
}

/** URL of the actual application form for a posting. */
export function applyPageUrl(ats: string, jobUrl: string, applyUrl?: string): string {
  if (ats === "lever") return jobUrl.replace(/\/apply\/?$/, "").replace(/\/$/, "") + "/apply";
  if (ats === "ashby") return jobUrl.replace(/\/application\/?$/, "").replace(/\/$/, "") + "/application";
  // SuccessFactors career sites: "Apply now" opens a dialog whose link is /talentcommunity/apply/<id>/; go straight there.
  if (ats === "successfactors") {
    const m = jobUrl.match(/^(https?:\/\/[^/]+)\/job\/[^?#]*?\/(\d{6,})\/?/);
    if (m) return `${m[1]}/talentcommunity/apply/${m[2]}/?locale=en_US`;
  }
  // Prefer Greenhouse's own form over a company site that wraps it.
  if (ats === "greenhouse") return applyUrl && /greenhouse\.io\//.test(applyUrl) ? applyUrl : jobUrl;
  return applyUrl || jobUrl;
}
