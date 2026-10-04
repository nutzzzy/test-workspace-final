import type { AssertionExecutor } from "../executors/assertion.executor";
import {
  expectedStatuses,
  type HttpRequestExecutor,
  type ResolvedHttpRequest,
} from "../executors/http-request.executor";
import type { ExecutionContext, StepExecutionResult } from "../types";
import {
  applyCandidate,
  changesRequestData,
  isRetrySafe,
  READ_ONLY_METHODS,
  likelyField,
  planRecoveryCandidates,
  recoverySettings,
  requestFingerprint,
  type CandidateChange,
  type RecoveryAttempt,
  type RecoveryCandidate,
  type RecoveryTrace,
} from "./recovery";
import { listInputTargets, setInput, type InputAddress } from "./request-inputs";

export type AssertionCheck = { label: string; passed: boolean; error?: string };
export type Expectation = { met: boolean; failures: string[]; checks: AssertionCheck[] };

/** Final state of an HTTP step after recovery. */
export type HttpStepState = "PASSED" | "RECOVERED" | "FAILED" | "NEEDS_INPUT" | "CANCELLED";

export type RecoveryProgress = { attempt: number; max: number; candidate: RecoveryCandidate };

/** Compact, value-free description of LOW candidates for optional model ranking. */
export type SemanticRankInput = {
  target: { location: string; key: string; type: string };
  candidates: Array<{ id: string; step: string; key: string; path: string; type: string }>;
  error: { status: number | null; message?: string };
};
export type SemanticRanker = (input: SemanticRankInput) => Promise<string[]>;

function isStatusAssertion(assertion: Record<string, unknown>) {
  if (assertion.kind === "status_code") return true;
  return /^(response\.)?status(_code)?$/.test(String(assertion.path ?? "").trim());
}

/**
 * Did the current response meet what the scenario expects of this step?
 * - an explicit `expectedStatus` is authoritative (201 expected ≠ 200 received);
 * - otherwise a status_code assertion right after the step decides the status
 *   (negative tests expecting 404 keep working);
 * - otherwise any 2xx is transport success;
 * - every attached assertion must pass as well — 2xx alone is never enough.
 */
export async function evaluateExpectation(
  config: Record<string, unknown>,
  attachedAssertions: Array<Record<string, unknown>>,
  context: ExecutionContext,
  assertions: AssertionExecutor,
): Promise<Expectation> {
  const status = context.lastHttpResponse?.status ?? null;
  const failures: string[] = [];
  const checks: AssertionCheck[] = [];
  const expected = expectedStatuses(config);
  if (expected) {
    const passed = status !== null && expected.includes(status);
    const error = `Expected HTTP ${expected.join(" or ")}, got ${status ?? "no response"}`;
    checks.push({ label: `status ∈ ${expected.join(", ")}`, passed, ...(passed ? {} : { error }) });
    if (!passed) failures.push(error);
  } else if (!attachedAssertions.some(isStatusAssertion)) {
    const passed = status !== null && status >= 200 && status < 300;
    checks.push({ label: "status 2xx", passed, ...(passed ? {} : { error: `HTTP ${status ?? "no response"}` }) });
    if (!passed) failures.push(`HTTP ${status ?? "no response"}`);
  }
  for (const assertion of attachedAssertions) {
    const result = await assertions.execute(assertion, context);
    const label = `${String(assertion.kind ?? "equals")}${assertion.path ? ` ${String(assertion.path)}` : ""}`;
    const passed = result.status === "PASSED";
    checks.push({ label, passed, ...(passed ? {} : { error: result.error ?? "Assertion failed" }) });
    if (!passed) failures.push(result.error ?? "Assertion failed");
  }
  return { met: failures.length === 0, failures, checks };
}

/** Short error text from a response body (message/error/detail/title). */
export function responseMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, 200) || undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "title", "error_description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
    if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
      return String((value as { message: string }).message).slice(0, 200);
    }
  }
  return undefined;
}

function sentUrl(request: ResolvedHttpRequest) {
  try {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value));
    return url.toString();
  } catch {
    return request.url;
  }
}

/** The exact request of an attempt, for the attempt history (redacted before it is stored). */
function attemptRequest(method: string, request: ResolvedHttpRequest) {
  return {
    method,
    url: sentUrl(request),
    ...(request.headers && Object.keys(request.headers).length ? { headers: request.headers } : {}),
    ...(request.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: request.body } : {}),
  };
}

