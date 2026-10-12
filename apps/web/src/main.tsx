import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./styles.css";
import { store } from "./lib/store";
import { Toaster } from "./components/toast";
import { AppLayout, RequireAuth } from "./components/AppLayout";
import Landing from "./pages/Landing";
import Login, { AuthAction } from "./pages/Login";
// Dashboard screens load on demand so the landing page stays light.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Applications = lazy(() => import("./pages/Applications"));
const ApplicationDetail = lazy(() => import("./pages/ApplicationDetail"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Tracker = lazy(() => import("./pages/Tracker"));
const ProfilePage = lazy(() => import("./pages/Profile"));
const ProfilesPage = lazy(() => import("./pages/Profiles"));
const AnswersPage = lazy(() => import("./pages/Answers"));
const Settings = lazy(() => import("./pages/Settings"));
const Onboarding = lazy(() => import("./pages/Onboarding"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <Suspense fallback={<div className="grid min-h-dvh place-items-center text-[13px] text-muted">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Login />} />
          <Route path="/auth/verify" element={<AuthAction kind="verify" />} />
          <Route path="/auth/magic" element={<AuthAction kind="magic" />} />
          <Route path="/auth/reset" element={<AuthAction kind="reset" />} />
          <Route element={<RequireAuth />}>
            <Route path="/welcome" element={<Onboarding />} />
            <Route path="/app" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="jobs" element={<Jobs />} />
              <Route path="applications" element={<Applications />} />
              <Route path="applications/:id" element={<ApplicationDetail />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="tracker" element={<Tracker />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="profiles" element={<ProfilesPage />} />
              <Route path="answers" element={<AnswersPage />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        <Toaster />
      </BrowserRouter>
    </Provider>
  </StrictMode>,
);

// Installable app: register the service worker (offline shell + push) in production builds.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
