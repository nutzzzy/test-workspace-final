import { parseJsonPath, readJsonPath } from "@qa-workbench/shared";
import { isResponseSource, readBindings, sameTarget, type StepBinding } from "./bindings";
import type { InputAddress } from "./request-inputs";
import { analyzeDependencies, type DependencySuggestion, type FlowHttpStep, type SampleResponse } from "./dependency-analyzer";
import { inferRequestDependencies, templateRequest } from "./request-dependencies";
import { normalizePath } from "./value-registry";

/**
 * Design-time view of a scenario's mappings: every saved binding with whether
 * it can still work, and the dependency suggestions that are not saved yet.
 * Nothing here changes a step; a broken mapping is reported for review,
 * never repaired or dropped silently.
 */

export type MappingStatus =
  /** Resolvable, and a run already confirmed it. */
  | "ok"
  /** Resolvable on paper; no run has confirmed it yet. */
  | "unverified"
  | "disabled"
  /** The source step was deleted. */
  | "source_missing"
  /** The source step no longer runs before this step. */
  | "source_after_target"
  | "source_disabled"
  /** The field the mapping fills no longer exists in the request. */
  | "target_missing"
  /** The latest response of the source step has no value at the saved path. */
  | "path_missing";

export type MappingReview = {
  stepId: string;
  index: number;
  binding: StepBinding;
  status: MappingStatus;
  /** 1-based position of the source step, when it still exists. */
  sourceStep: number | null;
  sourceName: string | null;
};

export type ReviewStep = FlowHttpStep & { enabled: boolean };

function sourceStepOf(steps: ReviewStep[], source: { stepId?: string; orderIndex?: number }) {
  if (source.stepId) return steps.find((step) => step.id === source.stepId);
  return source.orderIndex !== undefined ? steps.find((step) => step.orderIndex === source.orderIndex) : undefined;
}

function targetExists(step: ReviewStep, binding: StepBinding, env: Record<string, string>) {
  const { location, field } = binding.target;
  const request = templateRequest(step.config, env);
  if (location === "path" || location === "url") {
    try {
      const segments = new URL(request.url).pathname.split("/");
      const index = Number(field);
      return Number.isInteger(index) && index > 0 && index < segments.length && segments[index] !== "";
    } catch {
      return false;
    }
  }
  if (location === "body") {
    if (!request.body || typeof request.body !== "object") return false;
    const parts = field.split(".").filter(Boolean);
    let cursor: unknown = request.body;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) return false;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return true;
  }
  // Headers, query, form fields and cookies are added when missing.
  return true;
}

function pathInSample(path: string, sample: SampleResponse) {
  const normalized = normalizePath(path);
  if (normalized.startsWith("response.headers.")) {
    const name = normalized.slice("response.headers.".length).replace(/#id$/, "").toLowerCase();
    return Object.keys(sample.headers ?? {}).some((key) => key.toLowerCase() === name);
  }
  if (!normalized.startsWith("response.body")) return true;
  const parsed = parseJsonPath(`$${normalized.slice("response.body".length)}`);
  if (!parsed.ok) return false;
  // A masked sample still has the key; only a missing key means the response changed.
  return readJsonPath(sample.body, parsed.segments).found;
}

export function reviewMappings(
  steps: ReviewStep[],
  samples: SampleResponse[],
  env: Record<string, string> = {},
): MappingReview[] {
  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const out: MappingReview[] = [];
  for (const step of ordered) {
    readBindings(step.config).forEach((binding, index) => {
      const review = (status: MappingStatus, source?: ReviewStep) =>
        out.push({
          stepId: step.id,
          index,
          binding,
          status,
          sourceStep: source ? ordered.indexOf(source) + 1 : null,
          sourceName: source?.name ?? null,
        });
      if (!isResponseSource(binding.source)) {
        review(binding.enabled === false ? "disabled" : "ok");
        return;
      }
      const source = sourceStepOf(ordered, binding.source);
      if (binding.enabled === false) return review("disabled", source);
      if (!source) return review("source_missing");
      if (source.orderIndex >= step.orderIndex) return review("source_after_target", source);
      if (!source.enabled) return review("source_disabled", source);
      if (!targetExists(step, binding, env)) return review("target_missing", source);
      const sample = samples.find((item) => item.stepId === source.id);
      if (binding.source.path && sample && !pathInSample(binding.source.path, sample)) return review("path_missing", source);
      review(binding.verifiedAt || binding.evidence !== "request" ? "ok" : "unverified", source);
    });
  }
  return out;
}

/** A field automatic recovery fixed in the latest run, and the earlier value that fixed it. */
export type RecoveredInput = {
  consumerStepId: string;
  producerStepId: string;
  target: InputAddress & { key: string };
  path: string;
};

/**
 * Suggestions not saved yet, strongest evidence first: fields recovery fixed
 * in the latest run, then values matched in real responses, then request-only
 * inference. Each field gets suggestions from its strongest kind of evidence
 * only. A field that already has a saved mapping (manual or accepted, enabled
 * or not) gets none, so a guess never competes with the user's choice.
 */
export function suggestDependencies(
  steps: FlowHttpStep[],
  samples: SampleResponse[],
  env: Record<string, string> = {},
  recovered: RecoveredInput[] = [],
): DependencySuggestion[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const fixed: DependencySuggestion[] = recovered.flatMap((item) => {
    const producer = byId.get(item.producerStepId);
    const consumer = byId.get(item.consumerStepId);
    if (!producer || !consumer || producer.orderIndex >= consumer.orderIndex) return [];
    return [
      {
        id: `${producer.id}|${consumer.id}|recovered:${item.path}|${item.target.location}|${item.target.field}`,
        producerStepId: producer.id,
        producerName: producer.name,
        consumerStepId: consumer.id,
        consumerName: consumer.name,
        sourcePath: item.path,
        variable: item.target.key,
        location: item.target.location === "url" ? "path" : item.target.location,
        locationDetail: item.target.key,
        confidence: "HIGH",
        score: 1,
        masked: false,
        target: item.target,
        evidence: "response",
        reason: "recovered",
      },
    ];
  });
  const tiers = [fixed, analyzeDependencies(steps, samples), inferRequestDependencies(steps, env)];
  const out: DependencySuggestion[] = [];
  for (const tier of tiers) {
    const stronger = [...out];
    out.push(
      ...tier.filter(
        (item) => !stronger.some((other) => other.consumerStepId === item.consumerStepId && sameTarget(other.target, item.target)),
      ),
    );
  }
  const saved = (item: DependencySuggestion) => {
    const consumer = byId.get(item.consumerStepId);
    return consumer ? readBindings(consumer.config).some((binding) => sameTarget(binding.target, item.target)) : false;
  };
  return out.filter((item) => !saved(item));
}

/** The binding saved when the user accepts a suggestion. */
export function bindingFromSuggestion(item: DependencySuggestion, producer: FlowHttpStep): StepBinding {
  return {
    target: item.target,
    source: {
      stepId: producer.id,
      stepName: producer.name,
      orderIndex: producer.orderIndex,
      path: item.sourcePath ? normalizePath(item.sourcePath) : "",
      ...(item.expect ? { expect: item.expect } : {}),
    },
    origin: "accepted",
    confidence: item.confidence,
    evidence: item.evidence,
    createdAt: new Date().toISOString(),
  };
}
