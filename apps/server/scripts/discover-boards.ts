// Grow the watch list: probe candidate company boards on each ATS's public API and write the ones
// that respond with open jobs to src/ingest/boards.json.  npx tsx scripts/discover-boards.ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FETCHERS } from "../src/ingest/sources.ts";

const CANDIDATES: Record<string, string[]> = {
  greenhouse: `stripe vercel figma anthropic airbnb discord dropbox databricks robinhood coinbase brex gusto instacart reddit pinterest lyft cloudflare datadog twilio asana gitlab mongodb elastic okta samsara scaleai webflow
    benchling betterment bitgo chime coursera duolingo faire fivetran flexport gemini glossier grammarly hashicorp hubspot intercom lattice marqeta mercury miro monzo mozilla nextdoor nuro opendoor pagerduty
    peloton postman quizlet roblox sofi squarespace sumologic thumbtack toast twitch udemy unity3d upstart affirm zscaler wealthfront waymo navan harness launchdarkly newrelic chainalysis anduril relativityspace
    spacex verkada zipline aurorainnovation andurilindustries airtable carta checkr cockroachlabs contentful dataminr doordash dbtlabsinc everlaw gitguardian greenhouse grubhub gusto honor ironclad kraken
    justworks klaviyo lucidmotors masterclass mixpanel narvar netlify notion oscar outschool patreon plaid poshmark qualtrics remitly rubrik segment sentry shopify skydio smartsheet snyk sourcegraph
    spotify stash sumup tanium tempus thoughtspot torch trueup tubitv unqork vimeo wayfair whoop yext zapier zoom cerebras mistral sigmacomputing hightouch amplitude brainco calendly clickup`,
  lever: `palantir spotify zoox lever eventbrite outreach shieldai anyscale wealthsimple netlify plaid hive matterport tala jobber shopmonkey voleon highspot welocalize`,
  ashby: `notion openai linear ramp replit cursor supabase posthog vanta modal perplexity elevenlabs harvey runway pinecone retool airbyte clerk resend neon railway cohere character sierra decagon glean hebbia
    writer zapier mercury dbtlabs temporal sourcegraph warp raycast langchain baseten together fireworks 1password watershed rippling deepgram lovable mintlify browserbase pylon attio granola cognition
    hex anysphere ollama replicate weaviate chroma nomic suno pika luma ideogram figure physicalintelligence skild abridge ambience hippocratic`,
  workday: `nvidia.wd5.myworkdayjobs.com|NVIDIAExternalCareerSite salesforce.wd12.myworkdayjobs.com|External_Career_Site adobe.wd5.myworkdayjobs.com|external_experienced intel.wd1.myworkdayjobs.com|External
    walmart.wd5.myworkdayjobs.com|WalmartExternal dell.wd1.myworkdayjobs.com|External hp.wd5.myworkdayjobs.com|ExternalCareerSite paypal.wd1.myworkdayjobs.com|jobs mastercard.wd1.myworkdayjobs.com|CorporateCareers
    capitalone.wd12.myworkdayjobs.com|Capital_One autodesk.wd1.myworkdayjobs.com|Ext workday.wd5.myworkdayjobs.com|Workday crowdstrike.wd5.myworkdayjobs.com|crowdstrikecareers
    boeing.wd1.myworkdayjobs.com|EXTERNAL_CAREERS disney.wd5.myworkdayjobs.com|disneycareer motorolasolutions.wd5.myworkdayjobs.com|Careers broadcom.wd1.myworkdayjobs.com|External_Career
    redhat.wd5.myworkdayjobs.com|jobs pfizer.wd1.myworkdayjobs.com|PfizerCareers target.wd5.myworkdayjobs.com|targetcareers accenture.wd3.myworkdayjobs.com|AccentureCareers
    athenahealth.wd1.myworkdayjobs.com|External yahoo.wd5.myworkdayjobs.com|careers 3m.wd1.myworkdayjobs.com|Search gm.wd5.myworkdayjobs.com|Careers_GM`,
  workable: `huggingface typeform remote toggl hotjar personio`,
  smartrecruiters: `BoschGroup Canva ServiceNow Visa LinkedIn3 Equinox IKEA Ubisoft2 Wix2 Atlassian`,
};

const out: { name: string; ats: string; board: string; jobs: number }[] = [];
const tasks = Object.entries(CANDIDATES).flatMap(([ats, list]) => list.split(/\s+/).filter(Boolean).map((board) => ({ ats, board })));
const nice = (ats: string, board: string) => {
  const b = ats === "workday" ? board.split(".")[0] : board;
  return b.replace(/inc$|industries$|careers$|\d+$/i, "").replace(/^./, (c) => c.toUpperCase());
};
let i = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let t = tasks[i++]; t; t = tasks[i++]) {
      try {
        const jobs = await FETCHERS[t.ats]({ id: null, name: nice(t.ats, t.board), ats: t.ats, board: t.board });
        if (jobs.length) out.push({ name: jobs[0].company && t.ats !== "workday" ? jobs[0].company : nice(t.ats, t.board), ats: t.ats, board: t.board, jobs: jobs.length });
        process.stdout.write(jobs.length ? "+" : "0");
      } catch {
        process.stdout.write(".");
      }
    }
  }),
);
out.sort((a, b) => a.ats.localeCompare(b.ats) || a.name.localeCompare(b.name));
fs.writeFileSync(fileURLToPath(new URL("../src/ingest/boards.json", import.meta.url)), JSON.stringify(out.map(({ jobs: _j, ...r }) => r), null, 1));
const byAts = out.reduce<Record<string, number>>((m, r) => ((m[r.ats] = (m[r.ats] ?? 0) + 1), m), {});
console.log(`\n${out.length} live boards of ${tasks.length} probed`, byAts, "jobs:", out.reduce((s, r) => s + r.jobs, 0));
