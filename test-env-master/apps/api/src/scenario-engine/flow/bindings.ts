import type { ConsumedVar } from "../auto-bind";
import { setInput, type HttpRequestSpec, type InputAddress, type InputLocation } from "./request-inputs";
import { isTokenKey, normKey, type RegistryEntry, type ValueRegistry } from "./value-registry";

/**
 * A dependency mapping saved on a step (`config.bindings`):
 *   Request 4.query.bikerId ← Request 2.response.body.data.bikerId
 * It is the strongest evidence there is, so it is applied to every run before
 * the request is sent. A binding never rewrites the step's template; it only
 * decides the value sent. Only paths are stored — never response values.
 */

/**
 * A source known only by what it should be (inferred before any response was
 * seen): "the token Login returns", "the userId Login returns". It is resolved
 * against the source step's actual response at run time, and pinned to a
 * concrete path once a run verifies it.
 */
export type ExpectedValue = {
  kind: "token" | "value";
  key: string;
  /** Keys tried, in order, when `key` matches nothing (a create response's bare "id"). */
  alt?: string[];
};

export type ResponseSource = {
  stepId?: string;
  stepName?: string;
  orderIndex?: number;
  /** response.body.data.token · response.headers.x-request-id · "" while only `expect` is known. */
  path: string;
  expect?: ExpectedValue;
};

export type BindingSource = ResponseSource | { value: string };

export type BindingOrigin =
  /** Chosen by the user in the response explorer or Manual Recovery. */
  | "manual"
  /** A detected dependency the user accepted. */
  | "accepted";

export type StepBinding = {
  target: InputAddress & { key?: string };
  source: BindingSource;
  origin?: BindingOrigin;
  /** false keeps the mapping saved without applying it. */
  enabled?: boolean;
  /** Confidence of the suggestion when it was accepted. */
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  /** response = matched in a real response; request = inferred from request shapes only. */
  evidence?: "response" | "request";
  /** Last time a run resolved this mapping and the step then succeeded. */
  verifiedAt?: string;
  createdAt?: string;
};

const LOCATIONS: InputLocation[] = ["url", "path", "query", "header", "body", "form", "cookie"];
const MAX_FIELD = 300;

export const isResponseSource = (source: BindingSource): source is ResponseSource => !("value" in source);

function isExpected(value: unknown): value is ExpectedValue {
  if (!value || typeof value !== "object") return false;
  const { kind, key, alt } = value as Partial<ExpectedValue>;
  const name = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 100;
  if (alt !== undefined && (!Array.isArray(alt) || alt.length > 5 || !alt.every(name))) return false;
  return (kind === "token" || kind === "value") && name(key);
}

export function isBinding(value: unknown): value is StepBinding {
  if (!value || typeof value !== "object") return false;
  const { target, source, enabled } = value as Partial<StepBinding>;
  if (!target || typeof target !== "object" || !LOCATIONS.includes(target.location as InputLocation)) return false;
  if (typeof target.field !== "string" || !target.field || target.field.length > MAX_FIELD) return false;
  if (enabled !== undefined && typeof enabled !== "boolean") return false;
  if (!source || typeof source !== "object") return false;
  if ("value" in source) return typeof source.value === "string" && source.value.length <= 10_000;
  const { path, expect } = source as Partial<ResponseSource>;
  if (typeof path !== "string" || path.length > 500) return false;
  if (expect !== undefined && !isExpected(expect)) return false;
  return path.length > 0 || isExpected(expect);
}

export function readBindings(config: Record<string, unknown>): StepBinding[] {
  return Array.isArray(config.bindings) ? config.bindings.filter(isBinding) : [];
}

export const sameTarget = (a: InputAddress, b: InputAddress) =>
  a.location === b.location &&
  (a.location === "header" ? a.field.toLowerCase() === b.field.toLowerCase() : a.field === b.field);

/** Add or replace the binding for one target; other bindings are untouched. */
export function upsertBinding(list: StepBinding[], binding: StepBinding): StepBinding[] {
  return [...list.filter((item) => !sameTarget(item.target, binding.target)), binding];
}

export function removeBinding(list: StepBinding[], target: InputAddress): StepBinding[] {
  return list.filter((item) => !sameTarget(item.target, target));
}

/** "header.Authorization", "path.userId" — how a binding target is named in traces. */
export function bindingLocation(binding: StepBinding) {
  return `${binding.target.location}.${binding.target.key ?? binding.target.field}`;
}

/** A binding whose value is not available in this run: the request is not sent. */
export type MissingBinding = {
  target: string;
  sourceStep: string;
  path: string;
  /** The source step produced nothing in this run (did not run, failed or was skipped). */
  reason: "source_not_run" | "no_value" | "ambiguous";
};

export type ResolvedSource =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: MissingBinding["reason"] };

/**
 * Find a saved source in this run's registry. An exact path wins; an
 * `expect`-only source must match exactly one distinct value of that step,
 * otherwise it is ambiguous and nothing is guessed.
 */