function trace(
  partial: Pick<RecoveryTrace, "outcome" | "originalStatus" | "failures" | "maxAttempts"> & Partial<RecoveryTrace>,
): RecoveryTrace {
  return { attempts: [], suggestions: [], ...partial };
}

export type RecoverResult = {
  result: StepExecutionResult;
  recovery?: RecoveryTrace;
  state: HttpStepState;
  checks: AssertionCheck[];
  /** Registry refs a successful candidate used, to prefer them later in the run. */
  learned?: Array<{ fieldName: string; ref: string }>;
};

/**
 * Bounded, justified recovery of one failed HTTP step:
 * - candidates only from planRecoveryCandidates (deterministic evidence);
 * - HIGH always; MEDIUM for read-only requests unless `recovery.allowMedium: false`;
 *   LOW never, unless an optional model ranking promotes it (`recovery.aiAssist`);
 * - only safe methods unless `recovery.idempotent` or an Idempotency-Key; DELETE never;
 * - at most `recovery.maxAttempts` sends, never more than 10;
 * - never the same effective request twice (fingerprint);
 * - success = HTTP expectation AND every attached assertion, not just 2xx;
 * - stops at the first success.
 * A rejected retry leaves no trace in the variables or the last response.
 */
export async function recoverHttpStep(input: {
  config: Record<string, unknown>;
  request: ResolvedHttpRequest;
  firstResult: StepExecutionResult;
  attachedAssertions: Array<Record<string, unknown>>;
  context: ExecutionContext;
  http: HttpRequestExecutor;
  assertions: AssertionExecutor;
  onProgress?: (progress: RecoveryProgress) => void | Promise<void>;
  ranker?: SemanticRanker;
  previousMappings?: Array<{ fieldName: string; ref: string }>;
}): Promise<RecoverResult> {
  const { config, request, firstResult, attachedAssertions, context, http, assertions } = input;
  if (firstResult.status === "CANCELLED") return { result: firstResult, state: "CANCELLED", checks: [] };
  // Transport errors and blocked hosts have no response to reason about.
  if (!context.lastHttpResponse) return { result: firstResult, state: "FAILED", checks: [] };

  const first = await evaluateExpectation(config, attachedAssertions, context, assertions);
  if (first.met) return { result: { ...firstResult, status: "PASSED" }, state: "PASSED", checks: first.checks };

  const method = (request.method ?? "GET").toUpperCase();
  const spec = { ...request, method };
  const settings = recoverySettings(config);
  const failed = { ...firstResult, status: "FAILED" as const, error: firstResult.error ?? first.failures.join("; ") };
  const manualPossible = listInputTargets(spec).length > 0;
  const unresolved = (): HttpStepState => (manualPossible ? "NEEDS_INPUT" : "FAILED");
  const base = {
    originalStatus: context.lastHttpResponse.status,
    failures: first.failures,
    maxAttempts: settings.maxAttempts,
    original: {
      method,
      url: sentUrl(spec),
      status: context.lastHttpResponse.status,
      durationMs: context.lastHttpResponse.durationMs,
      message: responseMessage(context.lastHttpResponse.body),
    },
  };
  if (!settings.enabled) {
    return {
      result: failed,
      recovery: trace({ ...base, outcome: "DISABLED", stoppedBecause: "DISABLED" }),
      state: "FAILED",
      checks: first.checks,
    };
  }

  let candidates = planRecoveryCandidates(spec, context.registry, { previousMappings: input.previousMappings });
  const safe = isRetrySafe(method, settings.idempotent, request.headers);
  const mediumAllowed = safe ? settings.allowMedium : settings.allowMediumExplicit;
  const confident = (candidate: RecoveryCandidate) =>
    candidate.confidence === "HIGH" || (mediumAllowed && candidate.confidence === "MEDIUM");
  // Even a repeatable mutation keeps its business data unless the user allowed changing it.
  const dataLocked = !READ_ONLY_METHODS.includes(method) && !settings.allowDataChanges;
  const allowed = (candidate: RecoveryCandidate) => confident(candidate) && !(dataLocked && changesRequestData(candidate));

  // Optional semantic help: only when deterministic evidence is insufficient.
  if (settings.aiAssist && input.ranker && safe && !candidates.some(allowed) && candidates.length > 0) {
    candidates = await promoteWithRanker(candidates, input.ranker, base.originalStatus, base.original.message);
  }

  const likely = likelyField(candidates);
  if (candidates.length === 0) {
    return {
      result: failed,
      recovery: trace({ ...base, outcome: "NO_CANDIDATE", stoppedBecause: "NO_CANDIDATES", likelyField: likely }),
      state: unresolved(),
      checks: first.checks,
    };
  }
  if (!safe) {
    return {
      result: failed,
      recovery: trace({
        ...base,
        outcome: "SUGGESTED",
        suggestions: candidates,
        blockedReason: "UNSAFE_METHOD",
        stoppedBecause: "UNSAFE_ONLY",
        likelyField: likely,
      }),
      state: unresolved(),
      checks: first.checks,
    };
  }
  const runnable = candidates.filter(allowed);
  if (runnable.length === 0) {
    const dataOnly = candidates.some((candidate) => confident(candidate) && changesRequestData(candidate));
    return {
      result: failed,
      recovery: trace({
        ...base,
        outcome: "SUGGESTED",
        suggestions: candidates,
        blockedReason: dataOnly ? "UNSAFE_METHOD" : "CONFIDENCE",
        stoppedBecause: dataOnly ? "UNSAFE_ONLY" : "LOW_CONFIDENCE_ONLY",
        likelyField: likely,
      }),
      state: unresolved(),
      checks: first.checks,
    };
  }

  const originalResponse = context.lastHttpResponse;
  const originalState = context.snapshot();
  const sent = new Set([requestFingerprint(spec)]);
  const attempts: RecoveryAttempt[] = [];
  const suggestions = candidates.filter((candidate) => !allowed(candidate));
  let blockedReason: RecoveryTrace["blockedReason"];
  let skippedDuplicates = 0;
  let stoppedBecause: RecoveryTrace["stoppedBecause"] = "CANDIDATES_EXHAUSTED";

  for (const [index, candidate] of runnable.entries()) {
    if (attempts.length >= settings.maxAttempts) {
      suggestions.push(...runnable.slice(index));
      blockedReason = "BUDGET";
      stoppedBecause = "MAX_ATTEMPTS";
      break;
    }
    const retry = applyCandidate(spec, candidate);
    const fingerprint = requestFingerprint(retry);
    if (sent.has(fingerprint)) {
      blockedReason = blockedReason ?? "DUPLICATE_REQUEST";
      skippedDuplicates += 1;
      continue;
    }
    sent.add(fingerprint);

    if (context.isCancelled()) {
      stoppedBecause = "CANCELLED";
      break;
    }
    await input.onProgress?.({ attempt: attempts.length + 1, max: settings.maxAttempts, candidate });

    const before = context.snapshot();
    const result = await http.send(retry, context, expectedStatuses(config));
    if (result.status === "CANCELLED") {
      context.restore(originalState);
      context.lastHttpResponse = originalResponse;
      return {
        result: { ...failed, status: "CANCELLED", error: result.error ?? "Cancelled" },
        recovery: trace({ ...base, outcome: "FAILED", attempts, suggestions, stoppedBecause: "CANCELLED", likelyField: likely }),
        state: "CANCELLED",
        checks: first.checks,
      };
    }
    const response = context.lastHttpResponse as ExecutionContext["lastHttpResponse"];
    const verdict = response
      ? await evaluateExpectation(config, attachedAssertions, context, assertions)
      : { met: false, failures: [result.error ?? "No response"], checks: [] };
    const met = verdict.met && result.status === "PASSED";
    attempts.push({
      candidate,
      status: response?.status ?? null,
      expectationMet: met,
      failures: verdict.failures,
      request: attemptRequest(method, retry),
      durationMs: response?.durationMs,
      message: response ? responseMessage(response.body) : undefined,
      ...(result.error ? { error: result.error } : {}),
    });
    if (met) {
      return {
        result: { ...result, status: "PASSED", consumedVars: firstResult.consumedVars },
        recovery: trace({
          ...base,
          outcome: "RECOVERED",
          attempts,
          suggestions,
          blockedReason,
          stoppedBecause: "SUCCESS",
          likelyField: likely,
          skippedDuplicates,
        }),
        state: "RECOVERED",
        checks: verdict.checks,
        learned: candidate.changes
          .filter((change) => change.source.ref)
          .map((change) => ({ fieldName: change.fieldName, ref: change.source.ref! })),
      };
    }
    context.restore(before);
  }

  context.restore(originalState);
  context.lastHttpResponse = originalResponse;
  return {
    result: failed,
    recovery: trace({
      ...base,
      outcome: attempts.length > 0 ? "FAILED" : "SUGGESTED",
      attempts,
      suggestions,
      blockedReason,
      stoppedBecause,
      likelyField: likely,
      skippedDuplicates,
    }),
    state: unresolved(),
    checks: first.checks,
  };
}

