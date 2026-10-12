import { chromium } from "playwright";
const [url, sel] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {}); await p.evaluate("globalThis.__name = (t) => t");
const out = await p.evaluate((sel) => {
  const el = document.querySelector(sel); if (!el) return "not found";
  let n: Element | null = el; const chain: string[] = [];
  for (let i = 0; n && i < 7; i++, n = n.parentElement) {
    const kids = Array.from(n.children).map((c) => `${c.tagName.toLowerCase()}.${(c.className || "").toString().split(" ")[0]}[${(c as HTMLElement).innerText?.slice(0, 40).replace(/\n/g, "/")}]`).slice(0, 5);
    chain.push(`${i}: <${n.tagName.toLowerCase()} class="${(n.className || "").toString().slice(0, 60)}" role=${n.getAttribute("role")} aria-hidden=${n.getAttribute("aria-hidden")} tabindex=${n.getAttribute("tabindex")}> kids: ${kids.join(" ")}`);
  }
  return chain.join("\n");
}, sel);
console.log(out); await b.close();
