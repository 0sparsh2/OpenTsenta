import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { api } from "./api";

export interface LiveRun {
  applicationId: string;
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  thought?: string;
  currentPage?: number;
  totalPages?: number;
  at: string;
}

/** Live agent activity from the SSE channel, keyed by application id. */
const live = createSlice({
  name: "live",
  initialState: { runs: {} as Record<string, LiveRun>, connected: false },
  reducers: {
    upsertRun(s, a: PayloadAction<Partial<LiveRun> & { applicationId: string }>) {
      const base: LiveRun = s.runs[a.payload.applicationId] ?? { applicationId: a.payload.applicationId, jobId: "", status: "running", at: new Date().toISOString() };
      s.runs[a.payload.applicationId] = { ...base, ...a.payload };
    },
    setConnected(s, a: PayloadAction<boolean>) {
      s.connected = a.payload;
    },
  },
});
export const { upsertRun, setConnected } = live.actions;

export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer, live: live.reducer },
  middleware: (gdm) => gdm().concat(api.middleware),
});
export type RootState = ReturnType<typeof store.getState>;
