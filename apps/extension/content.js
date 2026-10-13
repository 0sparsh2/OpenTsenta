// Ferry job detector. On a job posting it shows a small panel (in a shadow root, so page
// styles can't break it) to add the role to Ferry or queue an application.
(() => {
  if (window.top !== window || window.__ferryInjected) return;
  window.__ferryInjected = true;

  const ATS_PATTERNS = [
    "greenhouse.io", "gh_jid=", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "myworkdaysite.com", "smartrecruiters.com",
    ".recruitee.com", "rippling-ats.com", "ats.rippling.com", "icims.com", ".bamboohr.com", "workable.com", ".applytojob.com",
    "jobvite.com", ".breezy.hr", ".oraclecloud.com", "taleo.net", ".paylocity.com/recruiting", "ultipro.com", ".successfactors.",
    ".teamtailor.com", ".pinpointhq.com", "app.dover.com/apply", "jobs.gem.com", "dayforcehcm.com", ".zohorecruit.", "workforcenow.adp.com",
    "linkedin.com/jobs/view", "currentJobId=", "/mock-ats/",
  ];
  // Pages on job sites that are lists, logins, or profiles rather than a single posting.
  const NOT_A_POSTING = /\/(search|jobs\/?$|login|signin|sign-in|account|profile|settings|saved)(\/|$|\?)/i;

  function jsonLdPosting() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent || "");
        const nodes = (Array.isArray(data) ? data : [data["@graph"] || data]).flat();
        const p = nodes.find((n) => n && (n["@type"] === "JobPosting" || (Array.isArray(n["@type"]) && n["@type"].includes("JobPosting"))));
        if (p) return p;
      } catch {
        /* malformed JSON-LD */
      }
    }
    return null;
  }

  const textOf = (html) => {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.innerText || d.textContent || "").trim();
  };

  function detect() {
    const url = location.href;
    const ld = jsonLdPosting();
    const atsHit = ATS_PATTERNS.some((p) => url.toLowerCase().includes(p));
    if (!ld && !atsHit) return null;
    // LinkedIn search results with a job open on the right (…/jobs/search/?currentJobId=…) count as that job.
    if (!ld && NOT_A_POSTING.test(location.pathname) && !/currentJobId=/.test(url)) return null;
    const h1 = document.querySelector("h1")?.innerText?.trim();
    const title = (ld?.title && textOf(ld.title)) || h1 || document.title.split(/[|\-–]/)[0].trim();
    if (!title) return null;
    const org = ld?.hiringOrganization;
    const company =
      (typeof org === "string" ? org : org?.name) ||
      document.querySelector("[class*='company-name' i]")?.innerText?.trim() ||
      document.querySelector('meta[property="og:site_name"]')?.content ||
      "";
    const loc = ld?.jobLocation ? [].concat(ld.jobLocation).map((l) => [l?.address?.addressLocality, l?.address?.addressRegion].filter(Boolean).join(", ")).filter(Boolean).join(" / ") : "";
    const description = ld?.description ? textOf(ld.description) : (document.querySelector("main") || document.body).innerText.slice(0, 20000);
    return { url, title: title.slice(0, 200), company, location: loc, description, fromLd: Boolean(ld) };
  }

  function send(type, payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, (r) => resolve(r || { error: chrome.runtime.lastError?.message || "No response" })));
  }

  function mount(job) {
    const host = document.createElement("div");
    host.id = "ferry-panel-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        [hidden] { display: none !important; }
        * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Inter, sans-serif; }
        .pill { display:flex; align-items:center; gap:8px; background:#0E1B2C; color:#F6F4EF; border:0; border-radius:999px; padding:10px 14px 10px 10px; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 10px 30px -10px rgba(14,27,44,.5); }
        .dot { width:22px; height:22px; border-radius:7px; background:#E8572A; display:grid; place-items:center; color:#fff; font-size:13px; }
        .card { width:320px; background:#fff; color:#0E1B2C; border:1px solid #E6E1D7; border-radius:16px; box-shadow:0 18px 40px -16px rgba(14,27,44,.45); overflow:hidden; }
        .head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#0E1B2C; color:#F6F4EF; font-size:13px; font-weight:600; }
        .x { background:none; border:0; color:#F6F4EF; opacity:.7; font-size:18px; cursor:pointer; line-height:1; }
        .body { padding:14px; }
        .t { font-size:15px; font-weight:650; line-height:1.3; }
        .c { font-size:12.5px; color:#66717F; margin-top:2px; }
        .row { display:flex; gap:8px; margin-top:12px; }
        button.b { flex:1; height:34px; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; border:1px solid #E6E1D7; background:#fff; color:#0E1B2C; }
        button.p { background:#E8572A; border-color:#E8572A; color:#fff; }
        button.b:disabled { opacity:.6; cursor:default; }
        .score { display:flex; align-items:center; gap:10px; margin-top:12px; padding:10px; background:#F6F4EF; border-radius:10px; font-size:12.5px; }
        .n { font-size:20px; font-weight:700; }
        ul { margin:6px 0 0; padding-left:16px; font-size:12px; color:#2A3A4F; }
        .err { margin-top:10px; font-size:12px; color:#C2413B; }
        .ok { margin-top:10px; font-size:12.5px; color:#1F8A5B; }
        a { color:#2F6FE4; cursor:pointer; text-decoration:underline; }
      </style>
      <button class="pill" part="pill"><span class="dot">⛴</span>Ferry found this job</button>
      <div class="card" hidden>
        <div class="head"><span>Ferry</span><button class="x" aria-label="Collapse">×</button></div>
        <div class="body">
          <div class="t"></div><div class="c"></div>
          <div class="row posting"><button class="b add">Add to Ferry</button><button class="b p apply">Apply with Ferry</button></div>
          <div class="row form" hidden><button class="b p fill">Fill this form</button></div>
          <div class="out"></div>
          <div class="row done" hidden><button class="b submitted">I submitted it</button></div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $(".t").textContent = job.title;
    $(".c").textContent = [job.company, job.location].filter(Boolean).join(" · ");
    const pill = $(".pill");
    const card = $(".card");
    pill.onclick = () => {
      pill.hidden = true;
      card.hidden = false;
    };
    $(".x").onclick = () => {
      card.hidden = true;
      pill.hidden = false;
    };
    const out = $(".out");
    const show = (r, applied) => {
      if (r.error) {
        out.innerHTML = `<div class="err"></div>`;
        out.firstChild.textContent = r.error;
        return;
      }
      const m = r.job?.match;
      out.innerHTML = "";
      if (m) {
        const s = document.createElement("div");
        s.className = "score";
        s.innerHTML = `<span class="n"></span><span><b class="v"></b><ul></ul></span>`;
        s.querySelector(".n").textContent = `${m.score}%`;
        s.querySelector(".v").textContent = `${m.verdict} match`;
        for (const reason of (m.reasons || []).slice(0, 3)) {
          const li = document.createElement("li");
          li.textContent = reason;
          s.querySelector("ul").appendChild(li);
        }
        out.appendChild(s);
      }
      const ok = document.createElement("div");
      ok.className = "ok";
      ok.innerHTML = applied ? `Queued. Ferry will pause before submitting. <a>Open</a>` : `Added to your Ferry jobs. <a>Open</a>`;
      ok.querySelector("a").onclick = () => send("ferry:open", { path: applied ? `/app/applications/${r.application.id}` : "/app/jobs" });
      out.appendChild(ok);
    };
    // Buttons are captured up front: after an await, a click event's target is the panel host, not the button.
    $(".add").onclick = async () => {
      const btn = $(".add");
      btn.disabled = true;
      show(await send("ferry:add", { job }), false);
      btn.disabled = false;
    };
    $(".apply").onclick = async () => {
      $(".apply").disabled = true;
      show(await send("ferry:apply", { job }), true);
    };

    // "Fill this form": for application forms in this tab (including sites that block Ferry's own browser).
    let appId = null;
    let filledSig = null;
    const refreshForm = () => {
      // Once you've filled part of a form here, later steps count even without an email or résumé field.
      const isForm = Boolean(window.__ferryFill?.detect(Boolean(appId)));
      $(".form").hidden = !isForm;
      const nextStep = isForm && appId && window.__ferryFill.signature() !== filledSig;
      if (isForm) pill.lastChild.textContent = nextStep ? "Ferry can fill this step" : "Ferry can fill this form";
      if (nextStep && !$(".fill").disabled) $(".fill").textContent = "Fill this step";
      $(".posting").hidden = isForm && !job.title;
    };
    refreshForm();
    setInterval(refreshForm, 2500);
    $(".fill").onclick = async () => {
      const btn = $(".fill");
      btn.disabled = true;
      out.innerHTML = `<div class="c">Reading the form and tailoring your résumé…</div>`;
      const fields = window.__ferryFill.collect();
      let posting = JSON.parse(sessionStorage.getItem("ferry:lastPosting") || "null");
      // A posting remembered from earlier in this tab only counts if this form is for the same job.
      const t = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (posting && job.title && posting.url !== job.url && t(posting.title) !== t(job.title)) posting = null;
      const r = await send("ferry:fill", { body: { url: location.href, jobUrl: posting?.url, title: posting?.title || job.title || undefined, company: posting?.company || job.company || undefined, fields } });
      btn.disabled = false;
      if (r.error) {
        out.innerHTML = `<div class="err"></div>`;
        out.firstChild.textContent = r.error;
        return;
      }
      let file = null;
      if (r.answers.some((a) => a.value === "resume")) {
        const pdf = await send("ferry:file", { path: r.resumeUrl });
        if (pdf.base64) file = new File([Uint8Array.from(atob(pdf.base64), (ch) => ch.charCodeAt(0))], pdf.name || "Resume.pdf", { type: "application/pdf" });
      }
      const res = await window.__ferryFill.apply(fields, r.answers, file);
      btn.textContent = "Fill again";
      appId = r.applicationId;
      filledSig = window.__ferryFill.signature();
      out.innerHTML = `<div class="ok"></div>`;
      const kept = res.kept ? ` ${res.kept} already filled in.` : "";
      const left = res.left.length ? ` Still needs you: ${res.left.slice(0, 4).join("; ")}${res.left.length > 4 ? "…" : ""}.` : "";
      out.firstChild.textContent = `Filled ${res.filled} of ${res.total} fields with your tailored answers.${kept}${left} Review everything, then continue or submit it yourself.`;
      $(".done").hidden = false;
    };
    $(".submitted").onclick = async () => {
      if (!appId) return;
      $(".submitted").disabled = true;
      const r = await send("ferry:submitted", { applicationId: appId });
      out.innerHTML = `<div class="${r.error ? "err" : "ok"}"></div>`;
      out.firstChild.textContent = r.error || "Marked as applied in Ferry. It's on your tracker now.";
    };
    document.documentElement.appendChild(host);
  }

  let mountedFor = null;
  const run = () => {
    let job = detect();
    // Remember the posting so a later application page in this tab knows which job it belongs to. A separate apply
    // page (SmartRecruiters' one-click form, say) isn't the posting, so it doesn't replace it.
    const applyPage = job && !job.fromLd && window.__ferryFill?.detect() && sessionStorage.getItem("ferry:lastPosting");
    if (job && !applyPage) sessionStorage.setItem("ferry:lastPosting", JSON.stringify({ url: job.url, title: job.title, company: job.company }));
    // No posting, but an application form (a separate apply page, a modal): offer to fill it.
    if (!job && window.__ferryFill?.detect()) job = { url: location.href, title: "", company: "", location: "", description: "" };
    if (!job || mountedFor === job.url) return;
    document.getElementById("ferry-panel-host")?.remove();
    mountedFor = job.url;
    mount(job);
  };
  run();
  // Single-page job boards change the URL without reloading.
  let href = location.href;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      mountedFor = null;
      document.getElementById("ferry-panel-host")?.remove();
      setTimeout(run, 800);
    }
  }, 1000);
})();
