import { z } from "zod";
import { SessionConfigSchema, type SessionConfig } from "./browser-session";

/**
 * A UI step (UI_FLOW): actions recorded in a real browser and replayed in a
 * headless one. Every element is remembered several ways (test id, role and
 * name, label, placeholder, name, text, CSS) plus a fingerprint, so a replay
 * finds it even after the page changed a little — and remembers which way
 * worked for next time.
 */

export const UI_ACTION_KINDS = [
  "navigate",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "upload",
  "waitForElement",
  "waitForText",
  "assertText",
  "assertUrl",
] as const;
export type UiActionKind = (typeof UI_ACTION_KINDS)[number];

export const LOCATOR_KINDS = ["testid", "id", "role", "label", "placeholder", "name", "text", "css", "xpath"] as const;
export type LocatorKind = (typeof LOCATOR_KINDS)[number];

export type LocatorCandidate = {
  kind: LocatorKind;
  /** CSS selector (testid/id/name/css), role (role), or visible text (label/placeholder/text). */
  value: string;
  /** Accessible name, for role locators. */
  name?: string;
  /** It matched exactly one element when recorded. */
  unique?: boolean;
  /** 0–1: how likely it finds the same element on a later version of the page (uniqueness, meaning, stability). */
  confidence?: number;
};

/**
 * Where an element in a repeated structure (table, list, grid, cards) lives:
 * the container, the row the user acted in — identified by what is in it,
 * not by its position — and the element inside that row.
 */
export type RowIdentity =
  | { strategy: "attr"; attr: string; value: string }
  | { strategy: "href"; value: string }
  | { strategy: "cell"; column?: string; columnIndex?: number; value: string }
  | { strategy: "text"; value: string }
  | { strategy: "index"; index: number };

export type RowScope = {
  kind: "row";
  /** The table / list / grid: its role and accessible name or caption, when it has them. */
  container?: { role?: string; name?: string; css?: string };
  /** CSS selecting the rows inside the container (tr, [role=row], li, or the repeated item). */
  rowSelector: string;
  /** Ways to recognise the row, most stable first; together they identify exactly one row. */
  identity: RowIdentity[];
  /** The element inside the row. */
  target: LocatorCandidate[];
  /** Rows when recorded (diagnostics). */
  rowCount?: number;
  /** The row's own text when recorded, shortened (diagnostics and AI fallback). */
  rowText?: string;
};

/** What the element looked like, for finding it again when every locator fails. */
export type ElementFingerprint = {
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  classes?: string[];
};

export type UiTarget = {
  candidates: LocatorCandidate[];
  fingerprint: ElementFingerprint;
  /** Index of the candidate that found the element last time (tried first). */
  learned?: number;
  /** Set when the element is inside a repeated structure: resolve the row first, then the element in it. */
  scope?: RowScope;
  /** The named region around the element (dialog, form, section, landmark): used when a locator matches several. */
  context?: { role?: string; name?: string };
};

export type UiAction = {
  id: string;
  kind: UiActionKind;
  target?: UiTarget;
  /** Text to type, option to select, key to press, text or URL part to check; may contain {{variables}}. */
  value?: string;
  /** Typed value is a password/secret: stored encrypted (`valueEnc`), never shown. */
  secret?: boolean;
  valueEnc?: string;
  /** Option label for a select (fallback when the value changed). */
  optionLabel?: string;
  /** Page URL when recorded (navigate: the URL to open). */
  url?: string;
  /** Browser tab the action happened in (0 = first). */
  tab?: number;
  /** URL of the frame, when the element is inside an iframe. */
  frameUrl?: string;
  /** A failure of this action does not fail the step. */
  optional?: boolean;
  /** Human description, e.g. Click «Sign in». */
  label?: string;
  /** Upload: the files chosen when recorded (names and types only; contents are not stored). */
  files?: Array<{ name: string; type?: string }>;
  /** The typed value looks generated (uuid, timestamp, random id): consider a {{variable}} or {{$uuid}}/{{$timestamp}}. */
  dynamicValue?: "uuid" | "timestamp" | "random";
  /** Legacy actions: one CSS selector instead of a target; replayed as such, migrated when the step is saved. */
  selector?: string;
};

