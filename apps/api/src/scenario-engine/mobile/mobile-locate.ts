import { AppiumError, type AppiumSession } from "./appium-client";
import type { MobileLocator } from "./mobile-locators";

export type MobileLocateCode = "ELEMENT_NOT_FOUND" | "AMBIGUOUS_LOCATOR";

export class MobileLocateError extends Error {
  constructor(
    readonly code: MobileLocateCode,
    message: string,
  ) {
    super(message);
    this.name = "MobileLocateError";
  }
}

export type MobileLocated = { element: string; index: number; locator: MobileLocator };

const POLL_MS = 500;

/**
 * Find the element on the device with the first locator that matches exactly
 * one element: `first` (the one that worked last time, or the user's choice)
 * before the others, in their ranked order. A locator matching several
 * elements is never used — that would act on a guess. Retries until
 * `timeoutMs` while the screen settles.
 */
export async function locateOnDevice(
  session: AppiumSession,
  candidates: MobileLocator[],
  options: { first?: number; timeoutMs: number; name: string; sleep?: (ms: number) => Promise<void>; isCancelled?: () => boolean },
): Promise<MobileLocated> {
  if (!candidates.length) throw new MobileLocateError("ELEMENT_NOT_FOUND", `Element not found: ${options.name} has no locator`);
  const order = candidates.map((_, index) => index);
  if (options.first !== undefined && options.first > 0 && options.first < candidates.length) {
    order.splice(order.indexOf(options.first), 1);
    order.unshift(options.first);
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  let ambiguous: { locator: MobileLocator; count: number } | null = null;
  for (;;) {
    for (const index of order) {
      const locator = candidates[index]!;
      let found: string[];
      try {
        found = await session.findAll(locator.using, locator.value);
      } catch (error) {
        // A strategy the driver does not know (e.g. an Android locator on iOS) just does not find it.
        if (error instanceof AppiumError && (error.code === "SESSION_GONE" || error.code === "UNREACHABLE" || error.code === "TIMEOUT")) throw error;
        continue;
      }
      if (found.length === 1) return { element: found[0]!, index, locator };
      if (found.length > 1 && !ambiguous) ambiguous = { locator, count: found.length };
    }
    if (options.isCancelled?.() || Date.now() + POLL_MS > deadline) break;
    await sleep(POLL_MS);
  }
  if (ambiguous) {
    throw new MobileLocateError("AMBIGUOUS_LOCATOR", `Ambiguous element: ${options.name} — ${ambiguous.locator.using} "${ambiguous.locator.value}" matches ${ambiguous.count} elements`);
  }
  throw new MobileLocateError("ELEMENT_NOT_FOUND", `Element not found: ${options.name}`);
}

export function describeLocator(locator: Pick<MobileLocator, "using" | "value">) {
  return `${locator.using}: ${locator.value}`;
}
