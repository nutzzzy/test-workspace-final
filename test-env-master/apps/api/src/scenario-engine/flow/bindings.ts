import type { ConsumedVar } from "../auto-bind";
import { setInput, type HttpRequestSpec, type InputAddress, type InputLocation } from "./request-inputs";
import type { ValueRegistry } from "./value-registry";

/**
 * A dependency mapping the user saved on a step (`config.bindings`):
 *   Request 4.query.bikerId ← Request 2.response.body.data.bikerId
 * It is the strongest evidence there is, so it is applied to every run before
 * the request is sent. A binding never rewrites the step's template; it only
 * decides the value sent.
 */
export type StepBinding = {
  target: InputAddress & { key?: string };
  source: { stepId?: string; stepName?: string; orderIndex?: number; path: string } | { value: string };
  origin?: "manual" | "accepted";
  createdAt?: string;
};

const LOCATIONS: InputLocation[] = ["url", "path", "query", "header", "body", "form", "cookie"];

export function isBinding(value: unknown): value is StepBinding {
  if (!value || typeof value !== "object") return false;
  const { target, source } = value as Partial<StepBinding>;
  if (!target || typeof target !== "object" || !LOCATIONS.includes(target.location as InputLocation)) return false;
  if (typeof target.field !== "string" || !target.field) return false;
  if (!source || typeof source !== "object") return false;
  if ("value" in source) return typeof source.value === "string";
  return typeof (source as { path?: unknown }).path === "string";
}

export function readBindings(config: Record<string, unknown>): StepBinding[] {
  return Array.isArray(config.bindings) ? config.bindings.filter(isBinding) : [];
}

const sameTarget = (a: InputAddress, b: InputAddress) =>
  a.location === b.location &&
  (a.location === "header" ? a.field.toLowerCase() === b.field.toLowerCase() : a.field === b.field);

/** Add or replace the binding for one target; other bindings are untouched. */
export function upsertBinding(list: StepBinding[], binding: StepBinding): StepBinding[] {
  return [...list.filter((item) => !sameTarget(item.target, binding.target)), binding];
}

export function removeBinding(list: StepBinding[], target: InputAddress): StepBinding[] {
  return list.filter((item) => !sameTarget(item.target, target));
}

/** Apply saved bindings to a resolved request using values from the registry. */
export function applyBindings(
  request: HttpRequestSpec,
  bindings: StepBinding[],
  registry: ValueRegistry,
): { request: HttpRequestSpec; consumed: ConsumedVar[]; warnings: string[] } {
  let next = request;
  const consumed: ConsumedVar[] = [];
  const warnings: string[] = [];
  for (const binding of bindings) {
    const location = `${binding.target.location}.${binding.target.key ?? binding.target.field}`;
    if ("value" in binding.source) {
      next = setInput(next, binding.target, binding.source.value);
      consumed.push({ variable: binding.target.key ?? binding.target.field, location });
      continue;
    }
    const entry = registry.resolve(binding.source);
    if (!entry) {
      warnings.push(
        `Saved mapping ${location} ← ${binding.source.stepName ?? "step"}.${binding.source.path} has no value in this run`,
      );
      continue;
    }
    next = setInput(next, binding.target, entry.value, { keepSourceType: true });
    consumed.push({
      variable: entry.semanticKey,
      location,
      source: { stepId: entry.stepId, stepName: entry.stepName, orderIndex: entry.orderIndex, path: entry.path },
    });
  }
  return { request: next, consumed, warnings };
}
