export type PipelineStatus =
  | "QUEUED"
  | "OPTIMIZING"
  | "OPTIMIZING_RESUME"
  | "OPTIMIZING_CL"
  | "PENDING_RESUME_REVIEW"
  | "PENDING_CL_REVIEW"
  | "PENDING_REVIEW"
  | "PENDING_SUBMIT_REVIEW"
  | "NEEDS_INPUT"
  | "READY"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export type TrackedStatus = "APPLIED" | "INTERVIEWING" | "OFFER" | "REJECTED" | "GHOSTED";
export const TRACKED: TrackedStatus[] = ["APPLIED", "INTERVIEWING", "OFFER", "REJECTED", "GHOSTED"];

export interface Me {
  id: string;
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
  authMode: "dev" | "password";
  name: string | null;
  plan: string;
  credits: number;
  onboarded: boolean;
  token: string;
  llm: boolean;
  allowRealSubmit: boolean;
  brand: string;
}

export interface Match {
  score: number;
  verdict: "strong" | "good" | "stretch" | "poor";
  reasons: string[];
  gaps: string[];
  method: "heuristic" | "llm";
  status?: string;
  /** The résumé profile this job was scored against. */
  profileId?: string | null;
}

export interface JobCard {
  id: string;
  title: string;
  company: string;
  location: string;
  workplace: "remote" | "hybrid" | "onsite" | "unknown";
  department?: string;
  ats: string;
  atsName: string;
  url: string;
  salary?: string;
  postedAt?: string;
  firstSeenAt: string;
  sponsorsVisa?: boolean | null;
  match: Match | null;
  applicationId?: string | null;
  applicationStatus?: PipelineStatus | null;
}
export interface JobDetail extends JobCard {
  description: string;
  applyUrl: string;
  applicationId: string | null;
}

export interface AtsScore {
  before: number;
  after: number;
  matched: string[];
  missing: string[];
}
export interface ResumeChange {
  section: string;
  before: string;
  after: string;
  reason: string;
}
export interface FilledField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  value: string | string[] | null;
  source: "profile" | "memory" | "ai" | "default" | "user" | "resume" | "library" | "written" | "unanswered";
  confidence: number;
  note?: string;
  page?: number;
}
export interface TraceStep {
  t: string;
  kind: "thought" | "action" | "screenshot" | "error" | "page";
  text: string;
  image?: string;
}

