# Tsenta teardown

Target: **Tsenta** (YC S26). `tsente.ai` does not resolve; `tsenta.ai` redirects to `https://tsenta.com`.
Date of analysis: 2026-10-11.

Method: public pages (`/`, `/mcp`, `/privacy`, `/ai-disclosure`, `/changelog`, `/llms-full.txt`, sitemap),
public OAuth discovery documents, the YC / Work at a Startup listings, and **REA**
(`rea-agents@6.4.0 analyze-javascript-application`) run statically over two shipped JavaScript artifacts:

| Artifact | Source | Size |
|---|---|---|
| Web dashboard bundle | `https://dashboard.tsenta.com/assets/*` (72 Vite chunks) | ~5 MB |
| Chrome extension v3.1.11 | Chrome Web Store id `momaobilceffibifldnhndcehhdjgaob` | 1.7 MB CRX |

Nothing was executed; no authenticated endpoint was called.

---

## 1. Product in one paragraph

An agent that (1) **finds** new postings by polling 50k+ company career pages / a 2M+ job index,
(2) **preps** a per-role tailored résumé + cover letter shown as a diff, (3) **applies** by driving a real
browser through the ATS form (login, account creation, email OTP, every field, uploads, free-text answers),
pausing for review unless auto-submit is on, and (4) **tracks** replies by classifying Gmail/Outlook mail
and moving the application status automatically. Surfaces: web dashboard, iOS/Android, iMessage/WhatsApp,
Chrome extension, MCP server + CLI. Pricing is per-application credits: 25 free, then $19/600, $39/1,500,
$99/4,500 per 30 days.

## 2. System architecture (recovered)

```
                ┌──────────────── tsenta.com ───────────────┐
                │ Next.js (Turbopack) on Vercel — marketing,  │
                │ /jobs SEO board, llms.txt                    │
                └─────────────────────────────────────────────┘
 dashboard.tsenta.com            Chrome ext (WXT, MV3)          Claude/Cursor/Codex
 Vite + React + Tailwind         overlay "Add to Tsenta"        MCP client
 Redux Toolkit Query + zod       job capture from LinkedIn/     │  OAuth 2.1 + DCR
 Firebase Auth (Google)          Jobright/MigrateMate RSC       │
 PostHog, Sentry, assistant-ui   dashboard-bridge (auth sync)   │
        │  Bearer <Firebase ID token>          │                │
        └──────────────┬───────────────────────┴────────────────┘
                       ▼
     api.autojobs.me / api.tsenta.com  (Cloudflare → Fly.io)
     AdonisJS (Node/TS) REST /api/v1/*, Transmit SSE (/__transmit/*),
     MCP endpoint /api/v1/mcp, OAuth AS (/oauth/authorize|token|register|revoke)
                       │
     ┌─────────────────┼────────────────────────┬────────────────────┐
     ▼                 ▼                        ▼                    ▼
 PostgreSQL       queue-driven workers      LLMs: OpenAI,          Mail: Gmail API
 + pgvector       (scrape, match, tailor,   Anthropic, DeepSeek    (readonly+compose),
 (Fly managed)    apply via Playwright)                            Composio (Outlook),
                                                                   Resend/SES outbound
```

Evidence:

* **AdonisJS backend**: `GET /` → `{"hello":"world"}` (AdonisJS starter route); 404 body
  `{"status":"error","message":"Route not found"}`; realtime client posts to `/__transmit/subscribe`
  with `X-XSRF-TOKEN` (AdonisJS Transmit). Work-at-a-Startup stack list confirms AdonisJS + PostgreSQL.
* **Fly.io + Cloudflare**: `fly-request-id`, `server: Fly/…`, `cf-ray` headers. Privacy policy names
  Fly.io (hosting + managed Postgres), Cloudflare, Firebase Auth, Anthropic, OpenAI, PostHog, Sentry,
  Resend, AWS SES, Composio.
* **MCP**: `/.well-known/oauth-protected-resource` →
  `{"resource":"https://api.autojobs.me/api/v1/mcp","authorization_servers":["https://api.autojobs.me"]}`;
  authorization-server metadata exposes `/oauth/register` (dynamic client registration). Setup command
  on `/mcp`: `claude mcp add --transport http tsenta https://api.autojobs.me/api/v1/mcp`.
