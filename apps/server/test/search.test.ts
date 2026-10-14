// Job search: the keyword query language, location parsing and buckets, and the search endpoint that combines them.
//   npm test --workspace apps/server
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-search-"));
process.env.LLM_DISABLED = "true";

const { compileQuery, describeQuery, parseQuery } = await import("../src/match/query.ts");
const { placesOf } = await import("../src/ingest/places.ts");
const { parseJobUrl } = await import("../src/ats.ts");
const { api } = await import("../src/api.ts");
const { upsertJob, getUserByEmail } = await import("../src/store.ts");
const { run } = await import("../src/db.ts");

let token = "";
const call = async (p: string) => (await api.request(p, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;
const keys = (loc: string, workplace?: string) => placesOf(loc, workplace).map((p) => p.key);

test("query language: AND by default, OR, phrases, exclusions, groups, prefixes; bad input degrades to words", () => {
  assert.equal(describeQuery(parseQuery('("machine learning" OR "data scientist") python -intern')), "(“machine learning” or “data scientist”) and python, but not intern");
  assert.equal(compileQuery("python OR golang").include, '{title company} : (("python" OR "golang"))');
  assert.equal(compileQuery("staff engineer -manager", "all").include, '{title company description} : ((("staff" AND "engineer") NOT ("manager")))');
  assert.deepEqual(compileQuery("-intern"), { include: null, exclude: '{title company} : ("intern")', node: parseQuery("-intern") });
  assert.equal(compileQuery("kube*").include, '{title company} : ("kube"*)');
  assert.equal(compileQuery("C++ c#").include, '{title company} : (("c++" AND "c#"))', "C++ and C# stay words");
  assert.equal(compileQuery("node.js").include, '{title company} : ("node js")', "punctuation inside a word makes a phrase");
  // Malformed: stray quote and parenthesis, lowercase or, operators alone.
  assert.equal(describeQuery(parseQuery('"machine learning')), "“machine learning”");
  assert.equal(describeQuery(parseQuery("(staff OR principal engineer")), "staff or principal and engineer");
  assert.equal(describeQuery(parseQuery("ml or ai")), "ml or ai");
  assert.equal(parseQuery("OR AND ()"), null);
  assert.equal(compileQuery("   ").include, null);
});

test("locations: cities, metros, states, countries and remote buckets from messy strings", () => {
  assert.deepEqual(keys("San Francisco"), ["us-ca-san-francisco", "metro-us-sfbay", "us-ca", "us"]);
  assert.deepEqual(keys("Palo Alto, CA"), ["us-ca-palo-alto", "metro-us-sfbay", "us-ca", "us"]);
  assert.deepEqual(keys("CHENNAI, TAMIL NADU, India"), ["in-chennai", "in-tamil-nadu", "in"]);
  assert.deepEqual(keys("Richardson, TX, US, 75080"), ["us-tx-richardson", "metro-us-dfw", "us-tx", "us"]);
  assert.deepEqual(keys("SAINT-LAURENT, Quebec, CA, H4T 2A2"), ["ca-qc-saint-laurent", "ca-qc", "ca"]);
  assert.deepEqual(keys("Remote - US"), ["us", "remote-us"]);
  assert.deepEqual(keys("Remote"), ["remote-any"]);
  assert.deepEqual(keys("United States", "remote"), ["us", "remote-us"]);
  assert.deepEqual(keys("Remote (United States | Canada)"), ["us", "remote-us", "ca", "remote-ca"]);
  assert.ok(keys("San Francisco, CA | New York City, NY").includes("metro-us-nyc"));
  assert.deepEqual(keys("New York"), ["us-ny-new-york", "metro-us-nyc", "us-ny", "us"], "bare New York is the city");
  assert.deepEqual(keys("Bangalore, India"), keys("Bengaluru, India"), "aliases land in one bucket");
  assert.deepEqual(keys("Washington, D.C."), ["us-dc-washington", "metro-us-dc", "us-dc", "us"]);
  assert.deepEqual(keys("Seattle, Washington"), ["us-wa-seattle", "metro-us-seattle", "us-wa", "us"]);
  assert.deepEqual(keys("2 Locations"), []);
  assert.deepEqual(keys("Hybrid"), []);
});

test("job links from more ATSes name their board (for adding a company)", () => {
  assert.deepEqual(parseJobUrl("https://ats.rippling.com/momentumcareers/jobs/abc").board, "momentumcareers");
  assert.equal(parseJobUrl("https://nexthopai.bamboohr.com/careers/62").board, "nexthopai");
  assert.equal(parseJobUrl("https://forge-nano.breezy.hr/p/66630c61f7e4/apply").board, "forge-nano");
  assert.equal(parseJobUrl("https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/42").board, "acme.fa.us2.oraclecloud.com|CX_1");
});

before(async () => {
  token = (await (await api.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "search@ferry.local", name: "Sam Rivera" }) })).json()).token;
  const base = { companyId: null, ats: "greenhouse", workplace: "onsite" as const, description: "", sponsorsVisa: null };
  const jobs = [
    ["Machine Learning Engineer", "Acme AI", "San Francisco, CA", "Train ranking models in Python and PyTorch."],
    ["Senior Data Scientist", "Beta Health", "Palo Alto, CA", "Python, SQL, experimentation."],
    ["Data Scientist Intern", "Gamma", "Mountain View, CA", "Summer internship, Python."],
    ["Backend Engineer (Go)", "Delta", "New York, NY", "Distributed systems in Go and Kubernetes."],
    ["Staff Software Engineer", "Epsilon", "Remote - US", "Platform work in TypeScript; machine learning a plus."],
    ["Frontend Engineer", "Zeta", "London, United Kingdom", "React and TypeScript."],
  ];
  jobs.forEach(([title, company, location, description], i) =>
    upsertJob({ ...base, company, title, location, description, externalId: `s${i}`, url: `https://example.com/j/${i}`, applyUrl: `https://example.com/j/${i}`, workplace: /remote/i.test(location) ? "remote" : "onsite" }),
  );
  // A match for the "For you" view.
  const u = getUserByEmail("search@ferry.local")!;
  const ml = (await call("/jobs/search?q=%22machine%20learning%20engineer%22")).items[0];
  run("INSERT INTO matches(user_id, job_id, score, verdict, method) VALUES(?,?,?,?,?)", u.id, ml.id, 88, "strong", "heuristic");
});

