// The NVIDIA NIM provider (OpenAI-compatible chat completions; DeepSeek by default), against a local fake of the API:
// request shape, JSON mode, schema-checked output with one repair turn, and falling back past a stalled model.
//   npm test --workspace apps/server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const seen: { model: string; auth?: string; json: boolean; system: string; turns: number; think: boolean; maxTokens: number }[] = [];

/** Fills a JSON Schema with plausible values. */
function sample(s: any): any {
  if (!s) return null;
  if (s.enum) return s.enum[0];
  if (s.type === "object") return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]));
  if (s.type === "array") return [sample(s.items)];
  if (s.type === "string") return "sample";
  if (s.type === "integer" || s.type === "number") return 80;
  if (s.type === "boolean") return true;
  return null;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const system = body.messages[0].content as string;
    const think = body.chat_template_kwargs?.thinking === true && body.chat_template_kwargs?.enable_thinking === true;
    seen.push({ model: body.model, auth: req.headers.authorization, json: body.response_format?.type === "json_object", system, turns: body.messages.length, think, maxTokens: body.max_tokens });
    const reply = (content: string) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
    };
    // A thinking model that spends its whole budget reasoning: no answer.
    if (think) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, reasoning_content: "Let me think…" }, finish_reason: "length" }] }));
      return;
    }
    const schemaText = system.slice(system.lastIndexOf("\n") + 1);
    const schema = schemaText.startsWith("{") ? JSON.parse(schemaText) : null;
    switch (body.model) {
      case "stalled":
        return; // never answers: the client's time limit must move on
      case "down":
        res.writeHead(503).end("busy");
        return;
      case "limited":
        res.writeHead(429).end('{"status":429,"title":"Too Many Requests"}');
        return;
      case "sloppy":
        // JSON in a code fence after some prose; the first reply misses a required field, the repair turn fixes it.
        if (!schema) return reply("Hi there.");
        if (body.messages.length === 2) {
          const partial = sample(schema);
          delete partial.score;
          return reply(`Sure! Here it is:\n\`\`\`json\n${JSON.stringify(partial)}\n\`\`\``);
        }
        return reply(JSON.stringify(sample(schema)));
      default:
        return reply(schema ? JSON.stringify(sample(schema)) : "Tailoring puts your most relevant work first.");
    }
  });
});
await new Promise<void>((r) => server.listen(0, r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

Object.assign(process.env, {
  NVIDIA_NIM_API_KEY: "nvapi-test",
  NVIDIA_NIM_BASE_URL: url,
  LLM_PROVIDER: "nim",
  LLM_MODEL: "stalled",
  LLM_FALLBACK_MODELS: "down,sloppy",
  LLM_FAST_MODEL: "quick",
  LLM_TIMEOUT_MS: "400",
  LLM_DISABLED: "false",
});
const { z } = await import("zod");
const { structured, text, llmEnabled, llmLabel, extractJson } = await import("../src/llm.ts");

after(() => {
  server.closeAllConnections();
  server.close();
});

const Fit = z.object({ score: z.number().int(), verdict: z.enum(["strong", "good", "stretch", "poor"]), reasons: z.array(z.string()) });

test("NIM: OpenAI-style request with the key and JSON mode; a stalled and a down model are passed over; bad JSON is repaired", async () => {
  assert.equal(llmEnabled(), true);
  assert.match(llmLabel(), /stalled \(quick tasks: quick\) via NVIDIA NIM/);
  const t0 = Date.now();
  const r = await structured({ system: "Score the fit.", prompt: "Candidate vs job.", schema: Fit });
  assert.deepEqual(r, { score: 80, verdict: "strong", reasons: ["sample"] });
  assert.ok(Date.now() - t0 < 5000, "the stalled model's time limit moved things along");
  assert.deepEqual(
    seen.map((s) => s.model),
    ["stalled", "down", "sloppy", "sloppy"],
    "main model, then fallbacks in order; one repair turn on the model that answered",
  );
  assert.ok(seen.every((s) => s.auth === "Bearer nvapi-test" && s.json));
  assert.ok(seen.every((s) => !s.think), "thinking is off unless asked for");
  assert.match(seen[0].system, /^Score the fit\.\n\nReply with one JSON object only/);
  assert.equal(seen[3].turns, 4, "the repair turn shows the model its reply and what didn't match");

  // The models that failed rest for a while: the next call goes straight to the one that works.
  seen.length = 0;
  assert.equal(await text({ system: "Be brief.", prompt: "Why tailor a résumé?" }), "Hi there.");
  assert.deepEqual(
    seen.map((s) => s.model),
    ["sloppy"],
  );
  assert.equal(seen[0].json, false, "free text isn't JSON mode");

  // High effort thinks, with room to reason on top of the answer; a reply that runs dry is asked again without it.
  seen.length = 0;
  assert.equal(await text({ system: "Be brief.", prompt: "Why tailor a résumé?", effort: "high", maxTokens: 1000 }), "Hi there.");
  assert.deepEqual(
    seen.map((s) => [s.model, s.think, s.maxTokens]),
    [
      ["sloppy", true, 9000],
      ["sloppy", false, 1000],
    ],
  );
});

test("quick tasks go to the fast model first; writing stays on the main one", async () => {
  seen.length = 0;
  await structured({ system: "Classify.", prompt: "An email.", schema: Fit, effort: "low" });
  assert.deepEqual(
    seen.map((s) => s.model),
    ["quick"],
  );
  seen.length = 0;
  await text({ system: "Write.", prompt: "A letter.", effort: "medium" });
  assert.notEqual(seen[0].model, "quick");
});

test("a quick task whose quick models are busy fails fast instead of waiting on the main model", async () => {
  const { config } = await import("../src/config.ts");
  const prev = [config.fastModel, config.fallbackModels];
  Object.assign(config, { fastModel: "limited", fallbackModels: ["limited"] });
  try {
    seen.length = 0;
    await assert.rejects(structured({ system: "Classify.", prompt: "An email.", schema: Fit, effort: "low" }));
    assert.deepEqual(
      seen.map((s) => s.model),
      ["limited"],
      "the stalled main model is never tried for a quick task",
    );
    seen.length = 0;
    await assert.rejects(structured({ system: "Classify.", prompt: "Another.", schema: Fit, effort: "low" }), /resting/);
    assert.equal(seen.length, 0, "while it rests (a minute, for a rate limit), quick tasks don't even ask");
  } finally {
    Object.assign(config, { fastModel: prev[0], fallbackModels: prev[1] });
  }
});

test("extractJson: plain, fenced, or wrapped in a sentence", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('Here you go: {"a":"x"} hope that helps'), { a: "x" });
  assert.throws(() => extractJson("no json here"));
});

