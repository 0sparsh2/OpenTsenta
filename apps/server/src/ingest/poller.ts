import { config } from "../config.ts";
import { all, now, one, reclaimSpace, run, tx } from "../db.ts";
import { broadcast } from "../bus.ts";
import { ingestJob, type JobInput } from "../store.ts";
import { matchNewJobs } from "../match/score.ts";
import { FETCHERS } from "./sources.ts";
import { listCompanies, type CompanyRow } from "./companies.ts";
import { invalidateLocations } from "./locations.ts";

// Thousands of boards: each has its own schedule. Single-request boards (Greenhouse, Lever, Ashby…) are polled every
// interval; boards that page through results (Workday, iCIMS, Oracle…) less often; failing boards back off.

let running = false;
let lastRun: { at: string; newJobs: number; companies: number; errors: number; purged: number } | null = null;
export const pollerStatus = () => ({ running, lastRun, intervalMin: config.pollIntervalMin, heavyIntervalMin: config.pollHeavyIntervalMin });

const HEAVY = new Set(["workday", "icims", "oraclecloud", "successfactors", "taleo", "smartrecruiters"]);
const intervalMin = (c: CompanyRow) => (HEAVY.has(c.ats) ? config.pollHeavyIntervalMin : config.pollIntervalMin);
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** At most this many boards of one ATS at a time, so no single provider gets hammered (and rate-limits us). */
const PER_ATS: Record<string, number> = { workday: 4, workable: 2, smartrecruiters: 3, icims: 3, oraclecloud: 3, successfactors: 2, taleo: 2 };
const inFlight = new Map<string, number>();

/** Fetch with one retry after a pause when the provider is busy (429) or slow (timeout). */
async function fetchBoard(c: CompanyRow) {
  const fetcher = FETCHERS[c.ats];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetcher({ id: c.id, name: c.name, ats: c.ats, board: c.board });
    } catch (e) {
      const msg = String((e as Error).message);
      if (attempt >= 1 || !/429|timeout|aborted|ECONNRESET|fetch failed/i.test(msg)) throw e;
      await sleep(5000 + Math.random() * 5000);
    }
  }
}

async function pollCompany(c: CompanyRow): Promise<{ fresh: string[]; firstTime: boolean }> {
  const fetcher = FETCHERS[c.ats];
  const firstTime = !c.last_polled_at;
  if (!fetcher) return { fresh: [], firstTime };
  try {
    const jobs = (await fetchBoard(c)).filter((j) => j.title);
    const fresh: string[] = [];
    const cutoff = new Date(Date.now() - config.jobRetentionDays * 86400_000).toISOString();
    const seen = now();
    // Small transactions with a pause between them: other boards' requests keep flowing (a long synchronous write
    // starves them until their timeouts fire), and each batch still commits at once.
    for (let i = 0; i < jobs.length; i += 200) {
      tx(() => {
        for (const j of jobs.slice(i, i + 200)) {
          if (!keep(j, cutoff, seen)) continue;
          const r = ingestJob(j);
          if (r.isNew) fresh.push(r.id);
        }
      });
      await sleep(0);
    }
    // Anything from this board missing from this pass has been taken down (and leaves the location counts).
    const live = new Set(jobs.map((j) => j.externalId));
    tx(() => {
      for (const r of all<{ id: string; external_id: string }>("SELECT id, external_id FROM jobs WHERE company_id = ? AND closed_at IS NULL", c.id)) {
        if (live.has(r.external_id)) continue;
        run("UPDATE jobs SET closed_at = ? WHERE id = ?", now(), r.id);
        run("DELETE FROM job_places WHERE job_id = ?", r.id);
      }
    });
    run("UPDATE companies SET last_polled_at = ?, last_error = NULL, job_count = ?, fail_count = 0, next_poll_at = ? WHERE id = ?", now(), jobs.length, at(intervalMin(c)), c.id);
    return { fresh, firstTime };
  } catch (e) {
    // Back off: 2×, 4×, 8×… the usual interval, at most two days.
    const fails = (c.fail_count ?? 0) + 1;
    const wait = Math.min(2880, intervalMin(c) * 2 ** fails);
    const msg = String((e as Error).message).slice(0, 300);
    // A board that's gone (404 three polls running) is retired, not retried forever; Settings → Career pages can revive it.
    const gone = /^(404|410)\b/.test(msg) && fails >= 3;
    run("UPDATE companies SET last_polled_at = ?, last_error = ?, fail_count = ?, next_poll_at = ?, active = ? WHERE id = ?", now(), gone ? `Retired: ${msg}` : msg, fails, at(wait), gone ? 0 : 1, c.id);
    return { fresh: [], firstTime };
  }
}

/**
 * Recent jobs only (a week by default): a job posted more than JOB_RETENTION_DAYS ago isn't stored. A job with no posting date is a
 * "dropped" tombstone once it's been listed that long, so its board can't bring it back as new.
 */
