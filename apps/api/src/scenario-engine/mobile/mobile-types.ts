import { z } from "zod";
import { SECRET_PLACEHOLDER } from "../ui/ui-types";
import { LOCATOR_REASONS, MOBILE_STRATEGIES, type MobileLocator } from "./mobile-locators";

/**
 * A mobile step (MOBILE_FLOW): actions recorded on a phone or emulator
 * through Appium and replayed there. Like a UI step, every element is
 * remembered several ways (ranked locators) plus what it looked like, so a
 * replay finds it even when one way no longer works.
 */

export const MOBILE_STEP_TYPE = "MOBILE_FLOW";

export const MOBILE_ACTION_KINDS = ["tap", "type", "clear", "longPress", "swipe", "back", "assertText", "assertVisible", "waitForElement"] as const;
export type MobileActionKind = (typeof MOBILE_ACTION_KINDS)[number];

/** Actions that need an element. */
export const TARGETED_KINDS = new Set<MobileActionKind>(["tap", "type", "clear", "longPress", "assertText", "assertVisible", "waitForElement"]);

export const SWIPE_DIRECTIONS = ["up", "down", "left", "right"] as const;

export type MobileFingerprint = {
  tag: string;
  name?: string;
  text?: string;
  resourceId?: string;
  accessibilityId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
};

export type MobileTarget = {
  candidates: MobileLocator[];
  fingerprint: MobileFingerprint;
  /** Index of the candidate that found the element last time (tried first). */
  learned?: number;
};

export type MobileAction = {
  id: string;
  kind: MobileActionKind;
  target?: MobileTarget;
  /** Text to type or to find in the element; may contain {{variables}}. */
  value?: string;
  /** Typed value is a password or code: stored encrypted (`valueEnc`), never shown. */
  secret?: boolean;
  valueEnc?: string;
  direction?: (typeof SWIPE_DIRECTIONS)[number];
  label?: string;
  optional?: boolean;
};

export type MobileFlowConfig = {
  platform: "android" | "ios";
  /** Appium server, e.g. http://127.0.0.1:4723. */
  serverUrl: string;
  /** Appium capabilities (device, app, automation name …); `appium:` is added where missing. */
  capabilities: Record<string, unknown>;
  actions: MobileAction[];
  /** Per-action wait for the element (ms). */
  actionTimeoutMs?: number;
  /** Start a new Appium session instead of continuing the previous mobile step's. */
  newSession?: boolean;
};

const text = (max: number) => z.string().max(max);

export const MobileLocatorSchema = z.object({
  using: z.enum(MOBILE_STRATEGIES),
  value: text(2000),
  score: z.number().min(0).max(1).optional(),
  unique: z.boolean().optional(),
  matches: z.number().int().min(0).optional(),
  reasons: z.array(z.enum(LOCATOR_REASONS)).max(12).optional(),
});

export const MobileTargetSchema = z.object({
  candidates: z.array(MobileLocatorSchema).max(12),
  fingerprint: z.object({
    tag: text(200),
    name: text(300).optional(),
    text: text(300).optional(),
    resourceId: text(300).optional(),
    accessibilityId: text(300).optional(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  }),
  learned: z.number().int().min(0).max(11).optional(),
});

export const MobileActionSchema = z.object({
  id: text(64),
  kind: z.enum(MOBILE_ACTION_KINDS),
  target: MobileTargetSchema.optional(),
  value: text(10_000).optional(),
  secret: z.boolean().optional(),
  valueEnc: text(20_000).optional(),
  direction: z.enum(SWIPE_DIRECTIONS).optional(),
  label: text(300).optional(),
  optional: z.boolean().optional(),
});

export const MobileFlowConfigSchema = z
  .object({
    platform: z.enum(["android", "ios"]),
    serverUrl: text(2000),
    capabilities: z.record(z.string().max(200), z.unknown()),
    actions: z.array(MobileActionSchema).max(500),
    actionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    newSession: z.boolean().optional(),
  })
  .passthrough();

/** The step's mobile flow, or an error describing what is wrong with it. */
export function readMobileConfig(config: Record<string, unknown>): { ok: true; value: MobileFlowConfig } | { ok: false; error: string } {
  const parsed = MobileFlowConfigSchema.safeParse({ actions: [], capabilities: {}, ...config });
  if (!parsed.success) return { ok: false, error: `Invalid mobile step: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  if (!parsed.data.serverUrl.trim()) return { ok: false, error: "Invalid mobile step: the Appium server URL is required" };
  for (const action of parsed.data.actions) {
    if (TARGETED_KINDS.has(action.kind) && !action.target?.candidates.length) return { ok: false, error: `Invalid mobile step: action "${action.label ?? action.kind}" has no element` };
  }
  return { ok: true, value: parsed.data as MobileFlowConfig };
}

/** Keep typed secrets out of the stored step, as for UI steps: encrypted into `valueEnc`, the old one kept when not retyped. */
export function sealMobileConfig(next: Record<string, unknown>, current: Record<string, unknown> | null, encrypt: (plain: string) => string): Record<string, unknown> {
  const parsed = readMobileConfig(next);
  if (!parsed.ok) throw new Error(parsed.error);
  const previous = new Map((Array.isArray(current?.actions) ? (current!.actions as MobileAction[]) : []).map((action) => [action.id, action]));
  const actions = parsed.value.actions.map((raw) => {
    const action = raw.label?.trim() ? raw : { ...raw, label: describeMobileAction({ ...raw, ...(raw.secret ? { value: SECRET_PLACEHOLDER } : {}) }) };
    if (!action.secret) {
      const { valueEnc: _drop, ...rest } = action;
      return rest;
    }
    const typed = action.value !== undefined && action.value !== "" && action.value !== SECRET_PLACEHOLDER;
    const valueEnc = typed ? encrypt(action.value!) : (previous.get(action.id)?.valueEnc ?? action.valueEnc);
    const { value: _plain, ...rest } = action;
    return { ...rest, ...(valueEnc ? { valueEnc } : {}) };
  });
  return { ...next, actions };
}

/** The step as the client sees it: secret values are never sent back. */
export function publicMobileConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(config.actions)) return config;
  return {
    ...config,
    actions: (config.actions as MobileAction[]).map(({ valueEnc, ...action }) => (action.secret ? { ...action, value: valueEnc ? SECRET_PLACEHOLDER : "" } : action)),
  };
}

/** Readable one-line description of a mobile action. */
export function describeMobileAction(action: Pick<MobileAction, "kind" | "target" | "value" | "secret" | "direction">): string {
  const what = mobileTargetName(action.target);
  const value = action.secret ? SECRET_PLACEHOLDER : (action.value ?? "");
  switch (action.kind) {
    case "tap":
      return `Tap ${what}`;
    case "type":
      return `Type "${value.slice(0, 60)}" into ${what}`;
    case "clear":
      return `Clear ${what}`;
    case "longPress":
      return `Long-press ${what}`;
    case "swipe":
      return `Swipe ${action.direction ?? "up"}`;
    case "back":
      return "Go back";
    case "assertText":
      return `Check ${what} shows "${value.slice(0, 60)}"`;
    case "assertVisible":
      return `Check ${what} is shown`;
    case "waitForElement":
      return `Wait for ${what}`;
  }
}

export function mobileTargetName(target: MobileTarget | undefined): string {
  if (!target) return "the screen";
  const fp = target.fingerprint;
  const name = fp.name || fp.accessibilityId || fp.text || fp.resourceId?.replace(/^.*:id\//, "") || fp.tag.split(".").pop()?.replace("XCUIElementType", "") || "element";
  return `«${name.slice(0, 60)}»`;
}
