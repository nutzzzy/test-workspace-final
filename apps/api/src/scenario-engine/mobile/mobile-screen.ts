import type { AppiumSession } from "./appium-client";
import { detectElements, findNode, parsePageSource, screenSize, type DetectedElement, type MobileNode, type MobilePlatform } from "./mobile-hierarchy";
import { locatorsFor, type MobileLocator } from "./mobile-locators";

/** One element of a captured screen with its ranked locators. */
export type ScreenElement = DetectedElement & { locators: MobileLocator[] };

export type CapturedScreen = {
  /** data:image/png;base64,… — or null when the device gave none. */
  screenshot: string | null;
  /** The screen in element coordinates (what bounds are measured in). */
  width: number;
  height: number;
  elements: ScreenElement[];
  capturedAt: string;
  root: MobileNode;
};

/** The stages of reading a screen, in order (the recorder shows each). */
export const CAPTURE_STAGES = ["capture", "hierarchy", "detect", "rank"] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

/**
 * Read the device's screen: screenshot, UI hierarchy, the elements on it and
 * their locators ranked against that same hierarchy. `onStage` is told when
 * each stage starts and how it ended.
 */
export async function captureScreen(
  session: AppiumSession,
  platform: MobilePlatform,
  onStage: (stage: CaptureStage, status: "running" | "done", detail?: string) => void = () => undefined,
  options: { settle?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CapturedScreen> {
  onStage("capture", "running");
  // Right after an action the app is often still animating to the next screen: wait until it stops changing.
  const settled = options.settle ? await stableSource(session, options.sleep) : null;
  // A screenshot is helpful, not required: a secure screen (FLAG_SECURE) refuses it.
  const screenshot = await session.screenshot().catch(() => null);
  onStage("capture", "done", screenshot ? undefined : "noScreenshot");

  onStage("hierarchy", "running");
  const root = parsePageSource(settled ?? (await session.source()));
  const size = (await session.windowSize()) ?? screenSize(root) ?? { width: 0, height: 0 };
  onStage("hierarchy", "done");

  onStage("detect", "running");
  const detected = detectElements(root, platform);
  onStage("detect", "done", String(detected.length));

  onStage("rank", "running");
  const elements = detected.map((element) => ({ ...element, locators: locatorsFor(root, findNode(root, element.id)!, platform) }));
  onStage("rank", "done", String(elements.reduce((sum, element) => sum + element.locators.length, 0)));

  return {
    screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null,
    width: size.width,
    height: size.height,
    elements,
    capturedAt: new Date().toISOString(),
    root,
  };
}

const SETTLE_POLL_MS = 300;
const SETTLE_MAX_MS = 3_000;

/** The page source once two reads in a row are the same (or after SETTLE_MAX_MS, the last one read). */
async function stableSource(session: AppiumSession, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<string> {
  const deadline = Date.now() + SETTLE_MAX_MS;
  let previous = await session.source();
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    const next = await session.source();
    if (next === previous) return next;
    previous = next;
  }
  return previous;
}
