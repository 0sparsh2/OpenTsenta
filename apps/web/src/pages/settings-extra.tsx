import { useState } from "react";
import {
  Bell,
  Eye,
  KeyRound,
  Mail,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import {
  errorMessage,
  useAtsAccountsQuery,
  useBillingPortalMutation,
  useChangePasswordMutation,
  useCheckoutMutation,
  useConnectImapMutation,
  useDeleteAccountMutation,
  useDisconnectGmailMutation,
  useDisconnectImapMutation,
  useGmailConnectMutation,
  useLogoutAllMutation,
  useMailQuery,
  useMeQuery,
  useMessagingQuery,
  usePlansQuery,
  usePushKeyQuery,
  usePushSubscribeMutation,
  usePushTestMutation,
  useRemovePhoneMutation,
  useRevealAccountMutation,
  useApplicationPasswordQuery,
  useSetApplicationPasswordMutation,
  useRevealApplicationPasswordMutation,
  useDeleteApplicationPasswordMutation,
  useRotateApiTokenMutation,
  useSandboxMailQuery,
  useSaveMessagingPrefsMutation,
  useSendPhoneCodeMutation,
  useSimulateTextMutation,
  useSyncMailMutation,
  useVerifyPhoneMutation,
  useWalletQuery,
  type Channel,
} from "../lib/api";
import { toast } from "../components/toast";
import { initNativePush, isNative } from "../lib/native";
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  Input,
  Label,
  SectionTitle,
  Segmented,
  Spinner,
  timeAgo,
  Toggle,
} from "../components/ui";

// ---------- Email ----------

const IMAP_HELP: Record<string, string> = {
  "gmail.com":
    "Google Account → Security → 2-Step Verification → App passwords",
  "outlook.com":
    "account.microsoft.com → Security → Advanced security options → App passwords",
  "hotmail.com":
    "account.microsoft.com → Security → Advanced security options → App passwords",
  "yahoo.com": "Yahoo Account Security → Generate app password",
  "icloud.com":
    "appleid.apple.com → Sign-In and Security → App-Specific Passwords",
};

