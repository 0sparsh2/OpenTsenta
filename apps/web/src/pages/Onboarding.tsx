import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Check, FileUp, Sparkles } from "lucide-react";
import { errorMessage, useCompleteOnboardingMutation, useProfileQuery, useResumesQuery, useSaveProfileMutation, useUploadResumeMutation } from "../lib/api";
import type { Profile } from "../lib/types";
import { Button, Card, cx, Input, Label, Logo, Segmented, Spinner, Toggle } from "../components/ui";
import { toast } from "../components/toast";

const SENIORITY = [
  { id: "intern", label: "Intern" },
  { id: "entry", label: "Entry" },
  { id: "mid", label: "Mid" },
  { id: "senior", label: "Senior" },
  { id: "staff", label: "Staff+" },
  { id: "manager", label: "Manager" },
];

export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-card px-2 py-1.5 focus-within:border-sea focus-within:ring-3 focus-within:ring-sea/15">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-ink/6 px-2 py-0.5 text-[13px]">
          {v}
          <button type="button" className="text-muted hover:text-ink" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? "" : placeholder}
        className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}

export default function Onboarding() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const { data: resumes } = useResumesQuery();
  const { data: profile } = useProfileQuery();
  const [upload, { isLoading: uploading }] = useUploadResumeMutation();
  const [saveProfile, { isLoading: saving }] = useSaveProfileMutation();
  const [complete, { isLoading: finishing }] = useCompleteOnboardingMutation();
  const [p, setP] = useState<Profile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (profile) setP(structuredClone(profile));
  }, [profile]);
  useEffect(() => {
    if (resumes?.length && step === 0) setStep(1);
  }, [resumes, step]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.set("file", f);
    try {
      const r = await upload(fd).unwrap();
      setP((cur) => (cur ? { ...cur, personal: { ...cur.personal, ...r.contact } } : cur));
      toast(`Created your "${r.resume.name}" profile: ${r.resume.doc.experience.length} roles, ${r.resume.doc.skills.length} skills`, "success");
      setStep(1);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const set = <K extends keyof Profile>(k: K, v: Partial<Profile[K]>) => setP((cur) => (cur ? { ...cur, [k]: { ...(cur[k] as object), ...v } } : cur));

  const finish = async () => {
    if (!p) return;
    await saveProfile(p).unwrap();
    await complete().unwrap();
    toast("You're set. Ferry is scoring every open role against your résumé.", "success");
    nav("/app");
  };

  const steps = ["Résumé", "About you", "What you want"];
  return (
    <div className="min-h-dvh px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-[620px]">
        <Logo className="mb-8" />
        <div className="mb-6 flex items-center gap-2">
          {steps.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold", i < step ? "bg-kelp text-white" : i === step ? "bg-ink text-paper" : "bg-ink/8 text-muted")}>
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cx("text-[13px] font-medium", i === step ? "text-ink" : "text-muted")}>{s}</span>
              {i < steps.length - 1 && <span className="h-px flex-1 bg-line" />}
            </div>
          ))}
        </div>

        {step === 0 && (
          <Card className="p-6">
            <h1 className="display text-[34px]">Start with your résumé.</h1>
            <p className="mt-1 text-[14px] text-muted">
              It becomes your first résumé profile, which Ferry tailors for every role. Going after different kinds of roles? Add a profile per role later, each from its own résumé. PDF, DOCX, or TXT.
            </p>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void onFile(e.dataTransfer.files[0]);
              }}
              className={cx("mt-5 flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 transition-colors", dragging ? "border-sea bg-sea-soft" : "border-line-2 hover:border-ink/40 hover:bg-paper")}
            >
              {uploading ? <Spinner className="h-6 w-6" /> : <FileUp className="h-7 w-7 text-ink-2" />}
              <span className="mt-3 font-medium">{uploading ? "Reading your résumé…" : "Drop your résumé here or click to browse"}</span>
              <span className="mt-1 text-[12px] text-muted">Up to 10 MB</span>
            </button>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </Card>
        )}

        {step === 1 && p && (
          <Card className="p-6">
            <h1 className="display text-[34px]">Check the basics.</h1>
            <p className="mt-1 mb-5 text-[14px] text-muted">These go into every application form, so they need to be exact.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>First name</Label>
                <Input value={p.personal.firstName} onChange={(e) => set("personal", { firstName: e.target.value })} />
              </div>
              <div>
                <Label>Last name</Label>
                <Input value={p.personal.lastName} onChange={(e) => set("personal", { lastName: e.target.value })} />
              </div>
              <div>
                <Label>Email</Label>
                <Input type="email" value={p.personal.email} onChange={(e) => set("personal", { email: e.target.value })} />
              </div>
              <div>
                <Label>Phone</Label>
                <Input value={p.personal.phone ?? ""} onChange={(e) => set("personal", { phone: e.target.value })} />
              </div>
              <div>
                <Label>City</Label>
                <Input value={p.personal.city ?? ""} onChange={(e) => set("personal", { city: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>State</Label>
                  <Input value={p.personal.region ?? ""} onChange={(e) => set("personal", { region: e.target.value })} />
                </div>
                <div>
                  <Label>Country</Label>
                  <Input value={p.personal.country ?? ""} onChange={(e) => set("personal", { country: e.target.value.toUpperCase() })} placeholder="US" />
                </div>
              </div>
              <div>
                <Label>LinkedIn</Label>
                <Input value={p.personal.linkedin ?? ""} onChange={(e) => set("personal", { linkedin: e.target.value })} />
              </div>
              <div>
                <Label>GitHub / website</Label>
                <Input value={p.personal.github ?? p.personal.website ?? ""} onChange={(e) => set("personal", { github: e.target.value })} />
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label hint="ISO codes, comma separated">Authorized to work in</Label>
                  <TagInput value={p.workAuth.authorizedCountries} onChange={(v) => set("workAuth", { authorizedCountries: v.map((x) => x.toUpperCase()) })} placeholder="US" />
                </div>
                <div>
                  <Label>Years of experience</Label>
                  <Input type="number" min={0} value={p.logistics.yearsOfExperience ?? ""} onChange={(e) => set("logistics", { yearsOfExperience: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </div>
              </div>
              <Toggle checked={p.workAuth.needsSponsorship} onChange={(v) => set("workAuth", { needsSponsorship: v })} label="I need visa sponsorship" sub="Used to answer sponsorship questions and to skip roles that say they don't sponsor." />
            </div>
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(0)} icon={<ArrowLeft className="h-4 w-4" />}>
                Re-upload
              </Button>
              <Button variant="primary" loading={saving} onClick={async () => { await saveProfile(p).unwrap(); setStep(2); }} icon={<ArrowRight className="h-4 w-4" />}>
                Continue
              </Button>
            </div>
          </Card>
        )}

        {step === 2 && p && (
          <Card className="p-6">
            <h1 className="display text-[34px]">What are you looking for?</h1>
            <p className="mt-1 mb-5 text-[14px] text-muted">Ferry only surfaces roles that fit. You can change this any time.</p>
            <div className="space-y-4">
              <div>
                <Label hint="press Enter to add">Target titles</Label>
                <TagInput value={p.preferences.titles} onChange={(v) => set("preferences", { titles: v })} placeholder="Senior Software Engineer, Full Stack Engineer" />
              </div>
              <div>
                <Label>Level</Label>
                <div className="flex flex-wrap gap-1.5">
                  {SENIORITY.map((s) => {
                    const on = p.preferences.seniority.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => set("preferences", { seniority: on ? p.preferences.seniority.filter((x) => x !== s.id) : [...p.preferences.seniority, s.id] })}
                        className={cx("h-8 rounded-lg border px-3 text-[13px] font-medium", on ? "border-ink bg-ink text-paper" : "border-line bg-card hover:border-line-2")}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label>Workplace</Label>
                <Segmented
                  value={p.preferences.workplace}
                  onChange={(v) => set("preferences", { workplace: v })}
                  options={[
                    { value: "any", label: "Any" },
                    { value: "remote", label: "Remote" },
                    { value: "hybrid", label: "Hybrid" },
                    { value: "onsite", label: "On-site" },
                  ]}
                />
              </div>
              <div>
                <Label>Preferred locations</Label>
                <TagInput value={p.preferences.locations} onChange={(v) => set("preferences", { locations: v })} placeholder="San Francisco, New York" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label hint="used in forms">Salary expectation</Label>
                  <Input value={p.logistics.salaryExpectation ?? ""} onChange={(e) => set("logistics", { salaryExpectation: e.target.value })} placeholder="$180,000" />
                </div>
                <div>
                  <Label>Earliest start</Label>
                  <Input value={p.logistics.earliestStart ?? ""} onChange={(e) => set("logistics", { earliestStart: e.target.value })} placeholder="2 weeks notice" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)} icon={<ArrowLeft className="h-4 w-4" />}>
                Back
              </Button>
              <Button variant="signal" size="lg" loading={finishing || saving} onClick={finish} icon={<Sparkles className="h-4 w-4" />}>
                Find my matches
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
