import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.ts";

// One model client for every AI feature (matching, tailoring, cover letters, form answers, email classification).
// Providers: NVIDIA NIM (OpenAI-compatible; DeepSeek v4.1 by default, with fallback models) or Anthropic.
// Callers must check `llmEnabled()` and keep a deterministic fallback.

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export const llmEnabled = () => (config.llmProvider === "nim" ? config.nimEnabled : config.anthropicEnabled);
/** The model doing the work, for status lines. */
export const llmLabel = () =>
  config.llmProvider === "nim" ? `${config.model}${config.fastModel && config.fastModel !== config.model ? ` (quick tasks: ${config.fastModel})` : ""} via NVIDIA NIM` : config.model;

export class LlmUnavailable extends Error {}

type Effort = "low" | "medium" | "high";

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  prompt: string | Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * Structured output call. `fallbacks: "default"` lets the API re-run a classifier-declined
 * request on Anthropic's recommended fallback model instead of returning a refusal.
 */
export async function structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  if (!llmEnabled()) throw new LlmUnavailable("LLM disabled");
  if (config.llmProvider === "nim") return nimStructured(req);
  try {
    const res = await getClient().beta.messages.parse({
      model: config.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
    });
    if (res.stop_reason === "refusal") throw new LlmUnavailable(`refused: ${res.stop_details?.category ?? "unknown"}`);
    if (res.stop_reason === "max_tokens") throw new LlmUnavailable("hit max_tokens");
    if (res.parsed_output == null) throw new LlmUnavailable("unparseable structured output");
    return res.parsed_output as z.infer<S>;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new LlmUnavailable("invalid Anthropic credentials");
    if (err instanceof Anthropic.RateLimitError) throw new LlmUnavailable("rate limited");
    if (err instanceof Anthropic.APIError) throw new LlmUnavailable(`API error ${err.status}: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new LlmUnavailable("connection error");
    throw err;
  }
}

/** Free-text call (cover letters, reply drafts). */
export async function text(req: { system: string; prompt: string; effort?: Effort; maxTokens?: number }): Promise<string> {
  if (!llmEnabled()) throw new LlmUnavailable("LLM disabled");
  if (config.llmProvider === "nim") return (await nimChat(req.system, req.prompt, { maxTokens: req.maxTokens, effort: req.effort })).trim();
  try {
    const res = await getClient().beta.messages.create({
      model: config.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: req.effort ?? "medium" },
    });
    if (res.stop_reason === "refusal") throw new LlmUnavailable("refused");
    return res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Anthropic.APIError) throw new LlmUnavailable(`API error ${err.status}: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new LlmUnavailable("connection error");
    throw err;
  }
}

/** Run an LLM path, falling back to a deterministic implementation on any LLM failure. */
export async function withFallback<T>(label: string, llmPath: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  if (!llmEnabled()) return fallback();
  try {
    return await llmPath();
  } catch (err) {
    console.warn(`[llm] ${label} fell back: ${(err as Error).message}`);
    return fallback();
  }
}

// ---------- NVIDIA NIM (OpenAI-compatible chat completions) ----------

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** Models that just timed out or failed are skipped until this time, so every call doesn't wait on them. */
const resting = new Map<string, number>();
/** Models that reject response_format: json_object (asked for JSON in the prompt alone). */
const noJsonMode = new Set<string>();
/** Models whose chat template rejects the thinking switch. */
const noThinkSwitch = new Set<string>();
/** Extra tokens a thinking model may spend reasoning before it writes the answer (they count against max_tokens). */
const THINK_BUDGET = 8000;

const promptText = (p: string | Anthropic.Beta.BetaContentBlockParam[]) =>
  typeof p === "string" ? p : p.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n\n");

/**
 * One chat completion. DeepSeek and Nemotron think before answering by default, and that reasoning counts against
 * max_tokens: a short budget comes back with no answer at all. So thinking is off unless asked for (high effort), and
 * then gets its own budget; a thinking reply that still runs dry is asked again with thinking off.
 */
