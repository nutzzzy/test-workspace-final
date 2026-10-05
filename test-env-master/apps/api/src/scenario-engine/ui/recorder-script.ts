/**
 * Runs inside every page and frame of the recording browser. It turns what
 * the user does into actions and hands them to the API through the
 * `__qaRecord` binding:
 * - click on buttons, links and other clickable elements;
 * - fill: the final text of an input, textarea or contenteditable (typing is
 *   collected and sent once, when the field is left or Enter is pressed);
 * - select, check / uncheck, Enter and Escape;
 * - a "check text" action: select text on the page and press the badge button.
 * Each element is described several ways (see `describe`) so a replay can find
 * it again. A small badge shows that recording is on and can stop it.
 *
 * Self-contained on purpose: it is serialized with toString() and injected.
 */
export function recorderMain() {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.__qaRecorderInstalled) return;
  w.__qaRecorderInstalled = true;
  const send = (payload: Record<string, unknown>) => {
    const binding = w.__qaRecord as ((payload: unknown) => Promise<unknown>) | undefined;
    if (typeof binding === "function") void binding(payload).catch(() => undefined);
  };

  const BADGE_ID = "__qa-recorder-badge";
  const clean = (value: string | null | undefined, max = 120) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const cssEscape = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&"));
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  /** Ids and classes made by build tools or counters change between builds. */
  const unstable = (value: string) =>
    /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}|^(css|jsx|sc|emotion|mui|chakra|ng|v|ember|svelte)-|__[a-z0-9]{5,}$|^[a-z]{1,3}[0-9a-z]{5,}$/i.test(value) ||
    /^(:r|radix-|headlessui-|react-aria|mantine-|rc_)/.test(value);
  const inBadge = (element: Element | null) => Boolean(element && element.closest && element.closest(`#${BADGE_ID}`));

  const implicitRole = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(" ")[0]!;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type))) return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "textarea" || (tag === "input" && ["", "text", "email", "search", "tel", "url", "password", "number"].includes(type))) return type === "search" ? "searchbox" : "textbox";
    if (tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "option") return "option";
    return "";
  };

  const labelOf = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (label && clean(label.textContent)) return clean(label.textContent);
    }
    const wrapping = element.closest("label");
    if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
    return "";
  };

  /** Accessible name, close to what getByRole matches. */
  const nameOf = (element: Element): string => {
    const label = labelOf(element);
    if (label) return label;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const input = element as HTMLInputElement;
      if (["button", "submit", "reset"].includes(input.type)) return clean(input.value);
      return clean(input.getAttribute("title") ?? input.placeholder ?? "");
    }
    if (tag === "img") return clean(element.getAttribute("alt"));
    return clean((element as HTMLElement).innerText ?? element.textContent, 80);
  };

  const count = (selector: string) => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };

  /** Short CSS path from the nearest element with a stable id. */
  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === 1 && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      const id = current.getAttribute("id");
      if (id && !unstable(id)) {
        parts.unshift(`#${cssEscape(id)}`);
        break;
      }
      let part = tag;
      const classes = [...current.classList].filter((name) => !unstable(name)).slice(0, 2);
      if (classes.length) part += classes.map((name) => `.${cssEscape(name)}`).join("");
      const parent: Element | null = current.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === current!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (count(selector) === 1) return selector;
      current = parent;
    }
    return parts.join(" > ");
  };

  const textMatches = (text: string, selector: string) => {
    let found = 0;
    for (const element of document.querySelectorAll(selector)) {
      if (clean((element as HTMLElement).innerText ?? element.textContent, 200) === text) found += 1;
      if (found > 1) break;
    }
    return found;
  };

  /** Every way to find this element again, strongest first. */
  const describe = (element: Element) => {
    const candidates: Array<{ kind: string; value: string; name?: string; unique?: boolean }> = [];
    const tag = element.tagName.toLowerCase();
    for (const attribute of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-automation-id"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        const selector = `[${attribute}=${quote(value)}]`;
        candidates.push({ kind: "testid", value: selector, unique: count(selector) === 1 });
      }
    }
    const id = element.getAttribute("id");
    if (id && !unstable(id)) {
      const selector = `#${cssEscape(id)}`;
      candidates.push({ kind: "id", value: selector, unique: count(selector) === 1 });
    }
    const role = implicitRole(element);
    const name = nameOf(element);
    if (role && name && role !== "heading") candidates.push({ kind: "role", value: role, name, unique: true });
    const label = labelOf(element);
    if (label && ["input", "textarea", "select"].includes(tag)) candidates.push({ kind: "label", value: label });
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) candidates.push({ kind: "placeholder", value: clean(placeholder) });
    const nameAttr = element.getAttribute("name");
    if (nameAttr) {
      const selector = `${tag}[name=${quote(nameAttr)}]`;
      candidates.push({ kind: "name", value: selector, unique: count(selector) === 1 });
    }
    const visible = clean((element as HTMLElement).innerText ?? element.textContent, 80);
    if (visible && visible.length <= 60 && !["input", "textarea", "select"].includes(tag) && textMatches(visible, tag) === 1) {
      candidates.push({ kind: "text", value: visible, unique: true });
    }
    const path = cssPath(element);
    candidates.push({ kind: "css", value: path, unique: count(path) === 1 });
    // Unique ones first, keeping the strength order within each group.
    const ordered = [...candidates.filter((item) => item.unique !== false), ...candidates.filter((item) => item.unique === false)];
    return {
      candidates: ordered.slice(0, 8),
      fingerprint: {
        tag,
        type: element.getAttribute("type") ?? undefined,
        role: role || undefined,
        text: visible || undefined,
        name: nameAttr ?? undefined,
        id: id ?? undefined,
        placeholder: placeholder ?? undefined,
        ariaLabel: element.getAttribute("aria-label") ?? undefined,
        classes: [...element.classList].slice(0, 8),
      },
    };
  };

  const isSecret = (element: Element) => {
    const input = element as HTMLInputElement;
    const hint = `${input.name ?? ""} ${input.id ?? ""} ${input.getAttribute("autocomplete") ?? ""} ${input.getAttribute("aria-label") ?? ""}`;
    return input.type === "password" || /pass(word)?|passwd|pwd|otp|one-time|pin\b|cvv|cvc|secret|token/i.test(hint);
  };

  const CLICKABLE =
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="treeitem"], summary, label, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], [onclick], [data-testid], [tabindex]:not([tabindex="-1"])';
  const isTextField = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if ((element as HTMLElement).isContentEditable) return true;
    if (tag !== "input") return false;
    const type = ((element as HTMLInputElement).type || "text").toLowerCase();
    return !["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color", "hidden"].includes(type);
  };
  const editableRoot = (element: Element): Element => {
    let current: Element = element;
    while (current.parentElement && (current.parentElement as HTMLElement).isContentEditable) current = current.parentElement;
    return current;
  };

  // Typing is collected per field and sent once.
  let pending: { element: Element; value: string } | null = null;
  const valueOf = (element: Element) =>
    (element as HTMLElement).isContentEditable ? clean((element as HTMLElement).innerText, 10_000) : (element as HTMLInputElement).value;
  const flush = () => {
    if (!pending) return;
    const { element, value } = pending;
    pending = null;
    send({ kind: "fill", value, secret: isSecret(element), target: describe(element), url: location.href, frame: window !== window.top });
  };

  document.addEventListener(
    "input",
    (event) => {
      const element = event.target as Element | null;
      if (!element || inBadge(element) || !isTextField(element)) return;
      const field = (element as HTMLElement).isContentEditable ? editableRoot(element) : element;
      if (pending && pending.element !== field) flush();
      pending = { element: field, value: valueOf(field) };
    },
    true,
  );
  document.addEventListener("focusout", (event) => {
    if (pending && event.target === pending.element) flush();
  }, true);

  document.addEventListener(
    "change",
    (event) => {
      const element = event.target as HTMLInputElement | HTMLSelectElement | null;
      if (!element || inBadge(element)) return;
      const tag = element.tagName.toLowerCase();
      if (tag === "select") {
        flush();
        const select = element as HTMLSelectElement;
        const option = select.options[select.selectedIndex];
        send({ kind: "select", value: select.value, optionLabel: clean(option?.textContent), target: describe(select), url: location.href, frame: window !== window.top });
        return;
      }
      const type = (element as HTMLInputElement).type;
      if (tag === "input" && (type === "checkbox" || type === "radio")) {
        flush();
        send({ kind: (element as HTMLInputElement).checked ? "check" : "uncheck", target: describe(element), url: location.href, frame: window !== window.top });
        return;
      }
      if (pending && pending.element === element) flush();
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const element = event.target as Element | null;
      if (!element || inBadge(element)) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      if (event.key === "Enter" && element.tagName.toLowerCase() === "textarea") return;
      flush();
      send({ kind: "press", value: event.key, target: isTextField(element) ? describe(element) : undefined, url: location.href, frame: window !== window.top });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      const raw = event.target as Element | null;
      if (!raw || inBadge(raw) || !event.isTrusted) return;
      // Checkboxes, radios and selects are recorded by their change; a label click toggles its input.
      const input = raw.closest("input, select, textarea, label") as HTMLElement | null;
      if (input) {
        const tag = input.tagName.toLowerCase();
        const type = (input as HTMLInputElement).type;
        if (tag === "select" || (tag === "input" && (type === "checkbox" || type === "radio"))) return;
        if (tag === "label") {
          const control = (input as HTMLLabelElement).control;
          if (control && (control.tagName === "SELECT" || ["checkbox", "radio"].includes((control as HTMLInputElement).type))) return;
        }
      }
      // A text field is the target itself (not the label around it); otherwise the clickable ancestor.
      const element = isTextField(raw) ? raw : (raw.closest(CLICKABLE) ?? raw);
      flush();
      send({ kind: "click", target: describe(element), url: location.href, frame: window !== window.top, textField: isTextField(element) });
    },
    true,
  );
  window.addEventListener("beforeunload", flush, true);

  // The badge: recording state, "check selected text", stop.
  if (window === window.top) {
    const mount = () => {
      if (document.getElementById(BADGE_ID) || !document.body) return;
      const host = document.createElement("div");
      host.id = BADGE_ID;
      host.style.cssText = "position:fixed;z-index:2147483647;bottom:16px;right:16px;all:initial;";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          .bar{position:fixed;bottom:16px;right:16px;display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:10px;
               background:#111827;color:#f9fafb;font:12px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}
          .dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:p 1s infinite alternate}
          @keyframes p{to{opacity:.3}}
          button{all:unset;cursor:pointer;padding:3px 8px;border-radius:6px;background:#374151}
          button:hover{background:#4b5563}
        </style>
        <div class="bar"><span class="dot"></span><span>QA Workbench · recording</span>
          <button data-a="assert" title="Select text on the page, then press">✓ check text</button>
          <button data-a="stop">■ stop</button></div>`;
      shadow.addEventListener("click", (event) => {
        const action = (event.target as HTMLElement).getAttribute?.("data-a");
        if (action === "stop") {
          flush();
          send({ kind: "__stop" });
        }
        if (action === "assert") {
          const selected = clean(window.getSelection()?.toString(), 300);
          if (selected) send({ kind: "assertText", value: selected, url: location.href, frame: false });
        }
      });
      document.documentElement.appendChild(host);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
  }
}

/**
 * Runs in the replay page when every locator of an element failed: scores the
 * page's elements against the recorded fingerprint and returns a unique CSS
 * path to the best one, or null when nothing is close enough.
 */
export function healMain(fingerprint: {
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  classes?: string[];
}): { selector: string; score: number } | null {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const cssEscape = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value);
  const similar = (a: string, b: string) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.7;
    const wordsA = new Set(a.split(/\W+/).filter(Boolean));
    const wordsB = b.split(/\W+/).filter(Boolean);
    if (!wordsA.size || !wordsB.length) return 0;
    return wordsB.filter((word) => wordsA.has(word)).length / Math.max(wordsA.size, wordsB.length);
  };
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  let best: { element: Element; score: number } | null = null;
  for (const element of document.querySelectorAll(fingerprint.tag || "*")) {
    if (!visible(element)) continue;
    let score = 0;
    let weight = 0;
    const add = (value: number, of: number) => {
      score += value * of;
      weight += of;
    };
    if (fingerprint.text) add(similar(clean((element as HTMLElement).innerText), clean(fingerprint.text)), 3);
    if (fingerprint.ariaLabel) add(similar(clean(element.getAttribute("aria-label")), clean(fingerprint.ariaLabel)), 2);
    if (fingerprint.placeholder) add(similar(clean(element.getAttribute("placeholder")), clean(fingerprint.placeholder)), 2);
    if (fingerprint.name) add(clean(element.getAttribute("name")) === clean(fingerprint.name) ? 1 : 0, 2);
    if (fingerprint.id) add(similar(clean(element.getAttribute("id")), clean(fingerprint.id)), 1);
    if (fingerprint.type) add(clean(element.getAttribute("type")) === clean(fingerprint.type) ? 1 : 0, 1);
    if (fingerprint.classes?.length) {
      const own = new Set([...element.classList]);
      add(fingerprint.classes.filter((name) => own.has(name)).length / fingerprint.classes.length, 1);
    }
    if (weight === 0) continue;
    const total = score / weight;
    if (!best || total > best.score) best = { element, score: total };
  }
  if (!best || best.score < 0.6) return null;
  // A unique path to the chosen element.
  const parts: string[] = [];
  let current: Element | null = best.element;
  while (current && current.nodeType === 1) {
    const id = current.getAttribute("id");
    if (id && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) {
      parts.unshift(`#${cssEscape(id)}`);
      break;
    }
    const parent: Element | null = current.parentElement;
    let part = current.tagName.toLowerCase();
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === current!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
    current = parent;
  }
  return { selector: parts.join(" > "), score: Math.round(best.score * 100) / 100 };
}

/** Visible error messages on the page (alerts, validation messages, invalid fields). */
export function pageErrorsMain(): string[] {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    ".error-message, .error, .errors, .alert-danger, .alert-error, .invalid-feedback, .text-danger, .form-error, .field-error, .toast-error, .ant-form-item-explain-error, .MuiFormHelperText-root.Mui-error",
  ];
  const out = new Set<string>();
  for (const element of document.querySelectorAll(selectors.join(","))) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = clean((element as HTMLElement).innerText);
    if (text) out.add(text);
    if (out.size >= 5) break;
  }
  return [...out];
}
