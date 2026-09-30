import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DatabaseConnectorsService } from "../database-connectors/database-connectors.service";
import { PrismaService } from "../prisma/prisma.service";
import { applyDependency, type DependencyChange } from "../scenario-engine/flow/apply-dependency";
import { analyzeDependencies, type FlowHttpStep } from "../scenario-engine/flow/dependency-analyzer";
import { flowHealth, validateFlow } from "../scenario-engine/flow/flow-validator";
import { parseCurl, splitCurlCommands } from "../scenario-engine/flow/parse-curl";
import { analyzeResponse } from "../scenario-engine/flow/response-analyzer";
import { ScenarioRunner } from "../scenario-engine/scenario.runner";

@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ScenarioRunner,
    private readonly connectors: DatabaseConnectorsService,
  ) {}

  list() {
    return this.prisma.scenario.findMany({
      include: {
        steps: { orderBy: { orderIndex: "asc" } },
        environment: true,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { stepRuns: { orderBy: { orderIndex: "asc" } } },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async get(id: string) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { orderIndex: "asc" } },
        environment: true,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { stepRuns: { orderBy: { orderIndex: "asc" } } },
        },
      },
    });
    if (!scenario) throw new NotFoundException("Scenario not found");
    return scenario;
  }

  create(input: {
    name: string;
    description?: string;
    environmentId?: string;
    stopOnFailure?: boolean;
  }) {
    return this.prisma.scenario.create({
      data: {
        name: input.name,
        description: input.description ?? "",
        environmentId: input.environmentId,
        stopOnFailure: input.stopOnFailure ?? true,
      },
    });
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      environmentId: string | null;
      stopOnFailure: boolean;
    }>,
  ) {
    return this.prisma.scenario.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.prisma.scenario.delete({ where: { id } });
    return { ok: true };
  }

  async duplicate(id: string) {
    const scenario = await this.get(id);
    return this.prisma.scenario.create({
      data: {
        name: `${scenario.name} (copy)`,
        description: scenario.description,
        environmentId: scenario.environmentId,
        stopOnFailure: scenario.stopOnFailure,
        steps: {
          create: scenario.steps.map((s) => ({
            name: s.name,
            type: s.type,
            orderIndex: s.orderIndex,
            enabled: s.enabled,
            config: s.config as Prisma.InputJsonValue,
          })),
        },
      },
      include: { steps: true },
    });
  }

  async addStep(
    scenarioId: string,
    input: {
      name: string;
      type: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    const known = this.runner.getRegistry().list();
    if (!known.includes(input.type)) {
      throw new BadRequestException(`Unknown StepType: ${input.type}`);
    }
    if (input.type === "DATABASE_ACTION") {
      await this.connectors.assertStepConfig(input.config ?? {});
    }
    return this.prisma.scenarioStep.create({
      data: {
        scenarioId,
        name: input.name,
        type: input.type,
        orderIndex: await this.nextOrderIndex(scenarioId),
        enabled: input.enabled ?? true,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async updateStep(
    stepId: string,
    data: Partial<{
      name: string;
      config: Record<string, unknown>;
      enabled: boolean;
      orderIndex: number;
    }>,
  ) {
    if (data.config) {
      const current = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
      if (current?.type === "DATABASE_ACTION") {
        await this.connectors.assertStepConfig(data.config);
      }
    }
    return this.prisma.scenarioStep.update({
      where: { id: stepId },
      data: {
        name: data.name,
        enabled: data.enabled,
        orderIndex: data.orderIndex,
        config: data.config
          ? (data.config as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }

  async deleteStep(stepId: string) {
    await this.prisma.scenarioStep.delete({ where: { id: stepId } });
    return { ok: true };
  }

  /** Append position: one past the highest index (count collides after a delete). */
  private async nextOrderIndex(scenarioId: string) {
    const { _max } = await this.prisma.scenarioStep.aggregate({
      where: { scenarioId },
      _max: { orderIndex: true },
    });
    return (_max.orderIndex ?? -1) + 1;
  }

  async reorderSteps(scenarioId: string, stepIds: string[]) {
    if (!Array.isArray(stepIds) || stepIds.some((id) => typeof id !== "string")) {
      throw new BadRequestException("stepIds must be a list of step ids");
    }
    const owned = await this.prisma.scenarioStep.findMany({
      where: { scenarioId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((step) => step.id));
    // The new order must name exactly this scenario's steps: a foreign id
    // would otherwise move another scenario's step into this one.
    if (
      new Set(stepIds).size !== stepIds.length ||
      stepIds.length !== ownedIds.size ||
      stepIds.some((id) => !ownedIds.has(id))
    ) {
      throw new BadRequestException("stepIds must list every step of this scenario exactly once");
    }
    await this.prisma.$transaction(
      stepIds.map((id, orderIndex) =>
        this.prisma.scenarioStep.update({
          where: { id },
          data: { orderIndex },
        }),
      ),
    );
    return this.get(scenarioId);
  }

  async duplicateStep(stepId: string) {
    const step = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
    if (!step) throw new NotFoundException("Step not found");
    return this.prisma.scenarioStep.create({
      data: {
        scenarioId: step.scenarioId,
        name: `${step.name} (copy)`,
        type: step.type,
        orderIndex: await this.nextOrderIndex(step.scenarioId),
        enabled: step.enabled,
        config: step.config as Prisma.InputJsonValue,
      },
    });
  }

  /** Live async start — returns RUNNING immediately. */
  start(scenarioId: string) {
    return this.runner.start(scenarioId);
  }

  /** Await full completion (scripts/demo). */
  run(scenarioId: string) {
    return this.runner.run(scenarioId);
  }

  getRun(runId: string) {
    return this.runner.getRun(runId);
  }

  cancel(runId: string) {
    return this.runner.cancel(runId);
  }

  async importCurl(scenarioId: string, text: string) {
    await this.get(scenarioId);
    const commands = splitCurlCommands(text);
    if (commands.length === 0) {
      throw new BadRequestException("The cURL command has no URL.");
    }
    for (const command of commands) {
      const parsed = parseCurl(command);
      if (!parsed.ok) {
        throw new BadRequestException(`cURL ${parsed.code}`);
      }
      let pathname = parsed.config.url;
      try {
        pathname = new URL(parsed.config.url).pathname || parsed.config.url;
      } catch {
        pathname = parsed.config.url;
      }
      await this.addStep(scenarioId, {
        name: `${parsed.config.method} ${pathname}`,
        type: "HTTP_REQUEST",
        config: { ...parsed.config, originalCurl: command },
      });
    }
    return this.get(scenarioId);
  }

  async analyzeFlow(scenarioId: string) {
    const scenario = await this.get(scenarioId);
    const steps = scenario.steps.map(toFlowStep);
    const samples = samplesFromRun(scenario.runs[0]);
    const dependencies = analyzeDependencies(steps, samples);
    const envKeys = scenario.environmentId
      ? (
          await this.prisma.environmentVariable.findMany({
            where: { environmentId: scenario.environmentId },
            select: { key: true },
          })
        ).map((item) => item.key)
      : [];
    const sampleBodies = Object.fromEntries(
      samples.map((sample) => [sample.stepId, sample.body]),
    );
    const issues = validateFlow(
      scenario.steps.map((step) => ({
        id: step.id,
        name: step.name,
        type: step.type,
        orderIndex: step.orderIndex,
        enabled: step.enabled,
        config: asRecord(step.config),
      })),
      { environmentKeys: envKeys, sampleBodies },
    );
    const responses = scenario.steps
      .filter((step) => step.type === "HTTP_REQUEST")
      .map((step) => {
        const sample = samples.find((item) => item.stepId === step.id);
        const run = scenario.runs[0]?.stepRuns.find((item) => item.scenarioStepId === step.id);
        const consumed = dependencies
          .filter((item) => item.producerStepId === step.id)
          .map((item) => item.sourcePath);
        return {
          stepId: step.id,
          analysis: analyzeResponse({
            status: sample?.status ?? null,
            headers: sample?.headers ?? null,
            body: sample?.body,
            durationMs: run?.durationMs ?? null,
            raw: sample?.body === undefined ? null : JSON.stringify(sample.body),
            consumedPaths: consumed,
          }),
        };
      });
    return {
      dependencies,
      issues,
      health: flowHealth({
        steps: scenario.steps.map((step) => ({
          id: step.id,
          name: step.name,
          type: step.type,
          orderIndex: step.orderIndex,
          enabled: step.enabled,
          config: asRecord(step.config),
        })),
        dependencies: dependencies.filter((item) => item.confidence === "HIGH").length,
        issues,
      }),
      responses,
    };
  }

  async acceptDependency(scenarioId: string, change: DependencyChange) {
    const scenario = await this.get(scenarioId);
    const sample = samplesFromRun(scenario.runs[0]).find(
      (item) => item.stepId === change.producerStepId,
    );
    if (!sample) {
      throw new BadRequestException("Run the source request before accepting this dependency");
    }
    const planned = applyDependency(
      scenario.steps.map(toFlowStep),
      change,
      sample.body,
    );
    await this.prisma.$transaction(async (tx) => {
      const extract = planned.steps.find((step) => step.id.startsWith("extract-"));
      if (planned.insertedExtract && extract) {
        await tx.scenarioStep.create({
          data: {
            scenarioId,
            name: extract.name,
            type: "EXTRACT_VARIABLE",
            orderIndex: extract.orderIndex,
            config: extract.config as Prisma.InputJsonValue,
          },
        });
      }
      for (const step of planned.steps) {
        if (step.id.startsWith("extract-")) continue;
        await tx.scenarioStep.update({
          where: { id: step.id },
          data: {
            orderIndex: step.orderIndex,
            ...(step.id === change.consumerStepId
              ? { config: step.config as Prisma.InputJsonValue }
              : {}),
          },
        });
      }
    });
    return this.analyzeFlow(scenarioId);
  }

  listRuns(scenarioId?: string) {
    return this.prisma.scenarioRun.findMany({
      where: scenarioId ? { scenarioId } : undefined,
      include: {
        scenario: true,
        stepRuns: { orderBy: { orderIndex: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toFlowStep(step: {
  id: string;
  name: string;
  type: string;
  orderIndex: number;
  config: unknown;
}): FlowHttpStep {
  return {
    id: step.id,
    name: step.name,
    type: step.type,
    orderIndex: step.orderIndex,
    config: asRecord(step.config),
  };
}

function samplesFromRun(
  run:
    | {
        stepRuns: Array<{
          scenarioStepId: string | null;
          output: unknown;
        }>;
      }
    | undefined,
) {
  if (!run) return [];
  return run.stepRuns.flatMap((stepRun) => {
    if (!stepRun.scenarioStepId) return [];
    const output = asRecord(stepRun.output);
    if (output.body === undefined && output.status === undefined) return [];
    return [
      {
        stepId: stepRun.scenarioStepId,
        status: typeof output.status === "number" ? output.status : undefined,
        headers: asRecord(output.headers) as Record<string, string>,
        body: output.body,
      },
    ];
  });
}
