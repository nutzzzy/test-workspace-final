import type { AppiumSession } from "./appium-client";
import type { MobileActionKind, SWIPE_DIRECTIONS } from "./mobile-types";

/** Do one action on the device. Checks fail with what the element showed instead. */
export async function perform(appium: AppiumSession, kind: MobileActionKind, element: string | null, value: string, direction?: (typeof SWIPE_DIRECTIONS)[number]) {
  switch (kind) {
    case "tap":
      await appium.click(element!);
      return;
    case "type":
      await appium.clear(element!).catch(() => undefined);
      await appium.type(element!, value);
      return;
    case "clear":
      await appium.clear(element!);
      return;
    case "longPress":
      await appium.longPress(element!);
      return;
    case "swipe":
      await appium.swipe(direction ?? "up");
      return;
    case "back":
      await appium.back();
      return;
    case "assertText": {
      const shown = await appium.text(element!);
      if (!shown.includes(value)) throw new Error(`Text check failed: the element shows "${shown.slice(0, 120)}", not "${value.slice(0, 120)}"`);
      return;
    }
    case "assertVisible":
      if (!(await appium.displayed(element!))) throw new Error("Visibility check failed: the element is not shown");
      return;
    case "waitForElement":
      return;
  }
}