export type UiFlowConfig = {
  startUrl: string;
  actions: UiAction[];
  /** Per-action wait for the element (ms). */
  actionTimeoutMs?: number;
  viewport?: { width: number; height: number };
  /** Start from an empty browser instead of continuing the previous UI step's session. */
  newSession?: boolean;
  /** Fail when an error message appears on the page after the last action. */
  failOnPageError?: boolean;
  /** Start signed in with what earlier steps obtained (cookies, credential headers, storage). */
  session?: SessionConfig;
};

const text = (max: number) => z.string().max(max);

export const LocatorCandidateSchema = z.object({
  kind: z.enum(LOCATOR_KINDS),
  value: text(1000),
  name: text(300).optional(),
  unique: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const RowIdentitySchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("attr"), attr: text(100), value: text(500) }),
  z.object({ strategy: z.literal("href"), value: text(2000) }),
  z.object({ strategy: z.literal("cell"), column: text(200).optional(), columnIndex: z.number().int().min(0).max(200).optional(), value: text(500) }),
  z.object({ strategy: z.literal("text"), value: text(500) }),
  z.object({ strategy: z.literal("index"), index: z.number().int().min(0).max(10_000) }),
]);

export const RowScopeSchema = z.object({
  kind: z.literal("row"),
  container: z.object({ role: text(40).optional(), name: text(300).optional(), css: text(1000).optional() }).optional(),
  rowSelector: text(500),
  identity: z.array(RowIdentitySchema).max(6),
  target: z.array(LocatorCandidateSchema).max(8),
  rowCount: z.number().int().min(0).optional(),
  rowText: text(300).optional(),
});

export const FingerprintSchema = z.object({
  tag: text(40),
  type: text(40).optional(),
  role: text(40).optional(),
  text: text(300).optional(),
  name: text(200).optional(),
  id: text(200).optional(),
  placeholder: text(200).optional(),
  ariaLabel: text(300).optional(),
  classes: z.array(text(120)).max(12).optional(),
});

export const UiTargetSchema = z.object({
  candidates: z.array(LocatorCandidateSchema).max(12),
  fingerprint: FingerprintSchema,
  learned: z.number().int().min(0).max(11).optional(),
  scope: RowScopeSchema.optional(),
  context: z.object({ role: text(40).optional(), name: text(300).optional() }).optional(),
});

export const UiActionSchema = z.object({
  id: text(64),
  kind: z.enum(UI_ACTION_KINDS),
  target: UiTargetSchema.optional(),
  value: text(10_000).optional(),
  secret: z.boolean().optional(),
  valueEnc: text(20_000).optional(),
  optionLabel: text(300).optional(),
  url: text(4000).optional(),
  tab: z.number().int().min(0).max(20).optional(),
  frameUrl: text(4000).optional(),
  optional: z.boolean().optional(),
  label: text(300).optional(),
  files: z.array(z.object({ name: text(300), type: text(200).optional() })).max(20).optional(),
  dynamicValue: z.enum(["uuid", "timestamp", "random"]).optional(),
  selector: text(2000).optional(),
});

export const UiFlowConfigSchema = z
  .object({
    startUrl: text(4000),
    actions: z.array(UiActionSchema).max(500),
    actionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).optional(),
    newSession: z.boolean().optional(),
    failOnPageError: z.boolean().optional(),
    session: SessionConfigSchema.optional(),
  })
  .passthrough();

