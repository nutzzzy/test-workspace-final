import { AssertionExecutor } from "./executors/assertion.executor";
import { ExtractVariableExecutor } from "./executors/extract-variable.executor";
import { expectedStatuses as expectedStatusOf, HttpRequestExecutor } from "./executors/http-request.executor";
import { applyBindings, readBindings, upsertBinding, verifyBindings, type StepBinding } from "./flow/bindings";
import {
  buildManualOptions,
  resolveManualChanges,
  type ManualRecoveryOptions,
  type ManualResolution,
} from "./flow/manual-recovery";
import {
  manualRetry,
  recoverHttpStep,
  type AssertionCheck,
  type HttpStepState,
  type SemanticRanker,
} from "./flow/recover-step";
import type { RecoveryTrace } from "./flow/recovery";
import { describeAddress } from "./flow/request-inputs";
import { explainUnresolved, runExtractions, variableCatalog, type ExtractionOutcome } from "./flow/response-mapping";
import { importantValues, viewEntry, type RegistryEntry } from "./flow/value-registry";
import type { StepExecutorRegistry } from "./step-executor.registry";
import type {
  ExecutionContext,
  OrchestrationResult,
  OrchestrationStep,
  OrchestrationStepResult,
  StepExecutionResult,
} from "./types";

/** What the live view shows while a step runs. */
export type LiveStepProgress = {
  orderIndex: number;
  stepId?: string;
  stepName: string;
  state: "RUNNING" | "RECOVERING" | "NEEDS_INPUT";
  attempt?: number;
  max?: number;
  trying?: Array<{ target: string; value: string; source: string }>;
};

/** A step waiting for the user in Manual Recovery. */
export type PendingInput = {
  orderIndex: number;
  stepId?: string;
  stepName: string;
  result: OrchestrationStepResult;
};

export type OrchestrationOptions = {
  stopOnFailure: boolean;
  onStepComplete?: (result: OrchestrationStepResult) => Promise<void> | void;
  /** Live progress (running step, recovery attempt n / max). */
  onProgress?: (progress: LiveStepProgress) => void;
  /**
   * Pause a NEEDS_INPUT step for Manual Recovery. Resolve with the user's
   * choice, or null to leave the step as NEEDS_INPUT. Without it a
   * NEEDS_INPUT step is final immediately (scripts, sync runs).
   */
  awaitInput?: (pending: PendingInput) => Promise<ManualResolution | null>;
  /** Persist a mapping the user asked to save (after it worked). */
  onSaveBindings?: (stepId: string, bindings: StepBinding[]) => Promise<void>;
  /** Optional model ranking of LOW candidates (`recovery.aiAssist`). */
  ranker?: SemanticRanker;
};

/** A user may try several values; this bounds a single step's manual loop. */
const MAX_MANUAL_ROUNDS = 10;

/**
 * Pure step-loop used by ScenarioRunner and unit tests.
 * Handles order, skip, cancel, stopOnFailure / continueOnFailure.
 */