export interface Experience {
  id: string;
  company: string;
  title: string;
  location?: string;
  start?: string;
  end?: string;
  current?: boolean;
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
export type SectionKey = "summary" | "experience" | "education" | "skills" | "projects" | "certifications" | "coursework" | `custom:${string}`;
export type HeaderLink = "location" | "email" | "phone" | "linkedin" | "github" | "website";
export interface ResumeStyle {
  template: "classic" | "serif" | "modern" | "compact";
  font?: "arial" | "times" | "calibri" | "georgia" | "garamond";
  fontSize: number;
  align: "left" | "justify";
  links: "url" | "label";
  pageLimit: 0 | 1 | 2;
  trimToFit: boolean;
  output: "template" | "original";
}
export interface ResumeLayout {
  style: ResumeStyle;
  sectionOrder: SectionKey[];
  hiddenSections: SectionKey[];
  hiddenLinks: HeaderLink[];
}
export interface ResumeDoc {
  headline?: string;
  summary?: string;
  experience: Experience[];
  education: Education[];
  skills: string[];
  skillGroups?: SkillGroup[];
  projects?: Project[];
  certifications?: Certification[];
  coursework?: string[];
  custom?: CustomSection[];
  layout?: ResumeLayout;
}
export interface FitInfo {
  pages: number;
  limit: number;
  step: number;
  cut: string[];
  overflow: boolean;
  fontSize: number;
}
export interface ResumeCatalog {
  templates: { id: ResumeStyle["template"]; label: string; font: string; entry: "inline" | "stacked" }[];
  fonts: { id: NonNullable<ResumeStyle["font"]>; label: string; generic: string }[];
  maxRedos: number;
}
export interface TailoredResume {
  applicationId: string;
  status: PipelineStatus;
  profile: { id: string; name: string; hasDocx: boolean } | null;
  base: ResumeDoc | null;
  tailored: ResumeDoc | null;
  changes: ResumeChange[];
  atsScore: AtsScore | null;
  keywords: string[];
  redos: { used: number; remaining: number; max: number };
  instructions: string | null;
  profiles: { id: string; name: string; isDefault: boolean }[];
  editable: boolean;
}

export interface ApplicationRow {
  id: string;
  status: PipelineStatus;
  /** The résumé profile this application uses. */
  profile: { id: string; name: string } | null;
  trackedStatus: TrackedStatus | null;
  source: string;
  job: { id: string; title: string; company: string; location: string; ats: string; atsName: string; url: string; description?: string } | null;
  atsScore: AtsScore | null;
  changesCount: number;
  hasCoverLetter: boolean;
  lastThought: string | null;
  currentPage: number | null;
  totalPages: number | null;
  error: string | null;
  confirmation: { url?: string; text?: string; screenshot?: string; dryRun?: boolean } | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  needs: string[];
}
export interface ApplicationDetail extends ApplicationRow {
  tailored: ResumeDoc | null;
  changes: ResumeChange[];
  coverLetter: string | null;
  fields: FilledField[];
  trace: TraceStep[];
  statusHistory: { status: string; at: string; note?: string }[];
  resumeId: string | null;
  hasPdf: boolean;
}

export interface Profile {
  personal: { firstName: string; lastName: string; email: string; phone?: string; address1?: string; postalCode?: string; city?: string; region?: string; country?: string; linkedin?: string; github?: string; website?: string; pronouns?: string };
  workAuth: { authorizedCountries: string[]; needsSponsorship: boolean; visaStatus?: string; citizenship?: string; clearance?: string };
  eeo: { gender?: string; race?: string; veteran?: string; disability?: string; hispanic?: string };
  preferences: { titles: string[]; locations: string[]; workplace: "any" | "remote" | "hybrid" | "onsite"; seniority: string[]; minSalary?: number; excludeCompanies: string[]; keywords: string[] };
  logistics: { salaryExpectation?: string; noticePeriod?: string; earliestStart?: string; willingToRelocate?: boolean; yearsOfExperience?: number };
  answers: Record<string, string>;
  library: AnswerEntry[];
}

export interface AnswerEntry {
  id: string;
  question: string;
  /** write: drafted fresh for each job (answer = your notes); fixed: used as written. */
  mode: "fixed" | "write";
  answer: string;
  builtin?: string;
}

export interface ApplySettings {
  optimizationMode: "off" | "honest" | "aggressive";
  autoApproveResume: boolean;
  coverLetterMode: "off" | "honest" | "aggressive";
  autoApproveCoverLetter: boolean;
  autoSubmitApplication: boolean;
  autoApply: boolean;
  autoApplyMinScore: number;
  autoApplyDailyLimit: number;
  allowAccountCreation: boolean;
  autoWriteAnswers: boolean;
}

/** A résumé profile: one imported résumé aimed at a role family. */
export interface Resume {
  id: string;
  name: string;
  fileName: string | null;
  hasDocx: boolean;
  origin: "import" | "duplicate" | "blank";
  doc: ResumeDoc;
  layout: ResumeLayout;
  targets: { titles: string[]; keywords: string[] };
  notes: string;
  isDefault: boolean;
  applications: number;
  createdAt: string;
}

export interface InboxMessage {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  category: string | null;
  company: string | null;
  applicationId: string | null;
  draftReply: string | null;
  read: boolean;
  application: ApplicationRow | null;
}

/** A place to filter jobs by (a city, metro, state, country, or remote bucket), with its count of open jobs. */
export interface PlaceOption {
  key: string;
  label: string;
  n: number;
}

export interface Company {
  id: string;
  name: string;
  ats: string;
  board: string;
  active: number;
  last_polled_at: string | null;
  last_error: string | null;
  job_count: number;
}

export interface Bootstrap {
  user: Omit<Me, "token" | "llm" | "allowRealSubmit" | "brand">;
  counts: Record<string, number>;
  topMatches: JobCard[];
  recent: ApplicationRow[];
  unread: number;
  hasResume: boolean;
  poller: { running: boolean; lastRun: { at: string; newJobs: number; companies: number; errors: number } | null; intervalMin: number };
  totals: { jobs: number; companies: number };
  llm: boolean;
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  credits: number;
  blurb: string;
  popular?: boolean;
}