test("search: keywords, scope, places, For you, and the readout", async () => {
  const titles = (r: any) => r.items.map((j: any) => j.title).sort();
  let r = await call(`/jobs/search?q=${encodeURIComponent('("machine learning" OR "data scientist") -intern')}`);
  assert.deepEqual(titles(r), ["Machine Learning Engineer", "Senior Data Scientist"]);
  assert.equal(r.query.reading, "(“machine learning” or “data scientist”), but not intern");
  assert.equal(r.total, 2);

  r = await call(`/jobs/search?q=${encodeURIComponent('"machine learning"')}&in=all`);
  assert.deepEqual(titles(r), ["Machine Learning Engineer", "Staff Software Engineer"], "descriptions count with Titles & descriptions");

  r = await call(`/jobs/search?q=engineering`);
  assert.equal(r.total, 4, "stemming: engineering finds engineer");

  r = await call(`/jobs/search?places=metro-us-sfbay`);
  assert.deepEqual(titles(r), ["Data Scientist Intern", "Machine Learning Engineer", "Senior Data Scientist"]);
  r = await call(`/jobs/search?places=us`);
  assert.equal(r.total, 5, "United States includes Remote - US");
  r = await call(`/jobs/search?places=remote-us,gb`);
  assert.deepEqual(titles(r), ["Frontend Engineer", "Staff Software Engineer"], "several places: any of them");
  r = await call(`/jobs/search?q=python&in=all&places=metro-us-sfbay&sort=relevance`);
  assert.equal(r.total, 3);

  r = await call(`/jobs/search?forYou=1&minScore=60`);
  assert.deepEqual(titles(r), ["Machine Learning Engineer"]);
  r = await call(`/jobs/search?forYou=1&minScore=90`);
  assert.equal(r.total, 0);

  r = await call(`/jobs/search?limit=2&offset=2&sort=newest`);
  assert.equal(r.items.length, 2);
  assert.equal(r.total, 6);
});

test("location suggestions: grouped with counts, nicknames, picked places left out", async () => {
  let r = await call("/jobs/locations?q=bay");
  assert.deepEqual(r.groups[0], { kind: "metro", items: [{ key: "metro-us-sfbay", label: "San Francisco Bay Area", n: 3 }] });
  r = await call("/jobs/locations?q=nyc");
  assert.ok(r.groups.some((g: any) => g.items.some((i: any) => i.key === "us-ny-new-york")), "nyc → New York");
  r = await call("/jobs/locations?q=remote");
  assert.deepEqual(r.groups.find((g: any) => g.kind === "remote")?.items.map((i: any) => i.key), ["remote-us"]);
  r = await call("/jobs/locations?q=&selected=us");
  assert.ok(!r.groups.some((g: any) => g.items.some((i: any) => i.key === "us")));
  assert.deepEqual(r.selected, [{ key: "us", label: "United States", n: 5 }]);
});
