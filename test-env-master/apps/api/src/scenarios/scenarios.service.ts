import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { maskSecrets, validateMappings } from "@qa-workbench/shared";
import { maskDeep } from "../common/mask.util";
import { DatabaseConnectorsService } from "../database-connectors/database-connectors.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { encryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import { UiRecorderService } from "../scenario-engine/ui/ui-recorder.service";
import { publicUiConfig, readUiConfig, sealUiConfig } from "../scenario-engine/ui/ui-types";
import { describeSeed, seedFromContext } from "../scenario-engine/ui/browser-session";
import { uiSessionState } from "../scenario-engine/executors/ui-flow.executor";
import {
  isBinding,
  isResponseSource,
  readBindings,
  removeBinding,
  sameTarget,
  upsertBinding,
  type StepBinding,
} from "../scenario-engine/flow/bindings";
import type { InputLocation } from "../scenario-engine/flow/request-inputs";
import type { DependencySuggestion, FlowHttpStep } from "../scenario-engine/flow/dependency-analyzer";
import { detectBodyError } from "../scenario-engine/flow/body-error";
import { flowHealth, validateFlow } from "../scenario-engine/flow/flow-validator";
import {
  bindingFromSuggestion,
  chooseAutoMappings,
  reviewMappings,
  suggestDependencies,
  type RecoveredInput,
} from "../scenario-engine/flow/mapping-review";
import { parseCurl, splitCurlCommands, type CurlWarning, type ParsedHttpRequest } from "../scenario-engine/flow/parse-curl";
import { inputFields } from "../scenario-engine/flow/request-dependencies";
import { analyzeResponse } from "../scenario-engine/flow/response-analyzer";
import { variableCatalog } from "../scenario-engine/flow/response-mapping";
import { ScenarioRunner, type RunOptions } from "../scenario-engine/scenario.runner";

/** Upper bounds for one paste: they keep parsing and analysis cheap. */
const MAX_IMPORT_TEXT = 200_000;
const MAX_IMPORT_COMMANDS = 50;

export type ImportItem =
  | {
      index: number;
      ok: true;
      name: string;
      method: string;
      url: string;
      /** Header names with masked values, query keys and the body kind — for review, not execution. */
      headers: Record<string, string>;
      query: string[];
      body: "none" | "json" | "form" | "text";
      warnings: Array<CurlWarning | { code: "duplicate_request"; detail: string }>;
    }
  | { index: number; ok: false; code: string; preview: string };

/** A step as the client sees it: secret values typed in UI steps are never sent back. */
export function publicStep<T extends { type: string; config: unknown }>(step: T): T {
  return step.type === "UI_FLOW" ? { ...step, config: publicUiConfig(asRecord(step.config)) as T["config"] } : step;
}

export function publicScenario<T extends { steps: Array<{ type: string; config: unknown }> }>(scenario: T): T {
  return { ...scenario, steps: scenario.steps.map(publicStep) };
}

