import { config } from "../config.ts";
import { all, now, run } from "../db.ts";
import { broadcast } from "../bus.ts";
import { upsertJob } from "../store.ts";
import { matchNewJobs } from "../match/score.ts";
import { FETCHERS } from "./sources.ts";
import { listCompanies, type CompanyRow } from "./companies.ts";

let running = false;
let lastRun: { at: string; newJobs: number; companies: number; errors: number } | null = null;
export const pollerStatus = () => ({ running, lastRun, intervalMin: config.pollIntervalMin });

async function pollCompany(c: CompanyRow): Promise<string[]> {
  const fetcher = FETCHERS[c.ats];
  if (!fetcher) return [];
  try {
    const jobs = await fetcher({ id: c.id, name: c.name, ats: c.ats, board: c.board });
    const fresh: string[] = [];
    for (const j of jobs) {
      const { job, isNew } = upsertJob(j);
      if (isNew) fresh.push(job.id);
    }
    // Anything from this board missing from this pass has been taken down.
    const live = new Set(jobs.map((j) => j.externalId));
    for (const r of all<{ id: string; external_id: string }>("SELECT id, external_id FROM jobs WHERE company_id = ? AND closed_at IS NULL", c.id)) {
      if (!live.has(r.external_id)) run("UPDATE jobs SET closed_at = ? WHERE id = ?", now(), r.id);
    }
    run("UPDATE companies SET last_polled_at = ?, last_error = NULL, job_count = ? WHERE id = ?", now(), jobs.length, c.id);
    return fresh;
  } catch (e) {
    run("UPDATE companies SET last_polled_at = ?, last_error = ? WHERE id = ?", now(), String((e as Error).message).slice(0, 300), c.id);
    return [];
  }
}

export async function pollAll(opts: { onlyIds?: string[] } = {}) {
  if (running) return pollerStatus();
  running = true;
  const companies = listCompanies().filter((c) => c.active && (!opts.onlyIds || opts.onlyIds.includes(c.id)));
  const fresh: string[] = [];
  const queue = [...companies];
  const firstPoll = all("SELECT 1 FROM jobs LIMIT 1").length === 0;
  try {
    await Promise.all(
      Array.from({ length: config.pollConcurrency }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) fresh.push(...(await pollCompany(c)));
      }),
    );
    const errors = listCompanies().filter((c) => c.active && c.last_error).length;
    lastRun = { at: now(), newJobs: fresh.length, companies: companies.length, errors };
    broadcast({ type: "jobs:polled", newJobs: fresh.length, companies: companies.length });
    console.log(`[poller] ${companies.length} boards, ${fresh.length} new jobs, ${errors} errors`);
    // On the very first poll every job is "new"; users get a full rematch on onboarding instead.
    if (!firstPoll) await matchNewJobs(fresh);
  } finally {
    running = false;
  }
  return pollerStatus();
}

export function startPoller() {
  if (config.pollOnBoot) setTimeout(() => void pollAll(), 1500);
  setInterval(() => void pollAll(), config.pollIntervalMin * 60_000).unref();
}
