import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
import { orchestrateSteps } from "./orchestrate";
import { StepExecutorRegistry } from "./step-executor.registry";
import { ExecutionContext } from "./types";

export const INTERRUPTED_RUN_ERROR =
  "Run was interrupted because the API restarted before it finished";

@Injectable()
export class ScenarioRunner implements OnModuleInit {
  private readonly logger = new Logger(ScenarioRunner.name);
  private readonly registry = new StepExecutorRegistry();
  private readonly active = new Map<string, ExecutionContext>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly environments: EnvironmentsService,
    connectors: DatabaseConnectorsService,
  ) {
    for (const executor of [
      new HttpRequestExecutor(),
      new AssertionExecutor(),
      new ExtractVariableExecutor(),
      new SetVariableExecutor(),
      new DelayExecutor(),
      new ConditionExecutor(),
      new DatabaseActionExecutor(connectors),
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
        where: { status: { in: ["RUNNING", "PENDING"] } },
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

  async getRun(runId: string) {
    const run = await this.prisma.scenarioRun.findUnique({
      where: { id: runId },
      include: {
        scenario: true,
        stepRuns: { orderBy: { orderIndex: "asc" } },
      },
    });
    if (!run) throw new NotFoundException("Scenario run not found");
    return run;
  }

  async cancel(runId: string) {
    const ctx = this.active.get(runId);
    if (ctx) {
      ctx.cancel();
      return { ok: true, live: true };
    }
    const run = await this.prisma.scenarioRun.findUnique({
      where: { id: runId },
    });
    if (run && run.status === "RUNNING") {
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
  async start(scenarioId: string) {
    const prepared = await this.prepareRun(scenarioId);
    void this.executePrepared(prepared).catch((error) => {
      this.logger.error(
        `Scenario run ${prepared.runId} crashed`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    return this.getRun(prepared.runId);
  }

  /** Synchronous full run — useful for scripts / demos that await completion. */
  async run(scenarioId: string) {
    const prepared = await this.prepareRun(scenarioId);
    await this.executePrepared(prepared);
    return this.getRun(prepared.runId);
  }

  private async prepareRun(scenarioId: string) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: { steps: { orderBy: { orderIndex: "asc" } } },
    });
    if (!scenario) throw new NotFoundException("Scenario not found");

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
  }) {
    const { runId, scenario, context, startedAt } = prepared;
    let finalStatus: "PASSED" | "FAILED" | "CANCELLED" = "PASSED";
    let runError: string | undefined;

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
          onStepComplete: async (stepResult) => {
            const matching = scenario.steps.find(
              (s) =>
                s.orderIndex === stepResult.orderIndex &&
                s.name === stepResult.name,
            );
            const finishedAt = new Date();
            const startedAtStep = new Date(
              finishedAt.getTime() - stepResult.durationMs,
            );
            const data = {
                scenarioRunId: runId,
                scenarioStepId: matching?.id,
                name: stepResult.name,
                type: stepResult.type,
                orderIndex: stepResult.orderIndex,
                status: stepResult.status,
                startedAt: startedAtStep,
                finishedAt,
                durationMs: stepResult.durationMs,
                resolvedInput: stepResult.resolvedInput
                  ? (context.redact(stepResult.resolvedInput) as Prisma.InputJsonValue)
                  : undefined,
                output: persistedOutput(stepResult, context),
                error: stepResult.error
                  ? (context.redact(stepResult.error) as string)
                  : undefined,
                extractedVars: stepResult.extractedVars
                  ? (context.redact(stepResult.extractedVars) as Prisma.InputJsonValue)
                  : undefined,
            };
            try {
              await this.prisma.scenarioStepRun.create({ data });
            } catch (error) {
              // The step may have been deleted while the run was executing;
              // keep the result (it is a snapshot) without the dangling link.
              if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === "P2003" &&
                data.scenarioStepId
              ) {
                await this.prisma.scenarioStepRun.create({
                  data: { ...data, scenarioStepId: undefined },
                });
              } else {
                throw error;
              }
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
    }

    if (context.isCancelled()) {
      finalStatus = "CANCELLED";
    }

    const finishedAt = new Date();
    // Only a run that is still RUNNING is finalized here: a cancellation
    // recorded meanwhile (e.g. through the non-live cancel path) wins.
    await this.prisma.scenarioRun.updateMany({
      where: { id: runId, status: "RUNNING" },
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
 * variables the step consumed and its recovery trace — both redacted. Kept
 * inside `output` so existing runs and readers stay compatible.
 */
function persistedOutput(
  stepResult: { output?: unknown; consumedVars?: unknown; recovery?: unknown },
  context: ExecutionContext,
): Prisma.InputJsonValue | undefined {
  const flow = {
    ...(stepResult.consumedVars ? { consumedVars: stepResult.consumedVars } : {}),
    ...(stepResult.recovery ? { recovery: stepResult.recovery } : {}),
  };
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
