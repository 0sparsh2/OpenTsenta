// Offline check: every zod schema used for structured outputs converts to a JSON schema
// without keywords the structured-outputs endpoint rejects.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const schemas: Record<string, z.ZodType> = {
  match: z.object({ score: z.number().int(), reasons: z.array(z.string()), gaps: z.array(z.string()) }),
  tailor: z.object({
    must_have_keywords: z.array(z.string()),
    headline: z.string(),
    summary: z.string(),
    experience: z.array(z.object({ id: z.string(), bullets: z.array(z.object({ text: z.string(), original_index: z.number().int(), reason: z.string() })) })),
    skills: z.array(z.string()),
  }),
  answers: z.object({ answers: z.array(z.object({ id: z.string(), value: z.string(), needs_user: z.boolean(), confidence: z.number() })) }),
  classify: z.object({ job_related: z.boolean(), category: z.enum(["confirmation", "interview", "rejection", "other"]), company: z.string(), summary: z.string() }),
};
const BAD = ["minimum", "maximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "$ref"];
for (const [name, s] of Object.entries(schemas)) {
  const f = betaZodOutputFormat(s) as unknown as { type: string; schema: Record<string, unknown> };
  const json = JSON.stringify(f.schema);
  const bad = BAD.filter((k) => json.includes(`"${k}"`));
  console.log(`${name.padEnd(9)} type=${f.type} additionalProperties=false:${json.includes('"additionalProperties":false')} ${bad.length ? "UNSUPPORTED: " + bad.join(",") : "ok"}`);
}
