import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";
import { lookup } from "../auto-bind";
import type { ExecutionContext, StepExecutionResult, StepExecutor, UiLiveAction, UiLiveProgress } from "../types";
import { pageErrorsMain } from "../ui/recorder-script";
import { randomUUID } from "crypto";
import { describeCandidate, launchBrowser, locate, UiLocateError, type AiResolver, type Located } from "../ui/ui-browser";
import { applySeed, describeSeed, learnTokenPlace, seedFromContext } from "../ui/browser-session";
import { sessionStatus, type StorageState } from "../ui/saved-sessions";
import { hasDynamicParts, sameRoute } from "../ui/replay-smarts";
import { describeAction, readUiConfig, type LocatorCandidate, type UiAction, type UiFlowConfig } from "../ui/ui-types";

/** One replayed action, as shown in the step result. */
export type UiActionResult = {
  id: string;
  kind: UiAction["kind"];
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  durationMs: number;
  /** How the element was found. */
  how?: string;
  /** Found another way than last time: the new way is remembered. */
  healed?: boolean;
  error?: string;
  /** ELEMENT_NOT_FOUND, AMBIGUOUS_LOCATOR, AUTHENTICATION_STATE_EXPIRED. */
  code?: string;
  /** What the replay saw (rows, matches, identities that no longer match). */
  diagnostics?: Record<string, unknown>;
  optional?: boolean;
};

/** Thrown when the saved session the step starts from no longer signs in. */
export const AUTH_EXPIRED = "AUTHENTICATION_STATE_EXPIRED";

