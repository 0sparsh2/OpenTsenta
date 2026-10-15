# Ferry

An end-to-end replica of **Tsenta** (YC S26), the agent that finds jobs, tailors your résumé, fills the
application, and tracks the reply. Built from a teardown of the shipped product: public pages plus a static
[REA](https://github.com/morluto/rea) analysis of Tsenta's dashboard bundle and Chrome extension. The findings
are in [docs/RESEARCH.md](docs/RESEARCH.md).

Ferry has its own name and design. It copies the architecture and behavior, not Tsenta's brand or copy.

```
find ──▶ prep ──▶ apply ──▶ track
 │        │        │         │
 │        │        │         └ Gmail / IMAP / pasted mail → classifier → routed to the application → tracker moves
 │        │        └ Playwright agent: account wall (sign in / create + email-code verify) → fields → profile rules,
 │        │          memory, Claude → fill → read-back → review gate → submit → confirmation
 │        └ per-role résumé rewrite (diff + ATS keyword score), cover letter, ATS-safe PDF
 └ 4,632 company boards on Greenhouse · Ashby · Lever · Workday · iCIMS · Oracle Recruiting · SuccessFactors · Taleo · SmartRecruiters · Workable · Rippling · Pinpoint · BambooHR · Breezy HR · Recruitee
```

## Quick start

```bash
npm install
npx playwright install chromium   # only if you don't already have Playwright's Chromium
npm run build                     # builds the dashboard; the API serves it
npm start                         # http://localhost:8787
```

Sign in with any email, upload a résumé (`samples/alex_morgan_resume.txt` works), and finish onboarding.
The watcher covers about 250,000 open roles posted in the last two weeks (JOB_RETENTION_DAYS) from 4,631 company boards. A full pass takes about 30 minutes; big paged boards (Workday, iCIMS…) refresh twice a day, the rest every two hours.

To work on the UI with hot reload, run `npm run dev` (API on :8787, Vite on :5173).

**Try the whole loop safely.** Search Browse jobs for "Acme". Those roles belong to local sandbox employers at
`/mock-ats`:

- a one-page form;
- a three-step wizard;
- a Workday-style tenant that requires creating an account and entering a code emailed to the sandbox mailbox.

Apply, answer anything under "Needs you", approve, and the agent submits. You'll see the receipt, the screenshot trace,
and the confirmation email land in your inbox and move the tracker.

## What's built

| Tsenta surface | Ferry | Where |
|---|---|---|
| Career-page watcher | 15 ATS feeds, 4,632 verified company boards (mined from public job lists by `scripts/mine-boards.ts`), add any company from its careers link, per-board polling schedule with back-off, lazy descriptions | `apps/server/src/ingest` |
| Job search | Keywords with AND / OR / "phrases" / -exclusions / (groups) / prefix* over titles or descriptions (SQLite FTS5, stemmed), a plain-English readout of the query, and a location filter that buckets messy locations into cities, metros, states, countries and remote | `match/query.ts`, `ingest/places.ts`, `pages/Jobs.tsx` |
| Résumé-aware matching | Heuristic pre-score (title, skills, level, location, work authorization, sponsorship), then Claude on the top results | `apps/server/src/match` |
| Résumé profiles | One profile per role family ("Backend Engineer", "Data Engineer"), each imported from a résumé or copied; every job is matched and applied with the best-fitting one | `resume/profiles.ts`, Résumé profiles page |
| Block résumé + formats | Editable blocks (roles, bullets, projects, skill groups, certifications, custom sections); 4 ATS-safe templates; section order, hidden sections and links; 1- or 2-page limit (tightens spacing, margins and type down to 9pt first; cuts the least relevant lines only if it still doesn't fit); keeps the typeface of an uploaded résumé; PDF + Word export; "keep my Word design" | `resume/render.ts`, `docx.ts`, `project.ts` |
| Per-role tailoring + cover letter | Honest/aggressive tailoring from the chosen profile, word diff, keyword score; optional preview before applying (per job or in Settings); "Ask Ferry to change this résumé" prompts ("make it one page", "drop the internship") with undo; edit per application; re-tailor with instructions (3 per application) | `resume/tailor.ts`, `resume/edit.ts`, application → Résumé tab |
| Answer library | Common questions answered once ({company}/{role} filled in) or written for each job ("Why are you interested in joining …?"), with an on/off switch and a preview | `apply/library.ts`, Answers page |
| Apply agent | Iframe-aware extraction: react-select comboboxes (options probed), button listboxes, radio and checkbox groups, uploads, multi-step and server-rendered wizards | `apps/server/src/apply` |
| Same agent, continued | Cookie banners (reject non-essential), résumé-parser overwrite repair, submit-error recovery, closed-posting detection, Claude navigator for unknown screens | `apps/server/src/apply` |
| Login, signup, email OTP (YC listing) | Per-employer accounts created with your own application password (or a generated one when a site's rules need it), AES-GCM vault; code or link read from your inbox; each application shows the account it used; "finish it yourself" handoff | `apply/auth.ts`, `vault.ts`, `mail/` |
| Review before submit | On by default; résumé, cover-letter, and submit gates; "Needs you" | engine + dashboard |
| Agent memory | Answers you give are reused on later forms | `store.rememberAnswer` |
| Live execution events | `execution:*` over SSE | `bus.ts`, `/api/v1/events` |
| Reply tracking | Gmail API (readonly) or any IMAP inbox, classifier, routing, ghost detection | `mail/`, `track/` |
| Web dashboard + PWA | Landing, onboarding, matches, applications + review, inbox, tracker, profile, 8 settings tabs; installable, offline shell, web push | `apps/web` |
| iOS / Android apps | Capacitor projects (`apps/mobile/ios`, `android`) with native push through FCM | `apps/mobile` |
| iMessage / WhatsApp / SMS | Sendblue (iMessage) and Twilio (SMS, WhatsApp): match alerts, YES/SKIP/MATCHES/APPLY n/STATUS, phone OTP | `messaging.ts` |
| Chrome extension | MV3: job detection panel, dashboard auth bridge, "Fill this form" in your own tab for bot-protected sites | `apps/extension` |
| MCP server at `/api/v1/mcp` | Streamable HTTP, 9 tools | `mcp.ts` |
| CLI | `npx ferry …` | `apps/cli` |
| Accounts | Password + email verification, magic links, reset, sessions, API tokens, rate limits | `session.ts` |
| Billing | Stripe Checkout subscriptions, portal, signed idempotent webhooks, 30-day credit cycles | `billing.ts` |

## Job-site coverage

Measured with `scripts/coverage.ts`, which runs real postings through the agent in dry-run mode with a throwaway persona.
Real submission and account creation are forced off in these runs, and a dry run on a real employer stops before
Next on multi-step forms (Next would send that page to the employer). Flows behind an account wall or past page one are
verified end to end against local sandboxes that mirror them. Percentages are required fields filled from the
résumé and profile alone, without Claude, in the latest sweep.

| ATS | Finding jobs | Applying |
|---|---|---|
| Greenhouse | Public API, 868 boards | One-page forms, including jobs on company sites (routed to Greenhouse's hosted form) |
| Ashby | Public API, 702 boards | One-page forms with custom questions |
| Lever | Public API, 327 boards | One-page forms (the site's language switcher is ignored) |
| Workday | Public jobs API, 1,673 boards | Account creation with your application password, emailed code, multi-step forms (sandbox). Real tenants stop at the account wall in dry runs. |
| iCIMS | Search pages, 329 boards | Iframe postings, email-first sign-in, account creation, profile form (sandbox) |
| Oracle Recruiting | Public REST API, 189 boards | Email + terms, emailed one-time code in split boxes, multi-step forms (sandbox) |
| SuccessFactors | Career-site search, 14 boards | Sign-in and the talent-community email step are recognized. Tenants with a captcha on sign-in are handed back. |
| Taleo | Public REST search, 4 boards | Apply Online, New User registration, privacy agreement, five-step flow with eSignature and review (sandbox) |
| SmartRecruiters | Public API, 294 boards | Forms sit behind DataDome bot protection, so Ferry hands them back. The extension fills the one-click form in your own browser: web components, city autocomplete, dropdowns, résumé (sandbox). |
| Workable | Public API (every page), 18 boards | One-page forms, 83% |
| Rippling | Public board API, 144 boards | One-page forms, 93% |
| Pinpoint | Public postings feed, 10 boards | One-page forms, 78% (graduation day and skill ratings are left to you) |
| BambooHR | Public careers API, 42 boards | One-page forms, 97% |
| Breezy HR | Public JSON feed, 17 boards | One-page forms, placeholder-only labels, bot-trap fields left empty |
| Jobvite | Paste a job link | Location gate, résumé upload menu, 100%; a reCAPTCHA before submit is handed back |
| JazzHR, Paylocity | Paste a job link | One-page forms, 80% and 86% |
| LinkedIn | Paste a job link | Matched to the same role on the company's own ATS when Ferry watches it. Easy Apply jobs are handed back; the extension fills each step of the Easy Apply modal in your own browser (sandbox). Ferry never uses your LinkedIn login. |
| Anything else | Paste a job link (JSON-LD or microdata) | Generic form agent, plus the Claude navigator when a key is set |

Ferry never solves captchas or bot checks. Those applications land in "Finish it yourself" with the posting, your
tailored résumé, and the account to sign in with. On those sites, the Chrome extension's **Fill this form** button
reads the form in your own tab, fills it with the same answers and tailored résumé, and leaves Submit to you.

## What needs your keys to go live

Everything above runs and is tested locally without external accounts. These keys connect it to the real world:

| Key | Unlocks | Without it |
|---|---|---|
| `NVIDIA_NIM_API_KEY` (or `ANTHROPIC_API_KEY`) | AI matching, tailoring rewrites, cover letters, open-ended answers, navigator. With a NIM key Ferry uses DeepSeek v4.1 (`deepseek-ai/deepseek-v4.1-flash`) through NVIDIA's OpenAI-compatible API, falling back to `LLM_FALLBACK_MODELS` when it's slow; `LLM_PROVIDER=anthropic` switches to Claude | Rule-based answers. Essays go to "Needs you". |
| `ALLOW_REAL_SUBMIT=true` | Submitting to real employers | Real forms are filled and stopped before Submit (dry run, no uploads) |
| `RESEND_API_KEY` | Real outbound email | Mail goes to the local sandbox mailbox |
| `GOOGLE_CLIENT_ID/SECRET` | One-click Gmail | Users can still connect any inbox with an IMAP app password |
| `STRIPE_*` | Charging for plans | Choosing a plan grants credits directly |
| `TWILIO_*`, `SENDBLUE_*` | Real texts | Texts are logged in Settings → Texts & alerts |
| `FCM_SERVICE_ACCOUNT` | Native app push | Web push still works |

See `.env.example` for every setting and webhook URL.

## Safety defaults

- **No real submissions unless you opt in.** With `ALLOW_REAL_SUBMIT=false`, the agent fills real employer forms but
  doesn't upload files or click Submit. Only the local sandboxes submit.
- **Review before submit is on.** `autoSubmitApplication` defaults to `false`, as in Tsenta.
- **No invented facts.** Tailoring forbids new employers, titles, dates, or numbers. Answers that can't be grounded
  in your data come to you.
- **No captcha bypass.** A captcha hands the application back to you.
- **Privacy defaults:** cookie banners get "reject non-essential"; voluntary self-ID questions get the decline option;
  questions about sharing your data with third parties get "No".
- **Secrets encrypted at rest** (AES-256-GCM): employer passwords, IMAP app passwords, OAuth tokens. Sessions are
  stored hashed and are revocable.

Automated applications may conflict with some employers' or job boards' terms. Turning on real submission is your call.

## Deploy

```bash
docker compose up -d          # self-host: http://localhost:8787, data in ./data
```

To deploy on Fly.io, run `fly launch --copy-config --no-deploy`, then `fly volumes create ferry_data --size 3`, then `fly deploy`.

The image is based on Playwright's official image, so Chromium and its libraries are included. Run a single instance:
the database is SQLite on a volume, and the watcher and apply queue run in-process.

**Mobile:** see `apps/mobile/README.md`. You need Xcode or Android Studio, plus `FERRY_API_URL` pointing at your deployed API.

## Connect

**MCP (Claude Code):**

```bash
claude mcp add --transport http ferry http://localhost:8787/api/v1/mcp --header "Authorization: Bearer <api-token>"
```

**CLI:**

```bash
npx ferry login you@example.com
```

Or use `npx ferry token <api-token>`. Then run `ferry matches`, `ferry apply <job-id>`, `ferry status needs`, or `ferry approve <app-id>`.

**Chrome extension:** open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select `apps/extension`.

**Texts:** Settings → Texts & alerts. Verify your number, then reply YES to match alerts.

## Tests and tools

```bash
npm test                                                  # 46 end-to-end + integration tests, no network or keys needed
npx tsx apps/server/scripts/inspect-form.ts <job-url>     # read-only: the fields the agent would see on a real form
npx tsx apps/server/scripts/inspect-workday.ts <url>      # read-only: walk a real Workday posting to its sign-in step
npx tsx apps/server/scripts/inspect-apply.ts <url>        # read-only: follow Apply on any posting to its form or sign-in wall
npx tsx apps/server/scripts/coverage.ts --ats ashby --per 6   # dry-run sweep of real postings, report per ATS
npx tsx apps/server/scripts/mine-boards.ts                # grow the watch list from public job lists (verifies every board live)
npx tsx apps/server/scripts/test-extension.ts             # loads the Chrome extension in Chromium and drives the panel
```

The suite covers:

- the full apply loop on six sandbox employers: a one-page form, a wizard, Workday (account creation with your application password, emailed code), Oracle Recruiting (email + one-time code in split boxes), iCIMS (iframe posting, email-first sign-in, account creation), and Taleo (New User registration, privacy agreement, eSignature, review);
- account walls never crossed when account creation is off or in a dry run;
- the Chrome extension's "Fill this form", loaded into Chromium: a plain form, a SmartRecruiters-style web-component form behind a bot wall, and a four-step LinkedIn-style Easy Apply modal (it never submits; the test submits as the person would);
- résumé profiles, templates, the page limit (verified against the real PDF page count), Word export, and "keep my design";
- the answer library: fixed answers, per-job written answers, and the auto-write switch;
- prompt-to-modify edits and the preview-before-applying pause;
- the real-employer dry-run guarantee;
- the model contracts, against local fakes of the Anthropic Messages API and NVIDIA NIM's chat completions (fallback past stalled models, JSON repair);
- password auth, sessions, magic links and reset;
- signed Stripe webhooks;
- Twilio signatures and the text-message conversation;
- cross-user isolation;
- the vault and the FCM signer.

## Stack

Tsenta runs AdonisJS + Postgres/pgvector on Fly.io, Firebase Auth, a Vite + React + RTK Query dashboard, a WXT
extension, and native apps. Ferry keeps the same shape but is lighter so it runs anywhere with one command:

- **Server:** Hono + `node:sqlite`, Playwright, the Anthropic TypeScript SDK, the MCP TypeScript SDK, Stripe, web-push, imapflow.
- **Web:** Vite + React 19 + Tailwind 4 + RTK Query.
- **Mobile:** Capacitor.
