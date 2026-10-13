// Ferry "Fill this form": reads the application form in your own tab, asks your Ferry server for answers, and
// fills them in. For sites that block automated browsers. It never clicks Submit; you review and submit.
// Handles plain forms, web components (fields inside open shadow roots), same-origin iframes, button dropdowns,
// autocompletes, and multi-step modals (fill each step as it appears).
(() => {
  if (window.__ferryFill) return;
  const PANEL = "ferry-panel-host";
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && st.visibility !== "hidden" && st.display !== "none";
  };
  const textOf = (el) => norm(el?.innerText || el?.textContent || "");
  const CONTROL = "input, select, textarea, [role=combobox], button[aria-haspopup=listbox]";

  /** Every form control under root, in document order, through open shadow roots and same-origin iframes. */
  function* controls(root) {
    for (const el of root.querySelectorAll("*")) {
      if (el.id === PANEL) continue;
      if (el.matches(CONTROL)) yield el;
      if (el.shadowRoot) yield* controls(el.shadowRoot);
      else if (el.tagName === "IFRAME") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          /* cross-origin frame */
        }
        if (doc) yield* controls(doc);
      }
    }
  }

  /** An open dialog with fields in it (Easy Apply and other modal flows): only its fields are the form. */
  function scope() {
    const dialogs = [...document.querySelectorAll("[role=dialog], dialog[open], [aria-modal=true]")].filter((d) => d.id !== PANEL && visible(d));
    for (const d of dialogs.reverse()) {
      for (const el of controls(d)) if (visible(el) || el.type === "file") return d;
    }
    return null;
  }

  /** "Question * " / "Question Required" → the question, and whether it was marked required. */
  const clean = (label) => {
    const l = norm(label);
    const m = l.match(/^(.*?)\s*\*$/) || l.match(/^(.*?)\s*\(required\)$/i) || l.match(/^(.*?[?:.)])\s+required$/i);
    return m && m[1] ? { label: m[1], marked: true } : { label: l, marked: false };
  };

  function labelFor(el) {
    const root = el.getRootNode();
    const byId = (id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(byId(id))).join(" ");
      if (norm(t)) return norm(t);
    }
    if (el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && textOf(l)) return textOf(l);
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
      if (q && !q.contains(el) && !q.querySelector(CONTROL) && textOf(q) && textOf(q).length < 300) return textOf(q);
    }
    // A web component's own label attribute.
    if (root instanceof ShadowRoot) {
      const t = root.host.getAttribute("label") || root.host.getAttribute("aria-label");
      if (t) return norm(t);
    }
    return norm(el.getAttribute("placeholder") || el.name || "");
  }

  const groupQuestion = (input) => {
    const fs = input.closest("fieldset");
    const legend = fs?.querySelector("legend");
    if (legend && textOf(legend)) return textOf(legend);
    const group = input.closest("[role=radiogroup], [role=group]");
    if (group) return labelFor(group);
    let node = input.parentElement;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`).length >= 2) {
        for (const child of node.children) {
          if (!child.querySelector(CONTROL) && textOf(child)) return textOf(child);
        }
        return labelFor(node);
      }
    }
    return labelFor(input);
  };

  const listboxOf = (el) => {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    if (!id) return null;
    const root = el.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  };

  /** The fields on screen right now: [{field, els}]. Doesn't touch the page. */
  function scan() {
    const out = [];
    const seen = new Set();
    const within = scope();
    let n = 0;
    for (const el of controls(within || document)) {
      if (seen.has(el)) continue;
      const tag = el.tagName;
      const type = (tag === "INPUT" ? el.type : tag).toLowerCase();
      if ((tag === "INPUT" && ["hidden", "submit", "button", "reset", "image", "search", "password"].includes(type)) || el.disabled || (el.readOnly && type !== "file")) continue;
      if (type !== "file" && !visible(el)) continue;
      // Site chrome (search boxes, nav) isn't part of the application.
      if (!within && el.closest("header, nav, footer")) continue;
      const native = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
      if (!native && el.querySelector("input, select, textarea")) continue; // a combobox wrapper; its input is the field
      if (type === "radio" || type === "checkbox") {
        const root = el.getRootNode();
        const group = el.name ? [...root.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`)].filter(visible) : [el];
        group.forEach((g) => seen.add(g));
        const single = type === "checkbox" && group.length === 1;
        const { label, marked } = clean(single ? labelFor(el) : groupQuestion(el));
        out.push({
          els: group,
          field: { id: `f${n++}`, label, kind: type, required: marked || group.some((g) => g.required || g.getAttribute("aria-required") === "true"), options: single ? undefined : group.map((g) => clean(labelFor(g)).label) },
        });
        continue;
      }
      seen.add(el);
      const { label, marked } = clean(labelFor(el));
      const listbox = !native;
      const kind = tag === "SELECT" ? "select" : tag === "TEXTAREA" ? "textarea" : listbox ? "listbox" : el.getAttribute("role") === "combobox" ? "combobox" : ["email", "tel", "url", "number", "date", "file"].includes(type) ? type : "text";
      const opts =
        tag === "SELECT"
          ? [...el.options].map((o) => norm(o.text)).filter((t) => t && !/^(select|choose|--)/i.test(t))
          : listbox
            ? [...(listboxOf(el)?.querySelectorAll("[role=option]") ?? [])].map((o) => norm(o.textContent)).filter(Boolean)
            : undefined;
      out.push({
        els: [el],
        field: {
          id: `f${n++}`,
          label,
          kind,
          required: marked || el.required || el.getAttribute("aria-required") === "true",
          options: opts?.length ? opts : undefined,
          maxLength: el.maxLength > 0 ? el.maxLength : undefined,
          accept: type === "file" ? el.accept || undefined : undefined,
        },
      });
    }
    return out.filter((x) => x.field.label);
  }

  // The elements behind the field ids from the last collect().
  let registry = new Map();

  /** Set a value the way a person typing would, so React/Angular/web-component forms register it. */
  function setValue(el, value, { keepFocus = false } = {}) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus?.();
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (!keepFocus) {
      el.dispatchEvent(new FocusEvent("blur"));
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    }
  }

  /** A suggestion or dropdown option matching value, near el. */
  function findOption(el, value) {
    const want = String(value).toLowerCase();
    const scopes = [listboxOf(el), el.getRootNode(), document].filter(Boolean);
    for (const s of scopes) {
      const opts = [...s.querySelectorAll("[role=option], [class*='option' i]")].filter((o) => visible(o) && textOf(o) && !o.contains(el));
      const hit = opts.find((o) => same(textOf(o), value)) ?? opts.find((o) => textOf(o).toLowerCase().startsWith(want)) ?? opts.find((o) => want.startsWith(textOf(o).toLowerCase()) && textOf(o).length > 2);
      if (hit) return hit;
    }
    return null;
  }
  const choose = async (opt) => {
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    opt.click();
    await sleep(120);
  };

  async function fillOne({ field, els }, value, resumeFile) {
    const el = els[0];
    if (!el || value == null || value === "" || (Array.isArray(value) && !value.length)) return false;
    if (field.kind === "file") {
      if (!resumeFile) return false;
      const dt = new DataTransfer();
      dt.items.add(resumeFile);
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
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
        if (on && !g.checked) g.click();
        if (on) hit = true;
      });
      return hit;
    }
    if (field.kind === "listbox") {
      // A button that opens a list of options.
      if (same(textOf(el), value)) return true;
      el.click();
      await sleep(250);
      const opt = findOption(el, value);
      if (opt) {
        await choose(opt);
        return true;
      }
      if (el.getAttribute("aria-expanded") === "true") el.click();
      return false;
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    const combo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list";
    setValue(el, text, { keepFocus: combo });
    if (combo) {
      // Autocompletes (react-select, city pickers) only keep a value once a suggestion is chosen.
      await sleep(350);
      let opt = findOption(el, text);
      if (!opt) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, composed: true }));
        await sleep(350);
        opt = findOption(el, text);
      }
      if (opt) await choose(opt);
    }
    return true;
  }

  /** Does the field already hold an answer (prefilled by the site, or typed by you)? */
  function hasValue({ field, els }) {
    const el = els[0];
    if (field.kind === "radio") return els.some((g) => g.checked);
    if (field.kind === "checkbox") return els.some((g) => g.checked);
    if (field.kind === "file") return Boolean(el.files?.length);
    if (field.kind === "select") return el.selectedIndex > 0 || (el.selectedIndex === 0 && !/^(select|choose|--|$)/i.test(norm(el.options[0]?.text)));
    if (field.kind === "listbox") return !/^(select|choose|--|$)/i.test(textOf(el));
    return Boolean(norm(el.value));
  }

  const mark = (entry, state) => {
    if (state === "skip") return;
    const style = state === "filled" ? "2px solid #1F8A5B" : "2px solid #D9822B";
    for (const el of entry.els) {
      const target = el.type === "radio" || el.type === "checkbox" || el.type === "file" ? el.parentElement : el;
      if (target) {
        target.style.outline = style;
        target.style.outlineOffset = "2px";
      }
    }
  };

  window.__ferryFill = {
    /** Does this page look like an application form? loose: any fields at all (a later step of a form you started). */
    detect(loose = false) {
      const f = scan().map((x) => x.field);
      if (loose) return f.length > 0;
      return f.length >= 3 && f.some((x) => x.kind === "email" || x.kind === "file" || /e-?mail|resume|cv\b/i.test(x.label));
    },
    /** A short fingerprint of the fields on screen, to notice when a multi-step form moves on. */
    signature() {
      return scan()
        .map((x) => x.field.label)
        .join("|");
    },
    /** The fields to send to Ferry. Remembers their elements for apply(). */
    collect() {
      const entries = scan();
      registry = new Map(entries.map((e) => [e.field.id, e]));
      return entries.map((e) => e.field);
    },
    /** Fill answers; returns counts and the questions still needing you. */
    async apply(fields, answers, resumeFile) {
      const byId = new Map(answers.map((a) => [a.id, a]));
      let filled = 0;
      let kept = 0;
      const left = [];
      for (const f of fields) {
        const entry = registry.get(f.id);
        if (!entry) continue;
        const ok = await fillOne(entry, byId.get(f.id)?.value, resumeFile).catch(() => false);
        if (ok) filled++;
        else if (hasValue(entry)) kept++;
        else if (f.required) left.push(f.label);
        mark(entry, ok ? "filled" : f.required && !hasValue(entry) ? "needs" : "skip");
      }
      return { filled, kept, total: fields.length, left };
    },
  };
})();