* **Desktop**: stack lists Electron + Playwright (the "on-device automation" claim on YC page); the
  current marketing says applications run in Tsenta's cloud. The dashboard's `ExecutionProvider` only
  has a `cloud` adapter now.

## 3. Domain model (from the dashboard bundle)

**Application pipeline status** (`applicationsApi`):

```
OPTIMIZING → OPTIMIZING_RESUME → OPTIMIZING_CL
   → PENDING_REVIEW | PENDING_RESUME_REVIEW | PENDING_CL_REVIEW | PENDING_SUBMIT_REVIEW
   → READY → RUNNING → COMPLETED | FAILED | SKIPPED
```
UI tabs: `all · submitted · in_flight · needs · failed · skipped`.

**Tracked (post-submit) status** (`tracked-application-status`):
`APPLIED · INTERVIEWING · OFFER · REJECTED · GHOSTED`, with a status-history Sankey in the tracker.

**Apply settings** (`useApplySettings`, persisted per user):

| key | values | default |
|---|---|---|
| `optimizationMode` | `off · honest · aggressive` | `honest` |
| `autoApproveResume` | bool | `true` |
| `coverLetterMode` | `off · honest · aggressive` (falls back to optimizationMode) | — |
| `autoApproveCoverLetter` | bool | `true` |
| `autoSubmitApplication` | bool | **`false`** (review-before-submit) |

**Execution events** (Transmit channel `users/{uid}/events`):
`execution:started · execution:thought · execution:completed · execution:failed · execution:aborted`,
plus `GET /cloud-executions/running` returning `{jobId, application, lastThought, currentPage, totalPages}`.

**ATS detection** (`ats` chunk): URL-substring table for 34 ATSes, e.g. Greenhouse
(`greenhouse.io`, `gh_jid=` → `greenhouse-embedded`), Workday (`myworkdayjobs.com`, `myworkdaysite.com`),
Lever (`lever.co`), Ashby (`ashbyhq.com`), iCIMS, SmartRecruiters, SuccessFactors, Oracle (`taleo.net`),
UKG, Dayforce, Teamtailor, Recruitee, Pinpoint (regex on `/postings/<uuid>`), … Avature and Bullhorn
are listed but unsupported.

**Workday credentials**: dedicated endpoints to store/reveal/delete a Workday password, since every
Workday tenant needs a candidate account.

## 4. API surface (≈140 routes, recovered from bundle literals)

Grouped (all under `/api/v1`):

* **applications**: list, list/counts, search, stats, count, rate-limit, skip-bulk, `{id}` detail,
  approve, reapply, trace, optimized-resume, regenerate-resume, resume-submit, cover-letter(+data,
  download-url), skip-cover-letter, skip-optimization, typeahead-suggest, password, resume-url.
* **jobs**: recommendations (+count, +sources), `{jobId}/skip`, `{jobId}/status`; **jobboard**: jobs/{id},
  company-options, location-options; **job-description/fetch** (scrape JD from URL).
* **users/{uid}**: profile (personal-info, education, work-experience, skills, preferences,
  resume-settings, custom-sections, mark-reviewed), resume-profiles (multiple résumés, set-default,
  reimport), apply-preferences, auto-apply-config, auto-apply-runs, generate-pdf, cover-letter/content,
  public-profile, memories (agent long-term memory about the user).
* **onboarding**: parse-resume, continue-without-parsing.
* **inbox**: messages, threads, unread-count, read-all, draft-reply, reply, settings.
* **networking**: companies discover/search/resolve/news/contacts, outreach, usage.
* **subscription / wallet**: plans, checkout, portal, change/preview/cancel/pause/resume, offer-code,
  wallet, wallet/topup.
* **auth**: check-email, forgot/reset-password, messaging-otp send/verify (iMessage/WhatsApp signup).
* misc: places autocomplete, universities search, feedback, referral, push-tokens, tracked-applications/export.

## 5. Chrome extension (WXT, MV3, v3.1.11)

| File | Role |
|---|---|
| `background.js` | auth store (Firebase refresh via `securetoken.googleapis.com`), API client, job capture |
| `content-scripts/overlay.js` (395 KB React) | floating "Tsenta detected this job" panel on any page: auto-add, choose résumé profile, "Generate Custom Resume", "Review before submit" |
| `content-scripts/dashboard-bridge.js` | dashboard `postMessage({type:'TSENTA_AUTH_SYNC', idToken, refreshToken, uid})` → extension |
| `content-scripts/{linkedin,jobright,migratemate}-rsc.js` | MAIN-world hooks that read job data/apply URLs from those sites |
| `content-scripts/content.js` | iframe PING/PONG + cookie-fix restart |
| `rules/strip-headers.json` | removes `X-Frame-Options`/CSP on frames so ATS pages can be embedded |