export async function orchestrateSteps(
  steps: OrchestrationStep[],
  registry: StepExecutorRegistry,
  context: ExecutionContext,
  options: OrchestrationOptions,
): Promise<OrchestrationResult> {
  const stepResults: OrchestrationStepResult[] = [];
  let finalStatus: OrchestrationResult["status"] = "PASSED";
  let runError: string | undefined;

  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const assertions = new AssertionExecutor();
  const learnedMappings: Array<{ fieldName: string; ref: string }> = [];
  const catalog = variableCatalog(ordered);

  for (const [position, step] of ordered.entries()) {
    if (context.isCancelled()) {
      finalStatus = "CANCELLED";
      break;
    }

    if (!step.enabled) {
      const skipped: OrchestrationStepResult = {
        name: step.name,
        type: step.type,
        orderIndex: step.orderIndex,
        status: "SKIPPED",
        durationMs: 0,
      };
      stepResults.push(skipped);
      await options.onStepComplete?.(skipped);
      continue;
    }

    const started = Date.now();
    let pausedMs = 0;
    let result: StepExecutionResult;
    try {
      const executor = registry.resolve(step.type);
      if (executor instanceof HttpRequestExecutor) {
        const outcome = await runHttpStep(executor, step, attachedAssertions(ordered, position), context, assertions, {
          ...options,
          learnedMappings,
          started,
        });
        result = outcome.result;
        pausedMs = outcome.pausedMs;
      } else {
        result = await executor.execute(step.config ?? {}, context);
        if (executor instanceof ExtractVariableExecutor && result.status === "PASSED") markExtraction(result, context);
      }
    } catch (error) {
      result = {
        status: "FAILED" as const,
        error:
          error instanceof Error ? explainUnresolved(error.message, step, catalog) : "Step execution failed",
      };
    }

    const stepResult: OrchestrationStepResult = {
      ...result,
      name: step.name,
      type: step.type,
      orderIndex: step.orderIndex,
      durationMs: Math.max(0, Date.now() - started - pausedMs),
    };
    stepResults.push(stepResult);
    await options.onStepComplete?.(stepResult);

    if (context.isCancelled() || result.status === "CANCELLED") {
      finalStatus = "CANCELLED";
      runError = result.error ?? "Cancelled";
      break;
    }

    if (result.status === "FAILED" || result.status === "NEEDS_INPUT") {
      // FAILED outranks NEEDS_INPUT for the run.
      if (result.status === "FAILED" || finalStatus !== "FAILED") finalStatus = result.status;
      runError = result.error;
      const continueOnFailure = step.config?.continueOnFailure === true;
      if (options.stopOnFailure && !continueOnFailure) break;
    }
  }

  if (context.isCancelled()) {
    finalStatus = "CANCELLED";
  }

  return { status: finalStatus, error: runError, stepResults };
}

/** ASSERTION steps directly after an HTTP step check that step's response. */
function attachedAssertions(ordered: OrchestrationStep[], position: number) {
  const out: Array<Record<string, unknown>> = [];
  for (const next of ordered.slice(position + 1)) {
    if (next.type !== "ASSERTION") break;
    if (next.enabled) out.push(next.config ?? {});
  }
  return out;
}

/** An EXTRACT_VARIABLE step names a registry value explicitly. */
function markExtraction(result: StepExecutionResult, context: ExecutionContext) {
  const input = result.resolvedInput as { path?: string; variable?: string } | undefined;
  const last = context.history[context.history.length - 1];
  if (!input?.path || !input.variable || !last) return;
  const entry = context.registry.markExplicit(last.orderIndex, input.path, input.variable);
  if (entry) {
    context.describeVariable(input.variable, {
      type: entry.type,
      source: { stepId: entry.stepId, stepName: entry.stepName, orderIndex: entry.orderIndex, path: entry.path },
    });
  }
}

function masked(value: string, context: ExecutionContext) {
  return String(context.redact(value));
}

/**
 * Send an HTTP step: apply saved mappings, let bounded recovery handle an
 * unmet expectation, pause for Manual Recovery when allowed, and record a
 * successful response in the Runtime Value Registry for later steps.
 */
