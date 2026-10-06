import { randomUUID } from "crypto";
import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from "@nestjs/common";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { z } from "zod";
import { launchBrowser } from "./ui-browser";
import { applySeed, type SessionSeed } from "./browser-session";
import { recorderMain } from "./recorder-script";
import { describeAction, FingerprintSchema, LocatorCandidateSchema, SECRET_PLACEHOLDER, type UiAction } from "./ui-types";

/** What the page script sends for one user action (untrusted: the recorded page could send anything). */
const EventSchema = z.object({
  kind: z.enum(["click", "fill", "select", "check", "uncheck", "press", "assertText", "__stop", "__activity"]),
  value: z.string().max(10_000).optional(),
  optionLabel: z.string().max(300).optional(),
  secret: z.boolean().optional(),
  url: z.string().max(4000).optional(),
  frame: z.boolean().optional(),
  textField: z.boolean().optional(),
  target: z
    .object({ candidates: z.array(LocatorCandidateSchema).max(12), fingerprint: FingerprintSchema })
    .optional(),
});

export type RecordRange = { fromActionId: string; toActionId: string };

/** Brings the recording browser to where recording starts (replays earlier actions); returns an error to show, if any. */
export type PrepareRecording = (parts: { browser: Browser; context: BrowserContext; page: Page }) => Promise<string | undefined>;

type Session = {
  id: string;
  scenarioId: string;
  stepId: string | null;
  startUrl: string;
  /** Actions of the step this recording replaces (first and last, inclusive). */
  range: RecordRange | null;
  /** "preparing": the step's earlier actions are being replayed; nothing is recorded yet. */
  state: "preparing" | "recording" | "stopped";
  browser: Browser;
  context: BrowserContext;
  actions: UiAction[];
  startedAt: number;
  lastActionAt: number;
  lastUrl: string;
  error?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const MAX_SESSIONS = 2;
const IDLE_MS = 30 * 60 * 1000;
const MAX_ACTIONS = 500;
/** A page change this soon after an action was caused by it (no separate "open URL"). */
const CAUSED_MS = 2500;

/**
 * Records UI steps: opens a visible browser on this machine at the start URL
 * and turns what the user does there into actions. The browser runs where the
 * API runs, so recording works when the API runs on the user's machine.
 */
@Injectable()
export class UiRecorderService implements OnModuleDestroy {
  private readonly logger = new Logger(UiRecorderService.name);
  private readonly sessions = new Map<string, Session>();

  /** `headless` is for tests: the page is then driven by the test instead of a person. */
  async start(
    input: { scenarioId: string; stepId?: string | null; startUrl: unknown; range?: RecordRange | null },
    options: {
      headless?: boolean;
      seed?: SessionSeed;
      storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
      prepare?: PrepareRecording;
    } = {},
  ) {
    const startUrl = typeof input.startUrl === "string" ? input.startUrl.trim() : "";
    if (!/^https?:\/\//i.test(startUrl)) throw new BadRequestException("Enter the start URL (http:// or https://)");
    const active = [...this.sessions.values()].filter((session) => session.state !== "stopped");
    if (active.length >= MAX_SESSIONS) throw new BadRequestException("Another recording is still open; stop it first");

    let browser: Browser;
    try {
      browser = await launchBrowser({ headless: options.headless === true });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Could not open the browser");
    }
    // Signed in as the steps before it left things: an earlier UI step's session, and the earlier requests' cookies and headers.
    const context = await browser.newContext({ viewport: null, ...(options.storageState ? { storageState: options.storageState } : {}) });
    if (options.seed) await applySeed(context, options.seed);
    const session: Session = {
      id: randomUUID(),
      scenarioId: input.scenarioId,
      stepId: input.stepId ?? null,
      startUrl,
      range: input.range ?? null,
      state: options.prepare ? "preparing" : "recording",
      browser,
      context,
      actions: [],
      startedAt: Date.now(),
      lastActionAt: 0,
      lastUrl: startUrl,
    };
    this.sessions.set(session.id, session);

    await context.exposeBinding("__qaRecord", (source: { page: Page; frame: Frame }, payload: unknown) => this.onEvent(session, source, payload));
    await context.addInitScript(`(${recorderMain.toString()})()`);
    context.on("page", (page) => this.watch(session, page));
    browser.on("disconnected", () => this.finish(session));

    const page = await context.newPage();
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      session.error = error instanceof Error ? error.message.split("\n")[0] : "Could not open the start URL";
    }
    await page.bringToFront().catch(() => undefined);
    // Replaying the earlier actions can take a while: the status shows "preparing" until it is done.
    if (options.prepare) void this.prepare(session, options.prepare, page);
    this.touch(session);
    return { ...this.view(session), page };
  }

  status(id: string) {
    return this.view(this.get(id));
  }

  /** Stop recording and close the browser; the actions stay until taken. */
  async stop(id: string) {
    const session = this.get(id);
    this.finish(session);
    await session.browser.close().catch(() => undefined);
    return this.view(session);
  }

  /** The recorded actions with their secret values, once, for saving into a step. */
  take(id: string) {
    const session = this.get(id);
    if (session.state !== "stopped") throw new BadRequestException("Stop the recording first");
    this.sessions.delete(id);
    return { scenarioId: session.scenarioId, stepId: session.stepId, startUrl: session.startUrl, range: session.range, actions: tidy(session.actions) };
  }

  async discard(id: string) {
    const session = this.sessions.get(id);
    if (!session) return { ok: true };
    this.finish(session);
    await session.browser.close().catch(() => undefined);
    this.sessions.delete(id);
    return { ok: true };
  }

  async onModuleDestroy() {
    await Promise.all([...this.sessions.values()].map((session) => session.browser.close().catch(() => undefined)));
  }

  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException("Recording not found");
    return session;
  }

  private async prepare(session: Session, prepare: PrepareRecording, page: Page) {
    const error = await prepare({ browser: session.browser, context: session.context, page }).catch((cause: unknown) =>
      cause instanceof Error ? cause.message : String(cause),
    );
    if (session.state !== "preparing") return;
    if (error) session.error = error.split("\n")[0];
    // What the replay typed is not the user's: forget it, and start from the page it reached.
    for (const open of session.context.pages()) {
      for (const frame of open.frames()) await frame.evaluate("window.__qaRecorderReset && window.__qaRecorderReset()").catch(() => undefined);
    }
    session.actions = [];
    session.lastUrl = session.context.pages().find((item) => !item.isClosed())?.url() ?? session.lastUrl;
    session.state = "recording";
    this.touch(session);
  }

  private finish(session: Session) {
    if (session.state === "stopped") return;
    session.state = "stopped";
    clearTimeout(session.idleTimer);
  }

  private touch(session: Session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.logger.warn(`UI recording ${session.id} was idle for 30 minutes; closing it`);
      void this.stop(session.id).catch(() => undefined);
    }, IDLE_MS);
  }

  /** Page changes the user made directly (typed URL, back/forward) become "open URL". */
  private watch(session: Session, page: Page) {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || session.state !== "recording") return;
      const url = frame.url();
      if (!/^https?:/i.test(url) || url === session.lastUrl) return;
      const caused = Date.now() - session.lastActionAt < CAUSED_MS;
      session.lastUrl = url;
      // Redirects before the first action belong to opening the start URL.
      if (caused || session.actions.length === 0) return;
      this.push(session, { id: randomUUID(), kind: "navigate", url, tab: tabOf(session, page) });
    });
  }

  private onEvent(session: Session, source: { page: Page; frame: Frame }, payload: unknown) {
    if (session.state !== "recording") return;
    const parsed = EventSchema.safeParse(payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.kind === "__stop") {
      void this.stop(session.id).catch(() => undefined);
      return;
    }
    if (event.kind === "__activity") {
      session.lastActionAt = Date.now();
      return;
    }
    session.lastActionAt = Date.now();
    const inFrame = source.frame !== source.page.mainFrame();
    const action: UiAction = {
      id: randomUUID(),
      kind: event.kind,
      ...(event.target ? { target: event.target } : {}),
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.optionLabel ? { optionLabel: event.optionLabel } : {}),
      ...(event.secret ? { secret: true } : {}),
      ...(event.url ? { url: event.url } : {}),
      tab: tabOf(session, source.page),
      ...(inFrame ? { frameUrl: source.frame.url() } : {}),
    };
    // A click into a text field that is then typed into is part of the typing.
    if (event.kind === "click" && event.textField) action.label = "focus";
    this.push(session, action);
  }

  private push(session: Session, action: UiAction) {
    if (session.actions.length >= MAX_ACTIONS) return;
    session.actions.push(action);
    this.touch(session);
  }

  private view(session: Session) {
    return {
      id: session.id,
      scenarioId: session.scenarioId,
      stepId: session.stepId,
      startUrl: session.startUrl,
      state: session.state,
      range: session.range,
      error: session.error ?? null,
      startedAt: new Date(session.startedAt).toISOString(),
      actions: tidy(session.actions).map((action) => ({
        id: action.id,
        kind: action.kind,
        label: action.label ?? describeAction(action),
        ...(action.secret ? { secret: true } : {}),
      })),
    };
  }
}

