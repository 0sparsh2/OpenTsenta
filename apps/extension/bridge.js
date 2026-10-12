// Runs on localhost pages. If this is a Ferry dashboard with a signed-in session, hand the
// token to the extension so the job panel works without a separate login.
(() => {
  const isFerry = document.querySelector('meta[name="description"]')?.content?.includes("Ferry") || document.title.includes("Ferry");
  if (!isFerry) return;
  const push = () => {
    let token = null;
    try {
      token = localStorage.getItem("ferry.token");
    } catch {
      return;
    }
    if (token) chrome.runtime.sendMessage({ type: "ferry:sync-auth", token }).catch?.(() => {});
  };
  push();
  // Pick up logins that happen after the page loads.
  let last = null;
  setInterval(() => {
    let t = null;
    try {
      t = localStorage.getItem("ferry.token");
    } catch {
      /* ignore */
    }
    if (t && t !== last) {
      last = t;
      push();
    }
  }, 2000);
})();
