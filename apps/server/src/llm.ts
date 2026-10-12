import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "./config.ts";

// One Claude client for every AI feature (matching, tailoring, cover letters, form answers,
// email classification). Callers must check `llmEnabled()` and keep a deterministic fallback.

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export const llmEnabled = () => config.anthropicEnabled;

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
