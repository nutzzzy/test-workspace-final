import type { MobilePlatform } from "./mobile-hierarchy";
import type { MobileStrategy } from "./mobile-locators";

/**
 * A small Appium client over the W3C WebDriver protocol (what Appium 2
 * speaks): create and quit a session, read the screen (page source,
 * screenshot), find elements and act on them. Plain HTTP, no driver library:
 * the Appium server and its drivers (UiAutomator2, XCUITest) do the work.
 */

export type AppiumErrorCode = "INVALID_SERVER" | "UNREACHABLE" | "SESSION_FAILED" | "TIMEOUT" | "NO_SUCH_ELEMENT" | "SESSION_GONE" | "WEBDRIVER";

export class AppiumError extends Error {
  constructor(
    readonly code: AppiumErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppiumError";
  }
}

export type Fetcher = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type AppiumOptions = {
  fetch?: Fetcher;
  /** Creating a session can install and start the app: allow it time. */
  sessionTimeoutMs?: number;
  commandTimeoutMs?: number;
};

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const DEFAULT_SESSION_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Capabilities W3C defines; every other one needs a vendor prefix (Appium: `appium:`). */
const W3C_CAPABILITIES = new Set([
  "platformName",
  "browserName",
  "browserVersion",
  "acceptInsecureCerts",
  "pageLoadStrategy",
  "proxy",
  "setWindowRect",
  "timeouts",
  "strictFileInteractability",
  "unhandledPromptBehavior",
  "webSocketUrl",
]);

/** The server's base URL (`/wd/hub` kept for Appium 1 style servers), or an error for anything that is not http(s). */
export function normalizeServerUrl(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppiumError("INVALID_SERVER", "Enter the Appium server URL (http:// or https://)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppiumError("INVALID_SERVER", "Enter the Appium server URL (http:// or https://)");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * The capabilities sent to Appium: platformName from the step's platform,
 * `appium:` added to vendor capabilities written without a prefix
 * (`deviceName` → `appium:deviceName`), as Appium 2 requires.
 */
export function normalizeCapabilities(platform: MobilePlatform, capabilities: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === undefined) continue;
    out[W3C_CAPABILITIES.has(key) || key.includes(":") ? key : `appium:${key}`] = value;
  }
  out.platformName = platform === "ios" ? "iOS" : "Android";
  if (!out["appium:automationName"]) out["appium:automationName"] = platform === "ios" ? "XCUITest" : "UiAutomator2";
  return out;
}

/** Element positions on screen, in the same coordinates as the page source. */
export type Rect = { x: number; y: number; width: number; height: number };

export class AppiumSession {
  constructor(
    readonly serverUrl: string,
    readonly id: string,
    readonly platform: MobilePlatform,
    private readonly http: AppiumHttp,
  ) {}

  private path(suffix = "") {
    return `/session/${encodeURIComponent(this.id)}${suffix}`;
  }

  /** The screen as XML (UiAutomator2 / XCUITest page source). */
  async source(): Promise<string> {
    const value = await this.http.command("GET", this.path("/source"));
    if (typeof value !== "string") throw new AppiumError("WEBDRIVER", "Appium returned no screen description");
    return value;
  }

  /** PNG screenshot, base64. */
  async screenshot(): Promise<string> {
    const value = await this.http.command("GET", this.path("/screenshot"));
    if (typeof value !== "string" || !value) throw new AppiumError("WEBDRIVER", "Appium returned no screenshot");
    return value;
  }

  async windowSize(): Promise<{ width: number; height: number } | null> {
    const value = (await this.http.command("GET", this.path("/window/rect")).catch(() => null)) as Partial<Rect> | null;
    return value && Number(value.width) > 0 && Number(value.height) > 0 ? { width: Number(value.width), height: Number(value.height) } : null;
  }

  /** Element ids the locator finds now (none is not an error). */
  async findAll(using: MobileStrategy, value: string): Promise<string[]> {
    const found = await this.http.command("POST", this.path("/elements"), { using, value });
    if (!Array.isArray(found)) return [];
    return found.map(elementId).filter((id): id is string => Boolean(id));
  }

  click(element: string) {
    return this.http.command("POST", this.path(`/element/${encodeURIComponent(element)}/click`), {});
  }

  type(element: string, text: string) {
    return this.http.command("POST", this.path(`/element/${encodeURIComponent(element)}/value`), { text, value: [...text] });
  }

  clear(element: string) {
    return this.http.command("POST", this.path(`/element/${encodeURIComponent(element)}/clear`), {});
  }

  async text(element: string): Promise<string> {
    const value = await this.http.command("GET", this.path(`/element/${encodeURIComponent(element)}/text`));
    return typeof value === "string" ? value : "";
  }

  async displayed(element: string): Promise<boolean> {
    const value = await this.http.command("GET", this.path(`/element/${encodeURIComponent(element)}/displayed`)).catch(() => true);
    return value !== false;
  }

  async rect(element: string): Promise<Rect> {
    const value = (await this.http.command("GET", this.path(`/element/${encodeURIComponent(element)}/rect`))) as Partial<Rect>;
    return { x: Number(value?.x ?? 0), y: Number(value?.y ?? 0), width: Number(value?.width ?? 0), height: Number(value?.height ?? 0) };
  }

  back() {
    return this.http.command("POST", this.path("/back"), {});
  }

  /** Press and hold the element (W3C pointer actions; both drivers support them). */
  async longPress(element: string, ms = 1000) {
    const rect = await this.rect(element);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await this.pointer([
      { type: "pointerMove", duration: 0, x, y },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: ms },
      { type: "pointerUp", button: 0 },
    ]);
  }

  /** Swipe across the middle of the screen; "up" moves the content up (scrolls down). */
  async swipe(direction: "up" | "down" | "left" | "right") {
    const size = (await this.windowSize()) ?? { width: 400, height: 800 };
    const cx = Math.round(size.width / 2);
    const cy = Math.round(size.height / 2);
    const dx = Math.round(size.width * 0.3);
    const dy = Math.round(size.height * 0.3);
    const [from, to] =
      direction === "up"
        ? [{ x: cx, y: cy + dy }, { x: cx, y: cy - dy }]
        : direction === "down"
          ? [{ x: cx, y: cy - dy }, { x: cx, y: cy + dy }]
          : direction === "left"
            ? [{ x: cx + dx, y: cy }, { x: cx - dx, y: cy }]
            : [{ x: cx - dx, y: cy }, { x: cx + dx, y: cy }];
    await this.pointer([
      { type: "pointerMove", duration: 0, ...from },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 100 },
      { type: "pointerMove", duration: 500, ...to },
      { type: "pointerUp", button: 0 },
    ]);
  }

  private async pointer(actions: Array<Record<string, unknown>>) {
    await this.http.command("POST", this.path("/actions"), {
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }],
    });
    await this.http.command("DELETE", this.path("/actions")).catch(() => undefined);
  }

  /** End the session (the app is left to the driver's own settings). Never throws. */
  async quit() {
    await this.http.command("DELETE", this.path()).catch(() => undefined);
  }
}

