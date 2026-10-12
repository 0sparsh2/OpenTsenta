import { run } from "../db.ts";
import { getJob } from "../store.ts";
import type { Job } from "../types.ts";
import { extractSalary } from "./sources.ts";
import { fetchDescription } from "./sources.ts";
import { sponsorshipSignal } from "../util/text.ts";

/** Make sure a job has its description (some ATS list APIs omit it). Returns the up-to-date job. */
export async function ensureDescription(job: Job): Promise<Job> {
  if (job.description || !["smartrecruiters", "workday", "workable"].includes(job.ats)) return job;
  const d = await fetchDescription(job.ats, job.externalId).catch(() => "");
  if (!d) return job;
  run("UPDATE jobs SET description = ?, salary = COALESCE(salary, ?), sponsors_visa = COALESCE(sponsors_visa, ?) WHERE id = ?", d, extractSalary(d) ?? null, (() => {
    const v = sponsorshipSignal(d);
    return v == null ? null : v ? 1 : 0;
  })(), job.id);
  return getJob(job.id)!;
}
