// Domain model. Status names mirror the pipeline recovered from the reference dashboard
// (see docs/RESEARCH.md §3) with two additions: QUEUED and NEEDS_INPUT.

export const PIPELINE_STATUSES = [
  "QUEUED",
  "OPTIMIZING",
  "OPTIMIZING_RESUME",
  "OPTIMIZING_CL",
  "PENDING_RESUME_REVIEW",
  "PENDING_CL_REVIEW",
  "PENDING_REVIEW",
  "PENDING_SUBMIT_REVIEW",
  "NEEDS_INPUT",
  "READY",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const TRACKED_STATUSES = ["APPLIED", "INTERVIEWING", "OFFER", "REJECTED", "GHOSTED"] as const;
export type TrackedStatus = (typeof TRACKED_STATUSES)[number];

/** UI tab buckets, same split as the reference: all · submitted · in_flight · needs · failed · skipped */
export const STATUS_BUCKETS: Record<string, PipelineStatus[]> = {
  submitted: ["COMPLETED"],
  in_flight: ["QUEUED", "OPTIMIZING", "OPTIMIZING_RESUME", "OPTIMIZING_CL", "READY", "RUNNING"],
  needs: ["PENDING_RESUME_REVIEW", "PENDING_CL_REVIEW", "PENDING_REVIEW", "PENDING_SUBMIT_REVIEW", "NEEDS_INPUT"],
  failed: ["FAILED"],
  skipped: ["SKIPPED"],
};

export type OptimizationMode = "off" | "honest" | "aggressive";

export interface ApplySettings {
  optimizationMode: OptimizationMode;
  autoApproveResume: boolean;
  coverLetterMode: OptimizationMode;
  autoApproveCoverLetter: boolean;
  /** Reference default is false: pause before the final submit for review. */
  autoSubmitApplication: boolean;
  /** Auto-apply: queue every match above the threshold automatically. */
  autoApply: boolean;
  autoApplyMinScore: number;
  autoApplyDailyLimit: number;
  /** Create per-employer candidate accounts (Workday etc.) with a generated password. */
  allowAccountCreation: boolean;
  /** Draft open-ended answers ("Why do you want to join …?") for each job. Off: those go to "Needs you". */
  autoWriteAnswers: boolean;
}

export const DEFAULT_APPLY_SETTINGS: ApplySettings = {
  optimizationMode: "honest",
  autoApproveResume: true,
  coverLetterMode: "honest",
  autoApproveCoverLetter: true,
  autoSubmitApplication: false,
  autoApply: false,
  autoApplyMinScore: 75,
  autoApplyDailyLimit: 25,
  allowAccountCreation: true,
  autoWriteAnswers: true,
};

// ---------- résumé blocks ----------
// A résumé is a list of blocks (sections of entries of bullets) plus a layout: template, type size,
// section order, hidden sections/links, and a page limit. Bullets may use **bold** and *italic*.

export interface Experience {
  id: string;
  company: string;
  title: string;
  location?: string;
  start?: string;
  end?: string;
  current?: boolean;
  /** One italic line under the role header. */
  summary?: string;
  bullets: string[];
  hidden?: boolean;
}

export interface Education {
  id: string;
  school: string;
  degree?: string;
  field?: string;
  minor?: string;
  honors?: string;
  location?: string;
  start?: string;
  end?: string;
  current?: boolean;
  gpa?: string;
  hidden?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  url?: string;
  start?: string;
  end?: string;
  bullets: string[];
  hidden?: boolean;
}

export interface SkillGroup {
  id: string;
  name: string;
  skills: string[];
}

export interface Certification {
  id: string;
  name: string;
  issuer?: string;
  date?: string;
  expires?: string;
  hidden?: boolean;
}

export interface CustomItem {
  id: string;
  title?: string;
  subtitle?: string;
  start?: string;
  end?: string;
  bullets: string[];
}

export interface CustomSection {
  id: string;
  title: string;
  items: CustomItem[];
}

export const BUILTIN_SECTIONS = ["summary", "experience", "education", "skills", "projects", "certifications", "coursework"] as const;
export type BuiltinSection = (typeof BUILTIN_SECTIONS)[number];
/** Built-in section keys, or `custom:<id>` for a custom section. */
export type SectionKey = BuiltinSection | `custom:${string}`;
export const HEADER_LINKS = ["location", "email", "phone", "linkedin", "github", "website"] as const;
export type HeaderLink = (typeof HEADER_LINKS)[number];

export const RESUME_TEMPLATES = ["classic", "serif", "modern", "compact"] as const;
export type ResumeTemplate = (typeof RESUME_TEMPLATES)[number];
export const RESUME_FONTS = ["arial", "times", "calibri", "georgia", "garamond"] as const;
export type ResumeFont = (typeof RESUME_FONTS)[number];

export interface ResumeStyle {
  template: ResumeTemplate;
  /** Overrides the template's typeface. */
  font?: ResumeFont;
  /** Base body size in points. */
  fontSize: number;
  align: "left" | "justify";
  /** Contact links as bare URLs ("linkedin.com/in/x") or labels ("LinkedIn"). */
  links: "url" | "label";
  /** 0 = no limit. Otherwise spacing, line height and then type size shrink until it fits. */
  pageLimit: 0 | 1 | 2;
  /** When shrinking isn't enough, drop the least relevant bullets (shown as changes). */
  trimToFit: boolean;
  /** Tailored output: Ferry's template, or the text projected into your own uploaded .docx. */
  output: "template" | "original";
}

export interface ResumeLayout {
  style: ResumeStyle;
  sectionOrder: SectionKey[];
  hiddenSections: SectionKey[];
  hiddenLinks: HeaderLink[];
}

/** The content of one résumé: what gets tailored and rendered. */
export interface ResumeDoc {
  headline?: string;
  summary?: string;
  experience: Experience[];
  education: Education[];
  /** Flat skill list (matching + ATS scoring). Rendered as-is unless skillGroups exist. */
  skills: string[];
  skillGroups?: SkillGroup[];
  projects?: Project[];
  certifications?: Certification[];
  coursework?: string[];
  custom?: CustomSection[];
  layout?: ResumeLayout;
}

export interface Profile {
  personal: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    address1?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    pronouns?: string;
  };
  workAuth: {
    authorizedCountries: string[];
    needsSponsorship: boolean;
    visaStatus?: string;
    /** ISO country of citizenship (passport), for export-control and passport questions. */
    citizenship?: string;
    /** Active U.S. security clearance: "None", "Public Trust", "Secret", "Top Secret", "TS/SCI", "TS/SCI with polygraph". */
    clearance?: string;
  };
  eeo: { gender?: string; race?: string; veteran?: string; disability?: string; hispanic?: string };
  preferences: {
    titles: string[];
    locations: string[];
    workplace: "any" | "remote" | "hybrid" | "onsite";
    seniority: string[];
    minSalary?: number;
    excludeCompanies: string[];
    keywords: string[];
  };
  logistics: {
    salaryExpectation?: string;
    noticePeriod?: string;
    earliestStart?: string;
    willingToRelocate?: boolean;
    yearsOfExperience?: number;
  };
  /** Long-term memory of answers to application questions, keyed by normalized question. */
  answers: Record<string, string>;
  /** Answer library: common questions with your answer, or "write it for each job". */
  library: AnswerEntry[];
}

