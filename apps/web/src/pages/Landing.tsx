import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, ChevronDown, Eye, FileCheck2, Globe, Inbox, Lock, Plug, Radar, ShieldCheck, Sparkles, Terminal, Wand2 } from "lucide-react";
import { getToken } from "../lib/api";
import { Badge, cx, Logo } from "../components/ui";

const SCANS = [
  ["stripe.com/jobs", "0 new"],
  ["vercel.com/careers", "+1 new"],
  ["linear.app/careers", "0 new"],
  ["notion.so/careers", "+2 new"],
  ["ramp.com/careers", "0 new"],
  ["figma.com/careers", "+1 new"],
  ["datadoghq.com/careers", "0 new"],
  ["supabase.com/careers", "+1 new"],
];

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[540px]">
      <div className="absolute -inset-6 -z-10 rounded-[32px] bg-[radial-gradient(60%_60%_at_70%_20%,rgba(232,87,42,0.18),transparent_70%),radial-gradient(50%_50%_at_10%_90%,rgba(47,111,228,0.16),transparent_70%)]" />
      <div className="overflow-hidden rounded-2xl border border-line bg-ink text-paper shadow-pop">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="ml-3 font-mono text-[11px] text-paper/50">ferry · watcher</span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-signal">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" /> live
          </span>
        </div>
        <div className="relative h-[132px] overflow-hidden px-4 font-mono text-[12px]">
          <div className="ticker">
            {[...SCANS, ...SCANS].map(([s, n], i) => (
              <div key={i} className="flex justify-between py-1 text-paper/70">
                <span>
                  <span className="text-paper/35">scan</span> {s}
                </span>
                <span className={n.startsWith("+") ? "text-[#7CE0A8]" : "text-paper/35"}>{n}</span>
              </div>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink" />
        </div>
        <div className="border-t border-white/10 px-4 pt-3 pb-10 font-mono text-[12px]">
          <span className="text-paper/40">match</span> Senior Frontend Engineer · Notion · <span className="text-[#7CE0A8]">93%</span>
        </div>
      </div>
      <div className="slide-up relative -mt-6 ml-auto w-[88%] rounded-2xl border border-line bg-card p-4 shadow-pop">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13px] font-semibold">Receipt · Notion via Ashby</p>
          <Badge tone="amber">Waiting for your OK</Badge>
        </div>
        <ul className="space-y-1.5 text-[13px]">
          {[
            ["Full name", "Alex Morgan"],
            ["Résumé", "alex_morgan_notion.pdf"],
            ["Authorized to work in the US", "Yes"],
            ["Why Notion?", "I've spent six years building collaborative…"],
          ].map(([k, v]) => (
            <li key={k} className="flex items-start gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-kelp" />
              <span className="w-40 shrink-0 text-muted">{k}</span>
              <span className="truncate">{v}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <span className="inline-flex h-8 items-center rounded-lg bg-signal px-3 text-[13px] font-medium text-white">Approve &amp; send</span>
          <span className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px]">Edit answers</span>
        </div>
      </div>
    </div>
  );
}

const STAGES = [
  {
    n: "01",
    k: "Find",
    title: "New roles reach you within hours of going live.",
    body: "Ferry polls company career pages directly, so you see a role before the job boards index it. Each one is scored against your résumé, with the reasons spelled out.",
    icon: Radar,
    visual: (
      <div className="space-y-1.5 font-mono text-[12px]">
        {[
          ["92%", "Senior Frontend Engineer", "Stripe"],
          ["88%", "Full Stack Engineer", "Linear"],
          ["81%", "Software Engineer, Platform", "Vercel"],
        ].map(([s, t, c]) => (
          <div key={t} className="flex items-center gap-3 rounded-lg bg-paper px-3 py-2">
            <span className="w-9 font-semibold text-kelp">{s}</span>
            <span className="flex-1 truncate">{t}</span>
            <span className="text-muted">{c}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    n: "02",
    k: "Prep",
    title: "A résumé rewritten for each role, and every change shown.",
    body: "Bullets are re-aimed at the job description using your real experience. Nothing is invented. You see a word-level diff and an ATS keyword score before anything is used.",
    icon: Wand2,
    visual: (
      <div className="space-y-2 text-[13px] leading-relaxed">
        <p>
          <span className="text-coral line-through decoration-coral/50">Built features for the web app using React.</span>
        </p>
        <p>
          <span className="rounded-sm bg-kelp-soft text-kelp">Shipped React + TypeScript surfaces for 4M monthly users; cut p95 render time 38%.</span>
        </p>
        <div className="flex items-center gap-2 pt-1 text-[12px] text-muted">
          ATS keywords <span className="font-semibold text-ink">62 → 91</span>
        </div>
      </div>
    ),
  },
  {
    n: "03",
    k: "Apply",
    title: "It fills the real form in a real browser, then waits for you.",
    body: "Greenhouse, Lever, Ashby, multi-step wizards, file uploads, and the open-ended questions in your voice. Anything it can't answer comes to you, once, and is remembered.",
    icon: FileCheck2,
    visual: (
      <div className="space-y-1.5 text-[13px]">
        {["First name · Alex", "Résumé · uploaded", "Sponsorship · No", "Why us? · drafted in your voice"].map((l) => (
          <div key={l} className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-kelp" />
            {l}
          </div>
        ))}
        <div className="flex items-center gap-2 text-signal">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" />
          Paused before Submit
        </div>
      </div>
    ),
  },
  {
    n: "04",
    k: "Track",
    title: "Replies sort themselves onto the right application.",
    body: "Confirmations, interview requests, assessments, and rejections are classified and routed. Your pipeline updates itself, and reply drafts are one click away.",
    icon: Inbox,
    visual: (
      <div className="grid grid-cols-3 gap-2 text-[12px]">
        {[
          ["Applied", 23, "bg-sea"],
          ["Interviewing", 4, "bg-kelp"],
          ["Offer", 1, "bg-amber"],
        ].map(([l, n, c]) => (
          <div key={l as string} className="rounded-lg bg-paper p-2.5">
            <span className={cx("mb-1.5 block h-1.5 w-6 rounded-full", c as string)} />
            <p className="text-muted">{l}</p>
            <p className="text-[18px] font-semibold">{n}</p>
          </div>
        ))}
      </div>
    ),
  },
];

const FAQ = [
  ["Does Ferry submit applications without asking me?", "Not unless you turn that on. By default it fills every field, shows you the full receipt, and waits for Approve & send. You can make résumé edits and cover letters wait for review too."],
  ["Will it make things up on my résumé?", "No. Honest mode only rephrases and reorders what's already true. Aggressive mode leads harder with outcomes but is still barred from inventing employers, titles, dates, or numbers."],
  ["Which application systems does it handle?", "It discovers jobs from Greenhouse, Lever, Ashby, SmartRecruiters, and Recruitee boards, and its form agent works on those plus most single-page and multi-step forms. Pages that need an account login, or show a captcha, are handed to you."],
  ["What happens with questions it can't answer?", "The application moves to Needs you with those questions highlighted. Answer once and Ferry remembers it for every future form."],
  ["How does it know who replied?", "Connect Gmail (read-only) or paste an email. Ferry classifies job mail and routes it to the matching application. It drafts replies but never sends email for you."],
  ["Do I need an AI key?", "Ferry runs without one using deterministic matching and form rules. With an Anthropic API key it uses Claude for match reasoning, résumé tailoring, cover letters, and open-ended answers."],
];

export default function Landing() {
  const authed = Boolean(getToken());
  const [open, setOpen] = useState<number | null>(0);
  const cta = authed ? "/app" : "/login";
  return (
    <div className="overflow-x-clip">
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 border-b border-line/70 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-4 py-3 sm:px-6">
          <Link to="/">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-7 text-[14px] text-ink-2 md:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#surfaces" className="hover:text-ink">Surfaces</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
            <a href="#faq" className="hover:text-ink">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            {!authed && (
              <Link to="/login" className="hidden h-9 items-center px-3 text-[14px] font-medium text-ink-2 hover:text-ink sm:inline-flex">
                Log in
              </Link>
            )}
            <Link to={cta} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[14px] font-medium text-paper hover:bg-ink-2">
              {authed ? "Open dashboard" : "Get started"} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid grid-cols-1 max-w-[1180px] items-center gap-14 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-20">
        <div>
          <Badge tone="signal" className="mb-5">
            <Sparkles className="h-3.5 w-3.5" /> Find · tailor · apply · track
          </Badge>
          <h1 className="display text-[52px] sm:text-[68px] lg:text-[76px]">
            Every role that fits you,
            <br />
            <em className="text-signal">applied to</em> before the rush.
          </h1>
          <p className="mt-6 max-w-[520px] text-[17px] leading-relaxed text-ink-2">
            Ferry watches company career pages, tailors your résumé to each new role, fills in the real application, and waits for your OK before it hits submit. Then it reads the replies for you.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to={cta} className="inline-flex h-12 items-center gap-2 rounded-xl bg-signal px-5 text-[15px] font-semibold text-white shadow-card hover:brightness-105">
              Start with 25 free applications <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="inline-flex h-12 items-center rounded-xl border border-line bg-card px-5 text-[15px] font-medium hover:border-line-2">
              See how it works
            </a>
          </div>
          <p className="mt-4 text-[13px] text-muted">No card required. You approve every send.</p>
        </div>
        <HeroVisual />
      </section>

      <section className="border-y border-line bg-card">
        <div className="mx-auto grid grid-cols-1 max-w-[1180px] gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
          {[
            ["48 hours", "is when most postings get flooded. Applying in the first few hours puts you near the top of the pile."],
            ["20–45 min", "is what a single Workday-style form takes by hand. Ferry fills it while you do something else."],
            ["0 silent sends", "by default. Every answer, upload, and résumé edit is visible before it leaves your account."],
          ].map(([a, b]) => (
            <div key={a}>
              <p className="display text-[40px]">{a}</p>
              <p className="mt-1 text-[14px] text-muted">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-[1180px] scroll-mt-20 px-4 py-24 sm:px-6">
        <p className="font-mono text-[12px] tracking-widest text-signal uppercase">The pipeline</p>
        <h2 className="display mt-2 max-w-[720px] text-[44px] sm:text-[54px]">Four stages, one agent, no spreadsheet.</h2>
        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2">
          {STAGES.map((s) => (
            <div key={s.k} className="flex flex-col rounded-2xl border border-line bg-card p-6 shadow-card">
              <div className="mb-4 flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-ink text-paper">
                  <s.icon className="h-[18px] w-[18px]" />
                </span>
                <span className="font-mono text-[12px] text-muted">
                  {s.n} · {s.k.toLowerCase()}
                </span>
              </div>
              <h3 className="text-[20px] leading-snug font-semibold">{s.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.body}</p>
              <div className="mt-5 rounded-xl border border-line p-3.5">{s.visual}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-ink text-paper">
        <div className="mx-auto grid grid-cols-1 max-w-[1180px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <p className="font-mono text-[12px] tracking-widest text-signal uppercase">Built to be trusted</p>
            <h2 className="display mt-2 text-[44px]">An agent you can watch work.</h2>
            <p className="mt-4 text-[15px] leading-relaxed text-paper/70">Applications go out under your name, so every step is visible and reversible until you say send.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              [Eye, "Full receipts", "Every field, answer, and upload, with where it came from: your profile, your memory, or an AI draft."],
              [ShieldCheck, "No invented facts", "Tailoring rephrases your real experience. Unknown answers come to you instead of being guessed."],
              [Lock, "Decline by default", "Voluntary self-ID questions get the decline option unless you've chosen an answer."],
              [Radar, "Hands off captchas", "When an employer asks for a captcha or a login, Ferry stops and hands the application back to you."],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof Eye;
              return (
                <div key={t as string} className="rounded-2xl border border-white/10 p-5">
                  <I className="h-5 w-5 text-signal" />
                  <p className="mt-3 font-semibold">{t as string}</p>
                  <p className="mt-1 text-[14px] leading-relaxed text-paper/65">{d as string}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="surfaces" className="mx-auto max-w-[1180px] scroll-mt-20 px-4 py-24 sm:px-6">
        <p className="font-mono text-[12px] tracking-widest text-signal uppercase">Wherever you work</p>
        <h2 className="display mt-2 text-[44px] sm:text-[54px]">One agent, three ways in.</h2>
        <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <Globe className="h-5 w-5" />
            <h3 className="mt-3 text-[18px] font-semibold">Web dashboard</h3>
            <p className="mt-1 text-[14px] text-muted">Matches, the application queue, review screens, inbox, and tracker. Installable on your phone.</p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 shadow-card">
            <Sparkles className="h-5 w-5" />
            <h3 className="mt-3 text-[18px] font-semibold">Chrome extension</h3>
            <p className="mt-1 text-[14px] text-muted">Open any job posting and a Ferry panel appears: add it to your queue or apply in one click.</p>
          </div>
          <div className="rounded-2xl border border-line bg-ink p-6 text-paper shadow-card">
            <div className="flex items-center gap-2">
              <Plug className="h-5 w-5" />
              <Terminal className="h-5 w-5" />
            </div>
            <h3 className="mt-3 text-[18px] font-semibold">MCP server &amp; CLI</h3>
            <p className="mt-1 text-[14px] text-paper/65">Let Claude Code or any MCP client search, apply, and approve for you.</p>
            <pre className="mt-4 overflow-x-auto rounded-lg bg-white/5 p-3 font-mono text-[12px] text-paper/85">
              {`> apply to the top 3 matches
→ ferry.get_job_matches()
→ ferry.apply_to_job(job_id)
✓ 3 queued · review in dashboard`}
            </pre>
          </div>
        </div>
      </section>

      <section id="pricing" className="scroll-mt-20 border-t border-line bg-card">
        <div className="mx-auto max-w-[1180px] px-4 py-24 sm:px-6">
          <p className="font-mono text-[12px] tracking-widest text-signal uppercase">Pricing</p>
          <h2 className="display mt-2 text-[44px] sm:text-[54px]">Pay for applications sent, not for seats.</h2>
          <p className="mt-3 text-[15px] text-muted">Every plan is the whole product. Only volume changes. Dry runs and failed attempts are free.</p>
          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { name: "Starter", price: 19, n: "600", blurb: "Enough for a focused search." },
              { name: "Pro", price: 39, n: "1,500", blurb: "For a high-volume search.", hot: true },
              { name: "Power", price: 99, n: "4,500", blurb: "Reach every match first." },
            ].map((p) => (
              <div key={p.name} className={cx("rounded-2xl border p-6", p.hot ? "border-ink bg-ink text-paper shadow-pop" : "border-line bg-paper")}>
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{p.name}</p>
                  {p.hot && <Badge tone="signal">Most popular</Badge>}
                </div>
                <p className="mt-4">
                  <span className="display text-[52px]">${p.price}</span>
                  <span className={p.hot ? "text-paper/60" : "text-muted"}> / month</span>
                </p>
                <p className={cx("text-[14px]", p.hot ? "text-paper/70" : "text-muted")}>{p.n} applications every 30 days</p>
                <p className="mt-3 text-[14px]">{p.blurb}</p>
                <Link to={cta} className={cx("mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg text-[14px] font-medium", p.hot ? "bg-signal text-white" : "border border-line bg-card hover:border-line-2")}>
                  Start free
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-[13px] text-muted">Your first 25 applications are free. No card required.</p>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-[860px] scroll-mt-20 px-4 py-24 sm:px-6">
        <h2 className="display text-[44px]">Questions, answered.</h2>
        <div className="mt-8 divide-y divide-line border-y border-line">
          {FAQ.map(([q, a], i) => (
            <div key={q}>
              <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center justify-between gap-4 py-5 text-left text-[16px] font-medium" aria-expanded={open === i}>
                {q}
                <ChevronDown className={cx("h-5 w-5 shrink-0 text-muted transition-transform", open === i && "rotate-180")} />
              </button>
              {open === i && <p className="-mt-1 pb-5 text-[15px] leading-relaxed text-ink-2">{a}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1180px] px-4 pb-24 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-signal px-6 py-14 text-center text-white sm:px-12">
          <h2 className="display text-[44px] sm:text-[56px]">Get tonight's 25 applications off your plate.</h2>
          <Link to={cta} className="mt-7 inline-flex h-12 items-center gap-2 rounded-xl bg-ink px-6 text-[15px] font-semibold text-paper hover:bg-ink-2">
            Get started <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-[13px] text-muted sm:px-6">
          <Logo />
          <p>An open replica of the agentic job-application stack. Runs on your machine.</p>
        </div>
      </footer>
    </div>
  );
}
