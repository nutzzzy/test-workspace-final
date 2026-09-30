import { AssertionExecutor } from "./executors/assertion.executor";
import { expectedStatuses as expectedStatusOf, HttpRequestExecutor } from "./executors/http-request.executor";
import { recoverHttpStep } from "./flow/recover-step";
import type { StepExecutorRegistry } from "./step-executor.registry";
import type {
  ExecutionContext,
  OrchestrationResult,
  OrchestrationStep,
  OrchestrationStepResult,
} from "./types";

/**
 * Pure step-loop used by ScenarioRunner and unit tests.
 * Handles order, skip, cancel, stopOnFailure / continueOnFailure.
 */
export async function orchestrateSteps(
  steps: OrchestrationStep[],
  registry: StepExecutorRegistry,
  context: ExecutionContext,
  options: {
    stopOnFailure: boolean;
    onStepComplete?: (result: OrchestrationStepResult) => Promise<void> | void;
  },
): Promise<OrchestrationResult> {
  const stepResults: OrchestrationStepResult[] = [];
  let finalStatus: OrchestrationResult["status"] = "PASSED";
  let runError: string | undefined;

  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const assertions = new AssertionExecutor();

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
    let result;
    try {
      const executor = registry.resolve(step.type);
      if (executor instanceof HttpRequestExecutor) {
        result = await runHttpStep(executor, step, attachedAssertions(ordered, position), context, assertions);
      } else {
        result = await executor.execute(step.config ?? {}, context);
      }
    } catch (error) {
      result = {
        status: "FAILED" as const,
        error:
          error instanceof Error ? error.message : "Step execution failed",
      };
    }

    const stepResult: OrchestrationStepResult = {
      ...result,
      name: step.name,
      type: step.type,
      orderIndex: step.orderIndex,
      durationMs: Date.now() - started,
    };
    stepResults.push(stepResult);
    await options.onStepComplete?.(stepResult);

    if (context.isCancelled() || result.status === "CANCELLED") {
      finalStatus = "CANCELLED";
      runError = result.error ?? "Cancelled";
      break;
    }

    if (result.status === "FAILED") {
      finalStatus = "FAILED";
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

/**
 * Send an HTTP step, let bounded recovery handle an unmet expectation, and
 * record a successful response in the runtime flow context for later steps.
 */
async function runHttpStep(
  http: HttpRequestExecutor,
  step: OrchestrationStep,
  attached: Array<Record<string, unknown>>,
  context: ExecutionContext,
  assertions: AssertionExecutor,
) {
  const config = step.config ?? {};
  if (context.isCancelled()) {
    return { status: "CANCELLED" as const, error: "Cancelled before HTTP request" };
  }
  const { request, consumed } = http.prepare(config, context);
  const sent = await http.send(request, context, expectedStatusOf(config));
  const firstResult = consumed.length ? { ...sent, consumedVars: consumed } : sent;
  const { result, recovery } = await recoverHttpStep({
    config,
    request,
    firstResult,
    attachedAssertions: attached,
    context,
    http,
    assertions,
  });
  const response = context.lastHttpResponse;
  if (result.status === "PASSED" && response && response.status < 400) {
    context.history.push({ orderIndex: step.orderIndex, name: step.name, response });
  }
  return recovery ? { ...result, recovery } : result;
}
