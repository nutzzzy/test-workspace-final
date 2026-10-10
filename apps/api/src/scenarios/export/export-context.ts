import type { ExportContext, ExportLocator, ExportMobileAction, ExportStep, ExportUiAction } from "@qa-workbench/shared";
import { isSecretKey, maskDeep } from "../../common/mask.util";
import type { LocatorCandidate, RowIdentity, UiAction, UiTarget } from "../../scenario-engine/ui/ui-types";
import { SECRET_PLACEHOLDER, describeAction, readUiConfig } from "../../scenario-engine/ui/ui-types";
import { rankMobileLocators } from "../../scenario-engine/mobile/mobile-locators";
import { MOBILE_STEP_TYPE, describeMobileAction, readMobileConfig, type MobileAction } from "../../scenario-engine/mobile/mobile-types";

/**
 * The compact, self-contained description of a precondition that an export
 * sends to the AI: steps in order with what each does, the reliable locators
 * of every element, and nothing else — no run history, recorder fingerprints,
 * learned state or secret values. Secrets become environment-variable names.
 */

type StepRow = { id: string; name: string; type: string; orderIndex: number; enabled: boolean; config: unknown };
export type ExportSource = {
  id: string;
  name: string;
  description: string;
  stopOnFailure: boolean;
  environment?: { name: string } | null;
  steps: StepRow[];
};

/** Locators kept per element: the best few are enough to convert, more only cost tokens. */
const MAX_LOCATORS = 3;
const MAX_BODY_CHARS = 2_000;

/**
 * `stepId`: export that one step on its own (enabled or not). The context
 * then carries a `scope` — the step's place, the values it needs as inputs,
 * whether it continues an earlier step's browser or app session — and is
 * named after the step.
 */
export function buildExportContext(source: ExportSource, connectorTypes: Map<string, string> = new Map(), options: { stepId?: string } = {}): ExportContext {
  const ordered = [...source.steps].sort((a, b) => a.orderIndex - b.orderIndex);
  if (options.stepId) return buildStepContext(source, ordered, connectorTypes, options.stepId);
  const enabled = ordered.filter((step) => step.enabled);
  const secretNames = new Set<string>();
  const steps = enabled.map((step) => exportStep(step, ordered, connectorTypes, secretNames)).filter((step): step is ExportStep => Boolean(step));
  const context: ExportContext = {
    preconditionId: source.id,
    name: source.name,
    ...(source.description.trim() ? { description: source.description.trim().slice(0, 500) } : {}),
    url: firstUrl(steps),
    steps,
    variables: [],
    metadata: {
      ...(source.environment?.name ? { environment: source.environment.name } : {}),
      stopOnFailure: source.stopOnFailure,
      ...(ordered.length > enabled.length ? { disabledStepsLeftOut: ordered.length - enabled.length } : {}),
    },
  };
  context.variables = externalVariables(context);
  return context;
}

function buildStepContext(source: ExportSource, ordered: StepRow[], connectorTypes: Map<string, string>, stepId: string): ExportContext {
  const position = ordered.findIndex((item) => item.id === stepId);
  const step = ordered[position];
  if (!step) throw new Error("Step not found");
  const exported = exportStep(step, ordered, connectorTypes, new Set());
  const steps = exported ? [exported] : [];
  // A UI or mobile step continues the session of an earlier enabled step of its kind unless it starts a new one.
  const sessionKind = step.type === "UI_FLOW" || step.type === MOBILE_STEP_TYPE ? step.type : null;
  const continuesSession =
    Boolean(sessionKind) && asRecord(step.config).newSession !== true && ordered.slice(0, position).some((item) => item.enabled && item.type === sessionKind);
  const context: ExportContext = {
    preconditionId: source.id,
    name: step.name,
    url: firstUrl(steps),
    steps,
    variables: [],
    metadata: {
      ...(source.environment?.name ? { environment: source.environment.name } : {}),
      stopOnFailure: source.stopOnFailure,
    },
  };
  context.variables = externalVariables(context);
  context.scope = {
    kind: "step",
    step: step.name,
    precondition: source.name,
    position: position + 1,
    total: ordered.length,
    inputs: [...context.variables, ...steps.flatMap(secretInputs)],
    ...(continuesSession ? { continuesSession: true } : {}),
  };
  return context;
}