export function EmailSettings() {
  const { data: m } = useMailQuery();
  const [gmailConnect] = useGmailConnectMutation();
  const [disconnectGmail] = useDisconnectGmailMutation();
  const [connectImap, { isLoading }] = useConnectImapMutation();
  const [disconnectImap] = useDisconnectImapMutation();
  const [sync, { isLoading: syncing }] = useSyncMailMutation();
  const { data: sandbox } = useSandboxMailQuery();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [host, setHost] = useState("");
  const help = IMAP_HELP[email.split("@")[1]?.toLowerCase() ?? ""];
  if (!m) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          title={
            <span className="flex items-center gap-2">
              <Mail className="h-4 w-4" /> Your inbox
            </span>
          }
          sub="Ferry reads job-related mail only: confirmations, recruiter replies, and the verification codes employers send during sign-up. It never sends email from your account."
          action={
            (m.gmail || m.imap) && (
              <Button
                size="sm"
                loading={syncing}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={async () =>
                  toast(
                    `Synced ${(await sync().unwrap()).synced} new job emails`,
                    "success",
                  )
                }
              >
                Sync now
              </Button>
            )
          }
        />
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-line p-3">
            <div>
              <p className="text-[14px] font-medium">Gmail</p>
              <p className="text-[12px] text-muted">
                {m.gmail
                  ? "Connected (read-only)"
                  : m.gmailConfigured
                    ? "One-click Google sign-in"
                    : "Needs GOOGLE_CLIENT_ID on the server; use an app password below instead"}
              </p>
            </div>
            {m.gmail ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => disconnectGmail()}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={!m.gmailConfigured}
                onClick={async () =>
                  (window.location.href = (await gmailConnect().unwrap()).url)
                }
              >
                Connect
              </Button>
            )}
          </div>
          {m.imap ? (
            <div className="flex items-center justify-between rounded-xl border border-line p-3">
              <div>
                <p className="text-[14px] font-medium">{m.imapUser}</p>
                <p className="text-[12px] text-muted">
                  IMAP · {m.imapHost}{" "}
                  {m.lastSync && `· synced ${timeAgo(m.lastSync)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => disconnectImap()}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3 rounded-xl border border-line p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const r = await connectImap({
                    email,
                    password: pw,
                    host: host || undefined,
                  }).unwrap();
                  toast(`Connected to ${r.host}`, "success");
                  setPw("");
                } catch (err) {
                  toast(errorMessage(err), "error");
                }
              }}
            >
              <p className="text-[14px] font-medium">
                Any inbox with an app password
              </p>
              <p className="text-[12px] text-muted">
                Outlook, Yahoo, iCloud, Fastmail, Gmail, and most others over
                IMAP.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  type="email"
                  required
                  placeholder="you@outlook.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Input
                  type="password"
                  required
                  placeholder="App password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
              </div>
              {email.includes("@") && !help && (
                <Input
                  placeholder="IMAP host (e.g. imap.example.com)"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              )}
              {help && (
                <p className="text-[12px] text-muted">Create one at: {help}</p>
              )}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={isLoading}
              >
                Connect inbox
              </Button>
            </form>
          )}
        </div>
      </Card>
      <Card className="p-5">
        <SectionTitle
          title="Sandbox mailbox"
          sub="Mail the local sandbox employers sent you (verification codes, confirmations). Real mail arrives through the inbox you connect."
        />
        {sandbox?.length ? (
          <ul className="scroll-thin max-h-[380px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {sandbox.map((s) => (
              <li key={s.id} className="p-3">
                <div className="flex justify-between gap-2 text-[12px] text-muted">
                  <span className="truncate">{s.from_name ?? s.from_addr}</span>
                  <span className="shrink-0">{timeAgo(s.received_at)}</span>
                </div>
                <p className="text-[13px] font-medium">{s.subject}</p>
                <p className="line-clamp-2 text-[12px] text-ink-2">{s.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            icon={<Mail className="h-5 w-5" />}
            title="Empty"
            sub="Apply to a sandbox Workday role to see verification codes arrive here."
          />
        )}
      </Card>
    </div>
  );
}

// ---------- Employer accounts ----------

function ApplicationPasswordCard() {
  const { data } = useApplicationPasswordQuery();
  const [setPw, { isLoading: saving }] = useSetApplicationPasswordMutation();
  const [reveal] = useRevealApplicationPasswordMutation();
  const [remove, { isLoading: removing }] =
    useDeleteApplicationPasswordMutation();
  const [editing, setEditing] = useState(false);
  const [pw, setPwText] = useState("");
  const [show, setShow] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const checks: [string, (p: string) => boolean][] = [
    ["At least 12 characters", (p) => p.length >= 12],
    ["A lowercase letter", (p) => /[a-z]/.test(p)],
    ["An uppercase letter", (p) => /[A-Z]/.test(p)],
    ["A number", (p) => /\d/.test(p)],
    ["A special character", (p) => /[^A-Za-z0-9\s]/.test(p)],
  ];
  const ok = checks.every(([, t]) => t(pw));
  const save = async () => {
    try {
      await setPw(pw).unwrap();
      setPwText("");
      setEditing(false);
      setRevealed(null);
      toast("Application password saved", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <Card className="mb-5 p-5">
      <SectionTitle
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Application password
          </span>
        }
        sub="One password for job sites that make you create an account to apply (Workday, iCIMS, Taleo…), so you can sign in to them yourself later. Encrypted before storage and only used to apply. Sites with stricter rules get a generated password instead."
      />
      {!editing ? (
        <div className="flex flex-wrap items-center gap-3">
          {data.hasPassword ? (
            <>
              <Badge tone="kelp">
                Saved
                {data.updatedAt ? ` · updated ${timeAgo(data.updatedAt)}` : ""}
              </Badge>
              <span className="font-mono text-[13px]">
                {revealed ?? "••••••••••••"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Eye className="h-3.5 w-3.5" />}
                onClick={async () =>
                  setRevealed(
                    revealed ? null : (await reveal().unwrap()).password,
                  )
                }
              >
                {revealed ? "Hide" : "View"}
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                Change
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={removing}
                onClick={() => remove()}
              >
                Remove
              </Button>
            </>
          ) : (
            <>
              <Badge tone="amber">
                Not set: Ferry generates a password per employer
              </Badge>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setEditing(true)}
              >
                Set a password
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="max-w-md space-y-3">
          <div>
            <Label htmlFor="app-pw">Application password</Label>
            <div className="flex gap-2">
              <Input
                id="app-pw"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPwText(e.target.value)}
                placeholder="Choose a password just for job sites"
              />
              <Button
                variant="ghost"
                aria-label={show ? "Hide password" : "Show password"}
                onClick={() => setShow(!show)}
                icon={<Eye className="h-4 w-4" />}
              />
            </div>
          </div>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {checks.map(([rule, test]) => (
              <li
                key={rule}
                className={cx(
                  "flex items-center gap-1.5 text-[12.5px]",
                  test(pw) ? "text-kelp" : "text-muted",
                )}
              >
                <span
                  className={cx(
                    "grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] text-white",
                    test(pw) ? "bg-kelp" : "bg-line-2",
                  )}
                >
                  {test(pw) ? "✓" : ""}
                </span>
                {rule}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-muted">
            Don't reuse your email or bank password. Existing employer accounts
            keep the password they were created with.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={!ok}
              loading={saving}
              onClick={save}
            >
              Save password
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setPwText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function AccountsSettings() {
  const { data: accts } = useAtsAccountsQuery();
  const [reveal] = useRevealAccountMutation();
  const [del] = useDeleteAccountMutation();
  const [shown, setShown] = useState<Record<string, string>>({});
  return (
    <>
      <ApplicationPasswordCard />
      <Card className="p-5">
        <SectionTitle
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> Employer accounts
            </span>
          }
          sub="Some employers (Workday, iCIMS, Taleo…) require a candidate account per company. Ferry creates them with your email and your application password (or a generated one), confirms them from your inbox, and signs in with them on later applications."
        />
        {!accts ? (
          <Spinner />
        ) : accts.length ? (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="text-left text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">Employer site</th>
                  <th className="py-2 font-medium">Login</th>
                  <th className="py-2 font-medium">Password</th>
                  <th className="py-2 font-medium">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accts.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-line/70 last:border-0"
                  >
                    <td className="py-2.5 font-medium">{a.host}</td>
                    <td className="py-2.5">{a.email}</td>
                    <td className="py-2.5 font-mono text-[12px]">
                      {shown[a.id] ?? "••••••••••••"}
                      {!shown[a.id] && (
                        <button
                          className="ml-2 inline-flex items-center text-muted hover:text-ink"
                          aria-label="Reveal password"
                          onClick={async () =>
                            setShown({
                              ...shown,
                              [a.id]: (await reveal(a.id).unwrap()).password,
                            })
                          }
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                    <td className="py-2.5">
                      <Badge
                        tone={
                          a.status === "active"
                            ? "kelp"
                            : a.status === "failed"
                              ? "coral"
                              : "amber"
                        }
                      >
                        {a.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        className="rounded-md p-1.5 text-muted hover:bg-coral-soft hover:text-coral"
                        aria-label="Forget account"
                        onClick={() => del(a.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={<KeyRound className="h-5 w-5" />}
            title="No employer accounts yet"
            sub="They're created automatically the first time an employer asks for one."
          />
        )}
      </Card>
    </>
  );
}

// ---------- Texts & notifications ----------

const urlB64 = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export function MessagingSettings() {
  const { data: m } = useMessagingQuery();
  const [send, { isLoading: sending }] = useSendPhoneCodeMutation();
  const [verify, { isLoading: verifying }] = useVerifyPhoneMutation();
  const [save] = useSaveMessagingPrefsMutation();
  const [remove] = useRemovePhoneMutation();
  const [simulate, { isLoading: simulating }] = useSimulateTextMutation();
  const { data: pk } = usePushKeyQuery();
  const [subscribe] = usePushSubscribeMutation();
  const [pushTest] = usePushTestMutation();
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("imessage");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [msg, setMsg] = useState("matches");
  const [convo, setConvo] = useState<{ me: string; ferry: string }[]>([]);
  if (!m) return <Spinner />;

  const enablePush = async () => {
    try {
      if (isNative()) {
        if (!(await initNativePush((u) => (window.location.href = u))))
          throw new Error(
            "Notifications are turned off for Ferry in system settings",
          );
        toast("Notifications are on", "success");
        return;
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("This browser doesn't support push notifications");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted")
        throw new Error("Notifications are blocked for this site");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64(pk!.key),
      });
      await subscribe(sub.toJSON()).unwrap();
      await pushTest().unwrap();
      toast("Browser notifications are on", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          title={
            <span className="flex items-center gap-2">
              <MessageSquareText className="h-4 w-4" /> Apply by text
            </span>
          }
          sub="Ferry texts you when a strong match drops. Reply YES to apply, SKIP to pass, MATCHES for the top three, STATUS for a summary."
        />
        {m.verified ? (
          <div className="flex items-center justify-between rounded-xl border border-line p-3">
            <div>
              <p className="text-[14px] font-medium">{m.phone}</p>
              <p className="text-[12px] text-muted">
                via {m.prefs.channel} ·{" "}
                {m.providers[m.prefs.channel ?? "sms"] === "log"
                  ? "provider not configured: texts are logged below"
                  : "live"}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => remove()}>
              Remove
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (!codeSent) {
                  const r = await send({ phone, channel }).unwrap();
                  setCodeSent(true);
                  toast(
                    r.provider === "log"
                      ? "No SMS provider configured: the code is in the message log below"
                      : `Code sent to ${r.to}`,
                    "info",
                  );
                } else {
                  await verify({ code }).unwrap();
                  toast("Phone verified", "success");
                }
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            }}
          >
            <Segmented
              value={channel}
              onChange={setChannel}
              options={[
                { value: "imessage", label: "iMessage" },
                { value: "whatsapp", label: "WhatsApp" },
                { value: "sms", label: "SMS" },
              ]}
            />
            <div className="flex gap-2">
              <Input
                type="tel"
                required
                placeholder="+1 415 555 0142"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={codeSent}
              />
              {codeSent && (
                <Input
                  className="w-32"
                  required
                  placeholder="Code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={sending || verifying}
            >
              {codeSent ? "Verify" : "Send code"}
            </Button>
          </form>
        )}
        <div className="mt-3 divide-y divide-line">
          <Toggle
            checked={m.prefs.matchAlerts}
            onChange={(v) => save({ matchAlerts: v })}
            label="New match alerts"
            sub={`Texts for matches at or above ${m.prefs.minScore}% (at most one every 20 minutes, 5 a day).`}
          />
          <div className="py-3">
            <Label>
              Alert threshold <b className="text-ink">{m.prefs.minScore}%</b>
            </Label>
            <input
              type="range"
              min={50}
              max={95}
              step={5}
              value={m.prefs.minScore}
              onChange={(e) => save({ minScore: Number(e.target.value) })}
              className="w-full accent-ink"
            />
          </div>
          <Toggle
            checked={m.prefs.statusUpdates}
            onChange={(v) => save({ statusUpdates: v })}
            label="Status updates"
            sub="When an application needs you, is submitted, or a recruiter replies."
          />
          <Toggle
            checked={m.prefs.emailDigest}
            onChange={(v) => save({ emailDigest: v })}
            label="Email digest of new matches"
          />
        </div>
      </Card>
      <div className="space-y-5">
        <Card className="p-5">
          <SectionTitle
            title={
              <span className="flex items-center gap-2">
                <Bell className="h-4 w-4" /> Browser & phone notifications
              </span>
            }
            sub="Push alerts on this device. On iPhone, add Ferry to your home screen first (Share → Add to Home Screen)."
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={enablePush} disabled={!pk}>
              Enable notifications
            </Button>
            <Button
              variant="ghost"
              onClick={async () =>
                toast(
                  `Sent to ${(await pushTest().unwrap()).sent} device(s)`,
                  "info",
                )
              }
            >
              Send a test
            </Button>
          </div>
        </Card>
        <Card className="p-5">
          <SectionTitle
            title="Try a reply"
            sub="Exactly what happens when you text Ferry."
          />
          <div className="mb-3 max-h-56 space-y-2 overflow-y-auto">
            {convo.map((c, i) => (
              <div key={i} className="space-y-1.5">
                <p className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-sea px-3 py-1.5 text-[13px] text-white">
                  {c.me}
                </p>
                <p className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-paper px-3 py-1.5 text-[13px] whitespace-pre-wrap">
                  {c.ferry}
                </p>
              </div>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await simulate({ text: msg }).unwrap();
              setConvo([...convo, { me: msg, ferry: r.reply }]);
              setMsg("");
            }}
          >
            <Input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="MATCHES, YES, APPLY 1, STATUS…"
            />
            <Button type="submit" loading={simulating}>
              Send
            </Button>
          </form>
        </Card>
        {m.log.length > 0 && (
          <Card className="p-5">
            <SectionTitle title="Recent texts" />
            <ul className="space-y-2 text-[12.5px]">
              {m.log.slice(0, 8).map((l, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate">{l.body}</span>
                  <span className="shrink-0 text-faint">
                    {l.channel} · {l.status}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------- Security ----------

export function SecuritySettings() {
  const { data: me } = useMeQuery();
  const [change, { isLoading }] = useChangePasswordMutation();
  const [rotate] = useRotateApiTokenMutation();
  const [logoutAll] = useLogoutAllMutation();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  if (!me) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />{" "}
              {me.hasPassword ? "Change password" : "Set a password"}
            </span>
          }
        />
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await change({
                current: cur || undefined,
                password: pw,
              }).unwrap();
              toast("Password saved", "success");
              setCur("");
              setPw("");
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          }}
        >
          {me.hasPassword && (
            <Input
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          )}
          <Input
            type="password"
            required
            placeholder="New password (10+ characters)"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={isLoading}>
            Save
          </Button>
        </form>
      </Card>
      <Card className="p-5">
        <SectionTitle
          title="API token"
          sub="Used by the MCP server, CLI, and Chrome extension. Rotating it disconnects them until you paste the new one."
        />
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={async () => {
              await rotate().unwrap();
              toast("New API token issued", "success");
            }}
          >
            Rotate token
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await logoutAll().unwrap();
              toast("Signed out of every browser", "success");
              window.location.href = "/login";
            }}
          >
            Sign out everywhere
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------- Billing ----------

export function BillingSettings() {
  const { data: wallet } = useWalletQuery();
  const { data: plans } = usePlansQuery();
  const [checkout, { isLoading }] = useCheckoutMutation();
  const [portal, { isLoading: opening }] = useBillingPortalMutation();
  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <p className="text-[13px] text-muted">Application credits</p>
          <p className="text-[34px] leading-tight font-semibold tabular-nums">
            {wallet?.credits ?? "—"}
          </p>
          <p className="text-[12px] text-faint">
            One credit per submitted application. Dry runs and failures are
            free.
            {wallet?.renewsAt &&
              ` Renews ${new Date(wallet.renewsAt).toLocaleDateString()}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="ink" className="capitalize">
            {wallet?.plan} plan
          </Badge>
          {wallet?.stripe && wallet.plan !== "free" && (
            <Button
              size="sm"
              loading={opening}
              onClick={async () =>
                (window.location.href = (await portal().unwrap()).url)
              }
            >
              Manage billing
            </Button>
          )}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {plans?.map((p) => (
          <Card
            key={p.id}
            className={cx("relative p-5", p.popular && "border-ink")}
          >
            {p.popular && (
              <Badge tone="signal" className="absolute top-4 right-4">
                Most popular
              </Badge>
            )}
            <p className="font-semibold">{p.name}</p>
            <p className="mt-2">
              <span className="text-[32px] font-semibold">${p.price}</span>
              <span className="text-muted"> / month</span>
            </p>
            <p className="text-[13px] text-muted">
              {p.credits.toLocaleString()} applications per 30 days
            </p>
            <p className="mt-2 text-[13px]">{p.blurb}</p>
            <Button
              className="mt-4 w-full"
              variant={p.popular ? "primary" : "secondary"}
              loading={isLoading}
              icon={<Zap className="h-4 w-4" />}
              onClick={async () => {
                try {
                  const r = await checkout({ plan: p.id }).unwrap();
                  if (r.url) window.location.href = r.url;
                  else toast(`Switched to ${p.name}`, "success");
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              {wallet?.plan === p.id ? "Current plan" : `Choose ${p.name}`}
            </Button>
          </Card>
        ))}
      </div>
      {!wallet?.stripe && (
        <p className="text-[12px] text-faint">
          Stripe isn't configured on this server, so choosing a plan grants its
          credits directly. Set STRIPE_SECRET_KEY, the STRIPE_PRICE_* ids, and
          STRIPE_WEBHOOK_SECRET to charge for real.
        </p>
      )}
      <Card className="p-5">
        <SectionTitle title="Credit history" />
        <ul className="divide-y divide-line text-[13px]">
          {wallet?.ledger.map((l, i) => (
            <li key={i} className="flex justify-between py-2">
              <span>{l.reason.replace(/_/g, " ")}</span>
              <span
                className={cx(
                  "tabular-nums",
                  l.delta > 0 ? "text-kelp" : "text-ink-2",
                )}
              >
                {l.delta > 0 ? "+" : ""}
                {l.delta} ·{" "}
                <span className="text-faint">
                  {timeAgo(l.created_at.replace(" ", "T") + "Z")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
