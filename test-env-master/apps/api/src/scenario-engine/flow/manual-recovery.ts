import type { ManualChange } from "./recover-step";
import type { RecoveryCandidate, RecoveryTrace } from "./recovery";
import { listInputTargets, type HttpRequestSpec, type InputAddress, type InputLocation } from "./request-inputs";
import { viewEntry, type RegistryView, type ValueRegistry } from "./value-registry";

/**
 * Manual Recovery: what the user needs to fix a NEEDS_INPUT step without
 * reading raw JSON — the request's inputs, the field most likely at fault,
 * ranked recommendations, and every earlier value grouped by step. Secret
 * values never leave as text; a choice refers to a registry value by `ref`.
 */

export type ManualTargetView = InputAddress & { key: string; display: string; type: string; secret: boolean };

export type Recommendation = {
  target: InputAddress & { fieldName: string };
  ref: string;
  display: string;
  stepName: string;
  orderIndex: number;
  path: string;
  confidence: RecoveryCandidate["confidence"];
  reason: RecoveryCandidate["reason"];
  /** Already sent automatically and still failed. */
  tried: boolean;
};

export type ManualRecoveryOptions = {
  targets: ManualTargetView[];
  likelyField: RecoveryTrace["likelyField"];
  recommended: Recommendation[];
  values: RegistryView[];
  truncated: boolean;
};

export type ManualResolution = {
  changes: Array<{ target: InputAddress; source: { ref: string } | { value: string } }>;
  /** Save the mapping on the step for future runs (only applied after it succeeds). */
  save?: boolean;
};

const MAX_VALUES = 300;
const MAX_RECOMMENDED = 6;
const MASK = "••••••";

export function buildManualOptions(
  request: HttpRequestSpec,
  recovery: RecoveryTrace | undefined,
  registry: ValueRegistry,
  secrets: ReadonlySet<string>,
): ManualRecoveryOptions {
  const targets = listInputTargets(request).map((target) => ({
    location: target.location,
    field: target.field,
    key: target.key,
    type: target.type,
    secret: target.secret || secrets.has(target.currentValue),
    display: target.secret || secrets.has(target.currentValue) ? MASK : target.currentValue,
  }));

  const tried = new Set(
    (recovery?.attempts ?? []).flatMap((attempt) =>
      (attempt.candidate.changes ?? [attempt.candidate]).map((change) => `${change.location}|${change.field}|${change.source.ref}`),
    ),
  );
  const pool = [
    ...(recovery?.suggestions ?? []),
    ...(recovery?.attempts ?? []).map((attempt) => attempt.candidate),
  ].filter((candidate) => (candidate.changes?.length ?? 1) === 1 && candidate.source.ref);
  const seen = new Set<string>();
  const recommended: Recommendation[] = [];
  for (const candidate of pool) {
    const key = `${candidate.location}|${candidate.field}|${candidate.source.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = registry.byRef(candidate.source.ref!);
    if (!entry) continue;
    const view = viewEntry(entry, secrets);
    recommended.push({
      target: { location: candidate.location, field: candidate.field, fieldName: candidate.fieldName },
      ref: entry.ref,
      display: view.display,
      stepName: entry.stepName,
      orderIndex: entry.orderIndex,
      path: entry.path,
      confidence: candidate.confidence,
      reason: candidate.reason,
      tried: tried.has(key),
    });
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  recommended.sort((a, b) => Number(a.tried) - Number(b.tried) || rank[a.confidence] - rank[b.confidence]);

  const all = registry.entries();
  return {
    targets,
    likelyField: recovery?.likelyField ?? null,
    recommended: recommended.slice(0, MAX_RECOMMENDED),
    values: all.slice(0, MAX_VALUES).map((entry) => viewEntry(entry, secrets)),
    truncated: all.length > MAX_VALUES,
  };
}

const LOCATIONS: InputLocation[] = ["url", "path", "query", "header", "body", "form", "cookie"];

/** Validate a resolution received from the API. */
export function parseResolution(input: unknown): ManualResolution | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { changes?: unknown; save?: unknown };
  if (!Array.isArray(raw.changes) || raw.changes.length === 0 || raw.changes.length > 10) return null;
  const changes: ManualResolution["changes"] = [];
  for (const item of raw.changes) {
    if (!item || typeof item !== "object") return null;
    const { target, source } = item as { target?: { location?: unknown; field?: unknown }; source?: Record<string, unknown> };
    if (!target || !LOCATIONS.includes(target.location as InputLocation) || typeof target.field !== "string" || !target.field) {
      return null;
    }
    if (!source || typeof source !== "object") return null;
    if (typeof source.ref === "string" && source.ref) {
      changes.push({ target: { location: target.location as InputLocation, field: target.field }, source: { ref: source.ref } });
    } else if (typeof source.value === "string" && source.value.length <= 10_000) {
      changes.push({ target: { location: target.location as InputLocation, field: target.field }, source: { value: source.value } });
    } else {
      return null;
    }
  }
  return { changes, save: raw.save === true };
}

/** Turn a resolution into concrete values; unknown refs are dropped. */
export function resolveManualChanges(
  resolution: ManualResolution,
  request: HttpRequestSpec,
  registry: ValueRegistry,
): ManualChange[] {
  const targets = listInputTargets(request);
  return resolution.changes.flatMap((change): ManualChange[] => {
    const target = targets.find(
      (item) =>
        item.location === change.target.location &&
        (item.location === "header" ? item.field.toLowerCase() === change.target.field.toLowerCase() : item.field === change.target.field),
    );
    const base = {
      address: change.target,
      fieldName: target?.key ?? change.target.field,
      original: target?.currentValue ?? "",
    };
    if ("value" in change.source) return [{ ...base, value: change.source.value, source: null }];
    const entry = registry.byRef(change.source.ref);
    if (!entry) return [];
    return [
      {
        ...base,
        value: entry.value,
        source: { stepId: entry.stepId, stepName: entry.stepName, orderIndex: entry.orderIndex, path: entry.path, ref: entry.ref },
      },
    ];
  });
}