/** Secret values a step reads from the environment: inputs of a single-step export too. */
function secretInputs(step: ExportStep): string[] {
  if (step.type === "ui" || step.type === "mobile") return step.actions.flatMap((action) => (action.secretEnv ? [action.secretEnv] : []));
  return [];
}

function exportStep(step: StepRow, all: StepRow[], connectorTypes: Map<string, string>, secretNames: Set<string>): ExportStep | null {
  const config = asRecord(step.config);
  const name = step.name;
  switch (step.type) {
    case "UI_FLOW": {
      const parsed = readUiConfig(config);
      if (!parsed.ok) return null;
      return {
        type: "ui",
        name,
        startUrl: parsed.value.startUrl,
        ...(parsed.value.newSession ? { newSession: true } : {}),
        actions: parsed.value.actions.map((action) => exportAction(action, secretNames)),
      };
    }
    case MOBILE_STEP_TYPE: {
      const parsed = readMobileConfig(config);
      if (!parsed.ok) return null;
      return {
        type: "mobile",
        name,
        platform: parsed.value.platform,
        server: withoutCredentials(parsed.value.serverUrl),
        capabilities: maskCapabilities(parsed.value.capabilities),
        ...(parsed.value.newSession ? { newSession: true } : {}),
        actions: parsed.value.actions.map((action) => exportMobileAction(action, secretNames)),
      };
    }
    case "HTTP_REQUEST": {
      const headers = stringRecord(maskHeaders(config.headers));
      const query = stringRecord(maskDeep(config.query));
      const body = compactBody(maskDeep(config.body));
      const expectStatus = (Array.isArray(config.expectedStatus) ? config.expectedStatus : [config.expectedStatus])
        .map(Number)
        .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
      const extract = Object.fromEntries(
        (Array.isArray(config.extract) ? (config.extract as Array<Record<string, unknown>>) : [])
          .filter((item) => typeof item.variable === "string" && item.variable)
          .map((item) => [String(item.variable), `${item.from && item.from !== "body" ? `${String(item.from)}:` : ""}${String(item.path ?? "")}`]),
      );
      const uses = Object.fromEntries(
        (Array.isArray(config.bindings) ? (config.bindings as Array<Record<string, unknown>>) : [])
          .filter((binding) => binding.enabled !== false)
          .map((binding) => {
            const target = asRecord(binding.target);
            const from = asRecord(binding.source);
            const field = inputName(target, String(config.url ?? ""));
            if (typeof from.value === "string") return [field, isSecretKey(String(target.field ?? "")) ? "***" : from.value];
            const source = all.find((item) => item.id === from.stepId);
            const stepLabel = source ? `step "${source.name}"` : typeof from.stepName === "string" ? `step "${from.stepName}"` : "an earlier step";
            const path = typeof from.path === "string" && from.path ? from.path : `the ${String(asRecord(from.expect).key ?? "value")} it returns`;
            return [field, `${stepLabel} ${path}`];
          }),
      );
      return {
        type: "http",
        name,
        method: String(config.method ?? "GET").toUpperCase(),
        url: String(maskDeep(String(config.url ?? ""))),
        ...(headers ? { headers } : {}),
        ...(query ? { query } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(expectStatus.length ? { expectStatus } : {}),
        ...(Object.keys(extract).length ? { extract } : {}),
        ...(Object.keys(uses).length ? { uses } : {}),
      };
    }
    case "ASSERTION":
      return {
        type: "assert",
        name,
        check: String(config.kind ?? "equals"),
        ...(config.path ? { path: String(config.path) } : {}),
        ...(config.expected !== undefined ? { expected: maskDeep(config.expected) } : {}),
      };
    case "DATABASE_ACTION": {
      const database = connectorTypes.get(String(config.connectorId ?? ""));
      const expect = config.assertion ? `${String(config.assertion)}${config.expected ? ` ${String(config.expected)}` : ""}` : undefined;
      return {
        type: "db",
        name,
        operation: String(config.operation ?? "SELECT"),
        query: String(config.query ?? ""),
        ...(database ? { database } : {}),
        ...(expect ? { expect } : {}),
      };
    }
    case "DELAY":
      return { type: "delay", name, ms: Number(config.ms ?? 0) || 0 };
    case "SET_VARIABLE":
      return { type: "setVar", name, variable: String(config.variable ?? ""), value: isSecretKey(String(config.variable ?? "")) ? "***" : maskDeep(config.value) };
    case "EXTRACT_VARIABLE":
      return { type: "extractVar", name, variable: String(config.variable ?? ""), path: String(config.path ?? "") };
    case "CONDITION":
      return { type: "condition", name, left: String(config.left ?? ""), op: String(config.op ?? "equals"), right: String(config.right ?? "") };
    default:
      return null;
  }
}

function exportAction(action: UiAction, secretNames: Set<string>): ExportUiAction {
  const out: ExportUiAction = { do: action.kind };
  // A label the user wrote says something the locators do not; the generated description only repeats them.
  if (action.label && action.label !== describeAction({ ...action, ...(action.secret ? { value: SECRET_PLACEHOLDER } : {}) })) out.label = action.label;
  if (action.kind === "navigate" && action.url) out.url = action.url;
  if (action.secret) {
    out.secretEnv = secretEnvName(action, secretNames);
  } else if (action.value !== undefined && action.value !== "") {
    out.value = action.value;
  }
  if (action.optionLabel && action.optionLabel !== action.value) out.option = action.optionLabel;
  if (action.target) Object.assign(out, exportTarget(action.target));
  if (action.frameUrl) out.frameUrl = action.frameUrl;
  if (action.tab) out.tab = action.tab;
  if (action.optional) out.optional = true;
  if (action.files?.length) out.files = action.files.map((file) => file.name);
  return out;
}

function exportMobileAction(action: MobileAction, secretNames: Set<string>): ExportMobileAction {
  const out: ExportMobileAction = { do: action.kind };
  if (action.label && action.label !== describeMobileAction({ ...action, ...(action.secret ? { value: SECRET_PLACEHOLDER } : {}) })) out.label = action.label;
  if (action.secret) {
    const fp = action.target?.fingerprint;
    out.secretEnv = uniqueEnvName([fp?.resourceId?.replace(/^.*:id\//, ""), fp?.accessibilityId, fp?.name, "password"], secretNames);
  } else if (action.value !== undefined && action.value !== "") {
    out.value = action.value;
  }
  if (action.target) {
    // The locator that worked last time first, then the ranking; one that matched several elements only when nothing else is left.
    const candidates = action.target.candidates;
    const learned = action.target.learned !== undefined ? candidates[action.target.learned] : undefined;
    const ranked = [...(learned ? [learned] : []), ...rankMobileLocators(candidates).filter((item) => item !== learned)];
    const unique = ranked.filter((item) => item.unique !== false);
    out.locators = (unique.length ? unique : ranked).slice(0, MAX_LOCATORS).map((item) => ({ using: item.using, value: item.value }));
  }
  if (action.kind === "swipe") out.direction = action.direction ?? "up";
  if (action.optional) out.optional = true;
  return out;
}

/** Device-cloud credentials in capabilities (BrowserStack, Sauce Labs, LambdaTest: accessKey). */
const CAPABILITY_SECRET = /^(?:accesskey|.*apikey|.*authkey)$/;

/**
 * Capabilities with secret values masked, nested vendor options
 * (`bstack:options`) included; `appium:accessKey` is judged by its name
 * without the vendor prefix.
 */
function maskCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => {
      const bare = key.split(":").pop() ?? key;
      const secret = isSecretKey(bare) || CAPABILITY_SECRET.test(bare.replace(/[-_\s]/g, "").toLowerCase());
      if (secret && (typeof value === "string" || typeof value === "number")) return [key, "***"];
      if (value && typeof value === "object" && !Array.isArray(value)) return [key, maskCapabilities(value as Record<string, unknown>)];
      return [key, maskDeep(value)];
    }),
  );
}

/** The server URL without user name or password (Appium cloud URLs carry keys there). */
function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function exportTarget(target: UiTarget): Pick<ExportUiAction, "locators" | "row" | "within"> {
  const out: Pick<ExportUiAction, "locators" | "row" | "within"> = {};
  if (target.scope) {
    out.row = {
      ...(target.scope.container ? { container: describeContainer(target.scope.container) } : {}),
      rowSelector: target.scope.rowSelector,
      match: target.scope.identity.map(describeIdentity),
      target: rankLocators(target.scope.target),
    };
  } else {
    const ranked = rankLocators(target.candidates, target.learned);
    if (ranked.length) out.locators = ranked;
    else {
      // Nothing reliable was recorded: describe the element so the AI can pick a semantic locator.
      const fp = target.fingerprint;
      const hint: ExportLocator[] = [];
      if (fp.role) hint.push(fp.text ? { role: fp.role, name: fp.text } : { role: fp.role });
      if (fp.ariaLabel) hint.push({ label: fp.ariaLabel });
      if (fp.placeholder) hint.push({ placeholder: fp.placeholder });
      if (!fp.role && fp.text) hint.push({ text: fp.text });
      out.locators = hint.length ? hint : rankLocators(target.candidates, target.learned, true);
    }
  }
  if (target.context?.name || target.context?.role) out.within = [target.context.role, target.context.name && `"${target.context.name}"`].filter(Boolean).join(" ");
  return out;
}

const PREFERENCE: Record<LocatorCandidate["kind"], number> = { testid: 0, role: 1, label: 2, placeholder: 3, id: 4, name: 5, text: 6, css: 7, xpath: 8 };

/**
 * Stable locators first (test id, role + name, label, placeholder), each as
 * `kind:value`. Fragile ones (positional CSS, generated ids or classes,
 * absolute XPath) are dropped unless nothing else exists.
 */
export function rankLocators(candidates: LocatorCandidate[], learned?: number, keepFragile = false): ExportLocator[] {
  const indexed = candidates.map((candidate, index) => ({ candidate, index }));
  const usable = indexed.filter(({ candidate }) => keepFragile || !isFragile(candidate));
  usable.sort((a, b) => {
    // The locator that found the element last time stays first among equally stable ones.
    const score = (item: typeof a) => PREFERENCE[item.candidate.kind] - (item.index === learned ? 0.5 : 0) - (item.candidate.confidence ?? 0.5) * 0.1;
    return score(a) - score(b);
  });
  const out: ExportLocator[] = [];
  const seen = new Set<string>();
  for (const { candidate } of usable) {
    const locator = formatLocator(candidate);
    const key = JSON.stringify(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(locator);
    if (out.length >= MAX_LOCATORS) break;
  }
  return out;
}

export function isFragile(candidate: LocatorCandidate): boolean {
  const value = candidate.value;
  if (candidate.kind === "xpath") return /^\/(?!\/)|^\(?\/html|\[\d+\]/.test(value);
  if (candidate.kind === "css") {
    if (/:nth-(?:child|of-type)|:eq\(|:first-child|:last-child/.test(value)) return true;
    if (/\.(?:css|sc|jss|emotion|makeStyles)-[\w-]*|\.[a-z]+_[A-Za-z0-9]{5,}\b|\.[a-zA-Z]*[0-9a-f]{6,}\b/.test(value)) return true;
    return value.split(">").length > 3;
  }
  if (candidate.kind === "id") return looksGenerated(value.replace(/^#/, ""));
  return false;
}

function looksGenerated(id: string) {
  return /^:r[0-9a-z]+:$|^(?:ember|ext-gen|react-select-|mui-|radix-|headlessui-)\d*|[0-9a-f]{8,}|\d{4,}|^[a-z]{0,3}\d+$/i.test(id.replace(/\\/g, ""));
}

function formatLocator(candidate: LocatorCandidate): ExportLocator {
  switch (candidate.kind) {
    case "role":
      return candidate.name ? { role: candidate.value, name: candidate.name } : { role: candidate.value };
    case "testid": {
      // Recorded as a CSS selector; the attribute matters (data-test, data-cy, …).
      const match = /^\[([\w-]+)=["']?([^"'\]]+)["']?\]$/.exec(candidate.value);
      if (!match) return { css: candidate.value };
      return match[1] === "data-testid" ? { testid: match[2] } : { testid: match[2], attr: match[1] };
    }
    case "label":
      return { label: candidate.value };
    case "placeholder":
      return { placeholder: candidate.value };
    case "text":
      return { text: candidate.value };
    case "xpath":
      return { xpath: candidate.value };
    default:
      // id, name and css are recorded as CSS selectors.
      return { css: candidate.value };
  }
}

function describeContainer(container: { role?: string; name?: string; css?: string }) {
  return [container.role, container.name && `"${container.name}"`, !container.role && !container.name ? container.css : undefined].filter(Boolean).join(" ");
}

function describeIdentity(identity: RowIdentity): string {
  switch (identity.strategy) {
    case "attr":
      return `[${identity.attr}="${identity.value}"]`;
    case "href":
      return `link ${identity.value}`;
    case "cell":
      return identity.column ? `${identity.column} = ${identity.value}` : identity.value;
    case "text":
      return identity.value;
    case "index":
      return `row #${identity.index + 1}`;
  }
}

/** An environment-variable name for a typed secret, from the field's name, label or type (e.g. PASSWORD, OTP_DIGIT_1). */
function secretEnvName(action: UiAction, used: Set<string>): string {
  const target = action.target;
  const fp = target?.fingerprint;
  const hints = [
    fp?.name,
    target?.candidates.find((item) => item.kind === "label")?.value,
    target?.candidates.find((item) => item.kind === "placeholder")?.value ?? fp?.placeholder,
    fp?.ariaLabel,
    fp?.type === "password" ? "password" : undefined,
  ];
  return uniqueEnvName(hints, used);
}

/** The first hint usable as an environment-variable name, made unique among those already used. */
function uniqueEnvName(hints: Array<string | undefined>, used: Set<string>): string {
  const base =
    hints
      .map((hint) => (hint ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30))
      .find((hint) => /[A-Z]/.test(hint)) ?? "SECRET";
  const first = /^[A-Z]/.test(base) ? base : `SECRET_${base}`;
  let name = first;
  for (let n = 2; used.has(name); n += 1) name = `${first}_${n}`;
  used.add(name);
  return name;
}

/** Credential headers are masked, but their scheme (Bearer, Basic, …) and {{variables}} stay: they change the code. */
function maskHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return maskDeep(headers);
  const masked = maskDeep(headers) as Record<string, unknown>;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== "string" || !isSecretKey(key)) continue;
    const scheme = /^(Bearer|Basic|Token|JWT|Digest)\s+/i.exec(value.trim())?.[1];
    const rest = scheme ? value.trim().slice(scheme.length).trim() : value.trim();
    const template = /^\{\{\s*[\w.$-]+\s*\}\}$/.test(rest);
    masked[key] = `${scheme ? `${scheme} ` : ""}${template ? rest : "***"}`;
  }
  return masked;
}

/** The request input a mapping fills: header.authorization, query.page, or the URL path segment it replaces. */
function inputName(target: Record<string, unknown>, url: string): string {
  const location = String(target.location ?? "");
  const field = String(target.field ?? target.key ?? "");
  if (location === "path") {
    try {
      const segment = new URL(url.replace(/\{\{[^}]+\}\}/g, "x")).pathname.split("/")[Number(field)];
      if (segment) return `path "${decodeURIComponent(segment)}"`;
    } catch {
      // not a full URL: fall back to the stored field
    }
  }
  return `${location}.${field}`;
}

function firstUrl(steps: ExportStep[]): string | undefined {
  for (const step of steps) {
    if (step.type === "ui" && step.startUrl) return step.startUrl;
    if (step.type === "http" && step.url) return step.url;
  }
  return undefined;
}

/** {{variables}} used somewhere but produced by no step: they come from configuration. */
function externalVariables(context: ExportContext): string[] {
  const text = JSON.stringify(context.steps);
  const used = new Set([...text.matchAll(/\{\{\s*([A-Za-z_$][\w.$-]*)\s*\}\}/g)].map((match) => match[1]!));
  for (const step of context.steps) {
    if (step.type === "http") for (const name of Object.keys(step.extract ?? {})) used.delete(name);
    if (step.type === "setVar" || step.type === "extractVar") used.delete(step.variable);
  }
  return [...used].filter((name) => !name.startsWith("$")).sort();
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** The request body, shortened when large (the AI needs its shape and values, not megabytes). */
function compactBody(body: unknown): unknown {
  if (body === undefined || body === null || body === "") return undefined;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= MAX_BODY_CHARS) return body;
  return `${text.slice(0, MAX_BODY_CHARS)}… (truncated)`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