/** Pages a signed-out user is sent to. */
const SIGN_IN_URL = /\/(login|log-in|signin|sign-in|sign_in|auth|sso|account\/login)(\/|\?|#|$)/i;

export type UiFlowDeps = {
  /** A saved session's storageState (decrypted), or null when it is gone. */
  loadSession?: (id: string) => Promise<StorageState | null>;
  /** Asked only when the page alone cannot tell which element or row was meant. */
  ai?: AiResolver;
};

/** A locator that worked better than the remembered one, to save on the step. */
export type UiLearning = { actionId: string; candidateIndex: number; healedCandidate?: LocatorCandidate };

/** Values a UI step leaves for later steps (cookies, storage, URL), recorded in the value registry. */
export type UiProduced = { url: string; body: Record<string, unknown>; cookies: Record<string, string> };

type Session = { browser: Browser; context: BrowserContext; page: Page };

export const SESSION_KEY = "ui-session";
/** Actions that type into or choose in a field. */
const FIELD_KINDS = new Set<UiAction["kind"]>(["fill", "select", "check", "uncheck", "press"]);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 450_000;

/**
 * Replays a recorded UI flow in a headless browser. Consecutive UI steps of a
 * run share one browser session (cookies, storage, open page) unless a step
 * asks for a new one; it is closed when the run ends.
 */
export class UiFlowExecutor implements StepExecutor {
  readonly type = "UI_FLOW";

  constructor(
    private readonly decrypt: (payload: string) => string,
    private readonly deps: UiFlowDeps = {},
  ) {}

  async execute(config: Record<string, unknown>, context: ExecutionContext): Promise<StepExecutionResult> {
    const parsed = readUiConfig(config);
    if (!parsed.ok) return { status: "FAILED", error: parsed.error };
    const flow = parsed.value;
    const timeout = flow.actionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const results: UiActionResult[] = [];
    const learned: UiLearning[] = [];

    // Live view: every action with its state, and what the step is doing now.
    const live: UiLiveAction[] = flow.actions.map((action) => ({ id: action.id, kind: action.kind, label: action.label || describeAction(action), status: "pending" }));
    let phase: UiLiveProgress["phase"] = "starting";
    const report = (next?: UiLiveProgress["phase"]) => {
      if (next) phase = next;
      const running = live.findIndex((item) => item.status === "running");
      const current = running >= 0 ? running + 1 : live.filter((item) => item.status !== "pending").length;
      context.reportUi?.({ phase, current, total: live.length, actions: live.map((item) => ({ ...item })) });
    };
    const mark = (id: string, status: UiLiveAction["status"]) => {
      const item = live.find((entry) => entry.id === id);
      if (item) item.status = status;
      report();
    };
    report("starting");

    // A saved session (cookies and storage) to start from: loaded before anything opens.
    const saved = flow.session?.useSavedSession && flow.session.savedSessionId ? flow.session.savedSessionId : null;
    let savedState: StorageState | null = null;
    if (saved) {
      savedState = (await this.deps.loadSession?.(saved).catch(() => null)) ?? null;
      const why = !savedState ? "the saved session no longer exists" : sessionStatus(savedState) === "expired" ? "every cookie of the saved session has expired" : null;
      if (why) return { status: "FAILED", error: `${AUTH_EXPIRED}: ${why}; sign in and save the session again`, output: { kind: "ui", errorCode: AUTH_EXPIRED, actions: [] } };
      // Its values are secrets: redacted wherever they could show up.
      for (const cookie of savedState!.cookies) context.markSecret(cookie.value);
      for (const origin of savedState!.origins) for (const item of origin.localStorage) context.markSecret(item.value);
    }

    let session: Session;
    if (savedState) report("signingIn");
    try {
      session = await this.session(context, flow, savedState);
    } catch (error) {
      return { status: "FAILED", error: error instanceof Error ? error.message : "Could not start the browser" };
    }
    // Answers of the AI fallback, per run: the same question is never asked twice.
    const asked = new Map<string, Promise<{ index: number; confidence: number } | null>>();
    const ai: AiResolver | undefined = this.deps.ai
      ? (question) => {
          const key = JSON.stringify(question);
          if (!asked.has(key)) asked.set(key, this.deps.ai!(question));
          return asked.get(key)!;
        }
      : undefined;
    const stopOnCancel = context.onAbort(() => void session.page.close().catch(() => undefined));

    let failure: string | undefined;
    let failureCode: string | undefined;
    let page = session.page;
    let signedIn: ReturnType<typeof describeSeed> | undefined;
    let seeded: { token?: string; guessed?: string[] } = {};
    try {
      // Recording started at the start URL, so replay does too (the session's cookies are kept).
      const startUrl = fill(flow.startUrl, context);
      // Signed in as the earlier steps were: their cookies, credential headers and the storage entries the step names.
      const seed = seedFromContext(context, startUrl, flow.session);
      await applySeed(session.context, seed);
      signedIn = describeSeed(seed);
      seeded = { token: seed.token, guessed: seed.guessed };
      report("opening");
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: Math.max(timeout, 30_000) });
      await settle(page);
      if (savedState) {
        const expired = await signedOut(page, startUrl, flow.session ?? {}, timeout);
        if (expired) {
          const screenshot = await shot(page);
          return {
            status: "FAILED",
            error: `${AUTH_EXPIRED}: ${expired}; sign in and save the session again`,
            output: { kind: "ui", errorCode: AUTH_EXPIRED, url: page.url(), actions: [], ...(screenshot ? { screenshot } : {}) },
          };
        }
      }

      // Errors already on the page before the final submit are not caused by it.
      const submit = lastSubmit(flow.actions);
      let errorsBefore = new Set<string>();
      // The order can adapt to the page (see below); each action still runs once.
      const order = [...flow.actions];
      for (let position = 0; position < order.length; position += 1) {
        if (context.isCancelled()) return { status: "CANCELLED", error: "Cancelled during UI step" };
        // Typing that makes the app move on by itself (a one-time code that submits on its last digit)
        // is recorded after the page change it caused: do it first while its field is still on this page.
        const next = order[position + 1];
        if (order[position]!.kind === "navigate" && next?.target && FIELD_KINDS.has(next.kind) && !sameRoute(page.url(), order[position]!.url ?? "")) {
          const here = await locate(await frameFor(page, next.frameUrl, 1000), next.target, 2_000, () => context.isCancelled()).catch(() => null);
          if (here) [order[position], order[position + 1]] = [next, order[position]!];
        }
        const action = order[position]!;
        const started = Date.now();
        const label = action.label || describeAction(action);
        phase = "actions";
        mark(action.id, "running");
        try {
          page = await pageFor(session, action.tab ?? 0, timeout);
          if (action === submit) errorsBefore = new Set(await page.evaluate(pageErrorsMain).catch(() => [] as string[]));
          const located = await this.perform(page, action, context, timeout, {
            ai,
            previous: order[position - 1],
            // Pages the next actions were recorded on: the app may skip ahead to one of them.
            upcoming: order.slice(position + 1, position + 6).map((item) => item.url).filter((url): url is string => Boolean(url)),
          });
          if (located && (located.healed || located.healedCandidate)) {
            learned.push({ actionId: action.id, candidateIndex: located.candidateIndex, healedCandidate: located.healedCandidate });
          }
          results.push({
            id: action.id,
            kind: action.kind,
            label,
            status: "PASSED",
            durationMs: Date.now() - started,
            ...(located ? { how: located.how, healed: located.healed } : {}),
            ...(action.optional ? { optional: true } : {}),
          });
          mark(action.id, "passed");
        } catch (error) {
          // The app already went where this click leads (the page the next action was recorded on): nothing left to click.
          const after = order[position + 1];
          if (
            action.kind === "click" &&
            /Element not found/.test(String(error)) &&
            after?.url &&
            action.url &&
            !sameRoute(action.url, after.url) &&
            sameRoute(page.url(), after.url)
          ) {
            results.push({ id: action.id, kind: action.kind, label, status: "PASSED", durationMs: Date.now() - started, how: "the app was already on the page this click leads to" });
            mark(action.id, "passed");
            continue;
          }
          const message = context.isCancelled() ? "Cancelled" : error instanceof Error ? firstLine(error.message) : "Action failed";
          const coded = error instanceof UiLocateError ? { code: error.code, diagnostics: error.diagnostics } : {};
          results.push({ id: action.id, kind: action.kind, label, status: "FAILED", durationMs: Date.now() - started, error: message, ...coded, ...(action.optional ? { optional: true } : {}) });
          mark(action.id, "failed");
          if (context.isCancelled()) return { status: "CANCELLED", error: "Cancelled during UI step" };
          if (!action.optional) {
            failure = `${label}: ${message}`;
            failureCode = error instanceof UiLocateError ? error.code : undefined;
            break;
          }
        }
      }
      // Actions after a failure did not run.
      for (const action of flow.actions.slice(results.length)) {
        results.push({ id: action.id, kind: action.kind, label: action.label || describeAction(action), status: "SKIPPED", durationMs: 0 });
      }
      for (const item of live) if (item.status === "pending") item.status = "skipped";
      report("finishing");

      await settle(page);
      const pageErrors = await page.evaluate(pageErrorsMain).catch(() => [] as string[]);
      const newErrors = pageErrors.filter((item) => !errorsBefore.has(item));
      if (!failure && submit && newErrors.length && flow.failOnPageError !== false) {
        failure = `The page shows an error: ${newErrors[0]}`;
      }
      const produced = await this.produced(session, page);
      // The app's own place for the token, once it shows: used instead of guessing next time.
      const tokenPlace = flow.session?.storage?.length ? null : learnTokenPlace(produced.body as never, seeded.token, seeded.guessed);
      const screenshot = await shot(page);
      return {
        status: failure ? "FAILED" : "PASSED",
        ...(failure ? { error: failure } : {}),
        resolvedInput: { startUrl, actions: flow.actions.length },
        output: {
          kind: "ui",
          url: page.url(),
          title: await page.title().catch(() => ""),
          actions: results,
          ...(failureCode ? { errorCode: failureCode } : {}),
          ...(signedIn && (signedIn.cookies.length || signedIn.headers.length || signedIn.storage.length || signedIn.missing) ? { signedIn } : {}),
          ...(pageErrors.length ? { pageErrors } : {}),
          ...(screenshot ? { screenshot } : {}),
          // Shown like a response: later steps map values from it.
          body: produced.body,
          cookies: produced.cookies,
        },
        uiProduced: produced,
        uiLearned: learned,
        ...(tokenPlace && !failure ? { uiLearnedStorage: tokenPlace } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? firstLine(error.message) : "UI step failed";
      const screenshot = await shot(page);
      return {
        status: context.isCancelled() ? "CANCELLED" : "FAILED",
        error: message,
        output: { kind: "ui", url: page.url(), actions: results, ...(screenshot ? { screenshot } : {}) },
      };
    } finally {
      stopOnCancel();
    }
  }

  /**
   * The run's browser session: the previous UI step's, or a new one. A step
   * that starts from a saved session always gets a new browser with it loaded
   * (cookies and storage in place before the first page opens).
   */
  private async session(context: ExecutionContext, flow: UiFlowConfig, savedState: StorageState | null = null): Promise<Session> {
    const existing = context.resources.get(SESSION_KEY) as Session | undefined;
    if (existing && !flow.newSession && !savedState && existing.browser.isConnected() && !existing.page.isClosed()) return existing;
    if (existing) await existing.browser.close().catch(() => undefined);
    const browser = await launchBrowser({ headless: true });
    const browserContext = await browser.newContext({
      viewport: flow.viewport ?? { width: 1366, height: 860 },
      ignoreHTTPSErrors: false,
      ...(savedState ? { storageState: savedState } : {}),
    });
    browserContext.on("page", track);
    const page = await browserContext.newPage();
    track(page);
    const session = { browser, context: browserContext, page };
    context.resources.set(SESSION_KEY, session);
    context.onDispose(async () => {
      await browser.close().catch(() => undefined);
    });
    return session;
  }

  private async perform(
    page: Page,
    action: UiAction,
    context: ExecutionContext,
    timeout: number,
    around: { previous?: UiAction; upcoming: string[]; ai?: AiResolver } = { upcoming: [] },
  ): Promise<Located | null> {
    const scope = await frameFor(page, action.frameUrl, timeout);
    const value = () => {
      if (action.secret) {
        if (!action.valueEnc) throw new Error("The secret value of this action is missing; type it again in the step");
        const plain = this.decrypt(action.valueEnc);
        context.markSecret(plain);
        return plain;
      }
      return fill(action.value ?? "", context);
    };
    const find = async () => {
      if (!action.target) throw new Error("This action has no element");
      return locate(scope, action.target, timeout, () => context.isCancelled(), { ai: around.ai });
    };

    switch (action.kind) {
      case "navigate": {
        const target = fill(action.url ?? action.value ?? "", context);
        // A page change right after a click, Enter or typing is the app's own doing (a redirect, a
        // payment return), often with a code that differs every run: follow the app there. It may
        // also skip ahead to the page of a later action. A URL typed by the user is opened directly.
        const caused = Boolean(around.previous && around.previous.kind !== "assertText" && around.previous.kind !== "assertUrl" && around.previous.kind !== "waitForText");
        const routes = [target, ...around.upcoming];
        const arrived = () => routes.some((route) => sameRoute(page.url(), route));
        const wait = caused ? (hasDynamicParts(target) ? Math.max(timeout, 30_000) : Math.min(timeout, 6_000)) : 0;
        // The app's own navigation: wait for the URL itself, not a fixed time.
        if (!arrived() && wait > 0) await page.waitForURL((url) => routes.some((route) => sameRoute(url.href, route)), { timeout: wait, waitUntil: "commit" }).catch(() => undefined);
        if (arrived()) {
          await settle(page);
          return null;
        }
        // Opening the recorded URL would show another run's record (an old order, an old basket).
        if (caused && hasDynamicParts(target)) {
          throw new Error(`The app did not go on to ${routeOf(target)} (it is on ${page.url()})`);
        }
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: Math.max(timeout, 30_000) });
        await settle(page);
        return null;
      }
      case "click": {
        const located = await find();
        // A choice (radio, payment method, tab…) is clicked to select it: nothing to do when it already
        // is, and it must be selected afterwards — a click on its inner "details" button does not count.
        const before = await selection(located.locator);
        if (before === true) return { ...located, how: `${located.how} (already selected)` };
        try {
          await located.locator.click({ timeout });
        } catch (error) {
          // Covered by an overlay that is about to go away, or animating: one forced try.
          if (!/intercepts pointer events|not stable|outside of the viewport/i.test(String(error))) throw error;
          await located.locator.click({ timeout, force: true });
        }
        await settle(page);
        if (before === false && (await selection(located.locator)) === false) {
          // Its own radio button, then its start edge (away from inner buttons on the far side).
          const radio = located.locator.locator('input[type="radio"], [role="radio"]').first();
          if ((await radio.count().catch(() => 0)) > 0) await radio.click({ timeout, force: true }).catch(() => undefined);
          else await located.locator.click({ timeout, position: { x: 8, y: 8 } }).catch(() => undefined);
          await settle(page);
          if ((await selection(located.locator)) === false) throw new Error("Clicked, but the option did not become selected");
        }
        return located;
      }
      case "fill": {
        const located = await find();
        const text = value();
        try {
          await located.locator.fill(text, { timeout });
        } catch {
          // Masked or custom inputs that refuse fill(): type it like a user.
          await located.locator.click({ timeout });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
          await page.keyboard.type(text, { delay: 15 });
        }
        return located;
      }
      case "select": {
        const located = await find();
        const wanted = value();
        try {
          await located.locator.selectOption({ value: wanted }, { timeout });
        } catch {
          if (!action.optionLabel) throw new Error(`Option "${wanted}" not found`);
          await located.locator.selectOption({ label: action.optionLabel }, { timeout });
        }
        await settle(page);
        return located;
      }
      case "check":
      case "uncheck": {
        const located = await find();
        try {
          if (action.kind === "check") await located.locator.check({ timeout });
          else await located.locator.uncheck({ timeout });
        } catch {
          // Custom checkboxes: a click toggles them.
          await located.locator.click({ timeout });
        }
        await settle(page);
        return located;
      }
      case "press": {
        const key = action.value || "Enter";
        if (action.target) {
          const located = await find();
          await located.locator.press(key, { timeout });
          await settle(page);
          return located;
        }
        await page.keyboard.press(key);
        await settle(page);
        return null;
      }
      case "waitForText":
      case "assertText": {
        const text = value();
        await scope.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
        return null;
      }
      case "assertUrl": {
        const part = value();
        await page.waitForURL((url) => url.href.includes(part), { timeout, waitUntil: "commit" }).catch(() => {
          throw new Error(`The URL is ${page.url()}, expected it to contain "${part}"`);
        });
        return null;
      }
      case "hover": {
        const located = await find();
        await located.locator.hover({ timeout });
        return located;
      }
      case "waitForElement": {
        // Explicit condition: the element is there and visible (locate waits for exactly that).
        return find();
      }
      case "upload": {
        const located = await find();
        // The recording keeps names and types only: the same names are uploaded with placeholder content.
        const files = (action.files ?? []).map((file) => ({ name: file.name, mimeType: file.type || "application/octet-stream", buffer: Buffer.from(`QA Workbench test file: ${file.name}\n`) }));
        if (files.length === 0) throw new Error("No file was recorded for this upload");
        await located.locator.setInputFiles(files, { timeout });
        await settle(page);
        return { ...located, how: `${located.how} (placeholder content)` };
      }
    }
  }

  /** Cookies, storage and URL of the page after the step. */
  private async produced(session: Session, page: Page): Promise<UiProduced> {
    const url = page.url();
    const cookies = Object.fromEntries((await session.context.cookies().catch(() => [])).slice(0, 60).map((cookie) => [cookie.name, cookie.value]));
    const storage = await page
      .evaluate(() => {
        const read = (store: Storage) => {
          const out: Record<string, string> = {};
          for (let index = 0; index < Math.min(store.length, 60); index += 1) {
            const key = store.key(index);
            if (key) out[key] = (store.getItem(key) ?? "").slice(0, 8000);
          }
          return out;
        };
        try {
          return { local: read(localStorage), session: read(sessionStorage) };
        } catch {
          return { local: {}, session: {} };
        }
      })
      .catch(() => ({ local: {}, session: {} }));
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = null;
    }
    return {
      url,
      cookies,
      body: {
        url,
        path: parsedUrl?.pathname ?? "",
        query: parsedUrl ? Object.fromEntries(parsedUrl.searchParams.entries()) : {},
        title: await page.title().catch(() => ""),
        // Stored JSON (e.g. {"token": …}) is opened up so its fields can be mapped.
        localStorage: openJson(storage.local),
        sessionStorage: openJson(storage.session),
      },
    };
  }
}

