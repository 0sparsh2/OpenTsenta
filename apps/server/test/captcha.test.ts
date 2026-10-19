// Captcha detection: only a widget a person could see stops Ferry. Invisible reCAPTCHA (Ashby, among others) keeps
// its badge and challenge frames on the page, hidden, until it decides to challenge.
//   npm test --workspace apps/server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

process.env.LLM_DISABLED = "true";
const { botCheckOn, hasCaptcha } = await import("../src/apply/fill.ts");

const frame = (style: string) =>
  `<!doctype html><body><h1>Apply</h1><button>Submit Application</button><div style="${style}"><iframe src="/recaptcha/enterprise/bframe?k=x" width="1278" height="150"></iframe></div></body>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  if (req.url!.startsWith("/recaptcha/")) return res.end("<p>challenge</p>");
  if (req.url === "/plain") return res.end("<!doctype html><form><input name=email><button>Submit</button></form>");
  res.end(req.url === "/hidden" ? frame("visibility:hidden;position:absolute;top:0;left:0") : frame(""));
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ headless: true });
after(async () => {
  await browser.close();
  server.close();
});

test("a hidden reCAPTCHA challenge frame doesn't stop Ferry; a visible one does", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/hidden`, { waitUntil: "load" });
  assert.equal(await hasCaptcha(page), false, "invisible reCAPTCHA: a person sees nothing and just submits");
  await page.goto(`${base}/visible`, { waitUntil: "load" });
  assert.equal(await hasCaptcha(page), true, "a challenge on screen: hand it to the person");
  await page.close();
});

test("bot checks are spotted even when invisible, so the final submit goes to your own browser", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/hidden`, { waitUntil: "load" });
  assert.equal(await botCheckOn(page), "reCAPTCHA");
  await page.goto(`${base}/plain`, { waitUntil: "load" });
  assert.equal(await botCheckOn(page), null);
  await page.close();
});
