import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useSelector } from "react-redux";
import { BriefcaseBusiness, FileText, Inbox as InboxIcon, MessageSquareText, KanbanSquare, LayoutDashboard, LogOut, Menu, Search, Settings as SettingsIcon, UserRound, X } from "lucide-react";
import { apiUrl, getToken, setToken, useBootstrapQuery, useMeQuery, useResendVerificationMutation, api } from "../lib/api";
import { useLiveEvents } from "../lib/events";
import { initNativePush, isNative } from "../lib/native";
import { store, type RootState } from "../lib/store";
import { cx, Logo, Spinner } from "./ui";

export function RequireAuth() {
  const token = getToken();
  const loc = useLocation();
  const { data: me, isLoading, isError } = useMeQuery(undefined, { skip: !token });
  if (!token || isError) {
    if (isError) setToken(null);
    return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  }
  if (isLoading || !me) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!me.onboarded && loc.pathname !== "/welcome") return <Navigate to="/welcome" replace />;
  return <Outlet />;
}

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/jobs", label: "Browse jobs", icon: Search },
  { to: "/app/applications", label: "Applications", icon: BriefcaseBusiness, count: "applications" as const },
  { to: "/app/inbox", label: "Inbox", icon: InboxIcon, count: "inbox" as const },
  { to: "/app/tracker", label: "Tracker", icon: KanbanSquare },
  { to: "/app/profiles", label: "Résumé profiles", icon: FileText },
  { to: "/app/answers", label: "Answers", icon: MessageSquareText },
  { to: "/app/profile", label: "About you", icon: UserRound },
  { to: "/app/settings", label: "Settings", icon: SettingsIcon },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMeQuery();
  const { data: boot } = useBootstrapQuery();
  const connected = useSelector((s: RootState) => s.live.connected);
  const nav = useNavigate();
  const logout = () => {
    void fetch(apiUrl("/api/v1/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${getToken() ?? ""}` } }).catch(() => {});
    setToken(null);
    store.dispatch(api.util.resetApiState());
    nav("/");
  };
  const counts = { applications: boot?.counts.needs ? boot.counts.needs : undefined, inbox: boot?.unread || undefined };
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-5">
        <NavLink to="/app" onClick={onNavigate}>
          <Logo />
        </NavLink>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2.5">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors", isActive ? "bg-card text-ink shadow-card" : "text-ink-2 hover:bg-ink/5")
            }
          >
            <n.icon className="h-[17px] w-[17px] opacity-80" />
            <span className="flex-1">{n.label}</span>
            {n.count && counts[n.count] ? (
              <span className={cx("rounded-full px-1.5 text-[11px] font-semibold tabular-nums", n.count === "applications" ? "bg-signal text-white" : "bg-sea text-white")}>{counts[n.count]}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>
      <div className="m-2.5 rounded-xl border border-line bg-card p-3 shadow-card">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">{me?.name || me?.email}</p>
            <p className="text-[12px] text-muted">
              <span className="font-semibold text-ink tabular-nums">{me?.credits ?? "—"}</span> credits · {me?.plan}
            </p>
          </div>
          <button onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink" title="Log out" aria-label="Log out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[12px] text-muted">
          <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "bg-kelp pulse-dot" : "bg-faint")} />
          {connected ? "Agent online" : "Connecting…"}
          {me && !me.llm && <span className="ml-auto rounded bg-amber-soft px-1.5 text-[11px] text-amber">no-LLM mode</span>}
        </div>
      </div>
    </div>
  );
}

export function AppLayout() {
  useLiveEvents(true);
  const navigate = useNavigate();
  useEffect(() => {
    if (isNative()) void initNativePush((url) => navigate(url));
  }, [navigate]);
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-paper lg:block">
        <Sidebar />
      </aside>
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 flex items-center justify-between border-b border-line bg-paper/90 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 hover:bg-ink/5" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px] bg-paper shadow-pop">
            <button onClick={() => setOpen(false)} className="absolute top-3 right-3 rounded-lg p-2 hover:bg-ink/5" aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
      <main className="min-w-0 px-4 pt-5 pb-16 sm:px-6 lg:px-10 lg:pt-8">
        <div className="mx-auto max-w-[1180px]">
          <VerifyBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, sub, action }: { title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="display text-[34px] sm:text-[40px]">{title}</h1>
        {sub && <p className="mt-1 text-[14px] text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function VerifyBanner() {
  const { data: me } = useMeQuery();
  const [resend, { isLoading, isSuccess }] = useResendVerificationMutation();
  if (!me || me.authMode !== "password" || me.emailVerified) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber/30 bg-amber-soft px-4 py-2.5 text-[13px]">
      <span>Confirm your email ({me.email}) so recruiter replies and employer verification codes reach you.</span>
      <button className="font-medium underline disabled:opacity-50" disabled={isLoading || isSuccess} onClick={() => resend()}>
        {isSuccess ? "Sent" : "Resend link"}
      </button>
    </div>
  );
}