/** Values made fresh for each run, for what must not be the same twice (a new user's email, an order note). */
const GENERATED: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $timestamp: () => String(Date.now()),
  $now: () => new Date().toISOString(),
  $random: () => Math.random().toString(36).slice(2, 10),
};

/** {{variables}} in a recorded value, and the generated {{$uuid}}, {{$timestamp}}, {{$now}}, {{$random}}. */
function fill(template: string, context: ExecutionContext): string {
  return template.replace(/\{\{\s*(\$?[A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    if (GENERATED[key]) return GENERATED[key]!();
    const value = lookup(key, context);
    if (value === undefined) throw new Error(`Unresolved variable: {{${key}}}`);
    return value;
  });
}

/** Requests each page has in flight and when the last one ended (Playwright's "networkidle" does not reset after load). */
const traffic = new WeakMap<Page, { inFlight: Set<unknown>; lastChange: number }>();

function track(page: Page) {
  if (traffic.has(page)) return;
  const state = { inFlight: new Set<unknown>(), lastChange: Date.now() };
  traffic.set(page, state);
  const done = (request: unknown) => {
    state.inFlight.delete(request);
    state.lastChange = Date.now();
  };
  page.on("request", (request) => {
    // Long-lived connections never finish and would hold every wait to the cap.
    if (["websocket", "eventsource"].includes(request.resourceType())) return;
    state.inFlight.add(request);
    state.lastChange = Date.now();
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("framenavigated", () => (state.lastChange = Date.now()));
}

/**
 * After an action: the page has loaded, and the requests it sent because of
 * the action (a form's fetch, a redirect) are finished — quiet for a moment —
 * so what the page shows afterwards (a message, a stored token) is there.
 */
async function settle(page: Page, { quietMs = 500, maxMs = 10_000 } = {}) {
  track(page);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  const state = traffic.get(page)!;
  const deadline = Date.now() + maxMs;
  // Give a click's handler a moment to start its request.
  await page.waitForTimeout(100).catch(() => undefined);
  while (Date.now() < deadline && !page.isClosed()) {
    if (state.inFlight.size === 0 && Date.now() - state.lastChange >= quietMs) break;
    await page.waitForTimeout(100).catch(() => undefined);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

async function pageFor(session: Session, tab: number, timeout: number): Promise<Page> {
  const pages = session.context.pages().filter((page) => !page.isClosed());
  if (pages[tab]) return pages[tab]!;
  // A tab the previous action opens (target=_blank, window.open).
  const opened = await session.context.waitForEvent("page", { timeout });
  await opened.waitForLoadState("domcontentloaded").catch(() => undefined);
  return opened;
}

async function frameFor(page: Page, frameUrl: string | undefined, timeout: number): Promise<Page | Frame> {
  if (!frameUrl) return page;
  const wanted = stripQuery(frameUrl);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((item) => item !== page.mainFrame() && stripQuery(item.url()) === wanted);
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  return page;
}

function stripQuery(url: string) {
  return url.split(/[?#]/)[0] ?? url;
}

/** The final submit (a click or Enter after which only checks follow): where a form shows its errors. */
function lastSubmit(actions: UiAction[]) {
  const last = [...actions].reverse().find((action) => action.kind !== "waitForText" && action.kind !== "assertText" && action.kind !== "assertUrl");
  return last && (last.kind === "click" || last.kind === "press") ? last : undefined;
}

function openJson(values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return [key, JSON.parse(trimmed)];
        } catch {
          return [key, value];
        }
      }
      return [key, value];
    }),
  );
}

async function shot(page: Page): Promise<string | null> {
  try {
    if (page.isClosed()) return null;
    const buffer = await page.screenshot({ type: "jpeg", quality: 55, timeout: 5_000 });
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) return null;
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function firstLine(message: string) {
  // Playwright errors carry a call log after the first line.
  return message.split("\n")[0]!.replace(/^locator\.\w+: /, "").slice(0, 400);
}

export { describeCandidate };

/** Cookies and storage of the run's UI browser, to hand a session over to a recording. */
export async function uiSessionState(context: ExecutionContext) {
  const session = context.resources.get(SESSION_KEY) as Session | undefined;
  if (!session || !session.browser.isConnected()) return undefined;
  return session.context.storageState().catch(() => undefined);
}

/** host/path of a URL with its codes shown as "…", for messages. */
function routeOf(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}/${parsed.pathname.split("/").filter(Boolean).map((part) => (/\d/.test(part) && part.length >= 5 ? "…" : part)).join("/")}`;
  } catch {
    return url;
  }
}

/**
 * Selected state of a single-choice option: aria-checked / aria-selected,
 * a data-(is-)selected attribute, or its own radio button. Null for elements
 * without one (plain buttons, links, checkboxes — whose click may mean "off").
 */
async function selection(locator: Locator): Promise<boolean | null> {
  return locator
    .evaluate((element) => {
      const read = (node: Element) => {
        const role = node.getAttribute("role");
        if (role === "radio" || role === "option" || role === "tab") {
          const value = node.getAttribute("aria-checked") ?? node.getAttribute("aria-selected");
          if (value !== null) return value === "true";
        }
        for (const name of ["data-is-selected", "data-selected", "aria-selected"]) {
          const value = node.getAttribute(name);
          if (value === "true" || value === "false") return value === "true";
        }
        if (node instanceof HTMLInputElement && node.type === "radio") return node.checked;
        return null;
      };
      const own = read(element);
      if (own !== null) return own;
      const radios = element.querySelectorAll('input[type="radio"], [role="radio"]');
      return radios.length === 1 ? read(radios[0]!) : null;
    })
    .catch(() => null);
}

/**
 * After opening the start URL with a saved session: why it looks signed out,
 * or null. Sent to a sign-in page (that the start URL is not), the text the
 * step expects when signed in is missing, or a password field asks to sign in.
 */
async function signedOut(page: Page, startUrl: string, session: { signedInText?: string; signInUrlPattern?: string }, timeout: number): Promise<string | null> {
  const pattern = (() => {
    try {
      return session.signInUrlPattern ? new RegExp(session.signInUrlPattern, "i") : SIGN_IN_URL;
    } catch {
      return SIGN_IN_URL;
    }
  })();
  const startIsSignIn = pattern.test(startUrl);
  if (!startIsSignIn && pattern.test(page.url())) return `the app sent the browser to its sign-in page (${page.url().split("?")[0]})`;
  if (session.signedInText) {
    const shown = await page
      .getByText(session.signedInText, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: Math.min(timeout, 8_000) })
      .then(() => true)
      .catch(() => false);
    if (!shown) return `the page does not show "${session.signedInText.slice(0, 60)}"`;
    return null;
  }
  if (!startIsSignIn) {
    const password = page.locator('input[type="password"]');
    if ((await password.count().catch(() => 0)) > 0 && (await password.first().isVisible().catch(() => false))) return "the page asks for a password";
  }
  return null;
}
