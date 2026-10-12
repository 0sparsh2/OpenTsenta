import type { Frame, Page } from "playwright";
import type { FormField } from "../types.ts";

export interface FrameField extends FormField {
  frameIndex: number;
}

// Runs inside the page. Tags every fillable control with data-ferry-id and returns a
// normalized description of it: label, kind, required, options. Radio and checkbox groups
// collapse into one field; each option gets data-ferry-group/data-ferry-idx so the filler
// can address it without relying on the `name` attribute (Ashby and others omit it).
function collectFields(prefix: string) {
  type VisEl = HTMLElement & { checkVisibility?: (o?: object) => boolean };
  const norm = (s: string | null | undefined) =>
    (s ?? "")
      .replace(/[✱*]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const isVis = (el: Element | null | undefined) => {
    if (!el) return false;
    const he = el as VisEl;
    if (he.checkVisibility) return he.checkVisibility({ visibilityProperty: true });
    const st = getComputedStyle(he);
    return st.display !== "none" && st.visibility !== "hidden";
  };
  const visible = (el: Element) => {
    const t = (el as HTMLInputElement).type;
    const choice = t === "radio" || t === "checkbox" || t === "file";
    if (!isVis(el)) {
      // Custom radios/checkboxes/uploads hide the native input behind a visible label or button.
      if (!choice) return false;
      const lab = (el as HTMLInputElement).labels?.[0];
      return isVis(lab) || isVis(el.parentElement);
    }
    const r = (el as HTMLElement).getBoundingClientRect();
    return (r.width > 0 && r.height > 0) || choice;
  };
  const byId = (id: string) => (id ? document.getElementById(id) : null);
  const textOf = (el: Element | null) => norm((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "");
  const GENERIC = /^(attach|upload|choose file|browse|select file|drop files? here|or drag and drop|enter manually|×|x)$/i;
  const LABELISH = ":scope > label, :scope > legend, :scope > [class*='label' i], :scope > [class*='question' i], :scope > [class*='title' i], :scope > h3, :scope > h4";

  function ariaLabel(el: Element): string {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => textOf(byId(id)))
        .filter(Boolean)
        .join(" ");
      if (t) return t;
    }
    return norm(el.getAttribute("aria-label"));
  }

  /** Walk up from `start` looking for the question text of a field container. */
  function containerLabel(start: Element | null, owner: Element, loose: boolean): string {
    let node = start as HTMLElement | null;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++, node = node.parentElement) {
      const sel = loose ? `${LABELISH}, :scope > p, :scope > span, :scope > div` : LABELISH;
      for (const q of Array.from(node.querySelectorAll(sel))) {
        if (q.contains(owner) || q.querySelector("input, select, textarea")) continue;
        const t = textOf(q);
        if (t && t.length < 400 && !GENERIC.test(t)) return t;
      }
      if (!loose) {
        const prev = node.previousElementSibling;
        if (prev && !prev.querySelector("input, select, textarea")) {
          const t = textOf(prev);
          if (t && t.length < 300 && !GENERIC.test(t)) return t;
        }
      }
    }
    return "";
  }

  function labelOf(el: HTMLElement): string {
    const a = ariaLabel(el);
    if (a && !GENERIC.test(a)) return a;
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = textOf(l);
      if (t && !GENERIC.test(t)) return t;
    }
    const wrap = el.closest("label");
    if (wrap && !GENERIC.test(ownText(wrap)) && ownText(wrap)) return ownText(wrap);
    return containerLabel(el.parentElement, el, false) || containerLabel(el.parentElement, el, true) || norm(el.getAttribute("placeholder") || el.getAttribute("name"));
  }

  /** A wrapping <label>'s own words, without the text of the select/options inside it. */
  function ownText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const c of Array.from(clone.querySelectorAll("select, option, textarea, input, [role=listbox], [role=option]"))) c.remove();
    return norm(clone.textContent || "");
  }

  function optionLabel(el: HTMLInputElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (textOf(l)) return textOf(l);
    }
    const wrap = el.closest("label");
    if (textOf(wrap)) return textOf(wrap);
    const next = el.nextElementSibling;
    if (textOf(next)) return textOf(next);
    return norm(el.getAttribute("aria-label") || el.value);
  }

  /** Smallest ancestor that holds the whole group of radios/checkboxes. */
  function groupContainer(el: HTMLInputElement): HTMLElement | null {
    const explicit = el.closest("fieldset, [role=radiogroup], [role=group]") as HTMLElement | null;
    if (explicit && explicit.querySelectorAll(`input[type=${el.type}]`).length >= 2) return explicit;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const n = node.querySelectorAll(`input[type=${el.type}]`).length;
      if (n >= 2) return node;
    }
    return null;
  }

  function groupLabel(container: HTMLElement | null, first: HTMLInputElement): string {
    if (container) {
      if (container.tagName === "FIELDSET") {
        const legend = container.querySelector("legend");
        if (textOf(legend)) return textOf(legend);
      }
      const a = ariaLabel(container);
      if (a) return a;
    }
    // Question text is usually a direct child of the group container (Ashby: fieldset > label);
    // otherwise walk up from above the option's own <label> so we don't return "Yes".
    if (container) {
      for (const q of Array.from(container.querySelectorAll(LABELISH))) {
        if (q.querySelector("input, select, textarea, button")) continue;
        const t = textOf(q);
        if (t && t.length < 400) return t;
      }
    }
    const owner = container ?? first;
    const start = (container ?? first.closest("label") ?? first).parentElement;
    return containerLabel(start, owner, false) || containerLabel(start, owner, true) || norm(first.name);
  }

  const isRequired = (el: HTMLElement, label: string, raw: string) =>
    (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /[*✱]/.test(raw) || /\(required\)/i.test(label);
  const rawLabelText = (el: HTMLElement) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return (l as HTMLElement).innerText ?? "";
    }
    return (el.closest("label") as HTMLElement | null)?.innerText ?? "";
  };

  const out: { id: string; label: string; kind: string; required: boolean; options?: string[]; name?: string; placeholder?: string; maxLength?: number; accept?: string }[] = [];
  const w = window as unknown as { __ferryN?: number };
  const done = new WeakSet<Element>();
  const tag = (el: Element) => {
    if (!el.getAttribute("data-ferry-id")) {
      w.__ferryN = (w.__ferryN ?? 0) + 1;
      el.setAttribute("data-ferry-id", `${prefix}${w.__ferryN}`);
    }
    return el.getAttribute("data-ferry-id")!;
  };

  for (const el of Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[]) {
    if (done.has(el)) continue;
    const input = el as HTMLInputElement;
    const type = (input.type || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
    if (input.disabled || (input.readOnly && type !== "file")) continue;

    // Button-backed choice widgets (Ashby yes/no): a hidden input next to "Yes"/"No" buttons.
    if ((type === "checkbox" || type === "radio") && el.getAttribute("tabindex") === "-1") {
      const btns = Array.from(el.parentElement?.querySelectorAll(":scope > button, :scope > [role=button]") ?? []) as HTMLElement[];
      if (btns.length >= 2 && btns.every((b) => textOf(b).length < 40)) {
        done.add(el);
        const id = tag(el);
        btns.forEach((b, i) => {
          b.setAttribute("data-ferry-group", id);
          b.setAttribute("data-ferry-idx", String(i));
        });
        const holder = el.parentElement!;
        const label = groupLabel(holder.parentElement as HTMLElement, el as HTMLInputElement);
        out.push({ id, label, kind: "radio", required: /[*✱]/.test((holder.parentElement as HTMLElement)?.innerText?.slice(0, 400) ?? "") || /\(required\)/i.test(label), options: btns.map((b) => textOf(b)) });
        continue;
      }
    }
    // Validation mirrors (Greenhouse react-select keeps an aria-hidden twin that carries `required`).
    if (el.getAttribute("aria-hidden") === "true" && type !== "file") continue;
    if (!visible(el)) continue;

    if (type === "radio" || type === "checkbox") {
      const container = groupContainer(input);
      let group: HTMLInputElement[];
      if (type === "radio" && input.name) group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(input.name)}"]`)) as HTMLInputElement[];
      else if (container) group = (Array.from(container.querySelectorAll(`input[type=${type}]`)) as HTMLInputElement[]).filter(visible);
      else group = [input];
      group.forEach((g) => done.add(g));
      const id = tag(group[0]);
      if (type === "checkbox" && group.length <= 1) {
        const label = optionLabel(input) || groupLabel(container, input);
        out.push({ id, label, kind: "checkbox", required: isRequired(input, label, rawLabelText(input)), name: input.name || undefined });
        continue;
      }
      group.forEach((g, i) => {
        g.setAttribute("data-ferry-group", id);
        g.setAttribute("data-ferry-idx", String(i));
      });
      const label = groupLabel(container, group[0]);
      const rawGroup = container ? ((container.querySelector("legend, [class*='label' i], [class*='question' i]") as HTMLElement | null)?.innerText ?? "") : "";
      out.push({
        id,
        label,
        kind: type,
        required: group.some((g) => g.required || g.getAttribute("aria-required") === "true") || /[*✱]/.test(rawGroup) || /\(required\)/i.test(label),
        options: group.map(optionLabel),
        name: input.name || undefined,
      });
      continue;
    }

    done.add(el);
    const label = labelOf(el);
    const raw = rawLabelText(el) || label;
    if (el.tagName === "SELECT") {
      const sel = el as HTMLSelectElement;
      out.push({
        id: tag(el),
        label,
        kind: "select",
        required: isRequired(el, label, raw),
        options: Array.from(sel.options)
          .map((o) => norm(o.text))
          .filter((t) => t && !/^(select|choose|please select|--)/i.test(t)),
        name: sel.name || undefined,
      });
      continue;
    }
    const role = el.getAttribute("role");
    const isCombo = role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || !!el.closest("[class*='select__' i], [class*='combobox' i]");
    const kind = el.tagName === "TEXTAREA" ? "textarea" : type === "file" ? "file" : isCombo ? "combobox" : ["email", "tel", "url", "number", "date"].includes(type) ? type : "text";
    let required = isRequired(el, label, raw);
    if (!required && kind === "combobox") {
      let box: HTMLElement | null = el.parentElement;
      for (let d = 0; box && d < 5 && !required; d++, box = box.parentElement) {
        required = Boolean(box.querySelector("input[aria-hidden=true][required]"));
        if (box.querySelectorAll("[role=combobox]").length > 1) break;
      }
    }
    const maxLength = (input as HTMLInputElement).maxLength > 0 ? (input as HTMLInputElement).maxLength : undefined;
    const accept = kind === "file" ? (input as HTMLInputElement).accept || undefined : undefined;
    out.push({ id: tag(el), label, kind, required, name: input.name || undefined, placeholder: input.placeholder || undefined, maxLength, accept });
  }
  // Button dropdowns (Workday and other React UIs): <button aria-haspopup="listbox">Select One</button>
  for (const el of Array.from(document.querySelectorAll("button[aria-haspopup=listbox], [role=button][aria-haspopup=listbox]")) as HTMLElement[]) {
    if (done.has(el) || !isVis(el)) continue;
    done.add(el);
    const label = labelOf(el);
    // The site's own language switcher (Lever: "EN - English, Select a language") isn't a question.
    if (/select a language|change language|language selector/i.test(label) || el.closest("header, footer, nav")) continue;
    const raw = (el.closest("[class*='field' i], [data-automation-id*='formField' i], div")?.querySelector("label") as HTMLElement | null)?.innerText ?? label;
    out.push({ id: tag(el), label, kind: "listbox", required: el.getAttribute("aria-required") === "true" || /[*✱]/.test(raw), placeholder: textOf(el) || undefined });
  }
  return out;
}

/**
 * Functions handed to `evaluate` are serialized with toString(). Under tsx/esbuild they can
 * reference the `__name` helper, which doesn't exist in the page — define a no-op first.
 */
export async function shim(frame: Frame) {
  await frame.evaluate("globalThis.__name = globalThis.__name || ((t) => t)");
}

export async function extractFields(page: Page): Promise<FrameField[]> {
  const frames = page.frames();
  const fields: FrameField[] = [];
  // Ids must stay unique across page navigations (server-rendered multi-step forms).
  const nonce = Date.now().toString(36).slice(-5);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.isDetached()) continue;
    try {
      await shim(f);
      const got = await f.evaluate(collectFields, `f${i}${nonce}_`);
      for (const g of got) fields.push({ ...(g as FormField), frameIndex: i });
    } catch {
      /* cross-origin frames we can't script (captchas etc.) */
    }
  }
  return fields;
}

export const frameOf = (page: Page, f: FrameField): Frame => page.frames()[f.frameIndex] ?? page.mainFrame();

/** Visible text of the page (all frames), for confirmation and error detection. */
export async function pageText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const f of page.frames()) {
    try {
      parts.push(await f.evaluate(() => document.body?.innerText ?? ""));
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n");
}
