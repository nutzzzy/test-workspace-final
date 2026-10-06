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
    if (tag === "textarea" || (tag === "input" && ["", "text", "email", "search", "tel", "url", "number"].includes(type))) return type === "search" ? "searchbox" : type === "number" ? "spinbutton" : "textbox";
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
    // A field's content (typed text, a select's options) is not its name.
    if (tag === "select" || tag === "textarea") return clean(element.getAttribute("title") ?? element.getAttribute("placeholder") ?? "");
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

  /** Short CSS path from the nearest element with a stable id (or from `root`, for a path inside a row). */
  const cssPath = (element: Element, root: ParentNode = document): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === 1 && current !== root && parts.length < 6) {
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
      if ((root === document ? count(selector) : countIn(root, selector)) === 1) return selector;
      current = parent;
    }
    return parts.join(" > ");
  };

  /** Elements a text locator would match, like getByText: any tag, the innermost element with that text. */
  const textMatches = (text: string) => {
    let found = 0;
    for (const element of document.body?.querySelectorAll("*") ?? []) {
      if (clean(element.textContent, 200) !== text) continue;
      if ([...element.children].some((child) => clean(child.textContent, 200) === text)) continue;
      found += 1;
      if (found > 1) break;
    }
    return found;
  };

  /** Elements with this implicit role and accessible name inside `root` (like getByRole with an exact name). */
  const roleCount = (role: string, name: string, root: ParentNode = document) => {
    let found = 0;
    for (const other of root.querySelectorAll("*")) {
      if (implicitRole(other) !== role || nameOf(other) !== name) continue;
      found += 1;
      if (found > 1) break;
    }
    return found;
  };
  const countIn = (root: ParentNode, selector: string) => {
    try {
      return root.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };
  /** Text that changes per run or per record: uuids, timestamps, long hex or random tokens. */
  const dynamicText = (value: string) =>
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value) ||
    /^\d{10,}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value) ||
    (/^[A-Za-z0-9_-]{16,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value));

  type Candidate = { kind: string; value: string; name?: string; unique?: boolean; confidence?: number };
  /** Starting confidence by kind (heuristics): a stable test id or role+name is likely to survive a redesign, a CSS path is not. */
  const BASE: Record<string, number> = { testid: 0.95, role: 0.92, label: 0.9, placeholder: 0.85, id: 0.7, name: 0.7, text: 0.65, css: 0.3, xpath: 0.2 };
  /** Spec order: role, label, placeholder, test id, text, then attributes and CSS. */
  const ORDER = ["role", "label", "placeholder", "testid", "text", "name", "id", "css", "xpath"];
  const scored = (candidate: Candidate, matches: number, depth = 0): Candidate => {
    let confidence = BASE[candidate.kind] ?? 0.3;
    if (matches !== 1) confidence *= 0.45;
    const shown = candidate.name ?? candidate.value;
    if ((candidate.kind === "text" || candidate.kind === "role") && /\d/.test(shown)) confidence *= 0.85;
    if (shown.length > 40 && (candidate.kind === "text" || candidate.kind === "role")) confidence *= 0.9;
    if (candidate.kind === "css") confidence = Math.max(0.1, confidence - 0.03 * depth);
    return { ...candidate, unique: matches === 1, confidence: Math.round(confidence * 100) / 100 };
  };
  const ranked = (list: Candidate[]) =>
    list
      .map((item, index) => ({ item, index }))
      .sort((a, b) => Number(b.item.unique) - Number(a.item.unique) || ORDER.indexOf(a.item.kind) - ORDER.indexOf(b.item.kind) || a.index - b.index)
      .map(({ item }) => item);

  /**
   * Ways to find the element inside `root` (the page, or the row it is in), by
   * what the user sees first: role and name, label, placeholder, test id, text;
   * its name or id attribute and a CSS path only when nothing better finds it.
   * Each is scored (uniqueness, meaning, stability); generated ids and classes
   * and position-only paths are never used as the main way.
   */
  const candidatesIn = (element: Element, root: ParentNode): Candidate[] => {
    const out: Candidate[] = [];
    const tag = element.tagName.toLowerCase();
    const field = ["input", "textarea", "select"].includes(tag);
    const role = implicitRole(element);
    const name = nameOf(element);
    if (role && name && role !== "heading") out.push(scored({ kind: "role", value: role, name }, roleCount(role, name, root)));
    const label = labelOf(element);
    if (label && field) out.push(scored({ kind: "label", value: label }, 1));
    const placeholder = element.getAttribute("placeholder");
    if (placeholder && clean(placeholder)) out.push(scored({ kind: "placeholder", value: clean(placeholder) }, countIn(root, `[placeholder=${quote(placeholder)}]`)));
    for (const attribute of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-automation-id"]) {
      const value = element.getAttribute(attribute);
      if (!value || unstable(value)) continue;
      const selector = `[${attribute}=${quote(value)}]`;
      out.push(scored({ kind: "testid", value: selector }, countIn(root, selector)));
      break;
    }
    const visible = clean((element as HTMLElement).innerText ?? element.textContent, 80);
    if (visible && visible.length <= 60 && !field && !dynamicText(visible)) {
      const matches = root === document ? textMatches(visible) : [...root.querySelectorAll("*")].filter((node) => clean(node.textContent, 200) === visible && ![...node.children].some((child) => clean(child.textContent, 200) === visible)).length;
      out.push(scored({ kind: "text", value: visible }, matches));
    }
    // Attributes and CSS only when nothing that a user sees finds it alone.
    if (!out.some((item) => item.unique)) {
      const nameAttr = element.getAttribute("name");
      const id = element.getAttribute("id");
      if (nameAttr) out.push(scored({ kind: "name", value: `${tag}[name=${quote(nameAttr)}]` }, countIn(root, `${tag}[name=${quote(nameAttr)}]`)));
      if (id && !unstable(id)) out.push(scored({ kind: "id", value: `#${cssEscape(id)}` }, countIn(root, `#${cssEscape(id)}`)));
      if (!out.some((item) => item.unique)) {
        const path = cssPath(element, root);
        // A path by position (nth-of-type) only for an element with no meaning of its own: one with a
        // role and name is told apart by its row or region instead, or reported as ambiguous.
        const positional = /nth-of-type|nth-child/.test(path);
        if (!positional || !out.some((item) => item.kind === "role")) out.push(scored({ kind: "css", value: path }, countIn(root, path), path.split(">").length));
      }
    }
    // A way that finds several elements now may find only a wrong one after a change: kept only for
    // role and name (used with the row or region around it), dropped otherwise.
    return ranked(out.filter((item) => item.unique || item.kind === "role")).slice(0, 8);
  };

  /** The named region around the element (dialog, form, section, landmark), for telling apart look-alikes. */
  const contextOf = (element: Element) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = node.getAttribute("role") ?? ({ dialog: "dialog", form: "form", nav: "navigation", aside: "complementary", section: "region", main: "main", header: "banner", footer: "contentinfo" } as Record<string, string>)[node.tagName.toLowerCase()];
      if (!role) continue;
      const heading = node.querySelector("h1, h2, h3, h4, legend");
      const name = labelOf(node) || clean(heading?.textContent, 80);
      if (name) return { role, name };
    }
    return undefined;
  };

  // ── repeated structures: tables, lists, grids, cards ──

  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const stableClass = (node: Element) => [...node.classList].find((name) => !unstable(name) && !/active|selected|hover|focus|odd|even|open|first|last/i.test(name));
  /** The data rows of a container for a row selector (header rows left out). */
  const rowsOf = (container: Element, selector: string) =>
    [...container.querySelectorAll(selector)].filter((row) => shown(row) && !row.closest("thead") && !(row.tagName === "TR" && !row.querySelector("td")));

  /**
   * The repeated item the element is in, if any: a table row, a grid row, a
   * list item, or — for div-based lists and cards — the ancestor whose siblings
   * share its tag and class. Null when the element is not in a repetition.
   */
  const rowContext = (element: Element) => {
    const explicit = element.closest('tr, [role="row"], [role="listitem"], li, [role="option"], [role="article"]');
    if (explicit && !explicit.closest("thead")) {
      const tag = explicit.tagName.toLowerCase();
      const roleAttr = explicit.getAttribute("role");
      const container =
        tag === "tr"
          ? explicit.closest("table")
          : roleAttr === "row"
            ? explicit.closest('[role="grid"], [role="table"], [role="treegrid"]') ?? explicit.parentElement
            : explicit.parentElement;
      const rowSelector = tag === "tr" ? "tr" : roleAttr ? `[role="${roleAttr}"]` : ":scope > li";
      if (container && rowsOf(container, rowSelector).length >= 2) return { row: explicit, container, rowSelector };
    }
    // Generic: an ancestor repeated among its siblings (same tag and stable class), holding more than the element.
    let node: Element | null = element;
    for (let depth = 0; node && node.parentElement && node.parentElement !== document.body && depth < 8; depth += 1) {
      const parent: Element = node.parentElement;
      const cls = stableClass(node);
      const selector = `:scope > ${node.tagName.toLowerCase()}${cls ? `.${cssEscape(cls)}` : ""}`;
      const siblings = rowsOf(parent, selector);
      if (node !== element && siblings.length >= 3 && clean((node as HTMLElement).innerText, 300) !== clean((element as HTMLElement).innerText, 300)) {
        return { row: node, container: parent, rowSelector: selector };
      }
      node = parent;
    }
    return null;
  };

  const containerName = (container: Element) => {
    const label = labelOf(container);
    if (label) return label;
    const caption = container.querySelector(":scope > caption");
    if (caption && clean(caption.textContent)) return clean(caption.textContent, 120);
    // The heading just before it ("Users").
    for (let node: Element | null = container; node && node !== document.body; node = node.parentElement) {
      let previous = node.previousElementSibling;
      for (let step = 0; previous && step < 3; step += 1, previous = previous.previousElementSibling) {
        if (/^H[1-6]$/.test(previous.tagName) || previous.getAttribute("role") === "heading") return clean(previous.textContent, 120);
      }
    }
    return "";
  };

  const cellsOf = (row: Element) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]')];
  const headersOf = (container: Element) => {
    const header = container.querySelector('thead tr, [role="row"]:has(> [role="columnheader"])');
    return header ? [...header.querySelectorAll(':scope > th, :scope > td, :scope > [role="columnheader"]')].map((cell) => clean(cell.textContent, 80)) : [];
  };
  /** Leaf texts of a row (what a person reads in it), in order. */
  const leafTexts = (row: Element, skip: Element) =>
    [...row.querySelectorAll("*")]
      .filter((node) => !skip.contains(node) && node.children.length === 0)
      .map((node) => clean(node.textContent, 80))
      .filter((text) => text.length >= 2);
  const PREFERRED_COLUMN = /name|title|email|user|login|code|sku|key|label|subject|نام|عنوان|ایمیل|کاربر|کد/i;

  /**
   * How to recognise the row on a later run, most stable first: a unique
   * data-*-id, a unique link to the record, a unique cell value (a name or
   * email column preferred, never a generated value), a pair of cells when no
   * single value is unique, a unique text in the row (lists, cards) — and the
   * row's position only when nothing else tells it apart.
   */
  const rowIdentity = (row: Element, rows: Element[], container: Element, target: Element) => {
    const identity: Array<Record<string, unknown>> = [];
    const index = rows.indexOf(row);
    const unique = (read: (other: Element) => string | null, value: string) => rows.filter((other) => read(other) === value).length === 1;
    // 1–2. A record id the app put on the row.
    for (const attr of [...row.attributes].map((item) => item.name).filter((name) => /^data-(row-?)?(id|key|uid|uuid|item-?id|entity-?id|record-?id|row)$/i.test(name) || /^data-[a-z-]*-id$/i.test(name))) {
      const value = row.getAttribute(attr) ?? "";
      const positional = value === String(index) || value === String(index + 1) || new RegExp(`^(row|item)[-_]?${index + 1}$`, "i").test(value);
      if (value && !positional && unique((other) => other.getAttribute(attr), value)) {
        identity.push({ strategy: "attr", attr, value });
        break;
      }
    }
    // 3. A link to the record (/users/42/edit).
    const link = row.querySelector("a[href]") as HTMLAnchorElement | null;
    if (link) {
      const href = (() => {
        try {
          const url = new URL(link.href);
          return url.origin === location.origin ? url.pathname + url.search : url.href;
        } catch {
          return "";
        }
      })();
      const hrefOf = (other: Element) => {
        const found = other.querySelector("a[href]") as HTMLAnchorElement | null;
        if (!found) return null;
        try {
          const url = new URL(found.href);
          return url.origin === location.origin ? url.pathname + url.search : url.href;
        } catch {
          return null;
        }
      };
      if (href && !/^javascript:|#$/.test(href) && /\d|[0-9a-f]{6,}/i.test(href) && unique(hrefOf, href)) identity.push({ strategy: "href", value: href });
    }
    // 4–5. Cell values (tables), or texts (lists and cards).
    const cells = cellsOf(row);
    if (cells.length) {
      const headers = headersOf(container);
      const options = cells
        .map((cell, column) => ({ column, text: clean(cell.textContent, 80), holdsTarget: cell.contains(target) }))
        .filter((cell) => cell.text && !cell.holdsTarget && !dynamicText(cell.text));
      const valueAt = (other: Element, column: number) => clean(cellsOf(other)[column]?.textContent, 80);
      const singles = options
        .filter((cell) => rows.filter((other) => valueAt(other, cell.column) === cell.text).length === 1)
        .sort((a, b) => Number(PREFERRED_COLUMN.test(headers[b.column] ?? "")) - Number(PREFERRED_COLUMN.test(headers[a.column] ?? "")) || Number(/^\d+([.,]\d+)?$/.test(a.text)) - Number(/^\d+([.,]\d+)?$/.test(b.text)) || a.column - b.column);
      const cellId = (cell: { column: number; text: string }) => ({ strategy: "cell", column: headers[cell.column] || undefined, columnIndex: cell.column, value: cell.text });
      if (singles.length) identity.push(...singles.slice(0, 2).map(cellId));
      else {
        // No single value is unique (two «Sara»s): the first pair of cells that is.
        outer: for (const [i, a] of options.entries()) {
          for (const b of options.slice(i + 1)) {
            if (rows.filter((other) => valueAt(other, a.column) === a.text && valueAt(other, b.column) === b.text).length === 1) {
              identity.push(cellId(a), cellId(b));
              break outer;
            }
          }
        }
      }
    } else {
      const texts = leafTexts(row, target).filter((text) => !dynamicText(text));
      const others = rows.filter((other) => other !== row).map((other) => new Set(leafTexts(other, other.querySelector("button, a") ?? other)));
      const distinct = texts.find((text) => others.every((set) => !set.has(text)));
      if (distinct) identity.push({ strategy: "text", value: distinct });
      else {
        const pair = texts.flatMap((a, i) => texts.slice(i + 1).map((b) => [a, b] as const)).find(([a, b]) => others.every((set) => !(set.has(a) && set.has(b))));
        if (pair) identity.push({ strategy: "text", value: pair[0] }, { strategy: "text", value: pair[1] });
      }
    }
    // 6. Position, only when nothing else identifies the row.
    if (identity.length === 0) identity.push({ strategy: "index", index });
    return identity.slice(0, 6);
  };

  const scopeOf = (element: Element) => {
    const found = rowContext(element);
    if (!found) return undefined;
    const { row, container, rowSelector } = found;
    const rows = rowsOf(container, rowSelector);
    const role = container.getAttribute("role") ?? (container.tagName === "TABLE" ? "table" : container.tagName === "UL" || container.tagName === "OL" ? "list" : "");
    const name = containerName(container);
    const containerCss = container.id && !unstable(container.id) ? `#${cssEscape(container.id)}` : cssPath(container, document);
    return {
      kind: "row",
      container: { ...(role ? { role } : {}), ...(name ? { name } : {}), css: containerCss },
      rowSelector,
      identity: rowIdentity(row, rows, container, element),
      // Empty: the row itself is what was clicked (a list option, a clickable card).
      target: row === element ? [] : candidatesIn(element, row),
      rowCount: rows.length,
      rowText: clean((row as HTMLElement).innerText, 200),
    };
  };

  /** How to find this element again (see candidatesIn), its row when it is in a repeated structure, and its surroundings. */
  const describe = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const role = implicitRole(element);
    const visible = clean((element as HTMLElement).innerText ?? element.textContent, 80);
    const scope = scopeOf(element);
    const context = contextOf(element);
    return {
      candidates: candidatesIn(element, document),
      ...(scope ? { scope } : {}),
      ...(context ? { context } : {}),
      fingerprint: {
        tag,
        type: element.getAttribute("type") ?? undefined,
        role: role || undefined,
        text: visible || undefined,
        name: element.getAttribute("name") ?? undefined,
        id: element.getAttribute("id") ?? undefined,
        placeholder: element.getAttribute("placeholder") ?? undefined,
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
  let lastPing = 0;
  const valueOf = (element: Element) =>
    (element as HTMLElement).isContentEditable ? clean((element as HTMLElement).innerText, 10_000) : (element as HTMLInputElement).value;
  const flush = () => {
    if (!pending) return;
    const { element, value } = pending;
    pending = null;
    const secret = isSecret(element);
    const dynamic = secret ? undefined : /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value) ? "uuid" : /^\d{10,13}$/.test(value.trim()) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim()) ? "timestamp" : dynamicText(value.trim()) ? "random" : undefined;
    send({ kind: "fill", value, secret, ...(dynamic ? { dynamicValue: dynamic } : {}), target: describe(element), url: location.href, frame: window !== window.top });
  };

  document.addEventListener(
    "input",
    (event) => {
      const element = event.target as Element | null;
      if (!element || inBadge(element) || !isTextField(element)) return;
      const field = (element as HTMLElement).isContentEditable ? editableRoot(element) : element;
      if (pending && pending.element !== field) flush();
      pending = { element: field, value: valueOf(field) };
      // Typing is activity: a page change it causes (auto-submit) is not a separate "open URL".
      const now = Date.now();
      if (now - lastPing > 300) {
        lastPing = now;
        send({ kind: "__activity" });
      }
    },
    true,
  );
  // Actions replayed before recording starts are not recorded: drop what they typed.
  w.__qaRecorderReset = () => {
    pending = null;
  };
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
      if (tag === "input" && type === "file") {
        flush();
        // File names and types only: the contents never leave the page.
        const files = [...((element as HTMLInputElement).files ?? [])].slice(0, 20).map((file) => ({ name: file.name.slice(0, 300), type: file.type || undefined }));
        send({ kind: "upload", files, target: describe(element), url: location.href, frame: window !== window.top });
        return;
      }
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
        if (tag === "select" || (tag === "input" && (type === "checkbox" || type === "radio" || type === "file"))) return;
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
  let runnerUp = 0;
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
    if (!best || total > best.score) {
      runnerUp = best?.score ?? 0;
      best = { element, score: total };
    } else if (total > runnerUp) runnerUp = total;
  }
  if (!best || best.score < 0.6) return null;
  // Two elements as similar (five «Edit» buttons): never guess between them.
  if (best.score - runnerUp < 0.05) return null;
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
  const title = clean(document.title);
  for (const element of document.querySelectorAll(selectors.join(","))) {
    // Route announcers (Next.js, Gatsby, …) read the page title out loud: not an error.
    if (element.closest("next-route-announcer, #__next-route-announcer__, #gatsby-announcer")) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = clean((element as HTMLElement).innerText);
    if (text && text !== title) out.add(text);
    if (out.size >= 5) break;
  }
  return [...out];
}

