// Verify the PWA in a standard Chromium: service worker registers and controls the page, manifest loads.
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://localhost:8787";
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto(base, { waitUntil: "load" });
const reg = await p.evaluate(async () => {
  const r = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return { scope: r.scope, active: Boolean(r.active) };
});
const manifest = await p.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
await p.reload({ waitUntil: "load" });
const controlled = await p.evaluate(() => Boolean(navigator.serviceWorker.controller));
// Offline: the cached shell still loads.
await ctx.setOffline(true);
const offline = await p.goto(`${base}/app`).then((r) => r?.status() ?? 0).catch(() => -1);
console.log(JSON.stringify({ reg, controlled, manifestName: manifest.name, icons: manifest.icons.length, offlineShellStatus: offline }));
await b.close();
