import http from "node:http";

// A local stand-in for POST /v1/messages that speaks the same wire format as the real API, so the
// SDK integration (headers, structured outputs, fallbacks, parsing) can be tested without a key.
// Responses are deterministic and shaped by which Ferry feature is calling (detected from the system prompt).

export interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}

function sample(schema: any): any {
  if (!schema) return null;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v)]));
    case "array":
      return [sample(schema.items)];
    case "string":
      return "sample";
    case "integer":
    case "number":
      return 80;
    case "boolean":
      return true;
    default:
      return null;
  }
}

function between(text: string, open: string, close: string) {
  const a = text.indexOf(open);
  const b = text.indexOf(close, a + open.length);
  return a >= 0 && b > a ? text.slice(a + open.length, b) : "";
}

function respond(body: Record<string, any>): { json?: unknown; text?: string } {
  const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
  const content = body.messages?.[0]?.content;
  const prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const schema = body.output_config?.format?.schema;

  if (/senior technical recruiter/i.test(system)) return { json: { score: 91, reasons: ["Led a Go microservices migration on Kubernetes", "Six years of TypeScript and React"], gaps: ["No robotics background"] } };
  if (/tailor résumés/i.test(system)) {
    const doc = JSON.parse(between(prompt, "<resume_json>\n", "\n</resume_json>") || "{}");
    return {
      json: {
        must_have_keywords: ["Kubernetes", "TypeScript", "distributed systems"],
        headline: "Full-stack engineer for distributed systems",
        summary: "Full-stack engineer with six years building TypeScript and Go services on Kubernetes.",
        experience: (doc.experience ?? []).map((e: any) => ({
          id: e.id,
          bullets: e.bullets.map((b: string, i: number) => ({ text: i === 0 ? `Built distributed ${b.replace(/^Built /, "")}` : b, original_index: i, reason: i === 0 ? "Uses the posting's terminology" : "Unchanged" })),
        })),
        projects: [],
        // Like a real model under keyword pressure: the posting's phrases slipped in as "skills" (Ferry must drop them).
        skills: [...(doc.skills ?? []), "builder mentality", "0-to-1 product"],
        skill_groups: (doc.skillGroups ?? []).map((g: any) => ({ id: g.id, skills: [...g.skills, "deeply collaborative", "customer embedding"] })),
      },
    };
  }
  if (/answers to job application questions/i.test(system)) {
    const ids = [...prompt.matchAll(/<q id="([^"]+)"[^>]*>([^<\n]*)/g)];
    return {
      json: {
        answers: ids.map(([, id, label]) => ({
          id,
          answer: `I'm excited about ${/acme/i.test(label) ? "Acme's fleet software" : "this role"} because my distributed systems work maps directly to it.`,
          needs_user: false,
        })),
      },
    };
  }
  if (/fill job application forms/i.test(system)) {
    const fields = JSON.parse(between(prompt, "<fields>\n", "\n</fields>") || "[]");
    return {
      json: {
        answers: fields.map((f: any) => ({
          id: f.id,
          value: f.options?.length ? f.options[0] : `I'm excited about ${/acme/i.test(f.label) ? "Acme's fleet software" : "this role"} because my distributed systems work maps directly to it.`,
          needs_user: false,
          confidence: 0.8,
        })),
      },
    };
  }
  if (/triage a job seeker's inbox/i.test(system)) {
    const cat = /unfortunately/i.test(prompt) ? "rejection" : /interview|schedule/i.test(prompt) ? "interview" : /thank you for applying/i.test(prompt) ? "confirmation" : "other";
    return { json: { job_related: cat !== "other", category: cat, company: "Acme Robotics", summary: "Classified by the fake model" } };
  }
  if (/extract job postings/i.test(system)) return { json: { is_job_posting: true, title: "Staff Engineer", company: "Example Co", location: "Remote", description: "Build things." } };
  if (/convert résumé text/i.test(system))
    return {
      json: {
        contact: { firstName: "Alex", lastName: "Morgan", email: "alex@morgan.dev", phone: "(415) 555-0142", city: "San Francisco", region: "CA", country: "US", linkedin: "linkedin.com/in/alex-morgan-dev", github: "github.com/alexmorgan", website: "" },
        headline: "Full-stack engineer",
        summary: "Full-stack engineer with 6 years of experience in TypeScript, React, Node.js, and Go.",
        experience: [
          { company: "Brightline Analytics", title: "Senior Software Engineer", location: "San Francisco, CA", start: "2022-01", end: "", current: true, bullets: ["Built features for the customer dashboard using React and TypeScript.", "Led migration to Go microservices on Kubernetes, cutting p95 latency 38%."] },
          { company: "Parcel Labs", title: "Software Engineer", location: "", start: "2019-06", end: "2021-12", current: false, bullets: ["Implemented real-time tracking with WebSockets and Redis for 4M MAU."] },
        ],
        education: [{ school: "University of California, Davis", degree: "B.S.", field: "Computer Science", start: "", end: "2019", gpa: "3.7" }],
        projects: [],
        skills: ["TypeScript", "React", "Node.js", "Go", "Kubernetes", "PostgreSQL", "Redis", "AWS", "Terraform", "Distributed systems"],
      },
    };
  if (/operate a browser/i.test(system)) return { json: { thought: "The form is visible", action: "done", target: "", value: "" } };
  if (/cover letters/i.test(system)) return { text: "Dear Hiring Team,\n\nFake-model cover letter.\n\nAlex Morgan" };
  if (/reply from the candidate/i.test(system)) return { text: "Hi, thanks! I'm free Tuesday 2-4pm.\n\nAlex" };
  return schema ? { json: sample(schema) } : { text: "ok" };
}

export async function startFakeAnthropic(): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
        return;
      }
      const r = respond(body);
      const text = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${requests.length}` });
      res.end(
        JSON.stringify({
          id: `msg_fake_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
