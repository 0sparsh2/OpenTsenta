import { EventEmitter } from "node:events";

// Per-user realtime channel, the equivalent of the reference's Transmit channel `users/{uid}/events`.
// Event names follow the recovered protocol: execution:started|thought|completed|failed|aborted.

export type BusEvent =
  | { type: "execution:started"; applicationId: string; jobId: string }
  | { type: "execution:thought"; applicationId: string; jobId: string; thought: string; currentPage?: number; totalPages?: number }
  | { type: "execution:completed"; applicationId: string; jobId: string; dryRun: boolean }
  | { type: "execution:failed"; applicationId: string; jobId: string; error: string }
  | { type: "execution:aborted"; applicationId: string; jobId: string }
  | { type: "application:updated"; applicationId: string; status: string }
  | { type: "application:asks"; applicationId: string; question: string }
  | { type: "matches:new"; count: number; top?: { jobId: string; title: string; company: string; score: number } }
  | { type: "inbox:new"; messageId: string; subject: string; category: string | null }
  | { type: "jobs:polled"; newJobs: number; companies: number };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(userId: string, event: BusEvent) {
  const e = { ...event, at: new Date().toISOString() };
  emitter.emit(`u:${userId}`, e);
  emitter.emit("any", userId, e);
}

/** Server-side listener for every user's events (notifications fan out from here). */
export function onAnyEvent(fn: (userId: string, e: BusEvent & { at: string }) => void) {
  emitter.on("any", fn);
}
export function broadcast(event: BusEvent) {
  emitter.emit("all", { ...event, at: new Date().toISOString() });
}
export function subscribe(userId: string, fn: (e: BusEvent & { at: string }) => void) {
  emitter.on(`u:${userId}`, fn);
  emitter.on("all", fn);
  return () => {
    emitter.off(`u:${userId}`, fn);
    emitter.off("all", fn);
  };
}