async function nimRequest(model: string, messages: ChatMessage[], opts: { maxTokens: number; json: boolean; temperature: number; think: boolean }): Promise<string> {
  const body: Record<string, unknown> = { model, messages, max_tokens: opts.maxTokens + (opts.think ? THINK_BUDGET : 0), temperature: opts.temperature };
  if (opts.json && !noJsonMode.has(model)) body.response_format = { type: "json_object" };
  // DeepSeek's template reads `thinking`, Nemotron's `enable_thinking`; each ignores the other's.
  if (!noThinkSwitch.has(model)) body.chat_template_kwargs = { thinking: opts.think, enable_thinking: opts.think };
  let res: Response;
  try {
    res = await fetch(`${config.nimBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NVIDIA_NIM_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
  } catch (e) {
    throw new LlmUnavailable(/abort|timeout/i.test(String((e as Error).message)) ? `${model} timed out` : `connection error (${(e as Error).message})`);
  }
  if (res.status === 400) {
    const t = await res.text();
    if (body.chat_template_kwargs && /chat_template|thinking/i.test(t)) {
      noThinkSwitch.add(model);
      return nimRequest(model, messages, opts);
    }
    if (body.response_format && /response_format|json/i.test(t)) {
      noJsonMode.add(model);
      return nimRequest(model, messages, opts);
    }
    throw new LlmUnavailable(`API error 400: ${t.slice(0, 200)}`);
  }
  if (res.status === 401 || res.status === 403) throw new LlmUnavailable("invalid NVIDIA NIM credentials");
  if (!res.ok) throw new LlmUnavailable(`${model}: API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const c = d.choices?.[0];
  if (!c?.message?.content) {
    if (opts.think) return nimRequest(model, messages, { ...opts, think: false });
    throw new LlmUnavailable(`${model}: empty reply${c?.finish_reason === "length" ? " (ran out of tokens)" : ""}`);
  }
  // Some templates leave the reasoning inline.
  return c.message.content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
}

/** A small queue: at most LLM_CONCURRENCY requests in flight. */
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= config.llmConcurrency) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/** Try the main model, then the fallbacks; a model that fails rests for five minutes. */
async function nimChat(system: string, prompt: string | ChatMessage[], opts: { maxTokens?: number; effort?: Effort; json?: boolean } = {}): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...(typeof prompt === "string" ? [{ role: "user" as const, content: prompt }] : prompt)];
  // Quick tasks (match scores, inbox sorting) all have rule-based fallbacks, so they never wait on the slower main
  // model: if the quick models are busy, the caller falls back at once.
  const quick = opts.effort === "low" && Boolean(config.fastModel);
  const models = quick ? [...new Set([config.fastModel, ...config.fallbackModels.filter((m) => m !== config.model)])] : [...new Set([config.model, ...config.fallbackModels])];
  const awake = models.filter((m) => (resting.get(m) ?? 0) < Date.now());
  if (quick && !awake.length) throw new LlmUnavailable("quick models are resting");
  let last: Error | null = null;
  for (const model of awake.length ? awake : models) {
    try {
      const reply = await slot(() => nimRequest(model, messages, { maxTokens: opts.maxTokens ?? 8000, json: Boolean(opts.json), temperature: opts.effort === "high" ? 0.4 : 0.2, think: opts.effort === "high" }));
      if (process.env.LLM_DEBUG) console.error(`[llm] ${model} replied:\n${reply.slice(0, 4000)}`);
      return reply;
    } catch (e) {
      last = e as Error;
      if (/credentials/.test(last.message)) throw last;
      // Rate limits clear in a minute; a model that timed out or failed rests longer.
      resting.set(model, Date.now() + (/API error 429/.test(last.message) ? 60_000 : 5 * 60_000));
      console.warn(`[llm] ${last.message}; trying the next model`);
    }
  }
  throw last instanceof LlmUnavailable ? last : new LlmUnavailable(String(last?.message ?? "no model available"));
}

/** The JSON object in a reply (models sometimes wrap it in a code fence or a sentence). */
export function extractJson(s: string): unknown {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : s).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("no JSON in the reply");
  }
}

/**
 * Smaller models drop properties they'd leave empty and send 1 for "1". Fill what the schema can say for certain:
 * a missing required text is "", a missing list is [], a number or yes/no where text belongs becomes text.
 * Anything else is left for the schema check (and the repair turn) to catch.
 */
export function fillGaps(v: unknown, s: any): unknown {
  if (!s || typeof s !== "object") return v;
  if (s.type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
    const o = { ...(v as Record<string, unknown>) };
    for (const [k, ps] of Object.entries<any>(s.properties ?? {})) {
      if (o[k] === undefined || o[k] === null) {
        if (!s.required?.includes(k)) continue;
        const t = ps.type ?? ps.anyOf?.[0]?.type;
        if (t === "string" && !ps.enum && !ps.anyOf?.[0]?.enum) o[k] = "";
        else if (t === "array") o[k] = [];
        continue;
      }
      o[k] = fillGaps(o[k], ps);
    }
    return o;
  }
  if (s.type === "array" && Array.isArray(v)) return v.map((x) => fillGaps(x, s.items));
  const takesText = (x: any) => x?.type === "string" && !x.enum;
  if ((takesText(s) || s.anyOf?.some(takesText)) && (typeof v === "number" || typeof v === "boolean")) return String(v);
  return v;
}

async function nimStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  const schema = z.toJSONSchema(req.schema, { target: "draft-7", unrepresentable: "any" });
  const system = `${req.system}\n\nReply with one JSON object only (no prose, no code fences) that matches this JSON Schema exactly. Every required property must be present; use "" or [] when unknown.\n${JSON.stringify(schema)}`;
  const user = promptText(req.prompt);
  const convo: ChatMessage[] = [{ role: "user", content: user }];
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await nimChat(system, convo, { maxTokens: req.maxTokens ?? 8000, effort: req.effort, json: true });
    try {
      const parsed = req.schema.safeParse(fillGaps(extractJson(reply), schema));
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    } catch (e) {
      problem = (e as Error).message;
    }
    // One repair turn: show the model what didn't match.
    convo.push({ role: "assistant", content: reply.slice(0, 20000) }, { role: "user", content: `That JSON doesn't match the schema (${problem}). Reply with the corrected JSON object only.` });
  }
  throw new LlmUnavailable(`unparseable structured output (${problem.slice(0, 300)})`);
}