/**
 * Runs in the replay page, on the container of a repeated structure: finds the
 * row a recorded identity describes. Identities narrow the rows one after the
 * other; one that matches no row any more (a generated id that changed) is
 * left out instead of failing. Marks the single remaining row with `mark` so
 * Playwright can act in it. Never picks among several rows.
 */
export function findRowMain(
  container: Element,
  spec: {
    rowSelector: string;
    identity: Array<{ strategy: string; attr?: string; value?: string; column?: string; columnIndex?: number; index?: number }>;
    mark: string;
  },
): { status: "one" | "none" | "many"; rows: number; matches: number; applied: string[]; stale: string[]; texts: string[] } {
  const clean = (value: string | null | undefined, max = 120) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let all: Element[] = [];
  try {
    all = [...container.querySelectorAll(spec.rowSelector)];
  } catch {
    all = [];
  }
  const rows = all.filter((row) => shown(row) && !row.closest("thead") && !(row.tagName === "TR" && !row.querySelector("td")));
  const cells = (row: Element) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]')];
  const header = container.querySelector('thead tr, [role="row"]:has(> [role="columnheader"])');
  const headers = header ? [...header.querySelectorAll(':scope > th, :scope > td, :scope > [role="columnheader"]')].map((cell) => clean(cell.textContent, 80).toLowerCase()) : [];
  const hrefOf = (row: Element) => {
    const link = row.querySelector("a[href]") as HTMLAnchorElement | null;
    if (!link) return null;
    try {
      const url = new URL(link.href);
      return url.origin === location.origin ? url.pathname + url.search : url.href;
    } catch {
      return null;
    }
  };
  const same = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();
  const test = (row: Element, identity: (typeof spec.identity)[number]): boolean => {
    switch (identity.strategy) {
      case "attr":
        return row.getAttribute(identity.attr ?? "") === identity.value;
      case "href":
        return hrefOf(row) === identity.value;
      case "cell": {
        // By the column's header when it is still there (columns may move), else by position.
        const byHeader = identity.column ? headers.indexOf(identity.column.toLowerCase()) : -1;
        const column = byHeader >= 0 ? byHeader : identity.columnIndex;
        const list = cells(row);
        if (column !== undefined && list[column]) return same(clean(list[column]!.textContent, 80), identity.value ?? "");
        return list.some((cell) => same(clean(cell.textContent, 80), identity.value ?? ""));
      }
      case "text":
        return [...row.querySelectorAll("*")].some((node) => node.children.length === 0 && same(clean(node.textContent, 80), identity.value ?? ""));
      case "index":
        return rows.indexOf(row) === identity.index;
      default:
        return false;
    }
  };
  let current = rows;
  const applied: string[] = [];
  const stale: string[] = [];
  for (const identity of spec.identity) {
    const label = `${identity.strategy}${identity.column ? `:${identity.column}` : identity.attr ? `:${identity.attr}` : ""}=${identity.value ?? identity.index}`;
    const narrowed = current.filter((row) => test(row, identity));
    if (narrowed.length === 0) {
      // Gone from the page (a generated id that changed): left out. Present but on another row: the
      // recorded facts disagree about which row it is — no row rather than a guess.
      if (rows.some((row) => test(row, identity))) {
        applied.push(`${label} (on another row)`);
        current = [];
        break;
      }
      stale.push(label);
      continue;
    }
    applied.push(label);
    current = narrowed;
  }
  // Nothing identified it (every recorded value is gone): no row, rather than any row.
  if (applied.length === 0 && rows.length > 0 && spec.identity.length > 0) current = [];
  for (const row of container.querySelectorAll(`[${spec.mark}]`)) row.removeAttribute(spec.mark);
  if (current.length === 1) current[0]!.setAttribute(spec.mark, "1");
  return {
    status: current.length === 1 ? "one" : current.length === 0 ? "none" : "many",
    rows: rows.length,
    matches: current.length,
    applied,
    stale,
    texts: (current.length > 1 ? current : rows).slice(0, 20).map((row) => clean((row as HTMLElement).innerText, 120)),
  };
}
