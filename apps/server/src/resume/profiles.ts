import { heuristicMatch } from "../match/score.ts";
import { getResume, listResumes, saveResume, type Resume, type User } from "../store.ts";
import type { Job, MatchResult, ResumeDoc } from "../types.ts";
import { allSkills } from "./model.ts";

// Résumé profiles. A user keeps one per role family ("Backend Engineer", "Data Engineer"), each created by
// importing a résumé or duplicating another profile. Every job is matched and applied with the profile that
// fits it best, and the application records which one it used.

/** The user as seen through one profile: its target titles and keywords replace/extend the shared preferences. */
export function profileUser(user: User, profile: Resume): User {
  const prefs = user.profile.preferences;
  return {
    ...user,
    profile: {
      ...user.profile,
      preferences: {
        ...prefs,
        titles: profile.targets.titles.length ? profile.targets.titles : prefs.titles,
        keywords: [...new Set([...prefs.keywords, ...profile.targets.keywords])],
      },
    },
  };
}

export interface ProfilePick {
  profile: Resume;
  match: MatchResult;
}

/** Best profile for a job by heuristic fit; the default wins ties. */
export function pickProfile(user: User, job: Job, profiles = listResumes(user.id)): ProfilePick | null {
  let best: ProfilePick | null = null;
  for (const profile of profiles) {
    const match = heuristicMatch(profileUser(user, profile), profile.doc, job);
    if (!best || match.score > best.match.score) best = { profile, match };
  }
  return best;
}

/** The profile an application should use: the one it was created with, else the best fit. */
export function profileFor(user: User, job: Job, resumeId?: string | null): Resume | undefined {
  const own = resumeId ? getResume(resumeId) : undefined;
  if (own && own.userId === user.id) return own;
  return pickProfile(user, job)?.profile;
}

/** "Senior Software Engineer" → "Software Engineer": a readable default profile name from the résumé. */
export function suggestProfileName(doc: ResumeDoc, fallback = "General"): string {
  const t = doc.experience.find((e) => !e.hidden)?.title?.trim();
  if (!t) return fallback;
  return t.replace(/^(senior|sr\.?|junior|jr\.?|lead|staff|principal|associate)\s+/i, "").replace(/\s+(i{1,3}|iv|v)$/i, "").slice(0, 60);
}

/** Starting targets for a freshly imported profile. */
export function suggestTargets(doc: ResumeDoc, name: string) {
  const titles = [...new Set([name, ...doc.experience.slice(0, 2).map((e) => e.title)].filter(Boolean))].slice(0, 4);
  return { titles, keywords: allSkills(doc).slice(0, 8) };
}

export function duplicateProfile(user: User, sourceId: string, name: string): Resume | null {
  const src = getResume(sourceId);
  if (!src || src.userId !== user.id) return null;
  return saveResume({
    userId: user.id,
    name,
    filePath: src.filePath,
    fileName: src.fileName,
    text: src.text,
    doc: structuredClone(src.doc),
    isDefault: false,
    targets: { titles: [name, ...src.targets.titles.filter((t) => t !== src.name)].slice(0, 4), keywords: [...src.targets.keywords] },
    notes: src.notes,
    origin: "duplicate",
  });
}