test("fillGaps: missing empty fields filled, numbers where text belongs turned to text, nothing else guessed", async () => {
  const { fillGaps } = await import("../src/llm.ts");
  const Op = z.object({ op: z.enum(["set", "hide"]), value: z.union([z.string(), z.array(z.string())]), values: z.array(z.string()), note: z.string().optional() });
  const schema = z.toJSONSchema(z.object({ ops: z.array(Op), reply: z.string() }), { target: "draft-7" });
  assert.deepEqual(fillGaps({ ops: [{ op: "set", value: 1 }, { op: "hide", value: ["a"], values: ["b"] }] }, schema), {
    ops: [
      { op: "set", value: "1", values: [] },
      { op: "hide", value: ["a"], values: ["b"] },
    ],
    reply: "",
  });
  // A missing enum or a wrong shape is left for the schema check.
  assert.deepEqual(fillGaps({ ops: ["hide it"] }, schema), { ops: ["hide it"], reply: "" });
  assert.deepEqual(fillGaps({ ops: [{ op: "hide", values: [] }] }, schema), { ops: [{ op: "hide", value: "", values: [] }], reply: "" }, "a missing text-or-list is empty text");
  assert.equal(z.object({ ops: z.array(Op), reply: z.string() }).safeParse(fillGaps({ ops: [{ value: "x" }] }, schema)).success, false);
});
