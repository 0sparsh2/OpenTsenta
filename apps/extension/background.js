// Ferry extension service worker: owns the API token and talks to the Ferry server.
// Content scripts never see the token; they send job data here.

const DEFAULT_API = "http://localhost:8787";

async function settings() {
  const s = await chrome.storage.local.get(["apiUrl", "token"]);
  return { apiUrl: (s.apiUrl || DEFAULT_API).replace(/\/$/, ""), token: s.token || "" };
}

async function api(method, path, body) {
  const { apiUrl, token } = await settings();
  if (!token) throw new Error("Not signed in. Open your Ferry dashboard once, or paste a token in the extension popup.");
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ferry returned ${res.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case "ferry:sync-auth": {
        // From the dashboard bridge: only accept tokens from a localhost Ferry dashboard.
        const origin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return { ok: false };
        const apiUrl = origin.endsWith(":5173") ? DEFAULT_API : origin;
        await chrome.storage.local.set({ token: msg.token, apiUrl });
        return { ok: true };
      }
      case "ferry:status": {
        const { apiUrl, token } = await settings();
        if (!token) return { signedIn: false, apiUrl };
        try {
          const me = await api("GET", "/me");
          return { signedIn: true, apiUrl, email: me.email, credits: me.credits };
        } catch (e) {
          return { signedIn: false, apiUrl, error: e.message };
        }
      }
      case "ferry:add":
        return { job: await api("POST", "/jobs/fetch", msg.job) };
      case "ferry:apply": {
        const job = await api("POST", "/jobs/fetch", msg.job);
        const app = await api("POST", "/applications", { jobId: job.id, source: "extension" });
        return { job, application: app };
      }
      case "ferry:fill":
        return await api("POST", "/extension/fill", msg.body);
      case "ferry:submitted":
        return await api("POST", "/extension/submitted", { applicationId: msg.applicationId, confirmation: msg.confirmation, url: msg.url });
      case "ferry:file": {
        // The tailored résumé, fetched with the token here so the page never sees it.
        const { apiUrl, token } = await settings();
        const res = await fetch(`${apiUrl}${msg.path}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Couldn't download the résumé (${res.status})`);
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "Resume.pdf";
        return { base64: btoa(bin), name };
      }
      case "ferry:open": {
        const { apiUrl } = await settings();
        await chrome.tabs.create({ url: `${apiUrl}${msg.path || "/app"}` });
        return { ok: true };
      }
      default:
        return { error: "unknown message" };
    }
  })()
    .then(reply)
    .catch((e) => reply({ error: e.message }));
  return true; // async reply
});
