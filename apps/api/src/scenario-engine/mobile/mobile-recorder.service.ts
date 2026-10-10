import { randomUUID } from "crypto";
import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from "@nestjs/common";
import { SECRET_PLACEHOLDER } from "../ui/ui-types";
import { AppiumError, normalizeServerUrl, openAppiumSession, type AppiumSession } from "./appium-client";
import type { MobilePlatform } from "./mobile-hierarchy";
import { locateOnDevice, MobileLocateError } from "./mobile-locate";
import { captureScreen, type CapturedScreen, type CaptureStage } from "./mobile-screen";
import { perform } from "./mobile-perform";
import { describeMobileAction, MOBILE_ACTION_KINDS, SWIPE_DIRECTIONS, TARGETED_KINDS, type MobileAction } from "./mobile-types";

/**
 * Records mobile steps the way an inspector does: the device's screen (a
 * screenshot and the elements Appium reports on it) is shown in the app; the
 * user picks an element and an action, the action is performed on the device
 * through Appium, recorded, and the screen read again. A recording has its own
 * Appium session, separate from web recordings and from runs.
 */

export const RECORDER_STAGES = ["connect", "validate", "perform", "capture", "hierarchy", "detect", "rank"] as const;
export type RecorderStageId = (typeof RECORDER_STAGES)[number];
export type RecorderStage = { id: RecorderStageId; status: "pending" | "running" | "done" | "failed"; detail?: string };

type Operation = "connect" | "capture" | "action";

