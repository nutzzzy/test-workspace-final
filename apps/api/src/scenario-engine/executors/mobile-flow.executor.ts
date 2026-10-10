import type { ExecutionContext, StepExecutionResult, StepExecutor, UiLiveAction, UiLiveProgress } from "../types";
import { AppiumError, openAppiumSession, type AppiumSession } from "../mobile/appium-client";
import { describeLocator, locateOnDevice, MobileLocateError, type MobileLocated } from "../mobile/mobile-locate";
import { perform } from "../mobile/mobile-perform";
import { describeMobileAction, mobileTargetName, readMobileConfig, TARGETED_KINDS, type MobileAction } from "../mobile/mobile-types";
import type { UiLearning } from "./ui-flow.executor";

/** One replayed action, as shown in the step result (same shape as a UI step's). */
export type MobileActionResult = {
  id: string;
  kind: MobileAction["kind"];
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  durationMs: number;
  /** The locator that found the element. */
  how?: string;
  /** Found with another locator than last time: that one is tried first next time. */
  healed?: boolean;
  error?: string;
  /** ELEMENT_NOT_FOUND, AMBIGUOUS_LOCATOR, CHECK_FAILED, APPIUM_<code>. */
  code?: string;
  optional?: boolean;
};

export const MOBILE_SESSION_KEY = "mobile-session";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Larger screenshots are left out of the stored result. */
const MAX_SCREENSHOT_CHARS = 900_000;

type Holder = { current: { key: string; session: AppiumSession } | null };

/**
 * Replays a recorded mobile flow through Appium. Consecutive mobile steps of a
 * run with the same server and capabilities share one Appium session (the app
 * stays where the previous step left it) unless a step asks for a new one; the
 * session ends with the run.
 */
export class MobileFlowExecutor implements StepExecutor {
  readonly type = "MOBILE_FLOW";