REA findings: 8 endpoints (6 API routes + 2 MigrateMate), storage in `firebaseLocalStorageDb`,
local/session storage, no Electron IPC; the extension does **not** fill forms itself — it captures jobs
and preferences and hands execution to the cloud.

## 6. What a faithful replica needs

| Capability | Tsenta | Replica plan |
|---|---|---|
| Job discovery | 50k career pages, 2M jobs, 2h refresh | Pollers for public ATS JSON APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable) + URL capture |
| Matching | LLM + pgvector | Claude scoring with explanation; heuristic fallback offline |
| Résumé tailoring | diff + ATS score | Structured résumé JSON → per-role rewrite, bullet diff, ATS keyword score, PDF render |
| Apply | Playwright agent, 30 ATSes, OTP | Playwright worker: generic DOM-extract → LLM field mapping → fill → upload → pause for review; screenshots trace; thoughts over SSE |
| Track | Gmail/Outlook + classifier | Inbox ingestion + LLM/regex classifier + routing by company; Gmail OAuth optional |
| Surfaces | web, iOS, Android, iMessage, WhatsApp, Chrome, MCP, CLI | web dashboard, Chrome extension, MCP (Streamable HTTP), CLI. Native apps & iMessage/WhatsApp out of scope. |
| Billing | credits per application | credit wallet with 25 free + plan tiers (Stripe optional) |


## Résumés, profiles, answers, and logins (second pass)

Read from the dashboard chunks `useFitToOnePage`, `generateResumeHTML`, `format_bar_kit`, `resume_stage`,
`profile_scope_bar`, `workday_password`, `workday`, `application_account`, `finish_yourself`, `emailProvidersApi`.

**Résumé profiles.** A user has several named profiles ("Software Engineer", "Data Scientist"), created by
*Import from file* (PDF/DOCX) or *Duplicate* (copy all data from another profile). One is the default and can't be
deleted. Auto-apply "lanes" each point at a `resumeProfileId` with their own filters, threshold, optimization mode,
cover-letter mode, and free-text `instructions`.

**Résumé model.** `optimizedProfile`: personalInformation, workExperience[] (company, role, location, dates,
summary, responsibilities[], achievements[], engagements[], hidden), education[], projects[], skillCategories[]
(name, skills[], order), certifications[], customSections[] (`bullets` or `structured` items). Layout:
`resumeStyles` (preset `standard` | `jake`, fontFamily, baseFontSize 10.5, textAlign, headerLinkStyle url|label,
fitToOnePage), `resumeSectionOrder`, `hiddenSections`, `hiddenHeaderLinks` (incl. location parts). Bullets allow
`<strong>/<em>/<a>` (sanitized). Rendered as US Letter HTML → PDF; DOCX alongside (`optimizedResumeDocxUrl`).
A user who uploaded a DOCX can have the tailored text projected into their own document (`docxProjectionEnabled`).

**Fit to one page.** A stepwise reduction ladder measured against 1056px (11in): section margins 12→10→8→6pt,
entry/bullet margins, line height 1.3→1.1, then font size in 0.5pt steps down to 9pt; bails out when a step saves
<1%; otherwise flags multi-page. It never removes content. *Ferry adds* a relevance-ranked cut step (optional)
and verifies with the real PDF page count.

**Redo.** `POST /applications/{id}/regenerate-resume {instructions, applyToFuture}`, limited by `redosRemaining`.

**Application password.** One user-chosen password ("Workday password"), ≥12 chars with lower, upper, digit, and
special, encrypted, with status/reveal/delete endpoints, used when a job site needs an account. Each application
exposes `applicationAccount {applicationId, email, hasSavedPassword}` with a reveal; ADP is passwordless (email
code). Failures with codes `ACCOUNT_REQUIRED`, `AUTH_FAILED`, `ASSESSMENT_REQUIRED`, `MANUAL_APPLY_REQUIRED`, … are
offered as "finish it yourself". Email providers: Gmail and Outlook connections, plus syncing the profile email to
the connected inbox so verification codes arrive where the agent reads them.
