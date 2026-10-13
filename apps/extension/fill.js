// Ferry "Fill this form": reads the application form in your own tab, asks your Ferry server for answers, and
// fills them in. For sites that block automated browsers. It never clicks Submit; you review and submit.
(() => {
  if (window.__ferryFill) return;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && st.visibility !== "hidden" && st.display !== "none";
  };

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (norm(t)) return norm(t);
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && norm(l.innerText)) return norm(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input,select,textarea,option").forEach((x) => x.remove());
      if (norm(clone.textContent)) return norm(clone.textContent);
    }
    // Nearest preceding text in the field's container.
    let node = el.parentElement;
    for (let d = 0; node && d < 4; d++, node = node.parentElement) {
      const q = node.querySelector("label, legend, [class*='label' i], [class*='question' i], h3, h4, p, span");
      if (q && !q.contains(el) && !q.querySelector("input,select,textarea") && norm(q.innerText) && norm(q.innerText).length < 300) return norm(q.innerText);
    }
    return norm(el.getAttribute("placeholder") || el.name || "");
  }

  const groupQuestion = (input) => {
    const fs = input.closest("fieldset");
    const legend = fs?.querySelector("legend");
    if (legend && norm(legend.innerText)) return norm(legend.innerText);
    const group = input.closest("[role=radiogroup], [role=group]");
    if (group) return labelFor(group);
    let node = input.parentElement;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`).length >= 2) {
        for (const child of node.children) {
          if (!child.querySelector("input,select,textarea") && norm(child.innerText)) return norm(child.innerText);
        }
        return labelFor(node);
      }
    }
    return labelFor(input);
  };

  /** Fields in this document (and same-origin iframes), each tagged with data-ferry-ext. */
  function collect() {
    const out = [];
    const docs = [document];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        if (f.contentDocument) docs.push(f.contentDocument);
      } catch {
        /* cross-origin frame */
      }
    }
    let n = 0;
    const seenGroups = new Set();
    for (const doc of docs) {
      for (const el of doc.querySelectorAll("input, select, textarea")) {
        const type = (el.type || el.tagName).toLowerCase();
        if (["hidden", "submit", "button", "reset", "image", "search", "password"].includes(type) || el.disabled || (el.readOnly && type !== "file")) continue;
        if (type !== "file" && !visible(el)) continue;
        if (type === "radio" || type === "checkbox") {
          const key = `${type}:${el.name || Math.random()}`;
          if (el.name && seenGroups.has(key)) continue;
          seenGroups.add(key);
          const group = el.name ? [...doc.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`)].filter(visible) : [el];
          const id = `f${n++}`;
          group.forEach((g, i) => {
            g.dataset.ferryExt = id;
            g.dataset.ferryIdx = String(i);
          });
          const single = type === "checkbox" && group.length === 1;
          out.push({
            id,
            label: single ? labelFor(el) : groupQuestion(el),
            kind: type,
            required: group.some((g) => g.required || g.getAttribute("aria-required") === "true"),
            options: single ? undefined : group.map((g) => labelFor(g)),
          });
          continue;
        }
        const id = `f${n++}`;
        el.dataset.ferryExt = id;
        const kind = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("role") === "combobox" ? "combobox" : ["email", "tel", "url", "number", "date", "file"].includes(type) ? type : "text";
        out.push({
          id,
          label: labelFor(el),
          kind,
          required: el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(labelFor(el)),
          options: el.tagName === "SELECT" ? [...el.options].map((o) => norm(o.text)).filter((t) => t && !/^(select|choose|--)/i.test(t)) : undefined,
          maxLength: el.maxLength > 0 ? el.maxLength : undefined,
          accept: type === "file" ? el.accept || undefined : undefined,
        });
      }
    }
    return out.filter((f) => f.label);
  }

  const nodes = (id) => {
    const found = [...document.querySelectorAll(`[data-ferry-ext="${id}"]`)];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        found.push(...(f.contentDocument?.querySelectorAll(`[data-ferry-ext="${id}"]`) ?? []));
      } catch {
        /* cross-origin */
      }
    }
    return found;
  };

  /** Set a value the way a person typing would, so React/Angular forms register it. */
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

  function fillOne(field, value, resumeFile) {
    const els = nodes(field.id);
    if (!els.length || value == null || value === "") return false;
    const el = els[0];
    if (field.kind === "file") {
      if (!resumeFile) return false;
      const dt = new DataTransfer();
      dt.items.add(resumeFile);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (field.kind === "select") {
      const opt = [...el.options].find((o) => same(o.text, value) || same(o.value, value));
      if (!opt) return false;
      setValue(el, opt.value);
      return true;
    }
    if (field.kind === "radio" || field.kind === "checkbox") {
      const wanted = Array.isArray(value) ? value : [value];
      let hit = false;
      els.forEach((g, i) => {
        const label = field.options?.[i] ?? "";
        const on = field.options ? wanted.some((w) => same(w, label)) : /^(yes|true|on)$/i.test(String(wanted[0]));
        if (on && !g.checked) {
          g.click();
          hit = true;
        } else if (on) hit = true;
      });
      return hit;
    }
    setValue(el, Array.isArray(value) ? value.join(", ") : String(value));
    if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") pendingCombos.push({ el, value: String(value) });
    return true;
  }

  // Autocomplete boxes (react-select and friends) only keep a value once a suggestion is chosen.
  const pendingCombos = [];
  async function commitCombos() {
    for (const { el, value } of pendingCombos.splice(0)) {
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const doc = el.ownerDocument;
      const options = [...doc.querySelectorAll("[role=option], [class*='option' i], li")].filter((o) => visible(o) && norm(o.innerText));
      const pick = options.find((o) => same(o.innerText, value)) ?? options.find((o) => norm(o.innerText).toLowerCase().startsWith(value.toLowerCase()));
      if (pick) pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), pick.click();
      else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const mark = (field, state) => {
    if (state === "skip") return;
    const style = state === "filled" ? "2px solid #1F8A5B" : "2px solid #D9822B";
    for (const el of nodes(field.id)) {
      const target = el.type === "radio" || el.type === "checkbox" ? el.parentElement : el;
      if (target) {
        target.style.outline = style;
        target.style.outlineOffset = "2px";
      }
    }
  };

  window.__ferryFill = {
    /** Does this page look like an application form? */
    detect() {
      const f = collect();
      return f.length >= 3 && f.some((x) => x.kind === "email" || x.kind === "file" || /e-?mail|resume|cv\b/i.test(x.label));
    },
    collect,
    /** Fill answers; returns counts and the labels still needing you. */
    async apply(fields, answers, resumeFile) {
      const byId = new Map(answers.map((a) => [a.id, a]));
      let filled = 0;
      const left = [];
      for (const f of fields) {
        const a = byId.get(f.id);
        const ok = a && fillOne(f, a.value, resumeFile);
        if (ok) filled++;
        else if (f.required) left.push(f.label);
        mark(f, ok ? "filled" : f.required ? "needs" : "skip");
      }
      await commitCombos();
      return { filled, total: fields.length, left };
    },
  };
})();
