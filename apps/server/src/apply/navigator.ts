import { z } from "zod";
import type { Page } from "playwright";
import { llmEnabled, structured } from "../llm.ts";
import { shim } from "./extract.ts";

// Claude fallback for page states the deterministic engine doesn't recognize. Each step sends a
// compact snapshot (visible controls with ids + page text) and gets back one action. It never
// submits the application: reaching the form or the final review is "done".

interface Snapshot {
  url: string;
  title: string;
  text: string;
  controls: { id: string; tag: string; type: string; text: string }[];
}

async function snapshot(page: Page): Promise<Snapshot> {
  const frame = page.mainFrame();
  await shim(frame);
  return frame.evaluate(() => {
    const vis = (e: Element) => (e as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility?.() ?? true;
    let n = 0;
    const controls = Array.from(document.querySelectorAll("a, button, [role=button], input, select, textarea"))
      .filter(vis)
      .slice(0, 80)
      .map((e) => {
        const id = `n${++n}`;
        e.setAttribute("data-ferry-nav", id);
        const el = e as HTMLInputElement;
        const label = el.labels?.[0]?.innerText ?? el.getAttribute("aria-label") ?? el.placeholder ?? "";
        return { id, tag: e.tagName.toLowerCase(), type: el.type ?? "", text: ((e as HTMLElement).innerText || el.value || label || "").replace(/\s+/g, " ").trim().slice(0, 80) };
      });
    return { url: location.href, title: document.title, text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 3500), controls };
  });
}

const Action = z.object({
  thought: z.string().describe("One short sentence on what you see and why this action"),
  action: z.enum(["click", "fill", "select", "done", "blocked"]),
  target: z.string().describe("Control id like n12, or empty for done/blocked"),
  value: z.string().describe("Text to type or option to choose; empty otherwise"),
});

const SYSTEM = `You operate a browser to reach a job application form on behalf of a candidate.
Goal: get from wherever the page is to the application form's first input fields.
- Click things like "Apply", "Apply now", "Apply manually", "Continue", "Start application", or close modals that block the page.
- For cookie banners, choose reject/necessary-only; if only "accept" exists, close the banner instead.
- Never click a final "Submit application" button, never enter passwords, never solve captchas.
- Answer "done" when application input fields (name, email, résumé) are visible, and "blocked" if a login, captcha, or dead end stops you.`;

export async function navigate(page: Page, goal: string, onThought: (t: string) => void, maxSteps = 5): Promise<"done" | "blocked" | "unavailable"> {
  if (!llmEnabled()) return "unavailable";
  for (let i = 0; i < maxSteps; i++) {
    const snap = await snapshot(page);
    let a: z.infer<typeof Action>;
    try {
      a = await structured({
        system: SYSTEM,
        effort: "low",
        maxTokens: 2000,
        schema: Action,
        prompt: `Goal: ${goal}\nURL: ${snap.url}\nTitle: ${snap.title}\n\nControls:\n${snap.controls.map((c) => `${c.id} <${c.tag}${c.type ? ` ${c.type}` : ""}> ${c.text}`).join("\n")}\n\nPage text:\n${snap.text}`,
      });
    } catch {
      return "unavailable";
    }
    onThought(a.thought);
    if (a.action === "done") return "done";
    if (a.action === "blocked") return "blocked";
    const el = page.locator(`[data-ferry-nav="${a.target}"]`).first();
    if (!(await el.count())) continue;
    const label = snap.controls.find((c) => c.id === a.target)?.text ?? "";
    if (/submit/i.test(label) && a.action === "click") return "done";
    if (a.action === "click") await el.click({ timeout: 5000 }).catch(() => {});
    if (a.action === "fill") await el.fill(a.value).catch(() => {});
    if (a.action === "select") await el.selectOption({ label: a.value }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
  }
  return "blocked";
}
