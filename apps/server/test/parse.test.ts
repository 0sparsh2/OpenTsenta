// Résumé import without Claude: real PDFs (rendered by Chromium from HTML, so they carry true layout and link
// annotations) through text extraction and the built-in parser.
//   npm test --workspace apps/server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { fileToText, heuristicParse } from "../src/resume/parse.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-parse-"));
let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function pdfOf(name: string, body: string) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body{font-family:Arial,sans-serif;font-size:10px;margin:0;color:#222} h1{font-size:16px;text-align:center;margin:0}
    h2{font-size:11px;text-align:center;margin:8px 0 3px} .row{display:flex;justify-content:space-between} ul{margin:2px 0 4px 14px;padding:0}
    p{margin:2px 0} a{color:#15c}</style></head><body>${body}</body></html>`);
  const file = path.join(dir, `${name}.pdf`);
  await page.pdf({ path: file, format: "Letter", margin: { top: "30px", bottom: "30px", left: "36px", right: "36px" } });
  await page.close();
  return file;
}

test("PDF import: right-aligned dates, links behind 'link' words, wrapped bullets, projects, education and skill groups", async () => {
  const file = await pdfOf(
    "single",
    `<h1>JORDAN LEE</h1>
    <p style="text-align:center">Portland, OR, USA | P: +1 503-555-0199 | jordan.lee@example.com | linkedin.com/in/jordanlee-example | <a href="https://github.com/jordanlee-example">Github</a></p>
    <p>Machine learning engineer who ships retrieval and ranking systems end to end. I care about evaluation, latency budgets, and keeping models honest in production.</p>
    <h2>WORK EXPERIENCE</h2>
    <div class="row"><span>Northwind Labs | Senior ML Engineer | Portland, OR, USA</span><span>Feb 2022 – Present</span></div>
    <ul><li>Search Relevance: Rebuilt the ranking stack with a two-tower retriever and a cross-encoder re-ranker over 40M documents, lifting click-through by 18% and cutting p95 latency from 340ms to 120ms across every
    surface</li><li>Evaluation: Built offline and online evaluation with interleaving tests.</li></ul>
    <div class="row"><span>Contoso Analytics | Data Scientist | Remote, India</span><span>Jun 2019 – Jan 2022</span></div>
    <ul><li>Forecasting: Shipped demand forecasts for 2,000 stores.</li></ul>
    <h2>PROJECTS / VOLUNTEER</h2>
    <div class="row"><span>Lumen - Open-source vector cache <a href="https://github.com/jordanlee-example/lumen">link</a> | 31 ★</span><span>Mar 2025 - May 2025</span></div>
    <ul><li>A semantic cache for LLM calls with policy-aware eviction.</li></ul>
    <p>Additional: Tally (a tiny metrics SDK) <a href="https://github.com/jordanlee-example/tally">link</a> · Quill (prompt diffing for teams) <a href="https://github.com/jordanlee-example/quill">link</a></p>
    <h2>EDUCATION</h2>
    <div class="row"><span>Oregon State University - Master of Science in Computer Science</span><span>Corvallis, OR, USA | 2017 - 2019</span></div>
    <h2>SKILLS</h2>
    <p><b>ML &amp; AI:</b> Retrieval, Ranking, Learning to Rank, Vector Databases (FAISS, Milvus, pgvector), Evaluation (offline, online, interleaving), Feature Stores, Model Serving, Distributed Training, Computer
    Vision, MLOps</p>
    <p><b>Engineering:</b> Python, Go, SQL, Kubernetes, CI/CD</p>`,
  );
  const text = await fileToText(file, file);
  const { doc, contact } = heuristicParse(text);

  assert.equal(contact.firstName, "Jordan");
  assert.equal(contact.github, "github.com/jordanlee-example", "the 'Github' word's link target");
  assert.match(doc.summary ?? "", /^Machine learning engineer who ships/);

  assert.equal(doc.experience.length, 2);
  const [nw, co] = doc.experience;
  assert.deepEqual([nw.company, nw.title, nw.location, nw.start, nw.current], ["Northwind Labs", "Senior ML Engineer", "Portland, OR, USA", "2022-02", true]);
  assert.match(nw.bullets[0], /across every surface$/, "a wrapped bullet keeps its last line");
  assert.equal(nw.bullets.length, 2);
  assert.deepEqual([co.company, co.title, co.location, co.end], ["Contoso Analytics", "Data Scientist", "Remote, India", "2022-01"]);

  const projects = doc.projects ?? [];
  assert.deepEqual(
    projects.map((p) => [p.name, p.url]),
    [
      ["Lumen", "github.com/jordanlee-example/lumen"],
      ["Tally", "github.com/jordanlee-example/tally"],
      ["Quill", "github.com/jordanlee-example/quill"],
    ],
  );
  assert.match(projects[0].description ?? "", /Open-source vector cache · 31 ★/);
  assert.equal(projects[0].start, "2025-03");
  assert.equal(projects[0].bullets.length, 1);

  assert.deepEqual(
    doc.education.map((e) => [e.school, e.degree, e.field, e.location, e.start, e.end]),
    [["Oregon State University", "Master of Science", "Computer Science", "Corvallis, OR, USA", "2017", "2019"]],
  );

  assert.deepEqual(doc.skillGroups?.map((g) => g.name), ["ML & AI", "Engineering"]);
  const ml = doc.skillGroups![0].skills;
  assert.ok(ml.includes("Vector Databases (FAISS, Milvus, pgvector)"), "commas inside parentheses don't split a skill");
  assert.ok(ml.includes("Computer Vision"), "a skill wrapped across lines stays whole");
  assert.ok(!doc.skills.includes("Growth"), "only the skills you listed");
});

test("PDF import: a two-column résumé is read column by column", async () => {
  const file = await pdfOf(
    "columns",
    `<h1>RIVER PATEL</h1><p style="text-align:center">river.patel@example.com | +1 206-555-0123 | Seattle, WA</p>
    <div style="display:flex;gap:28px;margin-top:10px">
      <div style="width:32%">
        <h2 style="text-align:left">SKILLS</h2><p>Python, TypeScript, PostgreSQL, Kafka, Terraform, Kubernetes</p>
        <h2 style="text-align:left">EDUCATION</h2><p>University of Michigan - Bachelor of Science in Computer Science</p><p>2014 - 2018</p>
        <h2 style="text-align:left">CERTIFICATIONS</h2><p>AWS Solutions Architect – Amazon, 2022</p>
      </div>
      <div style="flex:1">
        <h2 style="text-align:left">EXPERIENCE</h2>
        <p>Helio Systems | Staff Engineer | Seattle, WA</p><p>Jan 2021 – Present</p>
        <ul><li>Led the event pipeline rewrite onto Kafka, handling 2B events a day.</li><li>Cut cloud spend 30% with right-sizing and spot fleets.</li></ul>
        <p>Brightpath | Software Engineer | Remote</p><p>Jul 2018 – Dec 2020</p>
        <ul><li>Built the billing service and its reconciliation jobs.</li></ul>
      </div>
    </div>`,
  );
  const text = await fileToText(file, file);
  const { doc } = heuristicParse(text);
  assert.deepEqual(
    doc.experience.map((e) => [e.company, e.title, e.start]),
    [
      ["Helio Systems", "Staff Engineer", "2021-01"],
      ["Brightpath", "Software Engineer", "2018-07"],
    ],
  );
  assert.equal(doc.experience[0].bullets.length, 2);
  assert.ok(doc.skills.includes("Kafka") && doc.skills.includes("Terraform"));
  assert.equal(doc.education[0]?.school, "University of Michigan");
  assert.equal(doc.certifications?.[0]?.name, "AWS Solutions Architect");
});