async function promoteWithRanker(
  candidates: RecoveryCandidate[],
  ranker: SemanticRanker,
  status: number | null,
  message: string | undefined,
): Promise<RecoveryCandidate[]> {
  const low = candidates.filter((candidate) => candidate.confidence === "LOW" && candidate.changes.length === 1);
  const first = low[0];
  if (!first) return candidates;
  const sameTarget = low.filter((candidate) => candidate.location === first.location && candidate.field === first.field);
  let chosen: string[] = [];
  try {
    chosen = await ranker({
      target: { location: first.location, key: first.fieldName, type: /^-?\d+$/.test(first.original) ? "number" : "string" },
      // Never values: only where each candidate comes from and its shape.
      candidates: sameTarget.map((candidate, index) => ({
        id: String(index),
        step: `Step ${candidate.source.orderIndex + 1}`,
        key: candidate.source.path.split(".").pop() ?? "",
        path: candidate.source.path,
        type: /^-?\d+$/.test(candidate.replacement) ? "number" : "string",
      })),
      error: { status, message },
    });
  } catch {
    return candidates;
  }
  const promoted = new Set(
    chosen.map(Number).filter((index) => Number.isInteger(index)).map((index) => sameTarget[index]).filter(Boolean),
  );
  if (promoted.size === 0) return candidates;
  return [
    ...[...promoted].map((candidate) => ({ ...candidate!, confidence: "MEDIUM" as const, reason: "AI_SUGGESTION" as const })),
    ...candidates.filter((candidate) => !promoted.has(candidate)),
  ];
}