function tabOf(session: Session, page: Page) {
  const index = session.context.pages().indexOf(page);
  return index < 0 ? 0 : index;
}

/**
 * The recording as a step: typing into a field is one fill (repeated fills
 * of the same field keep the last), a click that only focused a field that is
 * then typed into is dropped, and every action gets its description.
 */
export function tidy(actions: UiAction[]): UiAction[] {
  const out: UiAction[] = [];
  const same = (a: UiAction | undefined, b: UiAction) =>
    Boolean(a && a.target && b.target && a.tab === b.tab && JSON.stringify(a.target.candidates[0]) === JSON.stringify(b.target.candidates[0]));
  for (const action of actions) {
    const previous = out[out.length - 1];
    if (action.kind === "fill" && previous?.kind === "fill" && same(previous, action)) {
      out[out.length - 1] = { ...action, id: previous.id };
      continue;
    }
    if (action.kind === "fill" && previous?.kind === "click" && previous.label === "focus" && same(previous, action)) {
      out[out.length - 1] = action;
      continue;
    }
    out.push(action);
  }
  return out.map((action) => {
    const { label, ...rest } = action;
    const kept = label && label !== "focus" ? label : undefined;
    const described = kept ?? describeAction({ ...rest, ...(rest.secret ? { value: SECRET_PLACEHOLDER } : {}) });
    return { ...rest, label: described };
  });
}
