import { useEffect, useState } from "react";
import { Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import {
  errorMessage,
  useAnswerBuiltinsQuery,
  useDraftAnswerMutation,
  useProfileQuery,
  useSaveProfileMutation,
  useSaveSettingsMutation,
  useSettingsQuery,
} from "../lib/api";
import type { AnswerEntry } from "../lib/types";
import { PageHeader } from "../components/AppLayout";
import { toast } from "../components/toast";
import {
  Badge,
  Button,
  Card,
  cx,
  Input,
  SectionTitle,
  Segmented,
  Spinner,
  Textarea,
  Toggle,
} from "../components/ui";

const rid = () => Math.random().toString(16).slice(2, 10);

export default function AnswersPage() {
  const { data: profile } = useProfileQuery();
  const { data: settings } = useSettingsQuery();
  const { data: builtins } = useAnswerBuiltinsQuery();
  const [saveSettings] = useSaveSettingsMutation();
  const [save, { isLoading: saving }] = useSaveProfileMutation();
  const [library, setLibrary] = useState<AnswerEntry[] | null>(null);
  const [learned, setLearned] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (profile && !dirty) {
      setLibrary(structuredClone(profile.library));
      setLearned({ ...profile.answers });
    }
  }, [profile, dirty]);

  if (!library || !settings)
    return <Spinner className="mx-auto mt-24 h-6 w-6" />;
  const hint = (id?: string) => builtins?.find((b) => b.id === id)?.hint;
  const setEntry = (i: number, p: Partial<AnswerEntry>) => {
    setDirty(true);
    setLibrary(library.map((e, j) => (j === i ? { ...e, ...p } : e)));
  };
  const persist = async () => {
    try {
      await save({
        library: library.filter((e) => e.question.trim()),
        answers: learned,
      }).unwrap();
      setDirty(false);
      toast("Answers saved", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <PageHeader
        title="Answers"
        sub="What Ferry says when an application asks you something. Answer once, or let Ferry write a fresh one for each job."
        action={
          <Button
            variant="primary"
            disabled={!dirty}
            loading={saving}
            onClick={persist}
          >
            Save answers
          </Button>
        }
      />

      <Card className="mb-5 px-5 py-1">
        <Toggle
          checked={settings.autoWriteAnswers}
          onChange={(v) => saveSettings({ autoWriteAnswers: v })}
          label="Write answers to open-ended questions for each job"
          sub={
            settings.autoWriteAnswers
              ? 'Questions like "Why are you interested in joining {company}?" get an answer written from the posting and your résumé. You see them before anything is sent unless auto-submit is on.'
              : 'Open-ended questions without a saved answer go to "Needs you".'
          }
        />
      </Card>

      <div className="space-y-3">
        {library
          .map((e, i) => ({
            e,
            i,
            rank: e.builtin
              ? (builtins?.findIndex((b) => b.id === e.builtin) ?? 0)
              : 100 + i,
          }))
          .sort((a, b) => a.rank - b.rank)
          .map(({ e, i }) => (
            <AnswerCard
              key={e.id}
              entry={e}
              hint={hint(e.builtin)}
              autoWrite={settings.autoWriteAnswers}
              onChange={(p) => setEntry(i, p)}
              onDelete={
                e.builtin
                  ? undefined
                  : () => {
                      setDirty(true);
                      setLibrary(library.filter((_, j) => j !== i));
                    }
              }
            />
          ))}
        <button
          type="button"
          onClick={() => {
            setDirty(true);
            setLibrary([
              ...library,
              { id: rid(), question: "", mode: "fixed", answer: "" },
            ]);
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line-2 py-3 text-[13.5px] font-medium text-ink-2 hover:border-ink hover:text-ink"
        >
          <Plus className="h-4 w-4" /> Add a question you get asked
        </button>
      </div>

      <Card className="mt-8 p-5">
        <SectionTitle
          title="Learned answers"
          sub="Facts you typed into earlier applications. Ferry reuses them on matching questions. Job-specific answers aren't kept here."
        />
        {Object.keys(learned).length ? (
          <div className="divide-y divide-line rounded-xl border border-line">
            {Object.entries(learned).map(([q, a]) => (
              <div
                key={q}
                className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start"
              >
                <p className="text-[13px] font-medium capitalize">{q}</p>
                <Textarea
                  rows={2}
                  className="min-h-0"
                  value={a}
                  onChange={(ev) => {
                    setDirty(true);
                    setLearned({ ...learned, [q]: ev.target.value });
                  }}
                />
                <button
                  onClick={() => {
                    const next = { ...learned };
                    delete next[q];
                    setDirty(true);
                    setLearned(next);
                  }}
                  className="justify-self-end rounded-md p-1.5 text-muted hover:bg-coral-soft hover:text-coral"
                  aria-label="Forget answer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            Nothing yet. What you type on "Needs you" applications lands here.
          </p>
        )}
      </Card>
    </>
  );
}

function AnswerCard({
  entry,
  hint,
  autoWrite,
  onChange,
  onDelete,
}: {
  entry: AnswerEntry;
  hint?: string;
  autoWrite: boolean;
  onChange: (p: Partial<AnswerEntry>) => void;
  onDelete?: () => void;
}) {
  const [draft, { isLoading }] = useDraftAnswerMutation();
  const [sample, setSample] = useState<{
    text: string;
    where: string;
    method: string;
  } | null>(null);
  const write = entry.mode === "write";
  const status = write
    ? autoWrite
      ? { tone: "sea" as const, text: "Written for each job" }
      : { tone: "ink" as const, text: "Auto-write is off: you'll be asked" }
    : entry.answer.trim()
      ? { tone: "kelp" as const, text: "Uses your answer" }
      : { tone: "amber" as const, text: "Not answered yet: you'll be asked" };

  const tryIt = async () => {
    try {
      const r = await draft({
        question: entry.question,
        notes: entry.answer,
        builtin: entry.builtin,
      }).unwrap();
      setSample({
        text:
          r.answer ||
          "(Nothing to write from yet. Add notes, or this one needs your own answer.)",
        where: `${r.job.title} at ${r.job.company}`,
        method: r.method,
      });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          {entry.builtin ? (
            <p className="text-[14.5px] font-semibold">
              {entry.question.replace("{company}", "___")}
            </p>
          ) : (
            <Input
              className="text-[14px] font-semibold"
              value={entry.question}
              placeholder="Type the question, e.g. Are you comfortable with on-call?"
              onChange={(e) => onChange({ question: e.target.value })}
            />
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.text}</Badge>
            {entry.builtin && (
              <span className="text-[12px] text-faint">
                Matches the usual phrasings of this question
              </span>
            )}
          </div>
        </div>
        <Segmented
          value={entry.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: "write", label: "Write per job" },
            { value: "fixed", label: "Use my answer" },
          ]}
        />
        {onDelete && (
          <button
            onClick={onDelete}
            aria-label="Remove question"
            className="rounded-md p-1.5 text-muted hover:bg-coral-soft hover:text-coral"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mt-3">
        <Textarea
          rows={write ? 2 : 3}
          className={cx("min-h-0", write && "text-[13px]")}
          value={entry.answer}
          onChange={(e) => onChange({ answer: e.target.value })}
          placeholder={
            write
              ? (hint ?? "Anything Ferry should always work in (optional)")
              : "Your answer. {company} and {role} are filled in for each job."
          }
        />
        <p className="mt-1 text-[12px] text-faint">
          {write
            ? "Notes, not the answer: Ferry writes the answer itself from the posting and your profile, and works these in."
            : 'Use {company} and {role} to personalize, e.g. "I\'d love to bring my payments work to {company}."'}
        </p>
      </div>

      {write && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="ghost"
            loading={isLoading}
            icon={<Wand2 className="h-3.5 w-3.5" />}
            onClick={tryIt}
            disabled={!entry.question.trim()}
          >
            Preview for a matched job
          </Button>
          {sample && (
            <div className="mt-2 rounded-xl border border-line bg-paper/50 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
                <Sparkles className="h-3.5 w-3.5" /> {sample.where}
                {sample.method === "template" &&
                  " · drafted from your résumé (add an Anthropic key for fully written answers)"}
              </p>
              <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">
                {sample.text}
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
