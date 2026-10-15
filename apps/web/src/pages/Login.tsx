import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, CheckCircle2, Mail } from "lucide-react";
import { api, errorMessage, setToken, useAuthConfigQuery, useConsumeMagicMutation, useForgotMutation, useLoginMutation, useMagicLinkMutation, useResetPasswordMutation, useSignupMutation, useVerifyEmailMutation } from "../lib/api";
import { store } from "../lib/store";
import { Button, Card, cx, Input, Label, Logo, Spinner } from "../components/ui";
import type { Me } from "../lib/types";

function AuthShell({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <Link to="/" className="mb-8 inline-block">
          <Logo />
        </Link>
        <h1 className="display text-[40px]">{title}</h1>
        {sub && <p className="mt-1 mb-6 text-[14px] text-muted">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

function useEnterApp() {
  const nav = useNavigate();
  const loc = useLocation();
  // Back to the page that asked you to sign in (an OAuth consent screen, a deep link), if it was one of ours.
  const from = (loc.state as { from?: string } | null)?.from;
  return (r: { token: string; user: Me }) => {
    setToken(r.token);
    store.dispatch(api.util.resetApiState());
    nav(from && from.startsWith("/") && !from.startsWith("//") ? from : r.user.onboarded ? "/app" : "/welcome");
  };
}

export default function Login() {
  const { data: cfg } = useAuthConfigQuery();
  const loc = useLocation();
  const [mode, setMode] = useState<"signin" | "signup" | "magic" | "forgot">(loc.pathname === "/signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [login, { isLoading: l1 }] = useLoginMutation();
  const [signup, { isLoading: l2 }] = useSignupMutation();
  const [magic, { isLoading: l3 }] = useMagicLinkMutation();
  const [forgot, { isLoading: l4 }] = useForgotMutation();
  const enter = useEnterApp();
  const dev = cfg?.mode === "dev";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    // Local mode has no password box, so a password typed (or autofilled) into "Full name" would become your name.
    if (name.trim() && !/^[\p{L}][\p{L}\p{M}'’.\- ]{0,79}$/u.test(name.trim())) {
      setErr(dev ? "That looks like a password, not a name. Local mode doesn't use a password: enter your name or leave it blank." : "Enter your name as you'd like it on applications (letters, spaces, hyphens).");
      return;
    }
    try {
      if (mode === "magic") {
        await magic({ email }).unwrap();
        setSent("We emailed you a sign-in link. It works once and expires in 20 minutes.");
      } else if (mode === "forgot") {
        await forgot({ email }).unwrap();
        setSent("If there's an account for that email, a reset link is on its way.");
      } else if (mode === "signup") enter(await signup({ email, name, password }).unwrap());
      else enter(await login({ email, password, name }).unwrap());
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  if (!cfg) return <Spinner className="mx-auto mt-40 h-6 w-6" />;
  if (sent)
    return (
      <AuthShell title="Check your inbox.">
        <Card className="flex items-start gap-3 p-5">
          <Mail className="mt-0.5 h-5 w-5 shrink-0 text-sea" />
          <p className="text-[14px]">{sent}</p>
        </Card>
        <button className="mt-4 text-[13px] text-muted hover:text-ink" onClick={() => setSent(null)}>
          ← Back
        </button>
      </AuthShell>
    );

  const titles = { signin: "Welcome back.", signup: "Create your account.", magic: "Sign in by email.", forgot: "Reset your password." };
  return (
    <AuthShell title={dev ? "Welcome aboard." : titles[mode]} sub={dev ? "Sign in or create your account. Your first 25 applications are free." : mode === "signup" ? "Your first 25 applications are free. No card required." : undefined}>
      {!dev && (mode === "signin" || mode === "signup") && (
        <div className="mb-4 inline-flex rounded-lg border border-line bg-paper p-0.5">
          {(["signin", "signup"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cx("h-8 rounded-md px-4 text-[13px] font-medium", mode === m ? "bg-card shadow-card" : "text-muted")}>
              {m === "signin" ? "Sign in" : "Sign up"}
            </button>
          ))}
        </div>
      )}
      <Card className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          {(dev || mode === "signup") && (
            <div>
              <Label htmlFor="name" hint={dev ? "optional" : undefined}>
                Full name
              </Label>
              <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Morgan" />
            </div>
          )}
          {!dev && (mode === "signin" || mode === "signup") && (
            <div>
              <Label htmlFor="password" hint={mode === "signup" ? "10+ characters, letters and numbers" : undefined}>
                Password
              </Label>
              <Input id="password" type="password" required autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          {err && <p className="text-[13px] text-coral">{err}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={l1 || l2 || l3 || l4} icon={<ArrowRight className="h-4 w-4" />}>
            {dev ? "Continue" : mode === "signup" ? "Create account" : mode === "magic" ? "Email me a link" : mode === "forgot" ? "Send reset link" : "Sign in"}
          </Button>
        </form>
      </Card>
      {!dev && (
        <div className="mt-4 flex flex-wrap justify-between gap-2 text-[13px] text-muted">
          {mode !== "magic" ? (
            <button className="hover:text-ink" onClick={() => setMode("magic")}>
              Email me a sign-in link instead
            </button>
          ) : (
            <button className="hover:text-ink" onClick={() => setMode("signin")}>
              Use a password
            </button>
          )}
          {mode === "signin" && (
            <button className="hover:text-ink" onClick={() => setMode("forgot")}>
              Forgot password?
            </button>
          )}
        </div>
      )}
      {dev && <p className="mt-4 text-center text-[12px] text-faint">Local mode: passwordless sign-in. Set AUTH_MODE=password before hosting this for other people.</p>}
    </AuthShell>
  );
}

/** Landing page for links in emails: /auth/verify, /auth/magic, /auth/reset. */
export function AuthAction({ kind }: { kind: "verify" | "magic" | "reset" }) {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [verify] = useVerifyEmailMutation();
  const [consume] = useConsumeMagicMutation();
  const [reset, { isLoading }] = useResetPasswordMutation();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState("");
  const enter = useEnterApp();
  useEffect(() => {
    if (kind === "reset") return;
    (async () => {
      try {
        if (kind === "verify") {
          await verify({ token }).unwrap();
          setState("done");
        } else enter(await consume({ token }).unwrap());
      } catch (e) {
        setErr(errorMessage(e));
        setState("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, token]);

  if (kind === "reset")
    return (
      <AuthShell title="Choose a new password.">
        <Card className="p-5">
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                enter(await reset({ token, password: pw }).unwrap());
              } catch (e2) {
                setErr(errorMessage(e2));
              }
            }}
          >
            <div>
              <Label htmlFor="pw" hint="10+ characters, letters and numbers">
                New password
              </Label>
              <Input id="pw" type="password" required autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            {err && <p className="text-[13px] text-coral">{err}</p>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={isLoading}>
              Save and sign in
            </Button>
          </form>
        </Card>
      </AuthShell>
    );
  return (
    <AuthShell title={state === "error" ? "That link didn't work." : kind === "verify" ? "Email confirmed." : "Signing you in…"}>
      {state === "working" && <Spinner className="h-6 w-6" />}
      {state === "done" && (
        <Card className="flex items-center gap-3 p-5">
          <CheckCircle2 className="h-5 w-5 text-kelp" />
          <p className="text-[14px]">
            Thanks. <Link to="/app" className="font-medium underline">Open your dashboard</Link>
          </p>
        </Card>
      )}
      {state === "error" && (
        <Card className="p-5">
          <p className="text-[14px] text-coral">{err}</p>
          <Link to="/login" className="mt-3 inline-block text-[13px] underline">
            Back to sign in
          </Link>
        </Card>
      )}
    </AuthShell>
  );
}
