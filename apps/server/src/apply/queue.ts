import { config } from "../config.ts";
import { all, one, run } from "../db.ts";
import { onMatched } from "../match/score.ts";
import { createApplication, getApplication } from "../store.ts";
import { processApplication, type RunOptions } from "./engine.ts";

const queue: { id: string; opts: RunOptions }[] = [];
const active = new Set<string>();

export const queueStatus = () => ({ queued: queue.map((q) => q.id), active: [...active], concurrency: config.applyConcurrency });

export function enqueue(appId: string, opts: RunOptions = {}) {
  if (active.has(appId) || queue.some((q) => q.id === appId)) return;
  queue.push({ id: appId, opts });
  pump();
}

function pump() {
  while (active.size < config.applyConcurrency && queue.length) {
    const next = queue.shift()!;
    active.add(next.id);
    processApplication(next.id, next.opts)
      .catch((e) => console.error("[queue]", next.id, e))
      .finally(() => {
        active.delete(next.id);
        pump();
      });
  }
}

/** On boot, resume anything that was mid-flight when the server stopped. */
export function recoverQueue() {
  const stuck = all<{ id: string }>("SELECT id FROM applications WHERE status IN ('QUEUED','OPTIMIZING','OPTIMIZING_RESUME','OPTIMIZING_CL','READY','RUNNING') ORDER BY created_at");
  for (const r of stuck) {
    run("UPDATE applications SET status = 'QUEUED' WHERE id = ? AND status IN ('RUNNING','READY')", r.id);
    enqueue(r.id);
  }
  if (stuck.length) console.log(`[queue] resumed ${stuck.length} application(s)`);
}

// Auto-apply: queue strong matches automatically, within the user's daily limit.
onMatched((user, job, m) => {
  const s = user.settings;
  if (!s.autoApply || m.score < s.autoApplyMinScore || user.credits <= 0) return;
  const today = one<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND source = 'auto' AND created_at >= date('now')", user.id);
  if ((today?.n ?? 0) >= s.autoApplyDailyLimit) return;
  const { app, created } = createApplication(user.id, job.id, "auto");
  if (created) enqueue(app.id);
});

export function cancel(appId: string) {
  const i = queue.findIndex((q) => q.id === appId);
  if (i >= 0) queue.splice(i, 1);
  return getApplication(appId);
}