async function runHttpStep(
  http: HttpRequestExecutor,
  step: OrchestrationStep,
  attached: Array<Record<string, unknown>>,
  context: ExecutionContext,
  assertions: AssertionExecutor,
  options: OrchestrationOptions & { learnedMappings: Array<{ fieldName: string; ref: string }>; started: number },
): Promise<{ result: StepExecutionResult; pausedMs: number }> {
  const config = step.config ?? {};
  if (context.isCancelled()) {
    return { result: { status: "CANCELLED" as const, error: "Cancelled before HTTP request" }, pausedMs: 0 };
  }
  const live = { orderIndex: step.orderIndex, stepId: step.id, stepName: step.name };
  options.onProgress?.({ ...live, state: "RUNNING" });

  const prepared = http.prepare(config, context);
  let bindings = readBindings(config);
  const bound = applyBindings({ ...prepared.request, method: prepared.request.method ?? "GET" }, bindings, context.registry);
  const request = { ...prepared.request, ...bound.request };
  const consumed = [...prepared.consumed, ...bound.consumed];
  if (bound.missing.length > 0) {
    // A mapped value is missing: sending the request would use stale or
    // placeholder data, so the step is blocked instead.
    return {
      result: {
        status: "FAILED",
        error: bound.warnings.join("; "),
        blocked: bound.missing,
        resolvedInput: context.redact({ method: request.method ?? "GET", url: request.url }),
        ...(consumed.length ? { consumedVars: consumed } : {}),
      },
      pausedMs: 0,
    };
  }
  context.pendingPaths.clear();
  // A step that does not succeed must not leave values behind for later steps.
  const before = context.snapshot();
  const sent = await http.send(request, context, expectedStatusOf(config));
  const firstResult = consumed.length ? { ...sent, consumedVars: consumed } : sent;

  const outcome = await recoverHttpStep({
    config,
    request,
    firstResult,
    attachedAssertions: attached,
    context,
    http,
    assertions,
    ranker: options.ranker,
    previousMappings: options.learnedMappings,
    onProgress: (progress) =>
      options.onProgress?.({
        ...live,
        state: "RECOVERING",
        attempt: progress.attempt,
        max: progress.max,
        trying: progress.candidate.changes.map((change) => ({
          target: describeAddress({ ...change, key: change.fieldName }),
          value: masked(change.replacement, context),
          source: `Step ${change.source.orderIndex + 1} → ${change.source.path}`,
        })),
      }),
  });
  let { result, recovery, state, checks } = outcome;
  if (state === "RECOVERED" && outcome.learned) options.learnedMappings.push(...outcome.learned);

  let pausedMs = 0;
  let manual: ManualRecoveryOptions | undefined;
  let savedMapping = false;
  for (let round = 0; state === "NEEDS_INPUT" && options.awaitInput && round < MAX_MANUAL_ROUNDS; round += 1) {
    if (context.isCancelled()) break;
    manual = buildManualOptions(request, recovery, context.registry, context.secretSet());
    options.onProgress?.({ ...live, state: "NEEDS_INPUT" });
    const pauseStarted = Date.now();
    const resolution = await options.awaitInput({
      ...live,
      result: {
        ...finish(result, state, recovery, checks, manual, []),
        name: step.name,
        type: step.type,
        orderIndex: step.orderIndex,
        durationMs: Math.max(0, pauseStarted - options.started - pausedMs),
      },
    });
    pausedMs += Date.now() - pauseStarted;
    if (!resolution || context.isCancelled()) break;
    const changes = resolveManualChanges(resolution, request, context.registry);
    if (changes.length === 0) continue;

    options.onProgress?.({ ...live, state: "RUNNING" });
    const retry = await manualRetry({ config, request, changes, attachedAssertions: attached, context, http, assertions });
    recovery = {
      ...(recovery ?? {
        outcome: "FAILED",
        originalStatus: null,
        failures: [],
        attempts: [],
        suggestions: [],
        maxAttempts: 0,
      }),
      manual: true,
    } as RecoveryTrace;
    recovery.attempts = [...recovery.attempts, retry.attempt];
    checks = retry.checks;
    result = { ...retry.result, consumedVars: firstResult.consumedVars };
    if (retry.result.status === "CANCELLED") {
      state = "CANCELLED";
      break;
    }
    if (!retry.met) continue;

    state = "RECOVERED";
    recovery.outcome = "RECOVERED";
    recovery.stoppedBecause = "SUCCESS";
    for (const change of changes) {
      if (change.source?.ref) options.learnedMappings.push({ fieldName: change.fieldName, ref: change.source.ref });
    }
    if (resolution.save && step.id && options.onSaveBindings) {
      let next = bindings;
      for (const change of changes) {
        next = upsertBinding(next, {
          target: { ...change.address, key: change.fieldName },
          source: change.source
            ? { stepId: change.source.stepId, stepName: change.source.stepName, orderIndex: change.source.orderIndex, path: change.source.path }
            : { value: String(change.value) },
          origin: "manual",
          createdAt: new Date().toISOString(),
        });
      }
      await options.onSaveBindings(step.id, next);
      bindings = next;
      savedMapping = true;
    }
  }
  if (savedMapping && recovery) recovery.savedMapping = true;
  // Mappings that just worked are verified; inferred ones are pinned to the path they matched.
  if ((state === "PASSED" || state === "RECOVERED") && step.id && options.onSaveBindings) {
    const verified = verifyBindings(bindings, bound.resolvedPaths);
    if (verified) await options.onSaveBindings(step.id, verified);
  }

  // Response mapping runs only on success, before anything is published to later steps.
  let extractions: ExtractionOutcome[] | undefined;
  const response = context.lastHttpResponse;
  if ((state === "PASSED" || state === "RECOVERED") && Array.isArray(config.extract) && config.extract.length > 0) {
    if (!response) {
      state = "FAILED";
      result = { ...result, error: "No HTTP response available for response mapping" };
    } else {
      const mapped = runExtractions(config, response, context, { stepId: step.id, stepName: step.name, orderIndex: step.orderIndex });
      extractions = mapped.outcomes;
      if (mapped.error) {
        state = "FAILED";
        result = { ...result, error: mapped.error };
      } else if (Object.keys(mapped.learned).length > 0) {
        // The response was redacted before a mapping marked some of its values secret.
        result = {
          ...result,
          output: context.redact(result.output),
          resolvedInput: context.redact(result.resolvedInput),
          extractedVars: context.redact({ ...(result.extractedVars ?? {}), ...mapped.learned }) as Record<string, string>,
        };
      }
    }
  }
  if (state !== "PASSED" && state !== "RECOVERED") {
    context.restore(before);
    result = { ...result, extractedVars: undefined };
  }

  let produced: RegistryEntry[] = [];
  if ((state === "PASSED" || state === "RECOVERED") && response && response.status < 400) {
    context.history.push({ stepId: step.id, orderIndex: step.orderIndex, name: step.name, response });
    produced = context.registry.addResponse(
      { stepId: step.id, stepName: step.name, orderIndex: step.orderIndex },
      { status: response.status, headers: response.headers, body: response.body, cookies: response.cookies },
    );
    const source = (path: string) => ({ stepId: step.id, stepName: step.name, orderIndex: step.orderIndex, path });
    for (const entry of produced) {
      if (entry.secret) context.markSecret(entry.text);
      // Location: /orders/9812 → orderId, when nothing defined it yet.
      if (entry.kind === "location" && !context.isInitial(entry.semanticKey) && context.get(entry.semanticKey) === undefined) {
        context.set(entry.semanticKey, entry.text);
        context.describeVariable(entry.semanticKey, { type: entry.type, source: source(entry.path) });
      }
    }
    for (const [key, path] of context.pendingPaths) context.describeVariable(key, { source: source(path) });
    for (const outcome of extractions ?? []) {
      const mappedPath = outcome.status === "EXTRACTED" ? context.sourceOf(outcome.variable)?.path : undefined;
      if (mappedPath) context.registry.markExplicit(step.orderIndex, mappedPath, outcome.variable);
    }
  }
  context.pendingPaths.clear();

  const finished = finish(result, state, recovery, checks, state === "NEEDS_INPUT" ? manual ?? buildManualOptions(request, recovery, context.registry, context.secretSet()) : undefined, produced, context);
  return {
    result: extractions ? { ...finished, extractions } : finished,
    pausedMs,
  };
}

/** The step result as stored: state, recovery trace, assertion checks, values it produced. */
function finish(
  result: StepExecutionResult,
  state: HttpStepState,
  recovery: RecoveryTrace | undefined,
  checks: AssertionCheck[],
  manual: ManualRecoveryOptions | undefined,
  produced: RegistryEntry[],
  context?: ExecutionContext,
): StepExecutionResult {
  const secrets = context?.secretSet();
  return {
    ...result,
    status: state,
    ...(state === "NEEDS_INPUT" || state === "FAILED"
      ? { error: result.error ?? recovery?.failures.join("; ") ?? "Request did not meet its expectation" }
      : { error: undefined }),
    ...(recovery ? { recovery } : {}),
    ...(checks.length ? { assertions: checks } : {}),
    ...(manual ? { manual } : {}),
    ...(produced.length
      ? {
          values: produced.slice(0, 80).map((entry) => viewEntry(entry, secrets)),
          important: importantValues(produced, 8, secrets),
        }
      : {}),
  };
}
