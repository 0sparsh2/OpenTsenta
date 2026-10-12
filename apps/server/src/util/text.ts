const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → readable plain text that keeps paragraph and list structure. */
export function htmlToText(html: string): string {
  let s = html;
  // Greenhouse returns entity-escaped HTML; unescape first if it looks escaped.
  if (/&lt;\s*[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|li|section|tr)>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function classifyWorkplace(...hints: (string | undefined | null | boolean)[]): "remote" | "hybrid" | "onsite" | "unknown" {
  const h = hints
    .filter((x) => typeof x === "string")
    .join(" ")
    .toLowerCase();
  if (/\bhybrid\b/.test(h)) return "hybrid";
  if (/\bremote\b|anywhere|distributed/.test(h)) return "remote";
  if (/on-?site|in[- ]office/.test(h)) return "onsite";
  return "unknown";
}

/** Detect visa sponsorship signals in a job description. null = unknown. */
export function sponsorshipSignal(desc: string): boolean | null {
  const d = desc.toLowerCase();
  if (/(unable|not able|cannot|can't|will not|won't|do not|does not|don't|doesn't)\s+(to\s+)?(offer|provide|sponsor|support)[^.]{0,40}(sponsor|visa)/.test(d)) return false;
  if (/without (the need for|requiring) (visa )?sponsorship|no (visa )?sponsorship/.test(d)) return false;
  if (/(visa|h-?1b|immigration) sponsorship (is )?(available|offered|provided)|we (will )?sponsor|sponsorship available/.test(d)) return true;
  return null;
}