/** One value the user chose in Manual Recovery, already resolved. */
export type ManualChange = {
  address: InputAddress;
  fieldName: string;
  original: string;
  value: string | number | boolean;
  /** Registry source, or null for a custom value. */
  source: CandidateChange["source"] | null;
};

/** Send the request with the user's values; record it as a manual attempt. */
export async function manualRetry(input: {
  config: Record<string, unknown>;
  request: ResolvedHttpRequest;
  changes: ManualChange[];
  attachedAssertions: Array<Record<string, unknown>>;
  context: ExecutionContext;
  http: HttpRequestExecutor;
  assertions: AssertionExecutor;
}): Promise<{ result: StepExecutionResult; attempt: RecoveryAttempt; met: boolean; checks: AssertionCheck[] }> {
  const { config, changes, context, http, assertions } = input;
  const method = (input.request.method ?? "GET").toUpperCase();
  const retry = changes.reduce(
    (next, change) => setInput(next, change.address, change.value),
    { ...input.request, method } as ResolvedHttpRequest & { method: string },
  );
  const candidateChanges: CandidateChange[] = changes.map((change) => ({
    location: change.address.location,
    field: change.address.field,
    fieldName: change.fieldName,
    original: change.original,
    replacement: String(change.value),
    source: change.source ?? { stepName: "manual", orderIndex: -1, path: "custom value" },
    originalSource: null,
  }));
  const candidate: RecoveryCandidate = {
    ...candidateChanges[0]!,
    changes: candidateChanges,
    confidence: "HIGH",
    reason: "MANUAL",
  };
  const before = context.snapshot();
  const result = await http.send(retry, context, expectedStatuses(config));
  const response = context.lastHttpResponse as ExecutionContext["lastHttpResponse"];
  const verdict = response
    ? await evaluateExpectation(config, input.attachedAssertions, context, assertions)
    : { met: false, failures: [result.error ?? "No response"], checks: [] };
  const met = verdict.met && result.status === "PASSED";
  if (!met) context.restore(before);
  return {
    result: met ? { ...result, status: "PASSED" } : { ...result, status: result.status === "CANCELLED" ? "CANCELLED" : "FAILED", error: result.error ?? verdict.failures.join("; ") },
    met,
    checks: verdict.checks,
    attempt: {
      candidate,
      manual: true,
      status: response?.status ?? null,
      expectationMet: met,
      failures: verdict.failures,
      request: attemptRequest(method, retry),
      durationMs: response?.durationMs,
      message: response ? responseMessage(response.body) : undefined,
      ...(result.error ? { error: result.error } : {}),
    },
  };
}
