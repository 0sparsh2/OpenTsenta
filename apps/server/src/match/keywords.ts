// Skill lexicon used for deterministic matching and ATS keyword scoring. Each entry is a
// canonical name plus aliases; matching is whole-word and case-insensitive.

const LEXICON: [string, ...string[]][] = [
  // languages
  ["JavaScript", "js", "ecmascript"],
  ["TypeScript", "ts"],
  ["Python"],
  ["Go", "golang"],
  ["Rust"],
  ["Java"],
  ["Kotlin"],
  ["Swift"],
  ["Objective-C"],
  ["C++", "cpp"],
  ["C#", "csharp"],
  ["Ruby"],
  ["PHP"],
  ["Scala"],
  ["Elixir"],
  ["Haskell"],
  ["SQL"],
  ["R"],
  ["Bash", "shell scripting"],
  ["Solidity"],
  // web / frontend
  ["React", "react.js", "reactjs"],
  ["Next.js", "nextjs"],
  ["Vue", "vue.js"],
  ["Angular"],
  ["Svelte"],
  ["HTML"],
  ["CSS"],
  ["Tailwind", "tailwindcss"],
  ["Redux"],
  ["GraphQL"],
  ["REST", "restful", "rest apis"],
  ["gRPC"],
  ["WebSockets", "websocket"],
  ["Node.js", "node", "nodejs"],
  ["Deno"],
  ["Express", "express.js"],
  ["Django"],
  ["Flask"],
  ["FastAPI"],
  ["Rails", "ruby on rails"],
  ["Spring", "spring boot"],
  [".NET", "dotnet", "asp.net"],
  ["React Native"],
  ["Flutter"],
  ["iOS"],
  ["Android"],
  ["SwiftUI"],
  ["Jetpack Compose"],
  ["WebAssembly", "wasm"],
  ["Accessibility", "a11y", "wcag"],
  // data / infra
  ["PostgreSQL", "postgres"],
  ["MySQL"],
  ["SQLite"],
  ["MongoDB"],
  ["Redis"],
  ["Elasticsearch"],
  ["Cassandra"],
  ["DynamoDB"],
  ["Kafka"],
  ["RabbitMQ"],
  ["Snowflake"],
  ["BigQuery"],
  ["Redshift"],
  ["dbt"],
  ["Airflow"],
  ["Spark", "apache spark", "pyspark"],
  ["Hadoop"],
  ["Flink"],
  ["ClickHouse"],
  ["AWS", "amazon web services"],
  ["GCP", "google cloud"],
  ["Azure"],
  ["Kubernetes", "k8s"],
  ["Docker"],
  ["Terraform"],
  ["Pulumi"],
  ["Ansible"],
  ["Linux"],
  ["CI/CD", "ci cd", "continuous integration"],
  ["GitHub Actions"],
  ["Jenkins"],
  ["Prometheus"],
  ["Grafana"],
  ["Datadog"],
  ["OpenTelemetry"],
  ["Microservices", "microservice"],
  ["Distributed systems", "distributed system"],
  ["System design"],
  ["Serverless", "lambda"],
  ["CDN"],
  ["Networking", "tcp/ip"],
  ["Security", "appsec", "application security"],
  ["OAuth"],
  ["Cryptography"],
  // ML / AI
  ["Machine learning", "ml"],
  ["Deep learning"],
  ["LLM", "llms", "large language models"],
  ["NLP", "natural language processing"],
  ["Computer vision"],
  ["PyTorch"],
  ["TensorFlow"],
  ["JAX"],
  ["scikit-learn", "sklearn"],
  ["Pandas"],
  ["NumPy"],
  ["Reinforcement learning", "rl", "rlhf"],
  ["MLOps"],
  ["RAG", "retrieval augmented generation"],
  ["Embeddings", "vector database", "pgvector"],
  ["Evals", "evaluation", "model evaluation"],
  ["CUDA"],
  ["Statistics", "statistical"],
  ["A/B testing", "experimentation", "ab testing"],
  ["Data analysis", "analytics"],
  ["Tableau"],
  ["Looker"],
  ["Excel"],
  // product / design / business
  ["Product management", "product manager"],
  ["Roadmapping", "roadmap"],
  ["User research"],
  ["Figma"],
  ["Prototyping"],
  ["Design systems", "design system"],
  ["UX", "user experience"],
  ["UI", "user interface"],
  ["Interaction design"],
  ["Visual design"],
  ["Motion design"],
  ["Copywriting"],
  ["SEO"],
  ["Growth"],
  ["Marketing"],
  ["Content marketing"],
  ["Salesforce"],
  ["HubSpot"],
  ["Enterprise sales"],
  ["SaaS"],
  ["Account management"],
  ["Customer success"],
  ["Solutions engineering", "solutions engineer", "sales engineering"],
  ["Technical writing", "documentation"],
  ["Payments"],
  ["Fintech"],
  ["Compliance"],
  ["Recruiting"],
  ["Operations"],
  ["Project management"],
  ["Agile", "scrum"],
  ["Leadership", "people management", "managed a team"],
  ["Mentoring", "mentorship"],
  ["Stakeholder management", "cross-functional"],
];

