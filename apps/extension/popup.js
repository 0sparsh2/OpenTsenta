const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.storage.local.get(["apiUrl", "token"]);
  $("api").value = s.apiUrl || "http://localhost:8787";
  $("token").value = s.token ? `${s.token.slice(0, 6)}…${s.token.slice(-4)}` : "";
  const r = await chrome.runtime.sendMessage({ type: "ferry:status" });
  const el = $("status");
  if (r?.signedIn) {
    el.innerHTML = `<span class="on">● Connected</span><br>`;
    el.append(`${r.email} · ${r.credits} credits`);
  } else {
    el.innerHTML = `<span class="off">● Not connected</span><br>`;
    el.append(r?.error || "Open your Ferry dashboard to connect.");
  }
}

$("save").onclick = async () => {
  const patch = { apiUrl: $("api").value.trim().replace(/\/$/, "") };
  const t = $("token").value.trim();
  if (t && !t.includes("…")) patch.token = t;
  await chrome.storage.local.set(patch);
  await refresh();
};
$("open").onclick = () => chrome.runtime.sendMessage({ type: "ferry:open", path: "/app" });
refresh();
