import { useEffect, useState } from "react";
import { Link } from "react-router";
import { FileText, MessageSquareText } from "lucide-react";
import { errorMessage, useProfileQuery, useRematchMutation, useSaveProfileMutation } from "../lib/api";
import type { Profile } from "../lib/types";
import { PageHeader } from "../components/AppLayout";
import { toast } from "../components/toast";
import { Button, Card, Input, Label, SectionTitle, Segmented, Select, Spinner, Toggle } from "../components/ui";
import { TagInput } from "./Onboarding";

const VISA_STATUSES = ["Green card (permanent resident)", "H-1B", "F-1 OPT / STEM OPT", "TN", "L-1", "O-1", "EAD (other)", "Other"];
const CLEARANCES = ["None", "Public Trust", "Secret", "Top Secret", "TS/SCI", "TS/SCI with polygraph"];

const EEO_OPTS = {
  gender: ["", "Male", "Female", "Non-binary", "Decline to self-identify"],
  hispanic: ["", "Yes", "No", "Decline to self-identify"],
  race: ["", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races", "Decline to self-identify"],
  veteran: ["", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I don't wish to answer"],
  disability: ["", "No, I do not have a disability", "Yes, I have a disability", "I do not wish to answer"],
};

export default function ProfilePage() {
  const { data } = useProfileQuery();
  const [save, { isLoading: saving }] = useSaveProfileMutation();
  const [rematch] = useRematchMutation();
  const [p, setP] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data) {
      setP(structuredClone(data));
      setDirty(false);
    }
  }, [data]);
  const set = <K extends keyof Profile>(k: K, v: Partial<Profile[K]>) => {
    setDirty(true);
    setP((cur) => (cur ? { ...cur, [k]: { ...(cur[k] as object), ...v } } : cur));
  };
  if (!p) return <Spinner className="mx-auto mt-24 h-6 w-6" />;

  const persist = async () => {
    try {
      await save(p).unwrap();
      await rematch().unwrap();
      toast("Profile saved. Re-scoring jobs against it.", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <PageHeader
        title="About you"
        sub="Contact details, eligibility, and what you're looking for. Shared by every résumé profile."
        action={
          <Button variant="primary" disabled={!dirty} loading={saving} onClick={persist}>
            Save changes
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle title="Contact" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ["firstName", "First name"],
                ["lastName", "Last name"],
                ["email", "Email"],
                ["phone", "Phone"],
                ["address1", "Street address"],
                ["city", "City"],
                ["region", "State / region"],
                ["postalCode", "Postal code"],
                ["country", "Country (ISO)"],
                ["pronouns", "Pronouns"],
                ["linkedin", "LinkedIn"],
                ["github", "GitHub"],
                ["website", "Website"],
              ] as const
            ).map(([k, l]) => (
              <div key={k}>
                <Label>{l}</Label>
                <Input value={(p.personal[k] as string) ?? ""} onChange={(e) => set("personal", { [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle title="Job preferences" sub="Drives matching and auto-apply" />
          <div className="space-y-3">
            <div>
              <Label>Target titles</Label>
              <TagInput value={p.preferences.titles} onChange={(v) => set("preferences", { titles: v })} />
            </div>
            <div>
              <Label>Locations</Label>
              <TagInput value={p.preferences.locations} onChange={(v) => set("preferences", { locations: v })} />
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
              <Label hint="intern, entry, mid, senior, staff, manager">Levels</Label>
              <TagInput value={p.preferences.seniority} onChange={(v) => set("preferences", { seniority: v.map((x) => x.toLowerCase()) })} />
            </div>
            <div>
              <Label hint="boosts roles mentioning these">Keywords</Label>
              <TagInput value={p.preferences.keywords} onChange={(v) => set("preferences", { keywords: v })} />
            </div>
            <div>
              <Label>Never apply to</Label>
              <TagInput value={p.preferences.excludeCompanies} onChange={(v) => set("preferences", { excludeCompanies: v })} placeholder="Current employer…" />
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle title="Eligibility & logistics" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Authorized to work in</Label>
              <TagInput value={p.workAuth.authorizedCountries} onChange={(v) => set("workAuth", { authorizedCountries: v.map((x) => x.toUpperCase()) })} />
            </div>
            <div>
              <Label hint="ISO code, for passport / export-control questions">Citizenship</Label>
              <Input value={p.workAuth.citizenship ?? ""} onChange={(e) => set("workAuth", { citizenship: e.target.value.toUpperCase() || undefined })} placeholder="US" />
            </div>
            <div>
              <Label hint="for work-eligibility questions">Visa or residency status</Label>
              <Select value={p.workAuth.visaStatus ?? ""} onChange={(e) => set("workAuth", { visaStatus: e.target.value || undefined })}>
                <option value="">Not set (Ferry won't claim one)</option>
                {VISA_STATUSES.map((v) => (
                  <option key={v}>{v}</option>
                ))}
                {p.workAuth.visaStatus && !VISA_STATUSES.includes(p.workAuth.visaStatus) && <option>{p.workAuth.visaStatus}</option>}
              </Select>
            </div>
            <div>
              <Label hint="for defense and government roles">Security clearance</Label>
              <Select value={p.workAuth.clearance ?? ""} onChange={(e) => set("workAuth", { clearance: e.target.value || undefined })}>
                <option value="">Not set (left for you)</option>
                {CLEARANCES.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Salary expectation</Label>
              <Input value={p.logistics.salaryExpectation ?? ""} onChange={(e) => set("logistics", { salaryExpectation: e.target.value })} />
            </div>
            <div>
              <Label>Years of experience</Label>
              <Input type="number" value={p.logistics.yearsOfExperience ?? ""} onChange={(e) => set("logistics", { yearsOfExperience: e.target.value === "" ? undefined : Number(e.target.value) })} />
            </div>
            <div>
              <Label>Notice period</Label>
              <Input value={p.logistics.noticePeriod ?? ""} onChange={(e) => set("logistics", { noticePeriod: e.target.value })} />
            </div>
            <div>
              <Label>Earliest start</Label>
              <Input value={p.logistics.earliestStart ?? ""} onChange={(e) => set("logistics", { earliestStart: e.target.value })} />
            </div>
          </div>
          <Toggle checked={p.workAuth.needsSponsorship} onChange={(v) => set("workAuth", { needsSponsorship: v })} label="Needs visa sponsorship" />
          <Toggle checked={Boolean(p.logistics.willingToRelocate)} onChange={(v) => set("logistics", { willingToRelocate: v })} label="Willing to relocate" />
        </Card>

        <Card className="p-5">
          <SectionTitle title="Voluntary self-identification" sub="Optional. Left blank, Ferry picks the decline option when a form offers one." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(Object.keys(EEO_OPTS) as (keyof typeof EEO_OPTS)[]).map((k) => (
              <div key={k}>
                <Label>{k === "hispanic" ? "Hispanic or Latino" : k.charAt(0).toUpperCase() + k.slice(1)}</Label>
                <Select value={p.eeo[k] ?? ""} onChange={(e) => set("eeo", { [k]: e.target.value || undefined })}>
                  {EEO_OPTS[k].map((o) => (
                    <option key={o} value={o}>
                      {o || "Not set (decline)"}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <SectionTitle title="Résumés and answers" sub="These facts are shared by all your résumé profiles." />
          <div className="flex flex-wrap gap-2">
            <Link to="/app/profiles">
              <Button icon={<FileText className="h-4 w-4" />}>Résumé profiles</Button>
            </Link>
            <Link to="/app/answers">
              <Button icon={<MessageSquareText className="h-4 w-4" />}>Answers to application questions</Button>
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
