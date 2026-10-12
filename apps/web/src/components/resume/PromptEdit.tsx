import { useState } from "react";
import { CornerDownLeft, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import { errorMessage, useModifyResumeMutation } from "../../lib/api";
import type { ResumeDoc } from "../../lib/types";
import { Button, cx } from "../ui";

const SUGGESTIONS = ["Make it one page", "Drop the internship", "Lead with my most relevant work", "Move education to the top", "Shorten the bullets", "Use the serif template", "Hide my phone number"];

/** Type what to change; Ferry edits the blocks, shows what it did, and offers an undo. */
export function PromptEdit({ doc, onApply, applicationId, className }: { doc: ResumeDoc; onApply: (d: ResumeDoc) => void; applicationId?: string; className?: string }) {
  const [modify, { isLoading }] = useModifyResumeMutation();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ prompt: string; changes: string[]; reply: string; warnings: string[]; before: ResumeDoc } | null>(null);

  const run = async (text = prompt) => {
    const p = text.trim();
    if (!p || isLoading) return;
    try {
      const r = await modify({ doc, prompt: p, applicationId }).unwrap();
      setResult({ prompt: p, changes: r.changes, reply: r.reply, warnings: r.warnings, before: doc });
      if (r.changes.length) onApply(r.doc);
      setPrompt("");
    } catch (e) {
      setResult({ prompt: p, changes: [], reply: errorMessage(e), warnings: [], before: doc });
    }
  };

  return (
    <div className={cx("rounded-xl border border-line bg-card p-3", className)}>
      <label htmlFor="resume-prompt" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
        <Sparkles className="h-4 w-4 text-signal" /> Ask Ferry to change this résumé
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="resume-prompt"
          rows={1}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run();
            }
          }}
          placeholder='e.g. "Make it one page and drop the internship"'
          className="min-h-9 flex-1 resize-none rounded-lg border border-line bg-card px-3 py-2 text-sm leading-snug placeholder:text-faint focus:border-sea focus:ring-3 focus:ring-sea/15 focus:outline-none"
        />
        <Button variant="primary" loading={isLoading} disabled={!prompt.trim()} onClick={() => run()} icon={<CornerDownLeft className="h-4 w-4" />}>
          Apply
        </Button>
      </div>
      {!result && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={isLoading} onClick={() => run(s)} className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink-2 hover:border-ink hover:text-ink disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
      )}
      {result && (
        <div className="mt-2.5 rounded-lg bg-paper/70 px-3 py-2 text-[13px]" aria-live="polite">
          <p className="text-[12px] text-muted">“{result.prompt}”</p>
          {result.changes.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {result.changes.map((c, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-kelp">✓</span>
                  {c}
                </li>
              ))}
            </ul>
          )}
          {result.reply && <p className={cx("mt-1", result.changes.length ? "text-muted" : "text-ink-2")}>{result.reply}</p>}
          {result.warnings.map((w) => (
            <p key={w} className="mt-1 flex items-start gap-1.5 text-amber">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </p>
          ))}
          <div className="mt-1.5 flex gap-3">
            {result.changes.length > 0 && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink"
                onClick={() => {
                  onApply(result.before);
                  setResult(null);
                }}
              >
                <Undo2 className="h-3.5 w-3.5" /> Undo
              </button>
            )}
            <button type="button" className="text-[12.5px] text-muted hover:text-ink" onClick={() => setResult(null)}>
              {result.changes.length ? "Keep" : "Dismiss"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