/** The step's UI flow, or an error describing what is wrong with it. Legacy `selector` actions get a target. */
export function readUiConfig(config: Record<string, unknown>): { ok: true; value: UiFlowConfig } | { ok: false; error: string } {
  const parsed = UiFlowConfigSchema.safeParse({ actions: [], ...config });
  if (!parsed.success) return { ok: false, error: `Invalid UI step: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  if (!parsed.data.startUrl.trim()) return { ok: false, error: "Invalid UI step: start URL is required" };
  return { ok: true, value: { ...(parsed.data as UiFlowConfig), actions: (parsed.data.actions as UiAction[]).map(migrateLegacy) } };
}

/**
 * An action saved before targets existed carries one CSS (or XPath) selector.
 * It becomes a target with that selector as its only, low-confidence locator:
 * replayed exactly as before, and re-recording it gives it semantic locators.
 */
export function migrateLegacy(action: UiAction): UiAction {
  if (action.target || !action.selector) return action;
  const xpath = /^(\/\/|\(\/\/|xpath=)/.test(action.selector);
  const { selector, ...rest } = action;
  return {
    ...rest,
    target: {
      candidates: [{ kind: xpath ? "xpath" : "css", value: selector.replace(/^xpath=/, ""), confidence: xpath ? 0.2 : 0.3 }],
      fingerprint: { tag: "*" },
    },
  };
}

/** Shown instead of a secret typed value. */
export const SECRET_PLACEHOLDER = "••••••";

/**
 * Keep typed secrets out of the stored step: a secret action's value is
 * encrypted into `valueEnc`. A secret action that comes back without a new
 * value (the client never sees the old one) keeps the stored ciphertext.
 */
export function sealUiConfig(
  next: Record<string, unknown>,
  current: Record<string, unknown> | null,
  encrypt: (plain: string) => string,
): Record<string, unknown> {
  const parsed = readUiConfig(next);
  if (!parsed.ok) throw new Error(parsed.error);
  const previous = new Map(
    (Array.isArray(current?.actions) ? (current!.actions as UiAction[]) : []).map((action) => [action.id, action]),
  );
  const actions = parsed.value.actions.map((raw) => {
    // Every action has a readable description (recorded ones already do).
    const action = raw.label?.trim() ? raw : { ...raw, label: describeAction({ ...raw, ...(raw.secret ? { value: SECRET_PLACEHOLDER } : {}) }) };
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
export function publicUiConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(config.actions)) return config;
  return {
    ...config,
    actions: (config.actions as UiAction[]).map(({ valueEnc, ...action }) =>
      action.secret ? { ...action, value: valueEnc ? SECRET_PLACEHOLDER : "" } : action,
    ),
  };
}

/** Readable one-line description of an action. */
export function describeAction(action: Pick<UiAction, "kind" | "target" | "value" | "secret" | "url" | "optionLabel">): string {
  const what = targetName(action.target);
  const value = action.secret ? SECRET_PLACEHOLDER : (action.value ?? "");
  switch (action.kind) {
    case "navigate":
      return `Open ${action.url ?? value}`;
    case "click":
      return `Click ${what}`;
    case "fill":
      return `Type "${value.slice(0, 60)}" into ${what}`;
    case "select":
      return `Select "${action.optionLabel ?? value}" in ${what}`;
    case "check":
      return `Check ${what}`;
    case "uncheck":
      return `Uncheck ${what}`;
    case "press":
      return `Press ${value}${action.target ? ` in ${what}` : ""}`;
    case "hover":
      return `Hover over ${what}`;
    case "upload":
      return `Upload a file into ${what}`;
    case "waitForElement":
      return `Wait for ${what}`;
    case "waitForText":
      return `Wait for "${value.slice(0, 60)}"`;
    case "assertText":
      return `Check the page shows "${value.slice(0, 60)}"`;
    case "assertUrl":
      return `Check the URL contains "${value.slice(0, 80)}"`;
  }
}

export function targetName(target: UiTarget | undefined): string {
  if (!target) return "the page";
  // In a row: «Edit» in the row «Sara».
  if (target.scope) {
    const inner = target.scope.target.find((candidate) => candidate.kind === "role" && candidate.name)?.name ?? target.scope.target[0]?.value ?? target.fingerprint.text ?? "";
    const row = target.scope.identity.find((item) => item.strategy !== "index");
    const rowName = row && "value" in row ? row.value : `#${((target.scope.identity[0] as { index?: number } | undefined)?.index ?? 0) + 1}`;
    return `«${String(inner).slice(0, 40)}» in row «${String(rowName).slice(0, 40)}»`;
  }
  const role = target.candidates.find((candidate) => candidate.kind === "role" && candidate.name);
  const label = target.candidates.find((candidate) => candidate.kind === "label" || candidate.kind === "placeholder");
  const textCandidate = target.candidates.find((candidate) => candidate.kind === "text");
  const name = role?.name ?? label?.value ?? textCandidate?.value ?? target.fingerprint.ariaLabel ?? target.fingerprint.text ?? target.fingerprint.name ?? target.fingerprint.tag;
  return `«${String(name).slice(0, 60)}»`;
}
