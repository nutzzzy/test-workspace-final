import type { AssertionExecutor } from "../executors/assertion.executor";
import {
  expectedStatuses,
  type HttpRequestExecutor,
  type ResolvedHttpRequest,
} from "../executors/http-request.executor";
import type { ExecutionContext, StepExecutionResult } from "../types";
import {
  applyCandidate,
  isRetrySafe,
  planRecoveryCandidates,
  recoverySettings,
  requestFingerprint,
  type RecoveryAttempt,
  type RecoveryCandidate,
  type RecoveryTrace,
} from "./recovery";

/**
 * Did the current response meet what the scenario expects of this step?
 * Expectations are the step's `expectedStatus` plus the ASSERTION steps that
 * directly follow it. With neither declared, a 4xx/5xx is unexpected.
 */
export async function evaluateExpectation(
  config: Record<string, unknown>,
  attachedAssertions: Array<Record<string, unknown>>,
  context: ExecutionContext,
  assertions: AssertionExecutor,
): Promise<{ met: boolean; failures: string[] }> {
  const status = context.lastHttpResponse?.status ?? null;
  const failures: string[] = [];
  const expected = expectedStatuses(config);
  if (expected) {
    if (status === null || !expected.includes(status)) {
      failures.push(`Expected HTTP ${expected.join(" or ")}, got ${status ?? "no response"}`);
    }
  } else if (attachedAssertions.length === 0 && (status === null || status >= 400)) {
    failures.push(`HTTP ${status ?? "no response"}`);
  }
  for (const assertion of attachedAssertions) {
    const result = await assertions.execute(assertion, context);
    if (result.status !== "PASSED") failures.push(result.error ?? "Assertion failed");
  }
  return { met: failures.length === 0, failures };
}

function trace(
  partial: Pick<RecoveryTrace, "outcome" | "originalStatus" | "failures" | "maxAttempts"> &
    Partial<RecoveryTrace>,
): RecoveryTrace {
  return { attempts: [], suggestions: [], ...partial };
}

/**
 * Bounded, justified recovery of one failed HTTP step:
 * - only candidates from planRecoveryCandidates (deterministic, one field each);
 * - HIGH confidence only unless `recovery.allowMedium`;
 * - only safe methods unless `recovery.idempotent`; DELETE never;
 * - at most `recovery.maxAttempts` (default 3) sends;
 * - never the same effective request twice (fingerprint);
 * - success = HTTP expectation AND every attached assertion, not just 2xx.
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
}): Promise<{ result: StepExecutionResult; recovery?: RecoveryTrace }> {
  const { config, request, firstResult, attachedAssertions, context, http, assertions } = input;
  // Transport errors, cancellations and blocked hosts have no response to reason about.
  if (firstResult.status === "CANCELLED" || !context.lastHttpResponse) return { result: firstResult };

  const first = await evaluateExpectation(config, attachedAssertions, context, assertions);
  if (first.met) return { result: firstResult };

  const settings = recoverySettings(config);
  const base = {
    originalStatus: context.lastHttpResponse.status,
    failures: first.failures,
    maxAttempts: settings.maxAttempts,
  };
  if (!settings.enabled) return { result: firstResult, recovery: trace({ ...base, outcome: "DISABLED" }) };

  const method = (request.method ?? "GET").toUpperCase();
  const candidates = planRecoveryCandidates({ ...request, method }, context.history);
  if (candidates.length === 0) {
    return { result: firstResult, recovery: trace({ ...base, outcome: "NO_CANDIDATE" }) };
  }
  if (!isRetrySafe(method, settings.idempotent)) {
    return {
      result: firstResult,
      recovery: trace({ ...base, outcome: "SUGGESTED", suggestions: candidates, blockedReason: "UNSAFE_METHOD" }),
    };
  }
  const allowed = (candidate: RecoveryCandidate) =>
    candidate.confidence === "HIGH" || (settings.allowMedium && candidate.confidence === "MEDIUM");
  const runnable = candidates.filter(allowed);
  if (runnable.length === 0) {
    return {
      result: firstResult,
      recovery: trace({ ...base, outcome: "SUGGESTED", suggestions: candidates, blockedReason: "CONFIDENCE" }),
    };
  }

  const originalResponse = context.lastHttpResponse;
  const originalState = context.snapshot();
  const sent = new Set([requestFingerprint({ ...request, method })]);
  const attempts: RecoveryAttempt[] = [];
  const suggestions = candidates.filter((candidate) => !allowed(candidate));
  let blockedReason: RecoveryTrace["blockedReason"];

  for (const [index, candidate] of runnable.entries()) {
    if (attempts.length >= settings.maxAttempts) {
      suggestions.push(...runnable.slice(index));
      blockedReason = "BUDGET";
      break;
    }
    const retry = applyCandidate({ ...request, method }, candidate);
    const fingerprint = requestFingerprint(retry);
    if (sent.has(fingerprint)) {
      blockedReason = "DUPLICATE_REQUEST";
      continue;
    }
    sent.add(fingerprint);

    const before = context.snapshot();
    const result = await http.send(retry, context, expectedStatuses(config));
    if (result.status === "CANCELLED") return { result };
    const verdict = context.lastHttpResponse
      ? await evaluateExpectation(config, attachedAssertions, context, assertions)
      : { met: false, failures: [result.error ?? "No response"] };
    const met = verdict.met && result.status === "PASSED";
    attempts.push({
      candidate,
      status: context.lastHttpResponse?.status ?? null,
      expectationMet: met,
      failures: verdict.failures,
      ...(result.error ? { error: result.error } : {}),
    });
    if (met) {
      return {
        result: { ...result, consumedVars: firstResult.consumedVars },
        recovery: trace({ ...base, outcome: "RECOVERED", attempts, suggestions, blockedReason }),
      };
    }
    context.restore(before);
  }

  context.restore(originalState);
  context.lastHttpResponse = originalResponse;
  return {
    result: firstResult,
    recovery: trace({
      ...base,
      outcome: attempts.length > 0 ? "FAILED" : "SUGGESTED",
      attempts,
      suggestions,
      blockedReason,
    }),
  };
}