export function keep(j: JobInput, cutoff: string, seen: string): boolean {
  if (j.postedAt && j.postedAt < cutoff) return false;
  if (one("SELECT 1 FROM job_tombstones WHERE ats = ? AND external_id = ?", j.ats, j.externalId)) {
    run("UPDATE job_tombstones SET last_seen = ? WHERE ats = ? AND external_id = ?", seen, j.ats, j.externalId);
    return false;
  }
  return true;
}

const KEEP_IF_YOURS = "id NOT IN (SELECT job_id FROM applications) AND id NOT IN (SELECT job_id FROM matches WHERE status != 'new')";

/**
 * Delete jobs past the retention period (and closed jobs after a couple of days), except ones you applied to, saved,
 * or skipped. In batches with pauses, so the server keeps answering while a big backlog clears.
 */
export async function sweepOldJobs(): Promise<number> {
  const openCutoff = new Date(Date.now() - config.jobRetentionDays * 86400_000).toISOString();
  const seen = now();
  let total = 0;
  for (const [sql, args] of [
    [`SELECT id, ats, external_id, posted_at FROM jobs WHERE closed_at IS NULL AND COALESCE(posted_at, first_seen_at) < ? AND ${KEEP_IF_YOURS} LIMIT 250`, [openCutoff]],
    [`SELECT id, ats, external_id, posted_at FROM jobs WHERE closed_at IS NOT NULL AND closed_at < datetime('now', ?) AND ${KEEP_IF_YOURS} LIMIT 250`, [`-${config.closedJobRetentionDays} days`]],
  ] as const) {
    for (;;) {
      const rows = all<{ id: string; ats: string; external_id: string; posted_at: string | null }>(sql, ...args);
      if (!rows.length) break;
      const open = sql.includes("closed_at IS NULL");
      tx(() => {
        for (const r of rows) {
          // Still listed but undated: remember it, or the next poll re-adds it as new.
          if (open && !r.posted_at) run("INSERT OR REPLACE INTO job_tombstones(ats, external_id, last_seen) VALUES(?,?,?)", r.ats, r.external_id, seen);
          run("DELETE FROM jobs WHERE id = ?", r.id);
        }
      });
      total += rows.length;
      await sleep(10);
    }
  }
  if (total) reclaimSpace();
  // Tombstones for jobs no board has listed in a month aren't needed.
  run("DELETE FROM job_tombstones WHERE last_seen < ?", new Date(Date.now() - 30 * 86400_000).toISOString());
  return total;
}

/** Poll the boards that are due (or the given ones, or all with force). */
export async function pollAll(opts: { onlyIds?: string[]; force?: boolean } = {}) {
  if (running) return pollerStatus();
  running = true;
  const due = now();
  const t0 = Date.now();
  const companies = listCompanies().filter((c) => c.active && (opts.onlyIds ? opts.onlyIds.includes(c.id) : opts.force || !c.next_poll_at || c.next_poll_at <= due));
  const fresh: string[] = [];
  const seeded: string[] = [];
  const queue = [...companies];
  const firstPoll = all("SELECT 1 FROM jobs LIMIT 1").length === 0;
  try {
    await Promise.all(
      Array.from({ length: config.pollConcurrency }, async () => {
        while (queue.length) {
          // The next board whose ATS has room; if none, wait for one to finish.
          const i = queue.findIndex((c) => (inFlight.get(c.ats) ?? 0) < (PER_ATS[c.ats] ?? config.pollConcurrency));
          if (i < 0) {
            await sleep(250);
            continue;
          }
          const [c] = queue.splice(i, 1);
          inFlight.set(c.ats, (inFlight.get(c.ats) ?? 0) + 1);
          try {
            const r = await pollCompany(c);
            (r.firstTime ? seeded : fresh).push(...r.fresh);
          } finally {
            inFlight.set(c.ats, (inFlight.get(c.ats) ?? 1) - 1);
          }
          await sleep(0); // let requests and timers run between boards
        }
      }),
    );
    const errors = all<{ n: number }>("SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND last_error IS NOT NULL")[0]?.n ?? 0;
    const purged = await sweepOldJobs();
    invalidateLocations();
    lastRun = { at: now(), newJobs: fresh.length, companies: companies.length, errors, purged };
    broadcast({ type: "jobs:polled", newJobs: fresh.length, companies: companies.length });
    console.log(`[poller] ${companies.length} boards due, ${fresh.length} new jobs, ${seeded.length} from newly watched boards, ${errors} boards failing, ${purged} old or closed jobs removed (${Math.round((Date.now() - t0) / 1000)}s)`);
    // On the very first poll everything is "new"; users get a full rematch on onboarding instead. After that, a newly
    // watched board's first poll brings in its whole history: score it, but don't announce it as news.
    if (!firstPoll) {
      await matchNewJobs(fresh);
      await matchNewJobs(seeded, { quiet: true });
    }
  } finally {
    running = false;
  }
  return pollerStatus();
}

export function startPoller() {
  if (config.pollOnBoot) setTimeout(() => void pollAll(), 1500);
  // Wake often; each board is polled only when its own schedule says so.
  setInterval(() => void pollAll(), Math.min(15, config.pollIntervalMin) * 60_000).unref();
}
