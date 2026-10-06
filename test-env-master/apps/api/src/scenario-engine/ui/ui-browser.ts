import { existsSync } from "fs";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { findRowMain, healMain } from "./recorder-script";
import { hasNumbers, looseTextPattern } from "./replay-smarts";
import type { LocatorCandidate, RowScope, UiTarget } from "./ui-types";

/** Why an element could not be used: shown as the action's error code, with what was seen. */
export type LocateCode = "ELEMENT_NOT_FOUND" | "AMBIGUOUS_LOCATOR" | "AUTHENTICATION_STATE_EXPIRED";

export class UiLocateError extends Error {
  constructor(
    readonly code: LocateCode,
    message: string,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    // The message stays readable (and translatable); the code travels separately.
    super(message);
  }
}

/**
 * Asked only when the page alone cannot decide (several look-alike matches
 * that differ in their surroundings, or a row whose recorded values all
 * changed): a short description of what was recorded and of each option —
 * never the page. Answers the option's index, or null.
 */
export type AiResolver = (question: { kind: "row" | "element"; recorded: string; options: string[] }) => Promise<{ index: number; confidence: number } | null>;

/** Where to look: a page, a frame, or an element (a row, a region). */
type Scope = Page | Frame | Locator;

/**
 * The installed Chrome / Chromium / Edge drives both recording (a visible
 * window) and replay (headless). `UI_BROWSER_PATH` points to another one.
 */
const KNOWN_BROWSERS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

export const NO_BROWSER = "No Chrome, Chromium or Edge was found for UI steps. Install Google Chrome or set UI_BROWSER_PATH.";

export function browserPath(): string | null {
  const configured = process.env.UI_BROWSER_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return KNOWN_BROWSERS.find((path) => existsSync(path)) ?? null;
}

export async function launchBrowser(options: { headless: boolean }): Promise<Browser> {
  const executablePath = browserPath();
  if (!executablePath) throw new Error(NO_BROWSER);
  const { chromium } = await import("playwright-core");
  return chromium.launch({
    executablePath,
    headless: options.headless,
    args: options.headless ? ["--disable-dev-shm-usage"] : ["--start-maximized"],
  });
}

/** A locator for one candidate, inside a page, frame or element. */
export function locatorOf(scope: Scope, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case "xpath":
      return scope.locator(`xpath=${candidate.value}`);
    case "role":
      return scope.getByRole(candidate.value as Parameters<Page["getByRole"]>[0], candidate.name ? { name: candidate.name, exact: true } : {});
    case "label":
      return scope.getByLabel(candidate.value, { exact: true });
    case "placeholder":
      return scope.getByPlaceholder(candidate.value, { exact: true });
    case "text":
      return scope.getByText(candidate.value, { exact: true });
    default:
      return scope.locator(candidate.value);
  }
}

export type Located = {
  locator: Locator;
  /** Index of the candidate that found it; -1 when found by similarity. */
  candidateIndex: number;
  /** Found by a different way than the one learned before (or by similarity). */
  healed: boolean;
  /** A new CSS candidate when found by similarity. */
  healedCandidate?: LocatorCandidate;
  how: string;
};

const POLL_MS = 250;

const ROW_MARK = "data-qa-row";
/** The AI's pick is used only when it is this sure. */
const AI_MIN_CONFIDENCE = 0.85;

/**
 * Find the element: the learned candidate first, then every other one, until
 * exactly one visible match appears. An element recorded in a repeated
 * structure is found through its row (see locateInRow). Several visible
 * matches are told apart by the named region the element was in; when they
 * still cannot be told apart, the step fails with AMBIGUOUS_LOCATOR — the
 * first match is never taken. When the element is on the page but
 * hidden (a closed menu or dropdown), open what holds it, like a user would.
 * Half way through the wait, look for the element most similar to the
 * recorded fingerprint as well — but never when the element itself is there
 * hidden: a look-alike (the menu's parent item) would be the wrong one.
 */
