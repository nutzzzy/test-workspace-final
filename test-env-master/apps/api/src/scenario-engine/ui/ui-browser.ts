import { existsSync } from "fs";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { healMain } from "./recorder-script";
import { hasNumbers, looseTextPattern } from "./replay-smarts";
import type { LocatorCandidate, UiTarget } from "./ui-types";

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

/** A locator for one candidate, inside a page or frame. */
export function locatorOf(scope: Page | Frame, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
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

/**
 * Find the element: the learned candidate first, then every other one, until
 * exactly one visible match appears. When the element is on the page but
 * hidden (a closed menu or dropdown), open what holds it, like a user would.
 * Half way through the wait, look for the element most similar to the
 * recorded fingerprint as well — but never when the element itself is there
 * hidden: a look-alike (the menu's parent item) would be the wrong one.
 */
export async function locate(scope: Page | Frame, target: UiTarget, timeoutMs: number, isCancelled: () => boolean): Promise<Located> {
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
  while (!isCancelled()) {
    for (const index of order) {
      const candidate = target.candidates[index]!;
      const locator = locatorOf(scope, candidate);
      const visible = await visibleOne(locator);
      if (visible) {
        const learnedBefore = target.learned ?? 0;
        return { locator: visible, candidateIndex: index, healed: index !== learnedBefore, how: describeCandidate(candidate) };
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
      if (visible) return { locator: visible, candidateIndex: index, healed: true, how: `${describeCandidate(candidate)} (numbers may differ)` };
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
        const visible = await visibleOne(locator);
        if (visible) {
          // Remembered by what it shows (role and name) when that finds it alone; the CSS path only otherwise.
          const semantic = await roleOf(scope, visible);
          const healedCandidate: LocatorCandidate = semantic ?? { kind: "css", value: healed.selector, unique: true };
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
  if (hidden) throw new Error(`Element is on the page but hidden (in a closed menu or tab?): ${what}`);
  throw new Error(`Element not found: ${what}`);
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

/** The single visible element of a locator: the only match, or the only visible one among a few. */
async function visibleOne(locator: Locator): Promise<Locator | null> {
  try {
    const total = await locator.count();
    if (total === 0) return null;
    if (total === 1) return (await locator.isVisible()) ? locator : null;
    if (total > 10) return null;
    const visible: Locator[] = [];
    for (let index = 0; index < total; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible()) visible.push(item);
      if (visible.length > 1) return null;
    }
    return visible[0] ?? null;
  } catch {
    return null;
  }
}

/** A role locator for the element (its role and accessible name, as getByRole sees them), if it finds only this one. */
async function roleOf(scope: Page | Frame, locator: Locator): Promise<LocatorCandidate | null> {
  try {
    const snapshot = await locator.ariaSnapshot({ timeout: 2_000 });
    const match = /^- ([a-z]+) "((?:[^"\\]|\\.)+)"/.exec(snapshot.trim());
    if (!match) return null;
    const candidate: LocatorCandidate = { kind: "role", value: match[1]!, name: JSON.parse(`"${match[2]}"`) as string, unique: true };
    const found = await visibleOne(locatorOf(scope, candidate));
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
    default:
      return candidate.value;
  }
}