const ALIAS: Map<string, string> = new Map();
for (const [canon, ...aliases] of LEXICON) {
  ALIAS.set(canon.toLowerCase(), canon);
  for (const a of aliases) ALIAS.set(a.toLowerCase(), canon);
}
// Ambiguous short aliases that create false positives in prose.
const PROSE_UNSAFE = new Set(["r", "go", "ts", "js", "ml", "rl", "ui", "ux", "node", "lambda", "rest", "spring", "express", "swift", "evaluation"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = [...ALIAS.entries()]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([alias, canon]) => ({ alias, canon, re: new RegExp(`(?<![\\w+#.])${escapeRe(alias)}(?![\\w+#])`, "i") }));

/** Canonical skills mentioned in a text. `strict` skips ambiguous short aliases (for JDs / prose). */
export function extractSkills(text: string, strict = true): string[] {
  const found = new Set<string>();
  for (const p of PATTERNS) {
    if (strict && PROSE_UNSAFE.has(p.alias)) {
      // Allow "Go" / "R" etc. only when written with the canonical capitalisation.
      const exact = new RegExp(`(?<![\\w+#.])${escapeRe(p.canon)}(?![\\w+#])`);
      if (p.alias === p.canon.toLowerCase() && exact.test(text) && p.canon.length > 1) found.add(p.canon);
      continue;
    }
    if (p.re.test(text)) found.add(p.canon);
  }
  return [...found];
}

export const canonicalSkill = (s: string) => ALIAS.get(s.toLowerCase().trim()) ?? s.trim();

// ---------- titles and seniority ----------

const STOP = new Set(["and", "or", "of", "the", "a", "an", "to", "for", "in", "at", "with", "i", "ii", "iii", "iv", "-", "–", "&", "/"]);
const TITLE_SYNONYMS: Record<string, string> = {
  swe: "software engineer",
  sde: "software engineer",
  "software developer": "software engineer",
  developer: "engineer",
  dev: "engineer",
  pm: "product manager",
  frontend: "front end",
  "front-end": "front end",
  backend: "back end",
  "back-end": "back end",
  fullstack: "full stack",
  "full-stack": "full stack",
  ml: "machine learning",
  ai: "machine learning",
  sre: "site reliability",
  "member of technical staff": "software engineer",
  mts: "software engineer",
};

export function titleTokens(t: string): string[] {
  let s = ` ${t.toLowerCase().replace(/[(),|:]/g, " ")} `;
  for (const [k, v] of Object.entries(TITLE_SYNONYMS)) s = s.replace(new RegExp(`(?<=\\s)${escapeRe(k)}(?=\\s)`, "g"), v);
  return s
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9+#.]/g, ""))
    .filter((w) => w && !STOP.has(w) && !SENIORITY_WORDS.has(w));
}

const SENIORITY_WORDS = new Set(["senior", "sr", "staff", "principal", "lead", "junior", "jr", "intern", "internship", "new", "grad", "graduate", "entry", "level", "mid", "head", "director", "vp", "manager"]);

export type Seniority = "intern" | "entry" | "mid" | "senior" | "staff" | "manager" | "director";

export function titleSeniority(title: string): Seniority {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|co-?op\b/.test(t)) return "intern";
  if (/\b(vp|vice president|director|head of)\b/.test(t)) return "director";
  if (/\b(principal|staff|distinguished|architect)\b/.test(t)) return "staff";
  if (/\bmanager\b/.test(t) && !/product manager|program manager|account manager|project manager/.test(t)) return "manager";
  if (/\b(senior|sr\.?|lead)\b|\biii\b|\biv\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|new grad|graduate|entry|associate)\b|\bi\b/.test(t)) return "entry";
  return "mid";
}

export function seniorityFromYears(years: number): Seniority {
  if (years < 1) return "entry";
  if (years < 3) return "entry";
  if (years < 6) return "mid";
  if (years < 10) return "senior";
  return "staff";
}

const ORDER: Seniority[] = ["intern", "entry", "mid", "senior", "staff", "manager", "director"];
export const seniorityDistance = (a: Seniority, b: Seniority) => Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b));
