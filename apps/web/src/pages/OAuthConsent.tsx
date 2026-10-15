import { useState } from "react";
import { useSearchParams } from "react-router";
import { ShieldCheck } from "lucide-react";
import { errorMessage, useMeQuery, useOauthApproveMutation, useOauthClientQuery } from "../lib/api";
import { Button, Card, Spinner } from "../components/ui";

/**
 * "Allow this app to use Ferry?": the consent step of the OAuth flow MCP clients (Claude Desktop, Claude Code,
 * claude.ai) start. Seeing your jobs and applications is always included; acting for you is a separate choice.
 */
export default function OAuthConsent() {
  const [q] = useSearchParams();
  const clientId = q.get("client_id") ?? "";
  const { data: me } = useMeQuery();
  const { data: client, isLoading, isError } = useOauthClientQuery(clientId, { skip: !clientId });
  const [approve, { isLoading: sending }] = useOauthApproveMutation();
  const [act, setAct] = useState((q.get("scope") ?? "").includes("jobs:apply"));
  const [err, setErr] = useState("");

  const decide = async (allow: boolean) => {
    setErr("");
    try {
      const r = await approve({
        client_id: clientId,
        redirect_uri: q.get("redirect_uri") ?? "",
        code_challenge: q.get("code_challenge") ?? "",
        state: q.get("state") ?? undefined,
        scope: act ? "jobs:read jobs:apply" : "jobs:read",
        allow,
      }).unwrap();
      window.location.href = r.redirect;
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-paper px-4">
      <Card className="w-full max-w-[440px] p-6">
        {isLoading ? (
          <Spinner className="mx-auto my-10 h-6 w-6" />
        ) : isError || !client ? (
          <p className="text-[14px]">This connection request isn't valid any more. Start connecting again from your app.</p>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-sea/10 text-sea">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-[18px] font-semibold">Allow {client.name} to use Ferry?</h1>
                <p className="text-[13px] text-muted">Signed in as {me?.email}</p>
              </div>
            </div>
            <ul className="mb-4 space-y-2 text-[14px]">
              <li className="flex gap-2">
                <input type="checkbox" checked disabled className="mt-1 accent-ink" />
                <span>See your job matches, applications, inbox, and profile.</span>
              </li>
              <li>
                <label className="flex cursor-pointer gap-2">
                  <input type="checkbox" checked={act} onChange={(e) => setAct(e.target.checked)} className="mt-1 accent-ink" />
                  <span>
                    Act for you: queue applications, answer questions, and update your profile.{" "}
                    <span className="text-muted">Applications still wait for your approval before they're submitted, unless you turned on auto-submit.</span>
                  </span>
                </label>
              </li>
            </ul>
            <p className="mb-4 text-[12.5px] text-muted">
              It will send you back to <span className="font-mono">{client.redirect_hosts.join(", ")}</span>. You can disconnect it any time in Settings → MCP · CLI · Extension.
            </p>
            {err && <p className="mb-3 text-[13px] text-danger">{err}</p>}
            <div className="flex gap-2">
              <Button variant="primary" loading={sending} onClick={() => decide(true)}>
                Allow
              </Button>
              <Button disabled={sending} onClick={() => decide(false)}>
                Deny
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
