import { text, withFallback } from "../llm.ts";
import { resumeText } from "../match/score.ts";
import type { Job, OptimizationMode, Profile, ResumeDoc } from "../types.ts";
import { truncate } from "../util/text.ts";

export async function writeCoverLetter(profile: Profile, doc: ResumeDoc, job: Job, mode: OptimizationMode): Promise<string | null> {
  if (mode === "off") return null;
  const name = `${profile.personal.firstName} ${profile.personal.lastName}`.trim();
  return withFallback(
    "cover-letter",
    () =>
      text({
        system: `You write concise, specific cover letters in the candidate's own plain voice. 3 short paragraphs, under 220 words.
No clichés ("I am writing to express", "passionate", "perfect fit"). Cite 2 concrete achievements from the résumé that map to the posting, each with the employer it happened at.
${mode === "honest" ? "Only use facts from the résumé." : "Lead with the strongest truthful framing; never invent facts."}
Output only the letter body, starting with "Dear Hiring Team," and ending with the candidate's name.`,
        effort: "medium",
        maxTokens: 2000,
        prompt: `<job title="${job.title}" company="${job.company}">\n${truncate(job.description, 8000)}\n</job>\n\n<resume>\n${truncate(resumeText(doc), 8000)}\n</resume>\n\nCandidate name: ${name}`,
      }),
    () => templateLetter(name, doc, job),
  );
}

function templateLetter(name: string, doc: ResumeDoc, job: Job): string {
  const recent = doc.experience[0];
  const wins = doc.experience.flatMap((e) => e.bullets).filter((b) => /\d/.test(b)).slice(0, 2);
  return [
    "Dear Hiring Team,",
    "",
    `I'm applying for the ${job.title} role at ${job.company}.${recent ? ` I'm currently ${recent.current ? "working as" : "most recently was"} ${recent.title} at ${recent.company}.` : ""}`,
    "",
    wins.length ? `A couple of things I've done that map to this role:\n${wins.map((w) => `• ${w}`).join("\n")}` : `My background in ${doc.skills.slice(0, 4).join(", ")} lines up with what the team is looking for.`,
    "",
    `I'd welcome the chance to talk about how I can help ${job.company}. Thank you for your time.`,
    "",
    name,
  ].join("\n");
}