@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ScenarioRunner,
    private readonly connectors: DatabaseConnectorsService,
    private readonly recorder: UiRecorderService,
    private readonly config: ConfigService,
  ) {}

  private encrypt = (plain: string) => encryptSecret(plain, resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY")));

  /** A UI step's config with typed secrets encrypted (the current ones kept when not retyped). */
  private sealUi(config: Record<string, unknown>, current: Record<string, unknown> | null) {
    try {
      return sealUiConfig(config, current, this.encrypt);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid UI step");
    }
  }

  // ── UI recording ──────────────────────────────────────────────────────

  /**
   * Open the recording browser. With `signedIn` (default), the steps before
   * the UI step run first — in memory, no run is saved — and the browser opens
   * with what they obtained: an earlier UI step's session, the cookies and
   * credential headers of earlier requests, and the storage entries the step names.
   */
  async startRecording(scenarioId: string, body: { startUrl?: unknown; stepId?: unknown; signedIn?: unknown }) {
    const scenario = await this.get(scenarioId);
    const stepId = typeof body.stepId === "string" ? body.stepId : null;
    const step = stepId ? scenario.steps.find((item) => item.id === stepId && item.type === "UI_FLOW") : undefined;
    if (stepId && !step) throw new NotFoundException("Step not found");
    const before = step ? step.orderIndex : Number.MAX_SAFE_INTEGER;
    const earlier = scenario.steps.filter((item) => item.enabled && item.orderIndex < before && item.type !== "ASSERTION");
    const startUrl = typeof body.startUrl === "string" ? body.startUrl.trim() : "";
    let prepared: Awaited<ReturnType<ScenarioRunner["runBefore"]>> | null = null;
    if (body.signedIn !== false && earlier.length > 0 && /^https?:\/\//i.test(startUrl)) {
      prepared = await this.runner.runBefore(scenarioId, before);
    }
    try {
      const session = step ? readUiConfig(asRecord(step.config)) : null;
      const seed = prepared ? seedFromContext(prepared.context, startUrl, session?.ok ? session.value.session : undefined) : undefined;
      const storageState = prepared ? await uiSessionState(prepared.context) : undefined;
      const { page: _page, ...view } = await this.recorder.start({ scenarioId, stepId, startUrl: body.startUrl }, { seed, storageState });
      return {
        ...view,
        prepared: prepared ? { status: prepared.status, steps: prepared.ran, signedIn: seed ? describeSeed(seed) : null } : null,
      };
    } finally {
      await prepared?.context.dispose();
    }
  }

  recordingStatus(id: string) {
    return this.recorder.status(id);
  }

  stopRecording(id: string) {
    return this.recorder.stop(id);
  }

  discardRecording(id: string) {
    return this.recorder.discard(id);
  }

  /**
   * Save a finished recording: a new UI step at the end, or — when it was
   * started from a step — appended to that step's actions or replacing them.
   */
  async saveRecording(id: string, body: { name?: unknown; mode?: unknown }) {
    const recording = this.recorder.take(id);
    if (recording.actions.length === 0) throw new BadRequestException("Nothing was recorded");
    if (recording.stepId) {
      const current = await this.prisma.scenarioStep.findUnique({ where: { id: recording.stepId } });
      if (current) {
        const config = asRecord(current.config);
        const existing = Array.isArray(config.actions) ? (config.actions as unknown[]) : [];
        const replace = body.mode === "replace";
        const next = {
          ...config,
          ...(replace ? { startUrl: recording.startUrl } : {}),
          actions: replace ? recording.actions : [...existing, ...recording.actions],
        };
        return this.prisma.scenarioStep.update({
          where: { id: current.id },
          data: { config: this.sealUi(next, config) as Prisma.InputJsonValue },
        });
      }
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `UI · ${hostAndPath(recording.startUrl)}`;
    return this.prisma.scenarioStep.create({
      data: {
        scenarioId: recording.scenarioId,
        name,
        type: "UI_FLOW",
        orderIndex: await this.nextOrderIndex(recording.scenarioId),
        enabled: true,
        config: this.sealUi({ startUrl: recording.startUrl, actions: recording.actions }, null) as Prisma.InputJsonValue,
      },
    });
  }

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
    if (input.type === "HTTP_REQUEST") assertMappings(input.config);
    if (input.type === "UI_FLOW") input = { ...input, config: this.sealUi({ startUrl: "", actions: [], ...(input.config ?? {}) }, null) };
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
      if (current?.type === "HTTP_REQUEST") assertMappings(data.config);
      if (current?.type === "UI_FLOW") data = { ...data, config: this.sealUi(data.config, asRecord(current.config)) };
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
  start(scenarioId: string, options: RunOptions = {}) {
    return this.runner.start(scenarioId, {
      ...(typeof options.untilStepId === "string" && options.untilStepId ? { untilStepId: options.untilStepId } : {}),
    });
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

  resolveInput(runId: string, body: unknown) {
    return this.runner.resolveInput(runId, body);
  }

  skipInput(runId: string) {
    return this.runner.skipInput(runId);
  }

  /**
   * Save a mapping `target ← source` on an HTTP step. Only the binding for the
   * same target is replaced; other saved mappings are never changed.
   */
  async saveBinding(stepId: string, body: unknown) {
    const step = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
    if (!step) throw new NotFoundException("Step not found");
    if (step.type !== "HTTP_REQUEST") throw new BadRequestException("Only HTTP steps take dependency mappings");
    if (!isBinding(body)) throw new BadRequestException("A mapping needs a target field and a source");
    const config = asRecord(step.config);
    const binding: StepBinding = {
      target: { location: body.target.location, field: body.target.field, ...(body.target.key ? { key: String(body.target.key).slice(0, 100) } : {}) },
      source: body.source,
      origin: body.origin === "accepted" ? "accepted" : "manual",
      ...(body.enabled === false ? { enabled: false } : {}),
      ...(body.confidence ? { confidence: body.confidence } : {}),
      ...(body.evidence ? { evidence: body.evidence } : {}),
      ...(body.verifiedAt ? { verifiedAt: body.verifiedAt } : {}),
      createdAt: typeof body.createdAt === "string" ? body.createdAt : new Date().toISOString(),
    };
    if (isResponseSource(binding.source)) {
      // The source must be an earlier step of the same scenario: a mapping can
      // never read another scenario's responses or a value not produced yet.
      const sourceId = binding.source.stepId;
      const source = sourceId ? await this.prisma.scenarioStep.findUnique({ where: { id: sourceId } }) : null;
      if (!source || source.scenarioId !== step.scenarioId) {
        throw new BadRequestException("The mapping source must be a step of this scenario");
      }
      if (source.orderIndex >= step.orderIndex) {
        throw new BadRequestException("The mapping source must run before this step");
      }
      binding.source = { ...binding.source, stepId: source.id, stepName: source.name, orderIndex: source.orderIndex };
      // A changed source is a new mapping until a run confirms it.
      const previous = readBindings(config).find((item) => sameTarget(item.target, binding.target));
      if (previous && JSON.stringify(previous.source) !== JSON.stringify(binding.source)) delete binding.verifiedAt;
    }
    return this.prisma.scenarioStep.update({
      where: { id: stepId },
      data: { config: { ...config, bindings: upsertBinding(readBindings(config), binding) } as Prisma.InputJsonValue },
    });
  }

  async removeBinding(stepId: string, target: { location?: string; field?: string }) {
    const step = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
    if (!step) throw new NotFoundException("Step not found");
    if (typeof target.location !== "string" || typeof target.field !== "string") {
      throw new BadRequestException("A mapping target needs a location and a field");
    }
    const config = asRecord(step.config);
    const next = removeBinding(readBindings(config), { location: target.location as InputLocation, field: target.field });
    return this.prisma.scenarioStep.update({
      where: { id: stepId },
      data: { config: { ...config, bindings: next } as unknown as Prisma.InputJsonValue },
    });
  }

  /** Parse pasted cURL commands and propose dependencies, without saving anything. */
  async previewImport(scenarioId: string, text: unknown) {
    const plan = await this.planImport(scenarioId, text);
    return { items: plan.items, dependencies: plan.dependencies };
  }

  /**
   * Save the valid commands as steps, in order. Nothing is executed. Only the
   * suggestions the user ticked (`accept`) become saved mappings; malformed
   * commands fail the import unless `skipInvalid` is set.
   */
  async importCurl(scenarioId: string, input: { text?: unknown; accept?: unknown; skipInvalid?: unknown }) {
    const plan = await this.planImport(scenarioId, input.text);
    const invalid = plan.items.find((item) => !item.ok);
    if (invalid && !invalid.ok && input.skipInvalid !== true) {
      throw new BadRequestException(`cURL ${invalid.code}`);
    }
    if (plan.valid.length === 0) throw new BadRequestException("No valid cURL command to import");
    const accept = new Set(Array.isArray(input.accept) ? input.accept.filter((id): id is string => typeof id === "string") : []);

    const ids = new Map<string, string>();
    await this.prisma.$transaction(async (tx) => {
      for (const item of plan.valid) {
        const created = await tx.scenarioStep.create({
          data: {
            scenarioId,
            name: item.name,
            type: "HTTP_REQUEST",
            orderIndex: item.orderIndex,
            config: item.config as Prisma.InputJsonValue,
          },
        });
        ids.set(item.tempId, created.id);
      }
      const bindings = new Map<string, StepBinding[]>();
      for (const suggestion of plan.dependencies) {
        if (!accept.has(suggestion.id)) continue;
        const consumerId = ids.get(suggestion.consumerStepId) ?? suggestion.consumerStepId;
        const producer = plan.flowSteps.find((step) => step.id === suggestion.producerStepId);
        if (!producer || !ids.has(suggestion.consumerStepId)) continue;
        const binding = bindingFromSuggestion(suggestion, { ...producer, id: ids.get(producer.id) ?? producer.id });
        bindings.set(consumerId, upsertBinding(bindings.get(consumerId) ?? [], binding));
      }
      for (const [stepId, list] of bindings) {
        const item = plan.valid.find((candidate) => ids.get(candidate.tempId) === stepId)!;
        await tx.scenarioStep.update({
          where: { id: stepId },
          data: { config: { ...item.config, bindings: list } as unknown as Prisma.InputJsonValue },
        });
      }
    });
    return {
      scenario: await this.get(scenarioId),
      imported: plan.valid.length,
      skipped: plan.items.length - plan.valid.length,
      mapped: plan.dependencies.filter((item) => accept.has(item.id)).length,
    };
  }

  private async planImport(scenarioId: string, text: unknown) {
    const scenario = await this.get(scenarioId);
    if (typeof text !== "string" || !text.trim()) throw new BadRequestException("Paste at least one cURL command");
    if (text.length > MAX_IMPORT_TEXT) throw new BadRequestException("The pasted text is too long");
    const commands = splitCurlCommands(text);
    if (commands.length === 0) throw new BadRequestException("No cURL command found");
    if (commands.length > MAX_IMPORT_COMMANDS) throw new BadRequestException("Import at most 50 requests at a time");

    let orderIndex = (scenario.steps.reduce((max, step) => Math.max(max, step.orderIndex), -1)) + 1;
    const seen = new Set(scenario.steps.map((step) => requestIdentity(asRecord(step.config))));
    const valid: Array<{ tempId: string; name: string; orderIndex: number; config: Record<string, unknown> }> = [];
    const items: ImportItem[] = commands.map((command, index) => {
      const parsed = parseCurl(command);
      if (!parsed.ok) {
        return { index, ok: false, code: parsed.code, preview: maskSecrets(command.replace(/\s+/g, " ")).slice(0, 120) };
      }
      const config: Record<string, unknown> = { ...parsed.config, originalCurl: command };
      const identity = requestIdentity(config);
      const warnings: Extract<ImportItem, { ok: true }>["warnings"] = [...parsed.warnings];
      if (seen.has(identity)) warnings.push({ code: "duplicate_request", detail: `${parsed.config.method} ${parsed.config.url}` });
      seen.add(identity);
      const name = stepNameOf(parsed.config);
      valid.push({ tempId: `import:${index}`, name, orderIndex: orderIndex++, config });
      return {
        index,
        ok: true,
        name,
        method: parsed.config.method,
        url: parsed.config.url,
        headers: maskDeep(parsed.config.headers) as Record<string, string>,
        query: Object.keys(parsed.config.query),
        body: bodyKind(parsed.config),
        warnings,
      };
    });

    const flowSteps: FlowHttpStep[] = [
      ...scenario.steps.map(toFlowStep),
      ...valid.map((item) => ({ id: item.tempId, name: item.name, type: "HTTP_REQUEST", orderIndex: item.orderIndex, config: item.config })),
    ];
    const env = await this.publicEnvironment(scenario.environmentId);
    const dependencies = suggestDependencies(flowSteps, samplesFromRun(scenario.runs[0]), env).filter((item) =>
      item.consumerStepId.startsWith("import:"),
    );
    return { items, valid, flowSteps, dependencies };
  }

  /** Non-secret environment values (only used to place URL path segments the way they are sent). */
  private async publicEnvironment(environmentId: string | null) {
    if (!environmentId) return {};
    const rows = await this.prisma.environmentVariable.findMany({
      where: { environmentId, type: { not: "SECRET" } },
      select: { key: true, value: true },
    });
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async analyzeFlow(scenarioId: string) {
    const scenario = await this.get(scenarioId);
    const steps = scenario.steps.map(toFlowStep);
    const samples = samplesFromRun(scenario.runs[0]);
    const env = await this.publicEnvironment(scenario.environmentId);
    const dependencies = suggestDependencies(steps, samples, env, recoveredInputs(scenario.runs[0]));
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
    const flowSteps = scenario.steps.map((step) => ({
      id: step.id,
      name: step.name,
      type: step.type,
      orderIndex: step.orderIndex,
      enabled: step.enabled,
      config: asRecord(step.config),
    }));
    const issues = validateFlow(
      flowSteps,
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
    const mappings = reviewMappings(flowSteps, samples, env);
    return {
      dependencies,
      mappings,
      inputs: flowSteps
        .filter((step) => step.type === "HTTP_REQUEST")
        .map((step) => ({ stepId: step.id, fields: inputFields(step.config, env) })),
      issues,
      variables: variableCatalog(flowSteps),
      environmentKeys: envKeys,
      health: flowHealth({
        steps: flowSteps,
        dependencies: mappings.filter((item) => item.status === "ok" || item.status === "unverified").length,
        issues,
      }),
      responses,
    };
  }

  /**
   * Save a detected dependency as a mapping on its consumer step. The
   * suggestion is looked up again on the server (never trusted from the
   * client). A manual mapping on the same field is kept unless `replace`.
   */
  async acceptDependency(scenarioId: string, body: { id?: unknown; replace?: unknown }) {
    const scenario = await this.get(scenarioId);
    const steps = scenario.steps.map(toFlowStep);
    const env = await this.publicEnvironment(scenario.environmentId);
    const suggestion = suggestDependencies(steps, samplesFromRun(scenario.runs[0]), env, recoveredInputs(scenario.runs[0])).find(
      (item) => item.id === body.id,
    );
    if (!suggestion) throw new BadRequestException("This suggestion is no longer available");
    const producer = steps.find((step) => step.id === suggestion.producerStepId);
    const consumer = scenario.steps.find((step) => step.id === suggestion.consumerStepId);
    if (!producer || !consumer) throw new NotFoundException("Step not found");
    const config = asRecord(consumer.config);
    const current = readBindings(config);
    const manual = current.find((item) => item.origin !== "accepted" && sameTarget(item.target, suggestion.target));
    if (manual && body.replace !== true) {
      throw new BadRequestException("A manual mapping already exists for this field");
    }
    await this.prisma.scenarioStep.update({
      where: { id: consumer.id },
      data: {
        config: { ...config, bindings: upsertBinding(current, bindingFromSuggestion(suggestion, producer)) } as unknown as Prisma.InputJsonValue,
      },
    });
    return this.analyzeFlow(scenarioId);
  }

  /**
   * "Detect mappings automatically": for every request field without a saved
   * mapping, find which earlier response it should come from and save the
   * clear cases. Evidence is the latest successful response of every step
   * over recent runs, fields recovery fixed, and the requests themselves.
   * Ambiguous and weak cases stay suggestions. `stepId` limits it to one step.
   */
  async autoMap(scenarioId: string, body: { stepId?: unknown }) {
    const scenario = await this.get(scenarioId);
    const steps = scenario.steps.map(toFlowStep);
    const env = await this.publicEnvironment(scenario.environmentId);
    const samples = latestSuccessfulSamples(scenario.runs);
    const recovered = scenario.runs.slice(0, 5).flatMap((run) => recoveredInputs(run));
    const only = typeof body.stepId === "string" ? body.stepId : null;
    const suggestions = suggestDependencies(steps, samples, env, recovered).filter((item) => !only || item.consumerStepId === only);
    const plan = chooseAutoMappings(suggestions);

    const byConsumer = new Map<string, DependencySuggestion[]>();
    for (const item of plan.chosen) byConsumer.set(item.consumerStepId, [...(byConsumer.get(item.consumerStepId) ?? []), item]);
    for (const [consumerId, items] of byConsumer) {
      const consumer = scenario.steps.find((step) => step.id === consumerId);
      if (!consumer) continue;
      const config = asRecord(consumer.config);
      let bindings = readBindings(config);
      for (const item of items) {
        const producer = steps.find((step) => step.id === item.producerStepId);
        if (producer) bindings = upsertBinding(bindings, bindingFromSuggestion(item, producer));
      }
      await this.prisma.scenarioStep.update({
        where: { id: consumerId },
        data: { config: { ...config, bindings } as unknown as Prisma.InputJsonValue },
      });
    }
    return {
      added: plan.chosen.length,
      ambiguous: plan.ambiguous.length,
      weak: plan.weak.length,
      // Without a run only the request shapes are evidence; a run lets real responses confirm them.
      usedResponses: samples.length > 0,
      analysis: await this.analyzeFlow(scenarioId),
    };
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

/** Reject response mappings that could never run (bad name, path, duplicate). */
function assertMappings(config: Record<string, unknown> | undefined) {
  const problem = validateMappings(config?.extract)[0];
  if (problem) {
    throw new BadRequestException(
      `Invalid response mapping ${problem.variable ? `{{${problem.variable}}}` : `#${problem.index + 1}`}: ${problem.code} (${problem.detail})`,
    );
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
        ...(output.kind === "ui" ? { cookies: asRecord(output.cookies) as Record<string, string> } : {}),
      },
    ];
  });
}

/**
 * The latest successful response of every step across recent runs (newest
 * first): a run that stopped early still leaves the earlier runs' responses of
 * the later steps. Failed responses and bodies that report an error are not
 * evidence of where a value comes from.
 */
function latestSuccessfulSamples(runs: Array<{ stepRuns: Array<{ scenarioStepId: string | null; output: unknown }> }>) {
  const found = new Map<string, ReturnType<typeof samplesFromRun>[number]>();
  for (const run of runs) {
    for (const sample of samplesFromRun(run)) {
      if (found.has(sample.stepId)) continue;
      if (sample.status !== undefined && sample.status >= 400) continue;
      if (detectBodyError(sample.body)) continue;
      found.set(sample.stepId, sample);
    }
  }
  return [...found.values()];
}

/**
 * Fields automatic recovery fixed in a run, with the earlier response value
 * that fixed them — offered as suggestions so the fix can be kept.
 */
function recoveredInputs(
  run: { stepRuns: Array<{ scenarioStepId: string | null; output: unknown }> } | undefined,
): RecoveredInput[] {
  if (!run) return [];
  return run.stepRuns.flatMap((stepRun) => {
    const recovery = asRecord(asRecord(stepRun.output).recovery);
    if (!stepRun.scenarioStepId || recovery.outcome !== "RECOVERED" || !Array.isArray(recovery.attempts)) return [];
    const winner = recovery.attempts.map(asRecord).find((attempt) => attempt.expectationMet === true && attempt.manual !== true);
    const candidate = asRecord(winner?.candidate);
    const changes = Array.isArray(candidate.changes) ? candidate.changes.map(asRecord) : [candidate];
    return changes.flatMap((change): RecoveredInput[] => {
      const source = asRecord(change.source);
      if (typeof source.stepId !== "string" || typeof source.path !== "string") return [];
      if (typeof change.location !== "string" || typeof change.field !== "string") return [];
      return [
        {
          consumerStepId: stepRun.scenarioStepId!,
          producerStepId: source.stepId,
          target: {
            location: change.location as InputLocation,
            field: change.field,
            key: typeof change.fieldName === "string" ? change.fieldName : change.field,
          },
          path: source.path,
        },
      ];
    });
  });
}

/** Same method, URL and query: the same request imported twice. */
function requestIdentity(config: Record<string, unknown>) {
  const query = asRecord(config.query);
  const sorted = Object.keys(query)
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join("&");
  return `${String(config.method ?? "GET").toUpperCase()} ${String(config.url ?? "")}?${sorted}`;
}

function stepNameOf(config: ParsedHttpRequest) {
  let pathname = config.url;
  try {
    pathname = new URL(config.url).pathname || config.url;
  } catch {
    // {{base_url}}/v1/items: name the step after the path after the variable
    pathname = config.url.replace(/^\{\{[^}]+\}\}/, "") || config.url;
  }
  pathname = pathname.replace(/%7B%7B([A-Za-z0-9_.-]+)%7D%7D/gi, "{{$1}}");
  return `${config.method} ${pathname}`;
}

function bodyKind(config: ParsedHttpRequest): "none" | "json" | "form" | "text" {
  const { body } = config;
  if (body === undefined || body === null || (typeof body === "object" && Object.keys(body).length === 0)) return "none";
  if (typeof body === "object") return "json";
  const type = Object.entries(config.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  return type.includes("x-www-form-urlencoded") || /^[^=&\s{}]+=/.test(String(body)) ? "form" : "text";
}

function hostAndPath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}