export interface AnswerEntry {
  id: string;
  question: string;
  /**
   * fixed: use `answer` as written ({company} and {role} are filled in).
   * write: draft a fresh answer for each job; `answer` holds your notes for it ("mention I use their API").
   */
  mode: "fixed" | "write";
  answer: string;
  /** Built-in questions match many phrasings; custom ones match by wording. */
  builtin?: string;
}

export interface Job {
  id: string;
  companyId: string | null;
  company: string;
  ats: string;
  externalId: string;
  title: string;
  location: string;
  workplace: "remote" | "hybrid" | "onsite" | "unknown";
  department?: string;
  employmentType?: string;
  url: string;
  applyUrl: string;
  description: string;
  salary?: string;
  postedAt?: string;
  firstSeenAt: string;
  sponsorsVisa?: boolean | null;
}

export interface MatchResult {
  score: number;
  verdict: "strong" | "good" | "stretch" | "poor";
  reasons: string[];
  gaps: string[];
  method: "heuristic" | "llm";
  /** The résumé profile this job was scored against (the best-fitting one). */
  profileId?: string;
}

export type FieldKind = "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "file" | "listbox";

export interface FormField {
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  name?: string;
  placeholder?: string;
  /** The input's maxlength, when it has one. */
  maxLength?: number;
  /** File inputs: the accept attribute (".pdf,.docx"). */
  accept?: string;
  page?: number;
}

export interface FilledField extends FormField {
  value: string | string[] | null;
  /** library = your answer from the answer library; written = drafted for this job from your profile. */
  source: "profile" | "memory" | "ai" | "default" | "user" | "resume" | "library" | "written" | "unanswered";
  confidence: number;
  note?: string;
}

export interface TraceStep {
  t: string;
  kind: "thought" | "action" | "screenshot" | "error" | "page";
  text: string;
  image?: string;
}

export interface ResumeChange {
  section: string;
  before: string;
  after: string;
  reason: string;
}

export interface AtsScore {
  before: number;
  after: number;
  matched: string[];
  missing: string[];
}