type Session = {
  id: string;
  scenarioId: string;
  stepId: string | null;
  platform: MobilePlatform;
  serverUrl: string;
  capabilities: Record<string, unknown>;
  /** connecting → ready ⇄ working → stopped; failed when the Appium session could not start or ended. */
  state: "connecting" | "ready" | "working" | "stopped" | "failed";
  operation: Operation | null;
  stages: RecorderStage[];
  error: string | null;
  /** How the last action found its element (locator used, whether it was the first choice). */
  lastAction: { label: string; how: string; fallback: boolean } | null;
  appium: AppiumSession | null;
  actions: MobileAction[];
  screen: (CapturedScreen & { version: number }) | null;
  startedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

export type ActionRequest = {
  kind?: unknown;
  elementId?: unknown;
  locatorIndex?: unknown;
  value?: unknown;
  secret?: unknown;
  direction?: unknown;
};

const MAX_SESSIONS = 2;
const MAX_ACTIONS = 500;
const IDLE_MS = 30 * 60 * 1000;
/** How long recording waits for the element a user just picked (it is on the screen they see). */
const RECORD_FIND_MS = 5_000;

/** Stages each operation goes through, in order. */
const PLAN: Record<Operation, RecorderStageId[]> = {
  connect: ["connect", "capture", "hierarchy", "detect", "rank"],
  capture: ["capture", "hierarchy", "detect", "rank"],
  action: ["validate", "perform", "capture", "hierarchy", "detect", "rank"],
};

@Injectable()
export class MobileRecorderService implements OnModuleDestroy {
  private readonly logger = new Logger(MobileRecorderService.name);
  private readonly sessions = new Map<string, Session>();
  /** Opens the Appium session (replaced in tests). */
  open: typeof openAppiumSession = openAppiumSession;
  /** Waits between screen reads while the app settles (replaced in tests). */
  sleep?: (ms: number) => Promise<void>;

  /** Start a recording: connect to Appium and read the first screen, in the background. */
  start(input: { scenarioId: string; stepId?: string | null; platform?: unknown; serverUrl?: unknown; capabilities?: unknown }) {
    const platform = input.platform === "ios" ? "ios" : input.platform === "android" ? "android" : null;
    if (!platform) throw new BadRequestException("Choose the platform (Android or iOS)");
    let serverUrl: string;
    try {
      serverUrl = normalizeServerUrl(input.serverUrl);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid Appium server URL");
    }
    const capabilities = input.capabilities;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new BadRequestException("Capabilities must be a JSON object");
    const active = [...this.sessions.values()].filter((session) => session.state !== "stopped" && session.state !== "failed");
    if (active.length >= MAX_SESSIONS) throw new BadRequestException("Another mobile recording is still open; stop it first");

    const session: Session = {
      id: randomUUID(),
      scenarioId: input.scenarioId,
      stepId: input.stepId ?? null,
      platform,
      serverUrl,
      capabilities: capabilities as Record<string, unknown>,
      state: "connecting",
      operation: null,
      stages: [],
      error: null,
      lastAction: null,
      appium: null,
      actions: [],
      screen: null,
      startedAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.touch(session);
    this.begin(session, "connect");
    void this.work(session, async () => {
      this.stage(session, "connect", "running");
      const appium = await this.open({ serverUrl, platform, capabilities: session.capabilities });
      // Stopped or discarded while the session was starting: end it right away.
      if (session.state !== "connecting") {
        await appium.quit();
        return;
      }
      session.appium = appium;
      this.stage(session, "connect", "done");
      await this.capture(session);
    });
    return this.view(session);
  }

  status(id: string) {
    return this.view(this.get(id));
  }

  /** The last captured screen: screenshot, size and elements with their ranked locators. */
  screen(id: string) {
    const session = this.get(id);
    if (!session.screen) throw new BadRequestException("The screen has not been read yet");
    const { root: _root, ...screen } = session.screen;
    return screen;
  }

  /** Read the screen again (after the user changed it by hand, or to retry after an error). */
  refresh(id: string) {
    const session = this.ready(id);
    this.begin(session, "capture");
    void this.work(session, () => this.capture(session));
    return this.view(session);
  }

  /**
   * Perform one action on the device and record it when it worked: the
   * element is found again on the device with the chosen locator (or the next
   * one that matches only it), the action runs, and the screen is read again.
   */
  act(id: string, request: ActionRequest) {
    const session = this.ready(id);
    const kind = MOBILE_ACTION_KINDS.find((item) => item === request.kind);
    if (!kind) throw new BadRequestException("Unknown mobile action");
    if (kind === "back" && session.platform === "ios") throw new BadRequestException("iOS has no back button; tap the app's own back control");
    if (session.actions.length >= MAX_ACTIONS) throw new BadRequestException("The recording has too many actions");
    const value = typeof request.value === "string" ? request.value.slice(0, 10_000) : "";
    if ((kind === "type" || kind === "assertText") && !value) throw new BadRequestException(kind === "type" ? "Enter the text to type" : "Enter the text the element must show");
    const direction = SWIPE_DIRECTIONS.find((item) => item === request.direction) ?? (kind === "swipe" ? "up" : undefined);
    const element = TARGETED_KINDS.has(kind) ? session.screen?.elements.find((item) => item.id === request.elementId) : undefined;
    if (TARGETED_KINDS.has(kind) && !element) throw new BadRequestException("Choose an element on the current screen");
    if (element && !element.locators.length) throw new BadRequestException("No locator finds this element; choose another one");
    const chosen = typeof request.locatorIndex === "number" && Number.isInteger(request.locatorIndex) ? request.locatorIndex : 0;
    const secret = kind === "type" && (request.secret === true || element?.password === true);

    this.begin(session, "action");
    void this.work(session, async () => {
      const appium = session.appium!;
      let found: { element: string; index: number } | null = null;
      if (element) {
        this.stage(session, "validate", "running");
        found = await locateOnDevice(appium, element.locators, { first: chosen, timeoutMs: RECORD_FIND_MS, name: `«${element.name}»` });
        this.stage(session, "validate", "done", found.index === chosen ? undefined : "fallback");
      }
      this.stage(session, "perform", "running");
      await perform(appium, kind, found?.element ?? null, value, direction);
      this.stage(session, "perform", "done");

      const action: MobileAction = {
        id: randomUUID(),
        kind,
        ...(element
          ? {
              target: {
                candidates: element.locators,
                fingerprint: {
                  tag: element.tag,
                  ...(element.name ? { name: element.name.slice(0, 300) } : {}),
                  ...(element.attributes.text && !element.password ? { text: element.attributes.text.slice(0, 300) } : {}),
                  ...(element.attributes["resource-id"] ? { resourceId: element.attributes["resource-id"] } : {}),
                  ...((element.attributes["content-desc"] ?? element.attributes.name) ? { accessibilityId: (element.attributes["content-desc"] ?? element.attributes.name)!.slice(0, 300) } : {}),
                  ...(element.bounds ? { bounds: element.bounds } : {}),
                },
                ...(found && found.index > 0 ? { learned: found.index } : {}),
              },
            }
          : {}),
        ...(kind === "type" || kind === "assertText" ? { value } : {}),
        ...(secret ? { secret: true } : {}),
        ...(kind === "swipe" ? { direction } : {}),
      };
      action.label = describeMobileAction({ ...action, ...(secret ? { value: SECRET_PLACEHOLDER } : {}) });
      session.actions.push(action);
      session.lastAction = found
        ? { label: action.label, how: `${element!.locators[found.index]!.using}: ${element!.locators[found.index]!.value}`, fallback: found.index !== chosen }
        : { label: action.label, how: "", fallback: false };
      await this.capture(session, true);
    });
    return this.view(session);
  }

  /** Drop a recorded action from the list (what it did on the device stays done). */
  removeAction(id: string, actionId: string) {
    const session = this.get(id);
    session.actions = session.actions.filter((action) => action.id !== actionId);
    return this.view(session);
  }

  /** End the Appium session; the recorded actions stay until saved or discarded. */
  async stop(id: string) {
    const session = this.get(id);
    await this.finish(session);
    return this.view(session);
  }

  /** The recorded actions with their typed values, once, for saving into a step. */
  take(id: string) {
    const session = this.get(id);
    if (session.state !== "stopped" && session.state !== "failed") throw new BadRequestException("Stop the recording first");
    this.sessions.delete(id);
    return {
      scenarioId: session.scenarioId,
      stepId: session.stepId,
      platform: session.platform,
      serverUrl: session.serverUrl,
      capabilities: session.capabilities,
      actions: session.actions,
    };
  }

  async discard(id: string) {
    const session = this.sessions.get(id);
    if (!session) return { ok: true };
    await this.finish(session);
    this.sessions.delete(id);
    return { ok: true };
  }

  async onModuleDestroy() {
    await Promise.all([...this.sessions.values()].map((session) => session.appium?.quit()));
  }

  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException("Mobile recording not found");
    return session;
  }

  /** The session, when it can take a new operation now. */
  private ready(id: string) {
    const session = this.get(id);
    if (session.state === "connecting" || session.state === "working") throw new BadRequestException("Wait for the current operation to finish");
    if (session.state !== "ready" || !session.appium) throw new BadRequestException("The recording is not connected to a device");
    this.touch(session);
    return session;
  }

  private begin(session: Session, operation: Operation) {
    session.operation = operation;
    session.error = null;
    if (operation !== "connect") session.state = "working";
    session.stages = PLAN[operation].map((id) => ({ id, status: "pending" }));
  }

  private stage(session: Session, id: RecorderStageId, status: RecorderStage["status"], detail?: string) {
    const stage = session.stages.find((item) => item.id === id);
    if (!stage) return;
    stage.status = status;
    if (detail !== undefined) stage.detail = detail;
    else delete stage.detail;
  }

  /** Run an operation; its failure is shown on the stage it happened in, and the recording goes on when the device still answers. */
  private async work(session: Session, task: () => Promise<void>) {
    try {
      await task();
      if (session.state === "connecting" || session.state === "working") session.state = "ready";
    } catch (error) {
      if (session.state === "stopped") return;
      const running = session.stages.find((item) => item.status === "running") ?? session.stages.find((item) => item.status === "pending");
      if (running) running.status = "failed";
      session.error = messageOf(error);
      const gone = error instanceof AppiumError && (error.code === "SESSION_GONE" || error.code === "UNREACHABLE" || error.code === "SESSION_FAILED" || error.code === "INVALID_SERVER");
      if (session.state === "connecting" || gone || !session.appium) {
        session.state = "failed";
        await session.appium?.quit();
      } else if (session.state === "working") {
        session.state = "ready";
      }
      this.logger.warn(`Mobile recording ${session.id}: ${session.error}`);
    } finally {
      session.operation = null;
    }
  }

  /** Read the screen; `afterAction`: wait for it to stop changing first. */
  private async capture(session: Session, afterAction = false) {
    const screen = await captureScreen(session.appium!, session.platform, (stage: CaptureStage, status, detail) => this.stage(session, stage, status, detail), {
      settle: afterAction,
      sleep: this.sleep,
    });
    session.screen = { ...screen, version: (session.screen?.version ?? 0) + 1 };
  }

  private async finish(session: Session) {
    clearTimeout(session.idleTimer);
    if (session.state !== "failed") session.state = "stopped";
    const appium = session.appium;
    session.appium = null;
    await appium?.quit();
  }

  private touch(session: Session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.logger.warn(`Mobile recording ${session.id} was idle for 30 minutes; closing it`);
      void this.finish(session).catch(() => undefined);
    }, IDLE_MS);
    session.idleTimer.unref?.();
  }

  private view(session: Session) {
    return {
      id: session.id,
      scenarioId: session.scenarioId,
      stepId: session.stepId,
      platform: session.platform,
      serverUrl: session.serverUrl,
      state: session.state,
      operation: session.operation,
      stages: session.stages.map((stage) => ({ ...stage })),
      error: session.error,
      lastAction: session.lastAction,
      screenVersion: session.screen?.version ?? 0,
      startedAt: new Date(session.startedAt).toISOString(),
      actions: session.actions.map((action) => ({ id: action.id, kind: action.kind, label: action.label ?? describeMobileAction(action), ...(action.secret ? { secret: true } : {}) })),
    };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof AppiumError || error instanceof MobileLocateError) return error.message;
  return error instanceof Error ? error.message.split("\n")[0]!.slice(0, 400) : "The mobile action failed";
}