/** Open an Appium session; errors say what to do (start the server, check capabilities). */
export async function openAppiumSession(
  input: { serverUrl: string; platform: MobilePlatform; capabilities: Record<string, unknown> },
  options: AppiumOptions = {},
): Promise<AppiumSession> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const http = new AppiumHttp(serverUrl, options);
  const capabilities = normalizeCapabilities(input.platform, input.capabilities);
  const value = (await http.command("POST", "/session", { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS, true)) as {
    sessionId?: unknown;
  } | null;
  const id = typeof value?.sessionId === "string" ? value.sessionId : null;
  if (!id) throw new AppiumError("SESSION_FAILED", "Appium did not start a session");
  return new AppiumSession(serverUrl, id, input.platform, http);
}

class AppiumHttp {
  private readonly fetcher: Fetcher;

  constructor(
    private readonly serverUrl: string,
    private readonly options: AppiumOptions,
  ) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async command(method: string, path: string, body?: unknown, timeoutMs?: number, creating = false): Promise<unknown> {
    const limit = timeoutMs ?? this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await this.fetcher(`${this.serverUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(limit),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AppiumError("TIMEOUT", creating ? `Appium did not start the session within ${Math.round(limit / 1000)} s` : `Appium did not answer within ${Math.round(limit / 1000)} s`);
      }
      throw new AppiumError("UNREACHABLE", `Could not reach the Appium server at ${this.serverUrl}. Start it (appium) and check the URL.`);
    }
    const text = await response.text();
    let parsed: { value?: unknown; sessionId?: unknown } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { value?: unknown; sessionId?: unknown }) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const value = (parsed?.value ?? {}) as { error?: unknown; message?: unknown };
      const error = typeof value.error === "string" ? value.error : "";
      const message = typeof value.message === "string" ? value.message.split("\n")[0]!.slice(0, 400) : `HTTP ${response.status}`;
      if (creating) throw new AppiumError("SESSION_FAILED", `Appium could not start the session: ${message}`);
      if (error === "no such element") throw new AppiumError("NO_SUCH_ELEMENT", message);
      if (error === "invalid session id") throw new AppiumError("SESSION_GONE", "The Appium session has ended (the app or device was closed)");
      if (response.status === 404 && !error) throw new AppiumError("UNREACHABLE", `${this.serverUrl} is not an Appium server (HTTP 404)`);
      throw new AppiumError("WEBDRIVER", message);
    }
    if (!parsed) throw new AppiumError("WEBDRIVER", "Appium answered with something that is not JSON");
    // Appium 1 style servers put the session id next to the value.
    if (creating && parsed.sessionId && parsed.value && typeof parsed.value === "object" && !(parsed.value as { sessionId?: unknown }).sessionId) {
      return { ...(parsed.value as object), sessionId: parsed.sessionId };
    }
    return parsed.value ?? null;
  }
}

function elementId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = record[ELEMENT_KEY] ?? record.ELEMENT;
  return typeof id === "string" ? id : null;
}
