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
 * exactly one visible match appears. Half way through the wait, look for the
 * element most similar to the recorded fingerprint as well.
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
    if (Date.now() >= healFrom && !tried) {
      tried = true;
      const healed = await scope.evaluate(healMain, target.fingerprint).catch(() => null);
      if (healed) {
        const locator = scope.locator(healed.selector);
        const visible = await visibleOne(locator);
        if (visible) {
          return {
            locator: visible,
            candidateIndex: -1,
            healed: true,
            healedCandidate: { kind: "css", value: healed.selector, unique: true },
            how: `similar element (${Math.round(healed.score * 100)}%): ${healed.selector}`,
          };
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    // A late heal attempt when the page kept changing.
    if (Date.now() >= deadline - POLL_MS) tried = false;
  }
  throw new Error(`Element not found: ${target.candidates.map(describeCandidate).slice(0, 3).join(" | ")}`);
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