  constructor(
    private readonly decrypt: (payload: string) => string,
    private readonly open: typeof openAppiumSession = openAppiumSession,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  async execute(config: Record<string, unknown>, context: ExecutionContext): Promise<StepExecutionResult> {
    const parsed = readMobileConfig(config);
    if (!parsed.ok) return { status: "FAILED", error: parsed.error };
    const flow = parsed.value;
    const timeout = flow.actionTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const live: UiLiveAction[] = flow.actions.map((action) => ({ id: action.id, kind: action.kind, label: action.label || describeMobileAction(action), status: "pending" }));
    let phase: UiLiveProgress["phase"] = "connecting";
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
    report("connecting");

    let session: AppiumSession;
    try {
      const capabilities = context.interpolateDeep(flow.capabilities);
      session = await this.session(context, { serverUrl: flow.serverUrl, platform: flow.platform, capabilities }, flow.newSession === true);
    } catch (error) {
      return { status: "FAILED", error: error instanceof Error ? error.message : "Could not start the Appium session", output: { kind: "mobile", platform: flow.platform, actions: [] } };
    }

    report("actions");
    const results: MobileActionResult[] = [];
    const learned: UiLearning[] = [];
    let failure: string | undefined;
    let cancelled = false;
    for (const action of flow.actions) {
      const label = action.label || describeMobileAction(action);
      if (failure || cancelled || context.isCancelled()) {
        cancelled = cancelled || (!failure && context.isCancelled());
        results.push({ id: action.id, kind: action.kind, label, status: "SKIPPED", durationMs: 0 });
        mark(action.id, "skipped");
        continue;
      }
      mark(action.id, "running");
      const started = Date.now();
      try {
        const value = this.valueOf(action, context);
        let found: MobileLocated | null = null;
        const first = action.target?.learned ?? 0;
        if (TARGETED_KINDS.has(action.kind)) {
          found = await locateOnDevice(session, action.target!.candidates, {
            first,
            timeoutMs: timeout,
            name: mobileTargetName(action.target),
            sleep: this.sleep,
            isCancelled: () => context.isCancelled(),
          });
        }
        await this.retryCheck(action, () => perform(session, action.kind, found?.element ?? null, value, action.direction), timeout);
        const healed = Boolean(found && found.index !== first);
        if (healed) learned.push({ actionId: action.id, candidateIndex: found!.index });
        results.push({
          id: action.id,
          kind: action.kind,
          label,
          status: "PASSED",
          durationMs: Date.now() - started,
          ...(found ? { how: describeLocator(found.locator) } : {}),
          ...(healed ? { healed: true } : {}),
          ...(action.optional ? { optional: true } : {}),
        });
        mark(action.id, "passed");
      } catch (error) {
        const message = error instanceof Error ? error.message : "The action failed";
        results.push({
          id: action.id,
          kind: action.kind,
          label,
          status: "FAILED",
          durationMs: Date.now() - started,
          error: message,
          code: codeOf(error),
          ...(action.optional ? { optional: true } : {}),
        });
        mark(action.id, "failed");
        if (!action.optional) failure = `${label}: ${message}`;
      }
    }

    report("finishing");
    const shot = await session.screenshot().catch(() => null);
    const output = {
      kind: "mobile",
      platform: flow.platform,
      actions: results,
      ...(shot && shot.length <= MAX_SCREENSHOT_CHARS ? { screenshot: `data:image/png;base64,${shot}` } : {}),
    };
    if (cancelled) return { status: "CANCELLED", error: "Cancelled", output, uiLearned: learned };
    return failure ? { status: "FAILED", error: failure, output, uiLearned: learned } : { status: "PASSED", output, uiLearned: learned };
  }

  /** The value an action types or checks: decrypted when secret, {{variables}} filled in. */
  private valueOf(action: MobileAction, context: ExecutionContext): string {
    if (action.secret) {
      if (!action.valueEnc) throw new Error("The secret value of this action is missing; type it again in the step");
      const plain = this.decrypt(action.valueEnc);
      context.markSecret(plain);
      return plain;
    }
    return context.interpolate(action.value ?? "");
  }

  /** Checks wait for the screen to settle: retried until the timeout. */
  private async retryCheck(action: MobileAction, run: () => Promise<void>, timeout: number) {
    if (action.kind !== "assertText" && action.kind !== "assertVisible") return run();
    const deadline = Date.now() + timeout;
    const sleep = this.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof AppiumError || Date.now() + 500 > deadline) throw error;
        await sleep(500);
      }
    }
  }

  /** The run's Appium session for these capabilities: the previous mobile step's, or a new one. */
  private async session(
    context: ExecutionContext,
    input: { serverUrl: string; platform: "android" | "ios"; capabilities: Record<string, unknown> },
    fresh: boolean,
  ): Promise<AppiumSession> {
    const key = JSON.stringify([input.serverUrl, input.platform, input.capabilities]);
    let holder = context.resources.get(MOBILE_SESSION_KEY) as Holder | undefined;
    if (!holder) {
      // dispose() clears the resources before running its handlers: the handler keeps the holder itself.
      const created: Holder = { current: null };
      holder = created;
      context.resources.set(MOBILE_SESSION_KEY, created);
      context.onDispose(async () => {
        const held = created.current;
        created.current = null;
        await held?.session.quit();
      });
    }
    if (holder.current && holder.current.key === key && !fresh) return holder.current.session;
    if (holder.current) {
      await holder.current.session.quit();
      holder.current = null;
    }
    const session = await this.open(input);
    holder.current = { key, session };
    return session;
  }
}

function codeOf(error: unknown): string {
  if (error instanceof MobileLocateError) return error.code;
  if (error instanceof AppiumError) return `APPIUM_${error.code}`;
  if (error instanceof Error && /^(?:Text|Visibility) check failed/.test(error.message)) return "CHECK_FAILED";
  return "ACTION_FAILED";
}