export async function locate(
  scope: Page | Frame,
  target: UiTarget,
  timeoutMs: number,
  isCancelled: () => boolean,
  options: { ai?: AiResolver } = {},
): Promise<Located> {
  if (target.scope) {
    const inRow = await locateInRow(scope, target.scope, timeoutMs, isCancelled, options.ai);
    if (inRow.found) return inRow.found;
    // The row is gone or ambiguous: only a stable attribute that was unique on the whole page may still find it.
    const stable = target.candidates.filter((candidate) => candidate.unique && (candidate.kind === "testid" || candidate.kind === "id"));
    for (const candidate of stable) {
      const visible = await visibleOne(locatorOf(scope, candidate));
      if (visible.one) return { locator: visible.one, candidateIndex: target.candidates.indexOf(candidate), healed: true, how: `${describeCandidate(candidate)} (row not identified)` };
    }
    throw inRow.error!;
  }
  const order = target.candidates.map((_, index) => index);
  if (target.learned !== undefined && target.learned < order.length) {
    order.splice(order.indexOf(target.learned), 1);
    order.unshift(target.learned);
  }
  const deadline = Date.now() + timeoutMs;
  const healFrom = Date.now() + Math.min(timeoutMs / 2, 5000);
  let tried = false;
  let revealed = 0;
  let hidden: Locator | false = false;
  /** A locator that matched several visible elements (and nothing matched one). */
  let ambiguous: { candidate: LocatorCandidate; index: number; locator: Locator; count: number; indices: number[] } | null = null;
  while (!isCancelled()) {
    for (const index of order) {
      const candidate = target.candidates[index]!;
      const locator = locatorOf(scope, candidate);
      const visible = await visibleOne(locator);
      if (visible.one) {
        const learnedBefore = target.learned ?? 0;
        return { locator: visible.one, candidateIndex: index, healed: index !== learnedBefore, how: describeCandidate(candidate) };
      }
      if (visible.count > 1) {
        // Look-alikes: the one inside the region the element was recorded in.
        const region = await regionOf(scope, target.context);
        if (region) {
          const inside = await visibleOne(locatorOf(region, candidate));
          if (inside.one) return { locator: inside.one, candidateIndex: index, healed: index !== (target.learned ?? 0), how: `${describeCandidate(candidate)} in «${target.context!.name}»` };
        }
        if (!ambiguous || visible.count < ambiguous.count) ambiguous = { candidate, index, locator, count: visible.count, indices: visible.indices };
      }
    }
    // Text with numbers that change between runs (a rating count, a balance): the same words, any number.
    for (const [index, candidate] of target.candidates.entries()) {
      const text = candidate.kind === "role" ? candidate.name : candidate.kind === "text" ? candidate.value : undefined;
      if (!text || !hasNumbers(text)) continue;
      const pattern = looseTextPattern(text);
      const locator =
        candidate.kind === "role"
          ? scope.getByRole(candidate.value as Parameters<Page["getByRole"]>[0], { name: pattern })
          : scope.getByText(pattern);
      const visible = await visibleOne(locator);
      if (visible.one) return { locator: visible.one, candidateIndex: index, healed: true, how: `${describeCandidate(candidate)} (numbers may differ)` };
    }
    hidden = await hiddenMatch(scope, target);
    if (hidden && revealed < 2) {
      revealed += 1;
      if (await reveal(scope, hidden)) continue;
    }
    if (Date.now() >= healFrom && !tried && !hidden) {
      tried = true;
      const healed = await scope.evaluate(healMain, target.fingerprint).catch(() => null);
      if (healed) {
        const locator = scope.locator(healed.selector);
        const visible = (await visibleOne(locator)).one;
        if (visible) {
          // Remembered by what it shows (role and name) when that finds it alone; the CSS path only otherwise.
          const semantic = await roleOf(scope, visible);
          const healedCandidate: LocatorCandidate = semantic ?? { kind: "css", value: healed.selector, unique: true, confidence: 0.3 };
          return {
            locator: visible,
            candidateIndex: -1,
            healed: true,
            healedCandidate,
            how: `similar element (${Math.round(healed.score * 100)}%): ${describeCandidate(healedCandidate)}`,
          };
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    // A late heal attempt when the page kept changing.
    if (Date.now() >= deadline - POLL_MS) tried = false;
  }
  const what = target.candidates.map(describeCandidate).slice(0, 3).join(" | ");
  if (ambiguous && !hidden) {
    const seen = await summaries(ambiguous.locator, ambiguous.indices);
    const picked = await askAi(options.ai, { kind: "element", recorded: recordedSummary(target), options: seen.texts });
    if (picked !== null) {
      return { locator: ambiguous.locator.nth(ambiguous.indices[picked]!), candidateIndex: ambiguous.index, healed: true, how: `${describeCandidate(ambiguous.candidate)}: chosen among ${ambiguous.count} by AI` };
    }
    throw new UiLocateError("AMBIGUOUS_LOCATOR", `Ambiguous element: ${ambiguous.count} elements match ${describeCandidate(ambiguous.candidate)}; none is told apart by its surroundings`, {
      locator: describeCandidate(ambiguous.candidate),
      matches: ambiguous.count,
      options: seen.texts.slice(0, 5),
    });
  }
  if (hidden) throw new UiLocateError("ELEMENT_NOT_FOUND", `Element is on the page but hidden (in a closed menu or tab?): ${what}`);
  throw new UiLocateError("ELEMENT_NOT_FOUND", `Element not found: ${what}`, { tried: target.candidates.map(describeCandidate).slice(0, 6) });
}

/**
 * An element in a repeated structure: the container (by its role and name,
 * else its recorded CSS), then the one row the recorded identity describes
 * (see findRowMain), then the element inside that row. Rows that moved, were
 * added or removed do not matter; several rows that fit, or several matching
 * elements in the row, fail as AMBIGUOUS_LOCATOR.
 */
async function locateInRow(
  scope: Page | Frame,
  rowScope: RowScope,
  timeoutMs: number,
  isCancelled: () => boolean,
  ai: AiResolver | undefined,
): Promise<{ found?: Located; error?: UiLocateError }> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof findRowMain>> | null = null;
  let innerMatches = 0;
  let container: Locator | null = null;
  while (!isCancelled()) {
    container = await containerOf(scope, rowScope);
    if (container) {
      last = await container
        .evaluate(findRowMain, { rowSelector: rowScope.rowSelector, identity: rowScope.identity, mark: ROW_MARK })
        .catch(() => null);
      if (last?.status === "one") {
        const row = container.locator(`[${ROW_MARK}]`).first();
        const rowName = describeIdentity(rowScope);
        if (rowScope.target.length === 0) return { found: { locator: row, candidateIndex: 0, healed: false, how: `row ${rowName}` } };
        for (const [index, candidate] of rowScope.target.entries()) {
          const visible = await visibleOne(locatorOf(row, candidate));
          if (visible.one) return { found: { locator: visible.one, candidateIndex: 0, healed: index > 0, how: `${describeCandidate(candidate)} in row ${rowName}` } };
          innerMatches = Math.max(innerMatches, visible.count);
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const diagnostics = { container: rowScope.container?.name ?? rowScope.container?.css, rows: last?.rows ?? 0, identity: describeIdentity(rowScope), applied: last?.applied, stale: last?.stale };
  // Several rows fit, or the recorded values are all gone: an AI may tell, from the rows' texts, which one was meant.
  if (container && last && (last.status === "many" || last.status === "none") && last.texts.length > 1) {
    const picked = await askAi(ai, { kind: "row", recorded: `${describeIdentity(rowScope)} · ${rowScope.rowText ?? ""}`, options: last.texts });
    if (picked !== null) {
      const row = container.locator(rowScope.rowSelector.replace(/^:scope\s*>\s*/, "")).filter({ hasText: last.texts[picked]!.slice(0, 60) });
      const inner = rowScope.target.length ? (await firstUnique(row, rowScope.target)) : (await visibleOne(row)).one;
      if (inner) return { found: { locator: inner, candidateIndex: 0, healed: true, how: `row chosen by AI among ${last.texts.length}` } };
    }
  }
  if (last?.status === "many") {
    return { error: new UiLocateError("AMBIGUOUS_LOCATOR", `Ambiguous element: ${last.matches} rows match ${describeIdentity(rowScope)}`, { ...diagnostics, options: last.texts.slice(0, 5) }) };
  }
  if (last?.status === "one" && innerMatches > 1) {
    return { error: new UiLocateError("AMBIGUOUS_LOCATOR", `Ambiguous element: ${innerMatches} elements match ${describeCandidate(rowScope.target[0]!)} in row ${describeIdentity(rowScope)}`, diagnostics) };
  }
  const why = !container ? `the ${rowScope.container?.role ?? "list"} ${rowScope.container?.name ? `«${rowScope.container.name}» ` : ""}is not on the page` : last?.status === "one" ? `${describeCandidate(rowScope.target[0]!)} is not in row ${describeIdentity(rowScope)}` : `no row matches ${describeIdentity(rowScope)}`;
  return { error: new UiLocateError("ELEMENT_NOT_FOUND", `Element not found: ${why}`, diagnostics) };
}

async function firstUnique(scope: Locator, candidates: LocatorCandidate[]) {
  for (const candidate of candidates) {
    const visible = await visibleOne(locatorOf(scope, candidate));
    if (visible.one) return visible.one;
  }
  return null;
}

/** The table / list: by role and name when that finds one, else the recorded CSS, else the page. */
async function containerOf(scope: Page | Frame, rowScope: RowScope): Promise<Locator | null> {
  const { container } = rowScope;
  if (container?.role && container.name) {
    const byName = scope.getByRole(container.role as Parameters<Page["getByRole"]>[0], { name: container.name, exact: true });
    if ((await byName.count().catch(() => 0)) === 1) return byName;
  }
  if (container?.css) {
    const byCss = scope.locator(container.css);
    if ((await byCss.count().catch(() => 0)) === 1) return byCss;
  }
  // Rows selected from the page itself (":scope >" needs a parent, so the body stands in).
  const body = scope.locator("body");
  return rowScope.rowSelector.startsWith(":scope") ? null : body;
}

/** The named region (dialog, form, section) the element was recorded in, if it is on the page once. */
async function regionOf(scope: Page | Frame, context: UiTarget["context"]): Promise<Locator | null> {
  if (!context?.role || !context.name) return null;
  const region = scope.getByRole(context.role as Parameters<Page["getByRole"]>[0], { name: context.name, exact: true });
  return (await region.count().catch(() => 0)) === 1 ? region : null;
}

/** Each match's text and surroundings (its row or region), shortened: what tells look-alikes apart. */
async function summaries(locator: Locator, indices: number[]) {
  const texts: string[] = [];
  for (const index of indices.slice(0, 10)) {
    texts.push(
      await locator
        .nth(index)
        .evaluate((element) => {
          const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
          const around = element.closest('tr, li, [role="row"], [role="listitem"], section, form, [role="dialog"], article') ?? element.parentElement;
          return `${clean((element as HTMLElement).innerText)} | ${clean((around as HTMLElement | null)?.innerText)}`;
        })
        .catch(() => ""),
    );
  }
  return { texts };
}

function recordedSummary(target: UiTarget) {
  const fp = target.fingerprint;
  return [fp.role, fp.text ?? fp.ariaLabel ?? fp.name, target.context?.name].filter(Boolean).join(" | ").slice(0, 200);
}

/** The AI's pick, only when the options differ at all and it is sure enough; null otherwise. */
async function askAi(ai: AiResolver | undefined, question: { kind: "row" | "element"; recorded: string; options: string[] }): Promise<number | null> {
  if (!ai || question.options.length < 2 || new Set(question.options).size < question.options.length) return null;
  try {
    const answer = await ai(question);
    if (!answer || answer.confidence < AI_MIN_CONFIDENCE || answer.index < 0 || answer.index >= question.options.length) return null;
    return answer.index;
  } catch {
    return null;
  }
}

export function describeIdentity(rowScope: RowScope) {
  const parts = rowScope.identity.map((item) => {
    switch (item.strategy) {
      case "attr":
        return `${item.attr}=${item.value}`;
      case "href":
        return `link ${item.value}`;
      case "cell":
        return `${item.column ?? `column ${(item.columnIndex ?? 0) + 1}`}=«${item.value}»`;
      case "text":
        return `«${item.value}»`;
      case "index":
        return `#${item.index + 1}`;
    }
  });
  return parts.join(" + ");
}

/** The element one of the locators finds on the page while it is hidden (none of them finds it visible). */
async function hiddenMatch(scope: Page | Frame, target: UiTarget): Promise<Locator | false> {
  for (const candidate of target.candidates) {
    if (candidate.kind === "css") continue;
    const locator =
      candidate.kind === "role"
        ? scope.getByRole(candidate.value as Parameters<Page["getByRole"]>[0], { ...(candidate.name ? { name: candidate.name, exact: true } : {}), includeHidden: true })
        : locatorOf(scope, candidate);
    try {
      if ((await locator.count()) === 1 && !(await locator.isVisible())) return locator;
    } catch {
      // try the next one
    }
  }
  return false;
}

/**
 * Open what hides the element: the toggle of the closed menu, dropdown or
 * section around it (the visible control just before it in its nearest visible
 * container). Hovered first (menus that open on hover), clicked otherwise.
 */
async function reveal(scope: Page | Frame, hidden: Locator): Promise<boolean> {
  const MARK = "data-qa-reveal";
  const found = await hidden
    .evaluate((element, mark) => {
      const shown = (node: Element) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      let branch: Element = element;
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (!shown(node)) {
          branch = node;
          continue;
        }
        const controls = [...node.querySelectorAll('a, button, summary, [role="button"], [role="menuitem"], [role="tab"], [aria-expanded], [data-toggle], [data-bs-toggle]')].filter(
          (control) => !branch.contains(control) && shown(control) && control.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const trigger = controls[controls.length - 1];
        if (!trigger) return false;
        // Only a real toggle: an unrelated button before a hidden element must not be clicked.
        const toggle =
          trigger.matches('[aria-expanded], [aria-haspopup], [data-toggle], [data-bs-toggle], summary, [role="tab"]') ||
          /toggle|dropdown|collapse|submenu|sub-menu|menu|accordion|nav/i.test(`${trigger.className} ${node.className}`) ||
          node.tagName === "LI" ||
          node.tagName === "DETAILS";
        if (!toggle) return false;
        trigger.setAttribute(mark, "1");
        return true;
      }
      return false;
    }, MARK)
    .catch(() => false);
  if (!found) return false;
  const trigger = scope.locator(`[${MARK}]`).first();
  try {
    await trigger.hover({ timeout: 2_000 }).catch(() => undefined);
    await hidden.waitFor({ state: "visible", timeout: 700 }).catch(() => undefined);
    if (!(await hidden.isVisible())) {
      await trigger.click({ timeout: 2_000 });
      await hidden.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
    }
    return hidden.isVisible();
  } catch {
    return false;
  } finally {
    await scope.evaluate((mark) => document.querySelectorAll(`[${mark}]`).forEach((node) => node.removeAttribute(mark)), MARK).catch(() => undefined);
  }
}

/**
 * The single visible element of a locator: the only match, or the only
 * visible one among several. `count` is how many visible ones there were
 * (more than one = ambiguous: never one of them picked at random).
 */
async function visibleOne(locator: Locator): Promise<{ one: Locator | null; count: number; indices: number[] }> {
  try {
    const total = await locator.count();
    if (total === 0) return { one: null, count: 0, indices: [] };
    if (total === 1) return (await locator.isVisible()) ? { one: locator, count: 1, indices: [0] } : { one: null, count: 0, indices: [] };
    const visible: number[] = [];
    for (let index = 0; index < Math.min(total, 50); index += 1) {
      if (await locator.nth(index).isVisible()) visible.push(index);
    }
    if (visible.length === 1) return { one: locator.nth(visible[0]!), count: 1, indices: visible };
    return { one: null, count: visible.length, indices: visible };
  } catch {
    return { one: null, count: 0, indices: [] };
  }
}

/** A role locator for the element (its role and accessible name, as getByRole sees them), if it finds only this one. */
async function roleOf(scope: Page | Frame, locator: Locator): Promise<LocatorCandidate | null> {
  try {
    const snapshot = await locator.ariaSnapshot({ timeout: 2_000 });
    const match = /^- ([a-z]+) "((?:[^"\\]|\\.)+)"/.exec(snapshot.trim());
    if (!match) return null;
    const candidate: LocatorCandidate = { kind: "role", value: match[1]!, name: JSON.parse(`"${match[2]}"`) as string, unique: true };
    const found = (await visibleOne(locatorOf(scope, candidate))).one;
    if (!found) return null;
    const same = await found.evaluate((element, other) => element === other, await locator.elementHandle());
    return same ? candidate : null;
  } catch {
    return null;
  }
}

export function describeCandidate(candidate: LocatorCandidate) {
  switch (candidate.kind) {
    case "role":
      return `role=${candidate.value}${candidate.name ? ` "${candidate.name}"` : ""}`;
    case "label":
    case "placeholder":
    case "text":
      return `${candidate.kind}="${candidate.value}"`;
    case "xpath":
      return `xpath=${candidate.value}`;
    default:
      return candidate.value;
  }
}
