import { useState } from "react";
import { useSearchParams } from "react-router";
import { AccountsSettings, BillingSettings, EmailSettings, MessagingSettings, SecuritySettings } from "./settings-extra";
import { Check, Copy, Globe, Plug, RefreshCw, Terminal, Zap } from "lucide-react";
import { errorMessage, useAddSourceMutation, useCheckoutMutation, useMeQuery, usePlansQuery, usePollNowMutation, useSaveSettingsMutation, useSettingsQuery, useSourcesQuery, useWalletQuery } from "../lib/api";
import { PageHeader } from "../components/AppLayout";
import { toast } from "../components/toast";
import { Badge, Button, Card, cx, Input, Label, SectionTitle, Segmented, Spinner, Tabs, timeAgo, Toggle } from "../components/ui";

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative">
      <pre className="scroll-thin overflow-x-auto rounded-lg bg-ink px-3.5 py-3 pr-11 font-mono text-[12.5px] leading-relaxed text-paper">{text}</pre>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="absolute top-2 right-2 rounded-md p-1.5 text-paper/70 hover:bg-white/10 hover:text-paper"
        aria-label="Copy"
      >
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Automation() {
  const { data: s } = useSettingsQuery();
  const [save] = useSaveSettingsMutation();
  if (!s) return <Spinner />;
  const modes = [
    { value: "off" as const, label: "Off" },
    { value: "honest" as const, label: "Honest" },
    { value: "aggressive" as const, label: "Aggressive" },
  ];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle title="Tailoring" sub="Honest rephrases and reorders; aggressive leads harder with outcomes. Neither invents facts." />
        <div className="space-y-4">
          <div>
            <Label>Résumé</Label>
            <Segmented value={s.optimizationMode} options={modes} onChange={(v) => save({ optimizationMode: v })} />
          </div>
          <div>
            <Label>Cover letter</Label>
            <Segmented value={s.coverLetterMode} options={modes} onChange={(v) => save({ coverLetterMode: v })} />
          </div>
        </div>
        <div className="mt-3 divide-y divide-line">
          <Toggle
            checked={!s.autoApproveResume}
            onChange={(v) => save({ autoApproveResume: !v })}
            label="Preview the tailored résumé before applying"
            sub="Ferry tailors, then pauses so you can look, edit, or ask for changes before it fills anything in. You can also choose this per job."
          />
          <Toggle checked={s.autoApproveCoverLetter} onChange={(v) => save({ autoApproveCoverLetter: v })} label="Auto-approve cover letters" />
          <Toggle checked={s.autoSubmitApplication} onChange={(v) => save({ autoSubmitApplication: v })} label="Submit without asking" sub="Off (recommended): Ferry fills the form, then waits for your approval before the final submit." />
          <Toggle checked={s.allowAccountCreation} onChange={(v) => save({ allowAccountCreation: v })} label="Create employer accounts for me" sub="When an employer (Workday, iCIMS...) requires a candidate account, create one with your email and a generated password, and verify it from your inbox." />
        </div>
      </Card>
      <Card className="p-5">
        <SectionTitle title="Auto-apply" sub="Queue new matches automatically as the watcher finds them." />
        <Toggle checked={s.autoApply} onChange={(v) => save({ autoApply: v })} label="Auto-apply to strong matches" sub="Each application still follows the review settings on the left." />
        <div className={cx("mt-2 space-y-4", !s.autoApply && "pointer-events-none opacity-50")}>
          <div>
            <Label>
              Minimum fit <span className="font-semibold text-ink">{s.autoApplyMinScore}%</span>
            </Label>
            <input type="range" min={50} max={95} step={5} value={s.autoApplyMinScore} onChange={(e) => save({ autoApplyMinScore: Number(e.target.value) })} className="w-full accent-ink" />
          </div>
          <div>
            <Label>Daily limit</Label>
            <Input type="number" min={1} max={200} value={s.autoApplyDailyLimit} onChange={(e) => save({ autoApplyDailyLimit: Number(e.target.value) || 1 })} className="w-28" />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Sources() {
  const { data, isLoading } = useSourcesQuery();
  const [add, { isLoading: adding }] = useAddSourceMutation();
  const [poll, { isLoading: polling }] = usePollNowMutation();
  const [url, setUrl] = useState("");
  if (isLoading || !data) return <Spinner />;
  return (
    <Card className="p-5">
      <SectionTitle
        title={`Watching ${data.companies.length} career pages`}
        sub={
          data.poller.lastRun
            ? `Last sweep ${timeAgo(data.poller.lastRun.at)} · ${data.poller.lastRun.newJobs} new roles · every ${data.poller.intervalMin} min`
            : `Sweeps every ${data.poller.intervalMin} min`
        }
        action={
          <Button loading={polling || data.poller.running} icon={<RefreshCw className="h-4 w-4" />} onClick={() => poll()}>
            Sweep now
          </Button>
        }
      />
      <form
        className="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const c = await add({ url }).unwrap();
            toast(`Watching ${c.name}`, "success");
            setUrl("");
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        }}
      >
        <Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" required placeholder="Any job URL from a Greenhouse, Lever, Ashby, or SmartRecruiters board" />
        <Button type="submit" variant="primary" loading={adding}>
          Watch
        </Button>
      </form>
      <div className="scroll-thin max-h-[420px] overflow-y-auto rounded-xl border border-line">
        <table className="w-full text-[13px]">
          <tbody>
            {data.companies.map((c) => (
              <tr key={c.id} className="border-b border-line/70 last:border-0">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2 text-muted">{c.ats}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.job_count} roles</td>
                <td className="px-3 py-2 text-right text-faint">{c.last_error ? <Badge tone="coral">error</Badge> : timeAgo(c.last_polled_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Connect() {
  const { data: me } = useMeQuery();
  const origin = window.location.origin.replace(":5173", ":8787");
  const token = me?.token ?? "";
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle title={<span className="flex items-center gap-2"><Plug className="h-4 w-4" /> MCP server</span>} sub="Run your job search from Claude Code, Claude Desktop, Cursor, or any MCP client." />
        <Label>Claude Code</Label>
        <CopyBlock text={`claude mcp add --transport http ferry ${origin}/api/v1/mcp \\\n  --header "Authorization: Bearer ${token}"`} />
        <p className="mt-3 mb-1.5 text-[13px] text-muted">Then ask: "find new roles that fit me and apply to the top three."</p>
        <Label>Tools</Label>
        <div className="flex flex-wrap gap-1.5">
          {["get_job_matches", "search_jobs", "add_job_by_url", "apply_to_job", "list_applications", "get_application", "approve_application", "inbox", "get_profile"].map((t) => (
            <Badge key={t} className="font-mono text-[11px]">
              {t}
            </Badge>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <SectionTitle title={<span className="flex items-center gap-2"><Terminal className="h-4 w-4" /> CLI</span>} sub="Same agent from your terminal." />
        <CopyBlock text={`export FERRY_URL=${origin}\nexport FERRY_TOKEN=${token}\nnpx ferry matches\nnpx ferry apply <job-id>\nnpx ferry status`} />
        <SectionTitle title={<span className="mt-5 flex items-center gap-2"><Globe className="h-4 w-4" /> Chrome extension</span>} sub="Detects job postings on any site and adds them to Ferry in one click." />
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
          <li>
            Open <span className="font-mono">chrome://extensions</span> and turn on Developer mode.
          </li>
          <li>
            Load unpacked → choose <span className="font-mono">apps/extension</span>.
          </li>
          <li>Open this dashboard once; the extension picks up your session automatically.</li>
        </ol>
      </Card>
    </div>
  );
}

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "automation";
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
  return (
    <>
      <PageHeader title="Settings" sub="How much Ferry does on its own, where it looks, and how you connect to it." />
      <div className="mb-5">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "automation", label: "Automation" },
            { id: "sources", label: "Career pages" },
            { id: "email", label: "Email" },
            { id: "accounts", label: "Employer accounts" },
            { id: "texts", label: "Texts & alerts" },
            { id: "connect", label: "MCP · CLI · Extension" },
            { id: "billing", label: "Credits & plan" },
            { id: "security", label: "Security" },
          ]}
        />
      </div>
      {tab === "automation" && <Automation />}
      {tab === "sources" && <Sources />}
      {tab === "connect" && <Connect />}
      {tab === "email" && <EmailSettings />}
      {tab === "accounts" && <AccountsSettings />}
      {tab === "texts" && <MessagingSettings />}
      {tab === "billing" && <BillingSettings />}
      {tab === "security" && <SecuritySettings />}
    </>
  );
}
