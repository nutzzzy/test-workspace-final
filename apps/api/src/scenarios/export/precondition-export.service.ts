import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  buildExportPrompt,
  contextForFramework,
  exportAnchors,
  exportBrowserActions,
  exportFrameworkOptions,
  exportName,
  exportSurfaces,
  findExportFramework,
  findExportLanguage,
  frameworkAvailability,
  validateExportCode,
  type ExportFrameworkOption,
  type ExportResult,
} from "@qa-workbench/shared";
import { z } from "zod";
import { AIService, type ConnectionView } from "../../ai/ai.service";
import { PrismaService } from "../../prisma/prisma.service";
import { buildExportContext } from "./export-context";

/** The AI-side failures an export reports; the UI translates each message. */
export const EXPORT_ERRORS = {
  unsupportedFramework: "Unsupported framework",
  unsupportedLanguage: "Unsupported language for this framework",
  nothingToExport: "This precondition has no steps to export",
  frameworkCannotExport: "This framework cannot drive the steps being exported",
  stepNotFound: "Step not found",
  noProvider: "No AI provider is available in this workspace",
  providerUnavailable: "The selected AI provider is not available",
  timeout: "The AI provider did not answer in time",
  empty: "The AI provider returned an empty answer",
  invalid: "The AI provider returned an invalid answer",
  cutOff: "The AI provider's answer was cut off before the code was complete",
} as const;

/** Failures caused by the AI service (not by the request): 424 keeps the message for the client. */
const AI_FAILED = HttpStatus.FAILED_DEPENDENCY;

const AnswerSchema = z.object({
  code: z.string(),
  warnings: z.array(z.string()).optional(),
});

export type ExportOptions = {
  frameworks: ExportFrameworkOption[];
  /** Set when one step is exported. */
  step: { id: string; name: string; type: string } | null;
  providers: Array<Pick<ConnectionView, "id" | "name" | "model" | "usable" | "blockedReason">>;
  /** The connection an export uses when none is chosen (the automation stage's first). */
  defaultProviderId: string | null;
};

/** `stepId`: export that one step instead of the whole precondition. */
export type ExportRequest = { framework?: unknown; language?: unknown; providerId?: unknown; stepId?: unknown };

/**
 * Precondition → automation code. One AI request per export, through the
 * workspace's AI connections; the precondition is only read, never changed.
 */
@Injectable()
export class PreconditionExportService {
  private readonly logger = new Logger(PreconditionExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIService,
  ) {}

