import { useEffect } from "react";
import { api, apiUrl, getToken } from "./api";
import { setConnected, store, upsertRun } from "./store";
import { toast } from "../components/toast";

type Evt = {
  type: string;
  applicationId?: string;
  jobId?: string;
  thought?: string;
  currentPage?: number;
  totalPages?: number;
  error?: string;
  dryRun?: boolean;
  status?: string;
  count?: number;
  subject?: string;
  newJobs?: number;
  at: string;
};

/** Subscribe to the user's realtime channel and keep RTK Query caches fresh. */
export function useLiveEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const token = getToken();
    if (!token) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (tags: Parameters<typeof api.util.invalidateTags>[0]) => {
      // Coalesce bursts of events into one refetch.
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => store.dispatch(api.util.invalidateTags(tags)), 400);
    };
    const connect = () => {
      es = new EventSource(apiUrl(`/api/v1/events?token=${encodeURIComponent(token)}`));
      es.onopen = () => store.dispatch(setConnected(true));
      es.onerror = () => {
        store.dispatch(setConnected(false));
        es?.close();
        retry = setTimeout(connect, 3000);
      };
      const on = (name: string, fn: (e: Evt) => void) => es!.addEventListener(name, (m) => fn(JSON.parse((m as MessageEvent).data)));
      on("execution:started", (e) => store.dispatch(upsertRun({ applicationId: e.applicationId!, jobId: e.jobId!, status: "running", thought: "Starting…", at: e.at })));
      on("execution:thought", (e) =>
        store.dispatch(upsertRun({ applicationId: e.applicationId!, jobId: e.jobId!, thought: e.thought, currentPage: e.currentPage, totalPages: e.totalPages, at: e.at })),
      );
      on("execution:completed", (e) => {
        store.dispatch(upsertRun({ applicationId: e.applicationId!, status: "completed", thought: e.dryRun ? "Dry run complete" : "Submitted", at: e.at }));
        toast(e.dryRun ? "Dry run finished: the form was filled but not submitted" : "Application submitted", "success");
      });
      on("execution:failed", (e) => {
        store.dispatch(upsertRun({ applicationId: e.applicationId!, status: "failed", thought: e.error, at: e.at }));
        toast(`Application failed: ${e.error}`, "error");
      });
      on("application:updated", (e) => {
        refresh(["Applications", "Bootstrap", { type: "Application", id: e.applicationId! }]);
      });
      on("application:asks", (e) => {
        refresh([{ type: "Application", id: e.applicationId! }]);
        toast("An employer emailed a verification code. Enter it on the application (or let Claude or muse answer).", "info");
      });
      on("inbox:new", (e) => {
        refresh(["Inbox", "Tracker", "Bootstrap"]);
        toast(`New ${(e as { category?: string }).category?.replace("_", " ") ?? "email"}: ${e.subject}`, "info");
      });
      on("jobs:polled", (e) => {
        if (e.newJobs) refresh(["Jobs", "Bootstrap", "Sources"]);
      });
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [enabled]);
}
