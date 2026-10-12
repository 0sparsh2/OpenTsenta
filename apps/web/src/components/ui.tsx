import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import type { PipelineStatus, TrackedStatus } from "../lib/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- Logo ----------
export function Logo({ className = "", light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden>
        <rect width="64" height="64" rx="14" fill={light ? "#F6F4EF" : "#0E1B2C"} />
        <path d="M14 38h36l-6 9H20z" fill={light ? "#0E1B2C" : "#F6F4EF"} />
        <path d="M24 36V20l14 10-14 0" fill="#E8572A" />
        <path d="M10 50c5 0 5-3 10-3s5 3 10 3 5-3 10-3 5 3 10 3" stroke="#6FA8FF" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </svg>
      <span className={cx("text-[19px]", light ? "text-paper" : "text-ink")}>ferry</span>
    </span>
  );
}

// ---------- Button ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "signal" | "danger"; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background,box-shadow,transform] active:translate-y-px disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sea whitespace-nowrap",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-9 px-3.5 text-sm",
        size === "lg" && "h-11 px-5 text-[15px]",
        variant === "primary" && "bg-ink text-paper hover:bg-ink-2 shadow-card",
        variant === "signal" && "bg-signal text-white hover:brightness-105 shadow-card",
        variant === "secondary" && "bg-card text-ink border border-line hover:border-line-2 hover:bg-paper/60 shadow-card",
        variant === "ghost" && "text-ink-2 hover:bg-ink/5",
        variant === "danger" && "bg-card text-coral border border-line hover:bg-coral-soft",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ---------- Card ----------
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-2xl border border-line bg-card shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {sub && <p className="text-[13px] text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------- Form controls ----------
const fieldBase =
  "rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-faint shadow-[inset_0_1px_0_rgba(14,27,44,0.03)] focus:border-sea focus:outline-none focus:ring-3 focus:ring-sea/15 disabled:opacity-60";

/** Full width unless the caller sets its own width class. */
const widthOf = (className?: string) => (/(^|\s)(w-|min-w-|max-w-|flex-1)/.test(className ?? "") ? "" : "w-full");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, "h-9", widthOf(className), className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, "min-h-24 py-2 leading-relaxed", widthOf(className), className)} {...rest} />;
});
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(fieldBase, "h-9 pr-8", widthOf(className), className)} {...rest}>
      {children}
    </select>
  );
}
export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink-2">
      {children}
      {hint && <span className="ml-1.5 font-normal text-faint">{hint}</span>}
    </label>
  );
}
export function Toggle({ checked, onChange, label, sub, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; sub?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("flex cursor-pointer items-start justify-between gap-4 py-3", disabled && "opacity-50")}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {sub && <span className="block text-[13px] text-muted">{sub}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-kelp" : "bg-line-2")}
      >
        <span className={cx("absolute top-0.5 left-0 h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-paper p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx("h-7 rounded-md px-3 text-[13px] font-medium transition", value === o.value ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Tabs ----------
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
            value === t.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count != null && <span className={cx("rounded-full px-1.5 text-[11px] tabular-nums", value === t.id ? "bg-ink text-paper" : "bg-ink/5 text-muted")}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Badges ----------
const TONES = {
  ink: "bg-ink/6 text-ink-2",
  sea: "bg-sea-soft text-sea",
  kelp: "bg-kelp-soft text-kelp",
  amber: "bg-amber-soft text-amber",
  coral: "bg-coral-soft text-coral",
  signal: "bg-signal-soft text-signal",
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = "ink", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap", TONES[tone], className)}>
      {dot && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const STATUS_META: Record<PipelineStatus, { label: string; tone: Tone; live?: boolean }> = {
  QUEUED: { label: "Queued", tone: "ink" },
  OPTIMIZING: { label: "Tailoring", tone: "sea", live: true },
  OPTIMIZING_RESUME: { label: "Tailoring résumé", tone: "sea", live: true },
  OPTIMIZING_CL: { label: "Writing cover letter", tone: "sea", live: true },
  PENDING_RESUME_REVIEW: { label: "Review résumé", tone: "amber" },
  PENDING_CL_REVIEW: { label: "Review cover letter", tone: "amber" },
  PENDING_REVIEW: { label: "Needs review", tone: "amber" },
  PENDING_SUBMIT_REVIEW: { label: "Ready to send", tone: "amber" },
  NEEDS_INPUT: { label: "Needs you", tone: "signal" },
  READY: { label: "Starting", tone: "sea", live: true },
  RUNNING: { label: "Applying", tone: "sea", live: true },
  COMPLETED: { label: "Submitted", tone: "kelp" },
  FAILED: { label: "Failed", tone: "coral" },
  SKIPPED: { label: "Skipped", tone: "ink" },
};
export function StatusPill({ status, dryRun }: { status: PipelineStatus; dryRun?: boolean }) {
  const m = STATUS_META[status];
  if (status === "COMPLETED" && dryRun) return <Badge tone="ink">Dry run</Badge>;
  return (
    <Badge tone={m.tone} dot={m.live}>
      {m.label}
    </Badge>
  );
}

export const TRACKED_META: Record<TrackedStatus, { label: string; tone: Tone; hex: string }> = {
  APPLIED: { label: "Applied", tone: "sea", hex: "#2f6fe4" },
  INTERVIEWING: { label: "Interviewing", tone: "kelp", hex: "#1f8a5b" },
  OFFER: { label: "Offer", tone: "amber", hex: "#b7791f" },
  REJECTED: { label: "Rejected", tone: "coral", hex: "#c2413b" },
  GHOSTED: { label: "Ghosted", tone: "ink", hex: "#98a1ab" },
};

// ---------- Score ring ----------
export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = score >= 80 ? "var(--color-kelp)" : score >= 65 ? "var(--color-sea)" : score >= 45 ? "var(--color-amber)" : "var(--color-faint)";
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} title={`${score}% match`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-line)" strokeWidth="3" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="3" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} strokeLinecap="round" />
      </svg>
      <span className="absolute text-[11px] font-semibold tabular-nums">{score}</span>
    </span>
  );
}

// ---------- misc ----------
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("h-4 w-4 animate-spin text-muted", className)} />;
}
export function Empty({ icon, title, sub, action }: { icon?: ReactNode; title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-ink/5 text-ink-2">{icon}</div>}
      <p className="font-medium">{title}</p>
      {sub && <p className="mt-1 max-w-sm text-[13px] text-muted">{sub}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function CompanyMark({ name, size = 36 }: { name: string; size?: number }) {
  const clean = name.replace(/\(.*?\)/g, "").trim();
  const hue = [...clean].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg text-[13px] font-semibold text-white"
      style={{ width: size, height: size, background: `oklch(0.45 0.09 ${hue})` }}
      aria-hidden
    >
      {clean.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function timeAgo(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
