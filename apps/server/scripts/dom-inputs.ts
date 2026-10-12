// Debug: list raw input attributes on a page (read-only).
import { chromium } from "playwright";
const url = process.argv[2];
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
await p.evaluate("globalThis.__name = (t) => t");
for (const f of p.frames()) {
  const rows = await f.evaluate(() => Array.from(document.querySelectorAll("input,select,textarea")).slice(0, 40).map((e) => {
    const r = (e as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(e as HTMLElement);
    return `${e.tagName.toLowerCase()} type=${(e as HTMLInputElement).type} id=${e.id} name=${(e as HTMLInputElement).name} role=${e.getAttribute("role")} aria-hidden=${e.getAttribute("aria-hidden")} tabindex=${e.getAttribute("tabindex")} req=${(e as HTMLInputElement).required} ${Math.round(r.width)}x${Math.round(r.height)} op=${s.opacity} cls=${(e.className || "").toString().slice(0, 40)}`;
  })).catch(() => [] as string[]);
  if (rows.length) console.log(`--- frame ${f.url().slice(0, 90)}\n` + rows.join("\n"));
}
await b.close();
