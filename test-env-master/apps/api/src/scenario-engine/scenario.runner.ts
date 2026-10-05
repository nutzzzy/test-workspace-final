import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AIService } from "../ai/ai.service";
import { PrismaService } from "../prisma/prisma.service";
import { EnvironmentsService } from "../environments/environments.service";
import { DatabaseConnectorsService } from "../database-connectors/database-connectors.service";
import { AssertionExecutor } from "./executors/assertion.executor";
import { ConditionExecutor } from "./executors/condition.executor";
import { DatabaseActionExecutor } from "./executors/database-action.executor";
import { DelayExecutor } from "./executors/delay.executor";
import { ExtractVariableExecutor } from "./executors/extract-variable.executor";
import { HttpRequestExecutor } from "./executors/http-request.executor";
import { SetVariableExecutor } from "./executors/set-variable.executor";
import { UiFlowExecutor, type UiLearning } from "./executors/ui-flow.executor";
import { decryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import type { UiAction } from "./ui/ui-types";
import type { StorageSeed } from "./ui/browser-session";
import type { StepBinding } from "./flow/bindings";
import { parseResolution, type ManualResolution } from "./flow/manual-recovery";
import type { SemanticRanker } from "./flow/recover-step";
import { orchestrateSteps, type LiveStepProgress, type PendingInput } from "./orchestrate";
import { StepExecutorRegistry } from "./step-executor.registry";
import { ExecutionContext } from "./types";

export const INTERRUPTED_RUN_ERROR =
  "Run was interrupted because the API restarted before it finished";

/** How long a run waits for Manual Recovery before the step stays NEEDS_INPUT. */
const INPUT_TIMEOUT_MS = 30 * 60 * 1000;

type Waiting = {
  orderIndex: number;
  stepRunId: string;
  resolve: (resolution: ManualResolution | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RunOptions = {
  /** Run the scenario up to and including this step only. */
  untilStepId?: string;
};

const RANK_SCHEMA = z.object({ candidateIds: z.array(z.string()).max(10) });

@Injectable()
export class ScenarioRunner implements OnModuleInit {
  private readonly logger = new Logger(ScenarioRunner.name);
  private readonly registry = new StepExecutorRegistry();
  private readonly active = new Map<string, ExecutionContext>();
  /** Live (not persisted) progress per run: running step, recovery attempt. */
  private readonly live = new Map<string, LiveStepProgress>();
  /** Runs paused on a NEEDS_INPUT step, waiting for Manual Recovery. */
  private readonly waiting = new Map<string, Waiting>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly environments: EnvironmentsService,
    connectors: DatabaseConnectorsService,
    @Optional() private readonly ai?: AIService,
  ) {
    for (const executor of [
      new HttpRequestExecutor(),
      new AssertionExecutor(),
      new ExtractVariableExecutor(),
      new SetVariableExecutor(),
      new DelayExecutor(),
      new ConditionExecutor(),
      new DatabaseActionExecutor(connectors),
      new UiFlowExecutor((payload) => decryptSecret(payload, resolveEncryptionKey(process.env.SECRETS_ENCRYPTION_KEY))),
    ]) {
      this.registry.register(executor);
    }
  }

  /**
   * Runs execute in this process only, so a RUNNING row found at start-up can
   * never finish. Mark it FAILED with an explicit reason instead of leaving it
   * "running" forever.
   */
  async onModuleInit() {
    try {
      const { count } = await this.prisma.scenarioRun.updateMany({
        where: { status: { in: ["RUNNING", "PENDING", "NEEDS_INPUT"] }, finishedAt: null },
        data: { status: "FAILED", finishedAt: new Date(), error: INTERRUPTED_RUN_ERROR },
      });
      if (count > 0) this.logger.warn(`Marked ${count} interrupted scenario run(s) as FAILED`);
    } catch (error) {
      this.logger.warn(
        `Could not reconcile interrupted runs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getRegistry() {
    return this.registry;
  }

  /**
   * Optional model ranking for `recovery.aiAssist` steps. It only sees
   * candidate metadata (step, key, path, type) and the error message — never
   * values. No reachable model means "no suggestion".
   */
  private semanticRanker(): SemanticRanker {
    return async (input) => {
      if (!this.ai) return [];
      const data = await this.ai.tryStructured("analysis", {
        system:
          "You rank which earlier API response field most likely supplies a request input. Answer with candidate ids only.",
        prompt: JSON.stringify(input),
        schema: RANK_SCHEMA,
      });
      return data ? data.candidateIds.slice(0, 3) : [];
    };
  }

  async getRun(runId: string) {
    const run = await this.prisma.scenarioRun.findUnique({
      where: { id: runId },
      include: {
        scenario: true,
        stepRuns: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!run) throw new NotFoundException("Scenario run not found");
    const live = this.live.get(runId);
    const waiting = this.waiting.get(runId);
    return {
      ...run,
      live: live ? { ...live, awaitingInput: Boolean(waiting), stepRunId: waiting?.stepRunId ?? null } : null,
    };
  }

  /** Continue a paused run with the user's Manual Recovery choice. */
  async resolveInput(runId: string, body: unknown) {
    const waiting = this.waiting.get(runId);
    if (!waiting) throw new BadRequestException("This run is not waiting for input");
    const resolution = parseResolution(body);
    if (!resolution) throw new BadRequestException("Choose a target field and a value");
    this.release(runId, resolution);
    await this.prisma.scenarioRun.updateMany({ where: { id: runId, status: "NEEDS_INPUT" }, data: { status: "RUNNING" } });
    return this.getRun(runId);
  }

  /** Stop waiting: the step stays NEEDS_INPUT and the run continues or stops as configured. */
  async skipInput(runId: string) {
    if (!this.waiting.has(runId)) throw new BadRequestException("This run is not waiting for input");
    this.release(runId, null);
    await this.prisma.scenarioRun.updateMany({ where: { id: runId, status: "NEEDS_INPUT" }, data: { status: "RUNNING" } });
    return this.getRun(runId);
  }

  private release(runId: string, resolution: ManualResolution | null) {
    const waiting = this.waiting.get(runId);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.waiting.delete(runId);
    waiting.resolve(resolution);
  }

  async cancel(runId: string) {
    const ctx = this.active.get(runId);
    if (ctx) {
      ctx.cancel();
      this.release(runId, null);
      return { ok: true, live: true };
    }
    const run = await this.prisma.scenarioRun.findUnique({
      where: { id: runId },
    });
    if (run && !run.finishedAt && (run.status === "RUNNING" || run.status === "NEEDS_INPUT")) {
      await this.prisma.scenarioRun.update({
        where: { id: runId },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
    }
    return { ok: true, live: false };
  }

  /**
   * Starts a run asynchronously and returns immediately (RUNNING)
   * so the UI can poll + cancel (live execution).
   */
  async start(scenarioId: string, options: RunOptions = {}) {
    const prepared = await this.prepareRun(scenarioId, options);
    void this.executePrepared(prepared, { interactive: true }).catch((error) => {
      this.logger.error(
        `Scenario run ${prepared.runId} crashed`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    return this.getRun(prepared.runId);
  }

  /**
   * Run the steps before `beforeOrderIndex` in memory — no run is saved — so
   * a UI recording can open signed in with what they obtained. The caller
   * disposes the returned context (it may hold the UI steps' browser).
   */
  async runBefore(scenarioId: string, beforeOrderIndex: number) {
    const found = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: { steps: { orderBy: { orderIndex: "asc" } } },
    });
    if (!found) throw new NotFoundException("Scenario not found");
    const envVars = found.environmentId ? await this.environments.getResolvedVariables(found.environmentId) : {};
    const secretKeys = found.environmentId ? await this.environments.getSecretKeys(found.environmentId) : [];
    const context = new ExecutionContext(envVars, { secretKeys });
    const steps = found.steps.filter((step) => step.orderIndex < beforeOrderIndex);
    const ran: Array<{ name: string; status: string; error?: string }> = [];
    const result = await orchestrateSteps(
      steps.map((step) => ({
        id: step.id,
        name: step.name,
        type: step.type,
        orderIndex: step.orderIndex,
        enabled: step.enabled,
        config: (step.config ?? {}) as Record<string, unknown>,
      })),
      this.registry,
      context,
      // The browser of earlier UI steps must outlive these steps: the recording takes over its session.
      { stopOnFailure: true, keepResources: true, onStepComplete: (step) => void ran.push({ name: step.name, status: step.status, ...(step.error ? { error: step.error } : {}) }) },
    ).catch((error: unknown) => ({ status: "FAILED" as const, error: error instanceof Error ? error.message : String(error), stepResults: [] }));
    return { context, ran, status: result.status };
  }

  /** Synchronous full run — useful for scripts / demos that await completion. */
  async run(scenarioId: string, options: RunOptions = {}) {
    const prepared = await this.prepareRun(scenarioId, options);
    await this.executePrepared(prepared, { interactive: false });
    return this.getRun(prepared.runId);
  }

  private async prepareRun(scenarioId: string, options: RunOptions) {
    const found = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: { steps: { orderBy: { orderIndex: "asc" } } },
    });
    if (!found) throw new NotFoundException("Scenario not found");
    let scenario = found;
    if (options.untilStepId) {
      // Run one step with everything before it, in a fresh context: a step
      // never reads values left over from an earlier run.
      const target = found.steps.find((step) => step.id === options.untilStepId);
      if (!target) throw new NotFoundException("Step not found");
      scenario = { ...found, steps: found.steps.filter((step) => step.orderIndex <= target.orderIndex) };
    }

    const envVars = scenario.environmentId
      ? await this.environments.getResolvedVariables(scenario.environmentId)
      : {};
    const secretKeys = scenario.environmentId
      ? await this.environments.getSecretKeys(scenario.environmentId)
      : [];
    const context = new ExecutionContext(envVars, { secretKeys });

    const run = await this.prisma.scenarioRun.create({
      data: {
        scenarioId: scenario.id,
        environmentId: scenario.environmentId,
        status: "RUNNING",
        startedAt: new Date(),
        variablesJson: context.redact(envVars) as Prisma.InputJsonValue,
      },
    });

    this.active.set(run.id, context);

    return {
      runId: run.id,
      scenario,
      context,
      startedAt: run.startedAt ?? new Date(),
    };
  }

  private async executePrepared(prepared: {
    runId: string;
    scenario: {
      id: string;
      stopOnFailure: boolean;
      steps: Array<{
        id: string;
        name: string;
        type: string;
        orderIndex: number;
        enabled: boolean;
        config: Prisma.JsonValue;
      }>;
    };
    context: ExecutionContext;
    startedAt: Date;
  }, mode: { interactive: boolean }) {
    const { runId, scenario, context, startedAt } = prepared;
    let finalStatus: "PASSED" | "FAILED" | "CANCELLED" | "NEEDS_INPUT" = "PASSED";
    let runError: string | undefined;
    /** Step-run rows written while a step waited for input, updated when it finishes. */
    const interimRows = new Map<number, string>();

    const rowData = (stepResult: import("./types").OrchestrationStepResult) => {
      const matching = scenario.steps.find(
        (s) => s.orderIndex === stepResult.orderIndex && s.name === stepResult.name,
      );
      const finishedAt = new Date();
      return {
        scenarioRunId: runId,
        scenarioStepId: matching?.id,
        name: stepResult.name,
        type: stepResult.type,
        orderIndex: stepResult.orderIndex,
        status: stepResult.status,
        startedAt: new Date(finishedAt.getTime() - stepResult.durationMs),
        finishedAt,
        durationMs: stepResult.durationMs,
        resolvedInput: stepResult.resolvedInput
          ? (context.redact(stepResult.resolvedInput) as Prisma.InputJsonValue)
          : undefined,
        output: persistedOutput(stepResult, context),
        error: stepResult.error ? (context.redact(stepResult.error) as string) : null,
        extractedVars: stepResult.extractedVars
          ? (context.redact(stepResult.extractedVars) as Prisma.InputJsonValue)
          : undefined,
      };
    };
    const createRow = async (data: ReturnType<typeof rowData>) => {
      try {
        return await this.prisma.scenarioStepRun.create({ data });
      } catch (error) {
        // The step may have been deleted while the run was executing;
        // keep the result (it is a snapshot) without the dangling link.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003" &&
          data.scenarioStepId
        ) {
          return this.prisma.scenarioStepRun.create({ data: { ...data, scenarioStepId: undefined } });
        }
        throw error;
      }
    };

    const awaitInput = async (pending: PendingInput) => {
      const data = rowData(pending.result);
      const existing = interimRows.get(pending.orderIndex);
      const row = existing
        ? await this.prisma.scenarioStepRun.update({ where: { id: existing }, data })
        : await createRow(data);
      interimRows.set(pending.orderIndex, row.id);
      await this.prisma.scenarioRun.updateMany({
        where: { id: runId, status: "RUNNING" },
        data: { status: "NEEDS_INPUT", variablesJson: context.redact(context.entries()) as Prisma.InputJsonValue },
      });
      if (context.isCancelled()) return null;
      return new Promise<ManualResolution | null>((resolve) => {
        const timer = setTimeout(() => this.release(runId, null), INPUT_TIMEOUT_MS);
        this.waiting.set(runId, { orderIndex: pending.orderIndex, stepRunId: row.id, resolve, timer });
      });
    };

    const onSaveBindings = async (stepId: string, bindings: StepBinding[]) => {
      const current = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
      if (!current) return;
      const config = (current.config ?? {}) as Record<string, unknown>;
      await this.prisma.scenarioStep.update({
        where: { id: stepId },
        data: { config: { ...config, bindings } as unknown as Prisma.InputJsonValue },
      });
    };

    /** A replay found an element another way: remember it, so the next run tries that first. */
    const onLearnUi = async (stepId: string, learned: UiLearning[], storage?: StorageSeed) => {
      const current = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
      if (!current) return;
      const config = (current.config ?? {}) as Record<string, unknown>;
      const actions = Array.isArray(config.actions) ? (config.actions as UiAction[]) : [];
      const next = actions.map((action) => {
        const lesson = learned.find((item) => item.actionId === action.id);
        if (!lesson || !action.target) return action;
        if (lesson.healedCandidate) {
          const candidates = [lesson.healedCandidate, ...action.target.candidates.filter((item) => item.value !== lesson.healedCandidate!.value)].slice(0, 10);
          return { ...action, target: { ...action.target, candidates, learned: 0 } };
        }
        return { ...action, target: { ...action.target, learned: lesson.candidateIndex } };
      });
      // Where the app keeps its token: named on the step, so it is no longer guessed.
      const session = (config.session ?? {}) as { storage?: unknown[] };
      const learnedSession = storage && !session.storage?.length ? { session: { ...session, storage: [storage] } } : {};
      await this.prisma.scenarioStep.update({
        where: { id: stepId },
        data: { config: { ...config, actions: next, ...learnedSession } as unknown as Prisma.InputJsonValue },
      });
    };

    try {
      const result = await orchestrateSteps(
        scenario.steps.map((step) => ({
          id: step.id,
          name: step.name,
          type: step.type,
          orderIndex: step.orderIndex,
          enabled: step.enabled,
          config: (step.config ?? {}) as Record<string, unknown>,
        })),
        this.registry,
        context,
        {
          stopOnFailure: scenario.stopOnFailure,
          ranker: this.ai ? this.semanticRanker() : undefined,
          onLearnUi,
          onProgress: (progress) => {
            this.live.set(runId, progress);
          },
          ...(mode.interactive ? { awaitInput, onSaveBindings } : { onSaveBindings }),
          onStepComplete: async (stepResult) => {
            const data = rowData(stepResult);
            const interim = interimRows.get(stepResult.orderIndex);
            if (interim) {
              await this.prisma.scenarioStepRun.update({ where: { id: interim }, data });
              interimRows.delete(stepResult.orderIndex);
            } else {
              await createRow(data);
            }
            // Live variables snapshot for polling UI
            await this.prisma.scenarioRun.update({
              where: { id: runId },
              data: {
                variablesJson: context.redact(
                  context.entries(),
                ) as Prisma.InputJsonValue,
              },
            });
          },
        },
      );

      finalStatus = result.status;
      runError = result.error;
    } catch (error) {
      finalStatus = "FAILED";
      runError =
        error instanceof Error ? error.message : "Scenario execution failed";
    } finally {
      this.active.delete(runId);
      this.live.delete(runId);
      this.release(runId, null);
    }

    if (context.isCancelled()) {
      finalStatus = "CANCELLED";
    }

    const finishedAt = new Date();
    // Only a run that is still RUNNING is finalized here: a cancellation
    // recorded meanwhile (e.g. through the non-live cancel path) wins.
    await this.prisma.scenarioRun.updateMany({
      where: { id: runId, status: { in: ["RUNNING", "NEEDS_INPUT"] } },
      data: {
        status: finalStatus,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: runError ? (context.redact(runError) as string) : undefined,
        variablesJson: context.redact(context.entries()) as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * Step output as stored: the executor output plus, when present, the
 * variables the step consumed, its recovery trace, assertion checks, the
 * values it produced and Manual Recovery options — all redacted. Kept inside
 * `output` so existing runs and readers stay compatible.
 */
function persistedOutput(
  stepResult: import("./types").StepExecutionResult,
  context: ExecutionContext,
): Prisma.InputJsonValue | undefined {
  const flow: Record<string, unknown> = {};
  for (const key of ["consumedVars", "recovery", "assertions", "manual", "blocked", "values", "important", "extractions", "responseError"] as const) {
    if (stepResult[key] !== undefined) flow[key] = stepResult[key];
  }
  if (Object.keys(flow).length === 0) {
    return stepResult.output ? (context.redact(stepResult.output) as Prisma.InputJsonValue) : undefined;
  }
  const base =
    stepResult.output && typeof stepResult.output === "object" && !Array.isArray(stepResult.output)
      ? (stepResult.output as Record<string, unknown>)
      : stepResult.output === undefined
        ? {}
        : { value: stepResult.output };
  return context.redact({ ...base, ...flow }) as Prisma.InputJsonValue;
}
