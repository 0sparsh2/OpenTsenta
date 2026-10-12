import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ClipboardPaste, Copy, Inbox as InboxIcon, Link2, MailPlus, PenLine, RefreshCw } from "lucide-react";
import { errorMessage, useDraftReplyMutation, useGmailQuery, useMailQuery, useGmailSyncMutation, useInboxQuery, useIngestEmailMutation, useMarkReadMutation } from "../lib/api";
import type { InboxMessage } from "../lib/types";
import { PageHeader } from "../components/AppLayout";
import { toast } from "../components/toast";
import { Badge, Button, Card, cx, Empty, Input, Label, Spinner, Textarea, timeAgo, type Tone } from "../components/ui";

const CAT: Record<string, { label: string; tone: Tone }> = {
  confirmation: { label: "Confirmation", tone: "ink" },
  interview: { label: "Interview", tone: "kelp" },
  assessment: { label: "Assessment", tone: "sea" },
  rejection: { label: "Rejection", tone: "coral" },
  offer: { label: "Offer", tone: "amber" },
  recruiter_reply: { label: "Recruiter", tone: "sea" },
  verification_code: { label: "Code", tone: "ink" },
  other: { label: "Other", tone: "ink" },
};

function PasteEmail({ onDone }: { onDone: () => void }) {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ingest, { isLoading }] = useIngestEmailMutation();
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await ingest({ from, subject, body }).unwrap();
          toast(r.ignored ? "That email doesn't look job-related, so it wasn't filed." : `Filed as ${CAT[r.message?.category ?? "other"].label}`, r.ignored ? "info" : "success");
          if (!r.ignored) onDone();
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label>From</Label>
          <Input required value={from} onChange={(e) => setFrom(e.target.value)} placeholder="recruiter@company.com" />
        </div>
        <div>
          <Label>Subject</Label>
          <Input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Next steps…" />
        </div>
      </div>
      <div>
        <Label>Body</Label>
        <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the email here" />
      </div>
      <Button type="submit" variant="primary" loading={isLoading} icon={<ClipboardPaste className="h-4 w-4" />}>
        File it
      </Button>
    </form>
  );
}

function Reader({ m }: { m: InboxMessage }) {
  const [draft, { isLoading }] = useDraftReplyMutation();
  const [text, setText] = useState(m.draftReply ?? "");
  useEffect(() => setText(m.draftReply ?? ""), [m.id, m.draftReply]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-5 py-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {m.category && <Badge tone={CAT[m.category]?.tone}>{CAT[m.category]?.label}</Badge>}
          {m.company && <span className="text-[12px] text-muted">{m.company}</span>}
        </div>
        <h2 className="text-[17px] font-semibold">{m.subject}</h2>
        <p className="text-[13px] text-muted">
          {m.fromName} &lt;{m.fromAddr}&gt; · {new Date(m.receivedAt).toLocaleString()}
        </p>
        {m.application?.job && (
          <Link to={`/app/applications/${m.application.id}`} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-paper px-2.5 py-1 text-[12px] hover:bg-ink/5">
            <Link2 className="h-3.5 w-3.5" /> Routed to {m.application.job.title} · {m.application.job.company}
          </Link>
        )}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4 text-[14px] leading-relaxed whitespace-pre-wrap">{m.body}</div>
      <div className="border-t border-line px-5 py-4">
        {text ? (
          <>
            <Label hint="saved as a draft: Ferry never sends email for you">Suggested reply</Label>
            <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button
                icon={<Copy className="h-4 w-4" />}
                onClick={() => {
                  void navigator.clipboard?.writeText(text);
                  toast("Copied", "success");
                }}
              >
                Copy reply
              </Button>
            </div>
          </>
        ) : (
          <Button loading={isLoading} icon={<PenLine className="h-4 w-4" />} onClick={async () => setText((await draft(m.id).unwrap()).draft)}>
            Draft a reply
          </Button>
        )}
      </div>
    </div>
  );
}

export default function Inbox() {
  const { data: msgs, isLoading } = useInboxQuery();
  const { data: gmail } = useGmailQuery();
  const { data: mailState } = useMailQuery();
  const [sync, { isLoading: syncing }] = useGmailSyncMutation();
  const [markRead] = useMarkReadMutation();
  const [sel, setSel] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const current = msgs?.find((m) => m.id === sel) ?? msgs?.[0];
  useEffect(() => {
    if (current && !current.read) void markRead(current.id);
  }, [current, markRead]);

  return (
    <>
      <PageHeader
        title="Inbox"
        sub="Recruiter replies, routed to the right application. Status moves on its own."
        action={
          <div className="flex gap-2">
            <Button icon={<MailPlus className="h-4 w-4" />} onClick={() => setPaste((p) => !p)}>
              Paste an email
            </Button>
            {gmail?.connected || mailState?.imap ? (
              <Button loading={syncing} icon={<RefreshCw className="h-4 w-4" />} onClick={async () => toast(`Synced ${(await sync().unwrap()).synced} new emails`, "success")}>
                Sync Gmail
              </Button>
            ) : (
              <Link to="/app/settings?tab=email">
                <Button variant="primary">Connect your inbox</Button>
              </Link>
            )}
          </div>
        }
      />
      {paste && (
        <Card className="mb-5 p-4">
          <PasteEmail onDone={() => setPaste(false)} />
        </Card>
      )}
      <Card className="overflow-hidden">
        {isLoading ? (
          <Spinner className="mx-auto my-16 h-6 w-6" />
        ) : !msgs?.length ? (
          <Empty
            icon={<InboxIcon className="h-5 w-5" />}
            title="No job email yet"
            sub="Connect your inbox (Settings → Email) and Ferry files confirmations, interview requests, and rejections automatically. You can also paste an email."
          />
        ) : (
          <div className="grid grid-cols-1 min-h-[560px] md:grid-cols-[340px_minmax(0,1fr)]">
            <ul className="scroll-thin max-h-[70vh] divide-y divide-line overflow-y-auto border-b border-line md:max-h-none md:border-r md:border-b-0">
              {msgs.map((m) => (
                <li key={m.id}>
                  <button onClick={() => setSel(m.id)} className={cx("w-full px-4 py-3 text-left hover:bg-paper", current?.id === m.id && "bg-paper")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={cx("truncate text-[13px]", !m.read ? "font-semibold" : "text-ink-2")}>{m.fromName || m.fromAddr}</span>
                      <span className="shrink-0 text-[11px] text-faint">{timeAgo(m.receivedAt)}</span>
                    </div>
                    <p className={cx("truncate text-[13px]", !m.read && "font-medium")}>{m.subject}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      {m.category && <Badge tone={CAT[m.category]?.tone} className="text-[11px]">{CAT[m.category]?.label}</Badge>}
                      <span className="truncate text-[12px] text-muted">{m.snippet}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-h-[420px]">{current && <Reader m={current} />}</div>
          </div>
        )}
      </Card>
    </>
  );
}
