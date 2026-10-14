import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  ApplicationDetail,
  ApplicationRow,
  ApplySettings,
  Bootstrap,
  Company,
  FilledField,
  InboxMessage,
  JobCard,
  JobDetail,
  Me,
  PlaceOption,
  Plan,
  Profile,
  AnswerEntry,
  FitInfo,
  Resume,
  ResumeCatalog,
  ResumeDoc,
  ResumeLayout,
  TailoredResume,
  TrackedStatus,
} from "./types";

export const TOKEN_KEY = "ferry.token";
/** API origin. Empty when the dashboard is served by the API; set VITE_API_URL for native (Capacitor) builds. */
export const API_ORIGIN = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
export const apiUrl = (path: string) => (path.startsWith("http") ? path : `${API_ORIGIN}${path}`);
export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
};

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({
    baseUrl: `${API_ORIGIN}/api/v1`,
    prepareHeaders: (h) => {
      const t = getToken();
      if (t) h.set("Authorization", `Bearer ${t}`);
      return h;
    },
  }),
  tagTypes: ["Me", "Bootstrap", "Jobs", "Applications", "Application", "Profile", "Settings", "Resumes", "Inbox", "Tracker", "Sources", "Wallet", "Mail", "Accounts", "Messaging"],
  endpoints: (b) => ({
    authConfig: b.query<{ mode: "dev" | "password"; brand: string }, void>({ query: () => "/auth/config" }),
    login: b.mutation<{ token: string; user: Me }, { email: string; name?: string; password?: string }>({ query: (body) => ({ url: "/auth/login", method: "POST", body }) }),
    signup: b.mutation<{ token: string; user: Me }, { email: string; name?: string; password?: string }>({ query: (body) => ({ url: "/auth/signup", method: "POST", body }) }),
    magicLink: b.mutation<{ ok: boolean }, { email: string }>({ query: (body) => ({ url: "/auth/magic-link", method: "POST", body }) }),
    consumeMagic: b.mutation<{ token: string; user: Me }, { token: string }>({ query: (body) => ({ url: "/auth/magic", method: "POST", body }) }),
    verifyEmail: b.mutation<{ ok: boolean }, { token: string }>({ query: (body) => ({ url: "/auth/verify-email", method: "POST", body }), invalidatesTags: ["Me"] }),
    forgot: b.mutation<{ ok: boolean }, { email: string }>({ query: (body) => ({ url: "/auth/forgot", method: "POST", body }) }),
    resetPassword: b.mutation<{ token: string; user: Me }, { token: string; password: string }>({ query: (body) => ({ url: "/auth/reset", method: "POST", body }) }),
    resendVerification: b.mutation<{ ok: boolean }, void>({ query: () => ({ url: "/auth/resend-verification", method: "POST" }) }),
    changePassword: b.mutation<{ ok: boolean }, { current?: string; password: string }>({ query: (body) => ({ url: "/auth/password", method: "POST", body }), invalidatesTags: ["Me"] }),
    rotateApiToken: b.mutation<{ token: string }, void>({ query: () => ({ url: "/auth/api-token/rotate", method: "POST" }), invalidatesTags: ["Me"] }),
    logout: b.mutation<{ ok: boolean }, void>({ query: () => ({ url: "/auth/logout", method: "POST" }) }),
    logoutAll: b.mutation<{ ok: boolean }, void>({ query: () => ({ url: "/auth/logout-all", method: "POST" }) }),
    me: b.query<Me, void>({ query: () => "/me", providesTags: ["Me"] }),
    bootstrap: b.query<Bootstrap, void>({ query: () => "/dashboard/bootstrap", providesTags: ["Bootstrap"] }),

    recommendations: b.query<{ items: JobCard[]; total: number }, { limit?: number; offset?: number; minScore?: number }>({
      query: ({ limit = 30, offset = 0, minScore = 0 }) => `/jobs/recommendations?limit=${limit}&offset=${offset}&minScore=${minScore}`,
      providesTags: ["Jobs"],
    }),
    searchJobs: b.query<{ items: JobCard[]; total: number; query: { reading: string; scope: "title" | "all" } | null }, Record<string, string>>({
      query: (p) => `/jobs/search?${new URLSearchParams(p)}`,
      providesTags: ["Jobs"],
    }),
    jobLocations: b.query<{ groups: { kind: "remote" | "metro" | "city" | "region" | "country"; items: PlaceOption[] }[]; selected: PlaceOption[] }, { q: string; selected: string[] }>({
      query: ({ q, selected }) => `/jobs/locations?${new URLSearchParams({ q, selected: selected.join(",") })}`,
      keepUnusedDataFor: 300,
    }),
    job: b.query<JobDetail, string>({ query: (id) => `/jobs/${id}`, providesTags: (_r, _e, id) => [{ type: "Jobs", id }] }),
    skipJob: b.mutation<void, string>({ query: (id) => ({ url: `/jobs/${id}/skip`, method: "POST" }), invalidatesTags: ["Jobs", "Bootstrap"] }),
    fetchJob: b.mutation<JobCard, { url: string }>({ query: (body) => ({ url: "/jobs/fetch", method: "POST", body }), invalidatesTags: ["Jobs"] }),
    rematch: b.mutation<void, void>({ query: () => ({ url: "/jobs/rematch", method: "POST" }), invalidatesTags: ["Jobs", "Bootstrap"] }),

    applications: b.query<ApplicationRow[], { tab?: string; q?: string }>({
      query: ({ tab = "all", q = "" }) => `/applications?tab=${tab}&q=${encodeURIComponent(q)}`,
      providesTags: ["Applications"],
    }),
    applicationCounts: b.query<Record<string, number>, void>({ query: () => "/applications/counts", providesTags: ["Applications"] }),
    application: b.query<ApplicationDetail, string>({ query: (id) => `/applications/${id}`, providesTags: (_r, _e, id) => [{ type: "Application", id }] }),
    apply: b.mutation<ApplicationRow, { jobId?: string; url?: string; resumeId?: string; previewResume?: boolean }>({
      query: (body) => ({ url: "/applications", method: "POST", body }),
      invalidatesTags: ["Applications", "Jobs", "Bootstrap"],
    }),
    applyBulk: b.mutation<{ queued: string[] }, { jobIds: string[] }>({
      query: (body) => ({ url: "/applications/bulk", method: "POST", body }),
      invalidatesTags: ["Applications", "Jobs", "Bootstrap"],
    }),
    approve: b.mutation<ApplicationRow, { id: string; fields?: { id: string; value: FilledField["value"] }[]; tailored?: ResumeDoc; coverLetter?: string }>({
      query: ({ id, ...body }) => ({ url: `/applications/${id}/approve`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => ["Applications", "Bootstrap", { type: "Application", id: a.id }],
    }),
    appAction: b.mutation<ApplicationRow, { id: string; action: "retry" | "skip" | "regenerate" }>({
      query: ({ id, action }) => ({ url: `/applications/${id}/${action}`, method: "POST" }),
      invalidatesTags: (_r, _e, a) => ["Applications", "Bootstrap", { type: "Application", id: a.id }],
    }),
    saveCoverLetter: b.mutation<ApplicationDetail, { id: string; text: string }>({
      query: ({ id, text }) => ({ url: `/applications/${id}/cover-letter`, method: "PUT", body: { text } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Application", id: a.id }],
    }),
    moveTracked: b.mutation<ApplicationRow, { id: string; status: TrackedStatus }>({
      query: ({ id, status }) => ({ url: `/applications/${id}/tracked`, method: "PATCH", body: { status } }),
      invalidatesTags: ["Tracker", "Applications"],
    }),
    tracker: b.query<{ columns: Record<TrackedStatus, ApplicationRow[]>; flows: { source: string; target: string; value: number }[] }, void>({
      query: () => "/tracker",
      providesTags: ["Tracker"],
    }),

    profile: b.query<Profile, void>({ query: () => "/profile", providesTags: ["Profile"] }),
    saveProfile: b.mutation<Profile, Partial<Profile>>({ query: (body) => ({ url: "/profile", method: "PUT", body }), invalidatesTags: ["Profile"] }),
    settings: b.query<ApplySettings, void>({ query: () => "/settings", providesTags: ["Settings"] }),
    saveSettings: b.mutation<ApplySettings, Partial<ApplySettings>>({
      query: (body) => ({ url: "/settings", method: "PATCH", body }),
      async onQueryStarted(patch, { dispatch, queryFulfilled }) {
        const r = dispatch(api.util.updateQueryData("settings", undefined, (d) => Object.assign(d, patch)));
        queryFulfilled.catch(r.undo);
      },
    }),
    resumes: b.query<Resume[], void>({ query: () => "/resumes", providesTags: ["Resumes"] }),
    uploadResume: b.mutation<{ resume: Resume; method: string; contact: Profile["personal"] }, FormData>({
      query: (body) => ({ url: "/resumes", method: "POST", body }),
      invalidatesTags: ["Resumes", "Profile", "Bootstrap"],
    }),
    duplicateResume: b.mutation<Resume, { sourceId: string; name: string }>({ query: (body) => ({ url: "/resumes/duplicate", method: "POST", body }), invalidatesTags: ["Resumes"] }),
    updateResume: b.mutation<Resume, { id: string; name?: string; doc?: ResumeDoc; layout?: ResumeLayout; targets?: Resume["targets"]; notes?: string }>({
      query: ({ id, ...body }) => ({ url: `/resumes/${id}`, method: "PUT", body }),
      async onQueryStarted({ id }, { dispatch, queryFulfilled }) {
        const { data } = await queryFulfilled.catch(() => ({ data: null }));
        if (data) dispatch(api.util.updateQueryData("resumes", undefined, (list) => list.map((r) => (r.id === id ? data : r))));
      },
    }),
    setDefaultResume: b.mutation<void, string>({ query: (id) => ({ url: `/resumes/${id}/set-default`, method: "POST" }), invalidatesTags: ["Resumes"] }),
    deleteResume: b.mutation<void, string>({ query: (id) => ({ url: `/resumes/${id}`, method: "DELETE" }), invalidatesTags: ["Resumes", "Bootstrap"] }),
    resumeCatalog: b.query<ResumeCatalog, void>({ query: () => "/resume/catalog" }),
    previewResume: b.mutation<{ html: string; layout: ResumeLayout; fit: FitInfo }, { doc: ResumeDoc; layout?: ResumeLayout; applicationId?: string }>({
      query: (body) => ({ url: "/resume/preview", method: "POST", body }),
    }),
    modifyResume: b.mutation<{ doc: ResumeDoc; changes: string[]; reply: string; warnings: string[]; method: "llm" | "rules" }, { doc: ResumeDoc; prompt: string; applicationId?: string }>({
      query: (body) => ({ url: "/resume/modify", method: "POST", body }),
    }),
    tailoredResume: b.query<TailoredResume, string>({ query: (id) => `/applications/${id}/resume`, providesTags: (_r, _e, id) => [{ type: "Application", id }] }),
    saveTailored: b.mutation<TailoredResume, { id: string; tailored: ResumeDoc; layout?: ResumeLayout }>({
      query: ({ id, ...body }) => ({ url: `/applications/${id}/resume`, method: "PUT", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Application", id: a.id }],
    }),
    redoResume: b.mutation<TailoredResume, { id: string; instructions: string; applyToFuture: boolean }>({
      query: ({ id, ...body }) => ({ url: `/applications/${id}/resume/redo`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Application", id: a.id }, "Resumes"],
    }),
    switchProfile: b.mutation<TailoredResume, { id: string; profileId: string }>({
      query: ({ id, profileId }) => ({ url: `/applications/${id}/profile`, method: "POST", body: { profileId } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Application", id: a.id }, "Applications"],
    }),
    answerBuiltins: b.query<{ id: string; question: string; mode: AnswerEntry["mode"]; hint: string }[], void>({ query: () => "/answers/builtins" }),
    draftAnswer: b.mutation<{ job: { id: string; title: string; company: string }; profile: { id: string; name: string }; question: string; answer: string; method: "llm" | "template" }, { question: string; notes: string; builtin?: string }>({
      query: (body) => ({ url: "/answers/draft", method: "POST", body }),
    }),
    completeOnboarding: b.mutation<void, void>({ query: () => ({ url: "/onboarding/complete", method: "POST" }), invalidatesTags: ["Me", "Bootstrap", "Jobs"] }),

    inbox: b.query<InboxMessage[], void>({ query: () => "/inbox/messages", providesTags: ["Inbox"] }),
    markRead: b.mutation<void, string>({ query: (id) => ({ url: `/inbox/messages/${id}/read`, method: "POST" }), invalidatesTags: ["Inbox", "Bootstrap"] }),
    draftReply: b.mutation<{ draft: string }, string>({ query: (id) => ({ url: `/inbox/messages/${id}/draft-reply`, method: "POST" }), invalidatesTags: ["Inbox"] }),
    ingestEmail: b.mutation<{ message: InboxMessage | null; ignored: boolean }, { from: string; fromName?: string; subject: string; body: string }>({
      query: (body) => ({ url: "/inbox/ingest", method: "POST", body }),
      invalidatesTags: ["Inbox", "Tracker", "Applications", "Bootstrap"],
    }),
    gmail: b.query<{ configured: boolean; connected: boolean; lastSync: string | null }, void>({ query: () => "/integrations/gmail", providesTags: ["Inbox"] }),
    gmailConnect: b.mutation<{ url: string }, void>({ query: () => ({ url: "/integrations/gmail/connect" }) }),
    gmailSync: b.mutation<{ synced: number }, void>({ query: () => ({ url: "/integrations/gmail/sync", method: "POST" }), invalidatesTags: ["Inbox", "Tracker"] }),

    sources: b.query<{ companies: Company[]; poller: Bootstrap["poller"]; atsList: { id: string; name: string; discovery: boolean }[] }, void>({
      query: () => "/sources",
      providesTags: ["Sources"],
    }),
    addSource: b.mutation<Company & { openJobs?: number }, { name?: string; ats?: string; board?: string; url?: string }>({
      query: (body) => ({ url: "/sources", method: "POST", body }),
      invalidatesTags: ["Sources", "Jobs"],
    }),
    pollNow: b.mutation<void, void>({ query: () => ({ url: "/sources/poll", method: "POST" }), invalidatesTags: ["Sources"] }),

    mail: b.query<{ gmail: boolean; imap: boolean; local: boolean; gmailConfigured: boolean; imapUser: string | null; imapHost: string | null; lastSync: string | null }, void>({ query: () => "/integrations/mail", providesTags: ["Mail"] }),
    connectImap: b.mutation<{ ok: boolean; host: string }, { email: string; password: string; host?: string; port?: number }>({ query: (body) => ({ url: "/integrations/imap", method: "POST", body }), invalidatesTags: ["Mail", "Inbox"] }),
    disconnectImap: b.mutation<void, void>({ query: () => ({ url: "/integrations/imap", method: "DELETE" }), invalidatesTags: ["Mail"] }),
    disconnectGmail: b.mutation<void, void>({ query: () => ({ url: "/integrations/gmail", method: "DELETE" }), invalidatesTags: ["Mail"] }),
    syncMail: b.mutation<{ synced: number }, void>({ query: () => ({ url: "/integrations/mail/sync", method: "POST" }), invalidatesTags: ["Mail", "Inbox", "Tracker"] }),
    sandboxMail: b.query<{ id: number; from_addr: string; from_name: string | null; subject: string; text: string; received_at: string }[], void>({ query: () => "/dev/mailbox", providesTags: ["Mail"] }),
    atsAccounts: b.query<{ id: string; host: string; ats: string | null; email: string; status: string; createdAt: string; lastUsedAt: string | null }[], void>({ query: () => "/ats-accounts", providesTags: ["Accounts"] }),
    revealAccount: b.mutation<{ password: string }, string>({ query: (id) => ({ url: `/ats-accounts/${id}/reveal`, method: "POST" }) }),
    deleteAccount: b.mutation<void, string>({ query: (id) => ({ url: `/ats-accounts/${id}`, method: "DELETE" }), invalidatesTags: ["Accounts"] }),
    applicationPassword: b.query<{ hasPassword: boolean; updatedAt: string | null; rules: string[] }, void>({ query: () => "/application-password", providesTags: ["Accounts"] }),
    setApplicationPassword: b.mutation<{ hasPassword: boolean }, string>({ query: (password) => ({ url: "/application-password", method: "PUT", body: { password } }), invalidatesTags: ["Accounts"] }),
    revealApplicationPassword: b.mutation<{ password: string }, void>({ query: () => ({ url: "/application-password/reveal", method: "POST" }) }),
    deleteApplicationPassword: b.mutation<void, void>({ query: () => ({ url: "/application-password", method: "DELETE" }), invalidatesTags: ["Accounts"] }),
    applicationAccount: b.query<{ email: string; account: { id: string; host: string; status: string; passwordKind: "application" | "generated"; createdAt: string } | null }, string>({
      query: (id) => `/applications/${id}/account`,
      providesTags: (_r, _e, id) => [{ type: "Application", id }],
    }),
    revealApplicationAccount: b.mutation<{ password: string }, string>({ query: (id) => ({ url: `/applications/${id}/account/reveal`, method: "POST" }) }),
    finishedMyself: b.mutation<ApplicationRow, string>({
      query: (id) => ({ url: `/applications/${id}/finished`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => ["Applications", "Tracker", "Bootstrap", { type: "Application", id }],
    }),
    messaging: b.query<MessagingState, void>({ query: () => "/messaging", providesTags: ["Messaging"] }),
    sendPhoneCode: b.mutation<{ to: string; provider: string }, { phone: string; channel: Channel }>({ query: (body) => ({ url: "/messaging/otp/send", method: "POST", body }), invalidatesTags: ["Messaging"] }),
    verifyPhone: b.mutation<{ ok: boolean }, { code: string }>({ query: (body) => ({ url: "/messaging/otp/verify", method: "POST", body }), invalidatesTags: ["Messaging"] }),
    saveMessagingPrefs: b.mutation<MessagingState["prefs"], Partial<MessagingState["prefs"]>>({ query: (body) => ({ url: "/messaging/prefs", method: "PATCH", body }), invalidatesTags: ["Messaging"] }),
    removePhone: b.mutation<void, void>({ query: () => ({ url: "/messaging/phone", method: "DELETE" }), invalidatesTags: ["Messaging"] }),
    simulateText: b.mutation<{ reply: string }, { text: string }>({ query: (body) => ({ url: "/messaging/simulate", method: "POST", body }), invalidatesTags: ["Messaging", "Applications", "Bootstrap"] }),
    pushKey: b.query<{ key: string }, void>({ query: () => "/push/key" }),
    pushSubscribe: b.mutation<{ ok: boolean }, PushSubscriptionJSON>({ query: (body) => ({ url: "/push/subscribe", method: "POST", body }) }),
    pushTest: b.mutation<{ sent: number }, void>({ query: () => ({ url: "/push/test", method: "POST" }) }),
    billingPortal: b.mutation<{ url: string }, void>({ query: () => ({ url: "/subscription/portal", method: "POST" }) }),
    plans: b.query<Plan[], void>({ query: () => "/subscription/plans" }),
    wallet: b.query<{ credits: number; plan: string; renewsAt: string | null; stripe: boolean; ledger: { delta: number; reason: string; created_at: string }[] }, void>({ query: () => "/wallet", providesTags: ["Wallet"] }),
    checkout: b.mutation<{ url?: string; local?: boolean }, { plan: string }>({ query: (body) => ({ url: "/subscription/checkout", method: "POST", body }), invalidatesTags: ["Wallet", "Me", "Bootstrap"] }),
  }),
});

export type Channel = "sms" | "whatsapp" | "imessage";
export interface MessagingState {
  prefs: { channel: Channel | null; matchAlerts: boolean; minScore: number; statusUpdates: boolean; emailDigest: boolean; push: boolean };
  phone: string | null;
  verified: boolean;
  providers: Record<Channel, string>;
  log: { channel: string; to_addr: string; body: string; status: string; created_at: string }[];
}

export const {
  useAuthConfigQuery,
  useSignupMutation,
  useMagicLinkMutation,
  useConsumeMagicMutation,
  useVerifyEmailMutation,
  useForgotMutation,
  useResetPasswordMutation,
  useResendVerificationMutation,
  useChangePasswordMutation,
  useRotateApiTokenMutation,
  useLogoutMutation,
  useLogoutAllMutation,
  useMailQuery,
  useConnectImapMutation,
  useDisconnectImapMutation,
  useDisconnectGmailMutation,
  useSyncMailMutation,
  useSandboxMailQuery,
  useAtsAccountsQuery,
  useRevealAccountMutation,
  useApplicationPasswordQuery,
  useSetApplicationPasswordMutation,
  useRevealApplicationPasswordMutation,
  useDeleteApplicationPasswordMutation,
  useApplicationAccountQuery,
  useRevealApplicationAccountMutation,
  useFinishedMyselfMutation,
  useDeleteAccountMutation,
  useMessagingQuery,
  useSendPhoneCodeMutation,
  useVerifyPhoneMutation,
  useSaveMessagingPrefsMutation,
  useRemovePhoneMutation,
  useSimulateTextMutation,
  usePushKeyQuery,
  usePushSubscribeMutation,
  usePushTestMutation,
  useBillingPortalMutation,
  useLoginMutation,
  useMeQuery,
  useBootstrapQuery,
  useRecommendationsQuery,
  useSearchJobsQuery,
  useJobQuery,
  useSkipJobMutation,
  useFetchJobMutation,
  useRematchMutation,
  useApplicationsQuery,
  useApplicationCountsQuery,
  useApplicationQuery,
  useApplyMutation,
  useApplyBulkMutation,
  useApproveMutation,
  useAppActionMutation,
  useSaveCoverLetterMutation,
  useMoveTrackedMutation,
  useTrackerQuery,
  useProfileQuery,
  useSaveProfileMutation,
  useSettingsQuery,
  useSaveSettingsMutation,
  useResumesQuery,
  useUploadResumeMutation,
  useDuplicateResumeMutation,
  useUpdateResumeMutation,
  useResumeCatalogQuery,
  usePreviewResumeMutation,
  useTailoredResumeQuery,
  useModifyResumeMutation,
  useSaveTailoredMutation,
  useRedoResumeMutation,
  useSwitchProfileMutation,
  useAnswerBuiltinsQuery,
  useDraftAnswerMutation,
  useSetDefaultResumeMutation,
  useDeleteResumeMutation,
  useCompleteOnboardingMutation,
  useInboxQuery,
  useMarkReadMutation,
  useDraftReplyMutation,
  useIngestEmailMutation,
  useGmailQuery,
  useGmailConnectMutation,
  useGmailSyncMutation,
  useSourcesQuery,
  useAddSourceMutation,
  useJobLocationsQuery,
  usePollNowMutation,
  usePlansQuery,
  useWalletQuery,
  useCheckoutMutation,
} = api;

export const errorMessage = (e: unknown) => {
  const d = (e as { data?: { error?: string } })?.data;
  return d?.error ?? (e as Error)?.message ?? "Something went wrong";
};
