import type { AnswerEntry } from "../types.ts";

// Built-in library questions. Kept free of imports: the store seeds every profile with these.

export interface Builtin {
  id: string;
  question: string;
  mode: AnswerEntry["mode"];
  /** Tested against the normalized label with the company name replaced by "company". */
  re: RegExp;
  hint: string;
  /** Checked before the broad ones ("Why are you leaving…" before "Why are you…"). */
  first?: boolean;
}

export const BUILTINS: Builtin[] = [
  {
    id: "why_company",
    question: "Why are you interested in joining {company}?",
    mode: "write",
    re: /why (are|were) you (interested|excited|applying|drawn)|why you('re| are) (interested|excited|applying|drawn)|what makes you (excited|interested|want)|why (do|would) you (want|like) to (join|work|be)|why d you like to (join|work)|what (interests|excites|attracts|draws|appeals to) you|why (this|our|the) (company|role|team|position|opportunity)|why (join|work (at|for)) company|interest(ed)? in (joining|working)|why company|motivat(es|ion|ed) you to apply|what made you (decide to |want to )?apply|why did you apply/,
    hint: "What genuinely draws you (products you use, mission, team). Ferry weaves it into each answer.",
  },
  {
    id: "fit",
    question: "Why are you a good fit for this role?",
    mode: "write",
    re: /(why|what makes) (are )?you (a |the )?(good|great|strong|ideal|right|best) (fit|candidate|match)|what (would|will|can|do) you bring|why should we (hire|choose)|what qualifies you|how (does|do) your (experience|background|skills) (prepare|qualify|align|match)/,
    hint: "Strengths you want every fit answer to lead with.",
  },
  {
    id: "about_you",
    question: "Tell us about yourself",
    mode: "write",
    re: /tell (us|me) (a (little|bit) )?about yourself|introduce yourself|(brief|short) (bio|summary|introduction)|describe (yourself|your background)|professional summary|^about (you|yourself)$/,
    hint: "Anything to always mention about yourself.",
  },
  {
    id: "proud_project",
    question: "Describe a project or accomplishment you're proud of",
    mode: "write",
    re: /proud|(most )?(significant|impactful|meaningful|challenging|interesting) (project|accomplishment|achievement|problem)|describe a (project|time|situation)|tell (us|me) about a (project|time)|an accomplishment|greatest achievement/,
    hint: "The project you'd most like to talk about.",
  },
  {
    id: "looking_for",
    question: "What are you looking for in your next role?",
    mode: "write",
    re: /what are you looking for|ideal (role|job|position|team|company)|next (role|position|step|opportunity)|career goals|where do you see yourself|what do you want (to do|in a)/,
    hint: "What you want next: scope, team, problems.",
  },
  {
    id: "leaving",
    question: "Why are you leaving your current role?",
    mode: "fixed",
    first: true,
    re: /why are you (leaving|looking)|reason (for|you are) (leaving|looking)|why (did|do) you (want to )?leave/,
    hint: "Ferry won't guess this one; leave blank to be asked.",
  },
  {
    id: "additional",
    question: "Is there anything else you'd like us to know?",
    mode: "fixed",
    re: /anything else|additional (information|info|comments|details|notes)|is there anything|other (information|comments)|^comments$/,
    hint: "Left blank, Ferry leaves the box empty.",
  },
];

export function defaultLibrary(): AnswerEntry[] {
  return BUILTINS.map((b) => ({ id: b.id, question: b.question, mode: b.mode, answer: "", builtin: b.id }));
}

/** Built-ins the user doesn't have yet (new ones added in later versions), appended to their library. */
export function withDefaults(lib: AnswerEntry[] | undefined): AnswerEntry[] {
  const have = new Set((lib ?? []).map((e) => e.builtin).filter(Boolean));
  return [...(lib ?? []), ...defaultLibrary().filter((e) => !have.has(e.builtin))];
}

export const builtinHint = (id?: string) => BUILTINS.find((b) => b.id === id)?.hint;