export function resolveSource(source: ResponseSource, registry: ValueRegistry): ResolvedSource {
  const own = registry
    .entries()
    .filter((entry) =>
      source.stepId !== undefined ? entry.stepId === source.stepId : entry.orderIndex === source.orderIndex,
    );
  if (own.length === 0) return { ok: false, reason: "source_not_run" };
  if (source.path) {
    const entry = registry.resolve({ stepId: source.stepId, orderIndex: source.orderIndex, path: source.path });
    if (entry) return { ok: true, entry };
    if (!source.expect) return { ok: false, reason: "no_value" };
  }
  const expect = source.expect!;
  const wanted = normKey(expect.key);
  const byKey = (key: string) => own.filter((entry) => normKey(entry.key) === normKey(key));
  const pools =
    expect.kind === "token"
      ? [byKey(expect.key), own.filter((entry) => entry.kind === "body" && isTokenKey(entry.key) && !/refresh/i.test(entry.key))]
      : [
          byKey(expect.key),
          own.filter((entry) => normKey(entry.semanticKey) === wanted),
          // A bare "id" only counts at the top of the response (data.id), never deep inside a list.
          ...(expect.alt ?? []).map((key) => byKey(key).filter((entry) => entry.path.split(".").length <= 4)),
        ];
  for (const candidates of pools) {
    const distinct = new Set(candidates.map((entry) => entry.text));
    if (distinct.size === 1) return { ok: true, entry: candidates[0]! };
    if (distinct.size > 1) return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "no_value" };
}

/**
 * Apply saved bindings to a resolved request using values from the registry.
 * Disabled bindings are skipped. A binding without a value is reported in
 * `missing` (the caller blocks the step rather than send a stale value);
 * `resolvedPaths` lists `expect`-only sources and the path they matched.
 */
export function applyBindings(
  request: HttpRequestSpec,
  bindings: StepBinding[],
  registry: ValueRegistry,
): {
  request: HttpRequestSpec;
  consumed: ConsumedVar[];
  warnings: string[];
  missing: MissingBinding[];
  resolvedPaths: Array<{ target: InputAddress; path: string }>;
} {
  let next = request;
  const consumed: ConsumedVar[] = [];
  const missing: MissingBinding[] = [];
  const resolvedPaths: Array<{ target: InputAddress; path: string }> = [];
  for (const binding of bindings) {
    if (binding.enabled === false) continue;
    const location = bindingLocation(binding);
    if (!isResponseSource(binding.source)) {
      next = setInput(next, binding.target, binding.source.value);
      consumed.push({ variable: binding.target.key ?? binding.target.field, location });
      continue;
    }
    const source = binding.source;
    const found = resolveSource(source, registry);
    if (!found.ok) {
      missing.push({
        target: location,
        sourceStep: source.orderIndex !== undefined ? `Step ${source.orderIndex + 1}${source.stepName ? ` (${source.stepName})` : ""}` : (source.stepName ?? "step"),
        path: source.path || `${source.expect?.kind === "token" ? "token" : source.expect?.key ?? "value"}`,
        reason: found.reason,
      });
      continue;
    }
    const entry = found.entry;
    if (!source.path || source.path !== entry.path) resolvedPaths.push({ target: binding.target, path: entry.path });
    next = setInput(next, binding.target, entry.value, { keepSourceType: true });
    consumed.push({
      variable: entry.semanticKey,
      location,
      source: { stepId: entry.stepId, stepName: entry.stepName, orderIndex: entry.orderIndex, path: entry.path },
    });
  }
  const warnings = missing.map(describeMissing);
  return { request: next, consumed, warnings, missing, resolvedPaths };
}

/** "Blocked: Step 1 (Login) did not provide response.body.token for header.Authorization" */
export function describeMissing(item: MissingBinding) {
  if (item.reason === "source_not_run") {
    return `Blocked: ${item.sourceStep} has no successful response in this run (needed for ${item.target})`;
  }
  if (item.reason === "ambiguous") {
    return `Blocked: ${item.sourceStep} returned several values that could be ${item.path} (needed for ${item.target})`;
  }
  return `Blocked: ${item.sourceStep} did not provide ${item.path} for ${item.target}`;
}

/**
 * After a step succeeded with these bindings: pin `expect`-only sources to the
 * path they matched and stamp them verified. Returns null when nothing changed.
 */
export function verifyBindings(
  bindings: StepBinding[],
  resolvedPaths: Array<{ target: InputAddress; path: string }>,
  now = new Date().toISOString(),
): StepBinding[] | null {
  let changed = false;
  const next = bindings.map((binding) => {
    if (binding.enabled === false || !isResponseSource(binding.source)) return binding;
    const pinned = resolvedPaths.find((item) => sameTarget(item.target, binding.target));
    if (!pinned && binding.verifiedAt) return binding;
    changed = true;
    return {
      ...binding,
      ...(pinned ? { source: { ...binding.source, path: pinned.path } } : {}),
      verifiedAt: now,
    };
  });
  return changed ? next : null;
}