  /** Frameworks (with whether each can drive what is exported), languages, file names and AI connections. */
  async options(scenarioId: string, stepId?: string): Promise<ExportOptions> {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      select: { id: true, name: true, description: true, stopOnFailure: true, steps: { orderBy: { orderIndex: "asc" } } },
    });
    if (!scenario) throw new NotFoundException("Scenario not found");
    const step = stepId ? scenario.steps.find((item) => item.id === stepId) : undefined;
    if (stepId && !step) throw new NotFoundException(EXPORT_ERRORS.stepNotFound);
    const context = buildExportContext(scenario, new Map(), { stepId });
    const [connections, chain] = await Promise.all([this.ai.listConnections(), this.ai.chainFor("automation")]);
    return {
      frameworks: exportFrameworkOptions(context.name, exportSurfaces(context.steps)),
      step: step ? { id: step.id, name: step.name, type: step.type } : null,
      providers: connections.map(({ id, name, model, usable, blockedReason }) => ({ id, name, model, usable, blockedReason })),
      defaultProviderId: chain[0]?.id ?? null,
    };
  }

  async generate(scenarioId: string, request: ExportRequest): Promise<ExportResult> {
    const framework = findExportFramework(String(request.framework ?? ""));
    if (!framework) throw new BadRequestException(EXPORT_ERRORS.unsupportedFramework);
    const language = findExportLanguage(framework, String(request.language ?? ""));
    if (!language) throw new BadRequestException(EXPORT_ERRORS.unsupportedLanguage);

    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: { steps: { orderBy: { orderIndex: "asc" } }, environment: { select: { name: true } } },
    });
    if (!scenario) throw new NotFoundException("Scenario not found");
    const stepId = typeof request.stepId === "string" && request.stepId ? request.stepId : undefined;
    if (stepId && !scenario.steps.some((step) => step.id === stepId)) throw new NotFoundException(EXPORT_ERRORS.stepNotFound);
    const connectorIds = scenario.steps
      .filter((step) => step.type === "DATABASE_ACTION" && (!stepId || step.id === stepId))
      .map((step) => String((step.config as Record<string, unknown> | null)?.connectorId ?? ""))
      .filter(Boolean);
    const connectors = connectorIds.length
      ? await this.prisma.databaseConnector.findMany({ where: { id: { in: connectorIds } }, select: { id: true, type: true } })
      : [];
    const full = buildExportContext(scenario, new Map(connectors.map((item) => [item.id, item.type])), { stepId });
    if (full.steps.length === 0) throw new BadRequestException(EXPORT_ERRORS.nothingToExport);
    if (!frameworkAvailability(framework, exportSurfaces(full.steps)).available) throw new BadRequestException(EXPORT_ERRORS.frameworkCannotExport);
    // UI steps the framework cannot drive (a mobile step for Playwright, a browser step for Appium) are left out, with a warning.
    const context = contextForFramework(full, framework);

    const providerId = typeof request.providerId === "string" && request.providerId ? request.providerId : undefined;
    const connections = await this.ai.listConnections();
    if (providerId) {
      const chosen = connections.find((item) => item.id === providerId);
      if (!chosen?.usable) throw new HttpException(EXPORT_ERRORS.providerUnavailable, AI_FAILED);
    } else if (!connections.some((item) => item.usable)) {
      throw new HttpException(EXPORT_ERRORS.noProvider, AI_FAILED);
    }

    const { system, prompt } = buildExportPrompt(context, framework, language);
    const { providerTimeoutMs } = await this.ai.getRunBudget();
    const abort = new AbortController();
    let timedOut = false;
    const timer = providerTimeoutMs > 0 ? setTimeout(() => ((timedOut = true), abort.abort()), providerTimeoutMs) : null;
    let answer: { data: z.infer<typeof AnswerSchema>; origin: { connectionId: string; name: string; model: string } };
    try {
      // One request per export. A failed answer (empty, not JSON) is asked once more — free services drop answers now and then;
      // without a chosen provider the automation chain moves to the next connection only when one fails.
      answer = await this.ai.call("automation", { system, prompt, schema: AnswerSchema }, { only: providerId, attemptsPerConnection: 2, signal: abort.signal });
    } catch (error) {
      throw this.aiFailure(error, timedOut, Boolean(providerId));
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!answer.data.code.trim()) throw new HttpException(EXPORT_ERRORS.empty, AI_FAILED);
    const checked = validateExportCode({
      code: answer.data.code,
      framework,
      language,
      anchors: exportAnchors(context),
      hasUiSteps: context.steps.some((step) => step.type === "ui" || step.type === "mobile"),
      browserActions: exportBrowserActions(context),
      mode: context.scope ? "step" : "full",
    });
    if (!checked.ok) {
      throw new HttpException(`The generated code was rejected: ${checked.errors.join("; ")}`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const aiWarnings = (answer.data.warnings ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20);
    const leftOut = (context.metadata.leftOut ?? []).map((item) => `Step "${item.step}" was left out: ${item.reason}.`);
    return {
      framework: framework.id,
      language: language.id,
      code: checked.code,
      filename: language.filename(exportName(context.name)),
      warnings: [...new Set([...leftOut, ...aiWarnings, ...checked.warnings])],
      provider: { id: answer.origin.connectionId, name: answer.origin.name, model: answer.origin.model },
    };
  }

  /** A failed AI call as the error the user sees: timeout, empty, invalid, unavailable or other. */
  private aiFailure(error: unknown, timedOut: boolean, chosen: boolean): HttpException {
    const full = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Export failed: ${full.slice(0, 500)}`);
    // With fallback, the message lists every connection's failure; the first is the chosen or default one, and the one that matters.
    const text = full.replace(/^AI \w+ failed on every connection — /, "").split(" | ")[0]!;
    if (timedOut || /did not answer in time|TimeoutError|timed out|writing time limit/i.test(text)) return new HttpException(EXPORT_ERRORS.timeout, AI_FAILED);
    if (/response is empty|before writing anything usable/i.test(text)) return new HttpException(EXPORT_ERRORS.empty, AI_FAILED);
    // A cut-off answer is closed at its last complete field, which drops the unfinished code.
    if (/schema validation failed[\s\S]*"path":\s*\[\s*"code"\s*\]|Unterminated string/i.test(text)) return new HttpException(EXPORT_ERRORS.cutOff, AI_FAILED);
    if (/not valid JSON|schema validation failed/i.test(text)) return new HttpException(EXPORT_ERRORS.invalid, AI_FAILED);
    if (/not available|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|cooling down|AI service error (?:401|402|403|404|429|5\d\d)/i.test(text)) {
      return new HttpException(chosen ? EXPORT_ERRORS.providerUnavailable : EXPORT_ERRORS.noProvider, AI_FAILED);
    }
    const detail = text.slice(0, 160);
    return new HttpException(`Code generation failed: ${detail}`, AI_FAILED);
  }
}
