import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { maskSecrets } from "@qa-workbench/shared";
import { AIService } from "../ai/ai.service";
import {
  localizeIssueContentToFa,
  normalizeLocale,
  type AppLocale,
} from "../ai/localize-fa";
import { PrismaService } from "../prisma/prisma.service";
import {
  isLegacyConditionKey,
  isLockedDesign,
  requirementHash,
  runQaPipeline,
  type PipelineResult,
  type QaInput,
} from "../qa-engine/pipeline";

const PIPELINE_CACHE_SIZE = 50;
import { criterionMatchKey, syncAcceptanceCriteria } from "./acceptance-sync";
import {
  DEEP_STEPS,
  mergeDeepAnalysis,
  runDeepAnalysis,
  type DeepAnalysis,
  type DeepStep,
} from "./deep-analysis";
import { analyzeRequirementGaps, dedupeQuestions, type AnalysisQuestion } from "./requirement-questions";
import {
  designAcceptanceCriteria,
  designAnalysis,
  type DesignedCriterion,
} from "./qa-design";

function sourceCriteria(
  rawAcceptanceText: string | null | undefined,
  current: Array<{ text: string }>,
) {
  const rawLines = rawAcceptanceText
    ?.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines && rawLines.length > 0) return rawLines;
  return current.map((item) => item.text);
}

/** A deep (model-assisted) analysis running in the background for one issue. */
export type DeepJob = {
  state: "running" | "done" | "failed" | "cancelled";
  locale: AppLocale;
  step: DeepStep | "apply";
  index: number;
  total: number;
  detail?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** The model was not called: a stored analysis of the same content was reused. */
  reused?: boolean;
  /** The model failed; the rule-based design was generated instead. */
  warning?: string;
};

type StoredDeep = DeepAnalysis & { sourceHash: string };

/** Fingerprint of the issue text a stored analysis (and its translation) was made from. */
function sourceHashOf(issue: { title: string; description: string; acceptanceCriteria: Array<{ text: string }> }) {
  return createHash("sha256")
    .update(JSON.stringify([issue.title, issue.description, issue.acceptanceCriteria.map((item) => item.text)]))
    .digest("hex");
}

/** "ai" when a model analysis is merged into this result. */
function providerOf(result: PipelineResult): "ai" | "heuristic" {
  return result.intelligence.ai ? "ai" : "heuristic";
}

function readDeep(intelligence: unknown): Partial<Record<AppLocale, StoredDeep>> {
  const deep = (intelligence as { deep?: unknown } | null)?.deep;
  return deep && typeof deep === "object" ? (deep as Partial<Record<AppLocale, StoredDeep>>) : {};
}

@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIService,
  ) {}

  private readonly deepJobs = new Map<string, DeepJob & { cancel: AbortController }>();

  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly pipelineCache = new Map<string, PipelineResult>();

  /**
   * Run generation for one issue at a time. Two overlapping requests (double
   * click, second tab) would otherwise both see "no existing case" and create
   * duplicates, or finish out of order and overwrite each other.
   */
  async exclusive<T>(jiraIssueId: string, task: () => Promise<T>): Promise<T> {
    const lockKey = jiraIssueId.trim().toUpperCase();
    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.locks.set(lockKey, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(lockKey) === current) this.locks.delete(lockKey);
    }
  }

  private designedFrom(issue: {
    acceptanceCriteria: Array<{
      key: string;
      text: string;
      origin: string;
      orderIndex: number;
    }>;
  }): DesignedCriterion[] {
    return issue.acceptanceCriteria.map((item) => ({
      key: item.key,
      text: item.text,
      origin: item.origin === "derived" ? "derived" : "cleaned",
      orderIndex: item.orderIndex,
    }));
  }

  private async loadIssue(jiraIssueId: string) {
    const issue = await this.prisma.jiraIssue.findFirst({
      where: { OR: [{ id: jiraIssueId }, { key: jiraIssueId.toUpperCase() }] },
      include: {
        acceptanceCriteria: { orderBy: { orderIndex: "asc" as const } },
        testCases: true,
      },
    });
    if (!issue) throw new NotFoundException("Issue not found");
    return issue;
  }

  async localizeIssueForRequest(jiraIssueId: string, localeInput?: unknown) {
    return this.localizeIssueContent(jiraIssueId, normalizeLocale(localeInput));
  }

  /**
   * Read-only Persian preview of the issue text. Imported requirement text is
   * the source of truth and is never overwritten for presentation: the regex
   * translation is lossy and must not change what Jira sync, AC design or
   * traceability operate on.
   */
  async localizeIssueContent(jiraIssueId: string, locale: AppLocale) {
    const issue = await this.loadIssue(jiraIssueId);
    // The model's translation (made during deep analysis of this exact text) is preferred.
    const profile = await this.prisma.requirementProfile.findUnique({ where: { jiraIssueId: issue.id } });
    const stored = readDeep(profile?.intelligence)[locale];
    if (stored?.translation && stored.sourceHash === sourceHashOf(issue)) {
      const translation = stored.translation;
      return {
        ...issue,
        title: translation.title || issue.title,
        description: translation.description || issue.description,
        acceptanceCriteria: issue.acceptanceCriteria.map((ac, index) => ({ ...ac, text: translation.acceptanceCriteria[index] ?? ac.text })),
        localizedPreview: true as const,
      };
    }
    if (locale !== "fa") return issue;
    const localized = localizeIssueContentToFa({
      title: issue.title,
      description: issue.description,
      acceptanceCriteria: issue.acceptanceCriteria.map((a) => a.text),
    });
    return {
      ...issue,
      title: localized.title,
      description: localized.description,
      acceptanceCriteria: issue.acceptanceCriteria.map((ac, index) => ({
        ...ac,
        text: localized.acceptanceCriteria[index] ?? ac.text,
      })),
      localizedPreview: true as const,
    };
  }

  async analyzeRequirements(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const loaded = await this.loadIssue(jiraIssueId);
    const issue = await this.ensureDesignedCriteria(loaded, locale);
    const existing = await this.prisma.requirementAnalysis.findUnique({
      where: { jiraIssueId: issue.id },
    });
    if (existing?.manuallyEdited) {
      throw new BadRequestException(
        "Analysis was manually edited; refuse automatic overwrite",
      );
    }

    const criteria = this.designedFrom(issue);
    const data = designAnalysis({
      title: issue.title,
      criteria,
      locale,
    });
    const pipeline = await this.pipelineFor(issue, locale);
    const deep = await this.deepFor(issue.id, pipeline.contentHash, locale);
    const gaps = [
      ...new Set([
        ...data.gaps,
        ...pipeline.gaps.map((gap) => gap.description),
      ]),
    ];
    // Questions come from the gaps of THIS requirement; inferred criteria are
    // suggestions, never questions and never mixed with the Jira criteria.
    const { questions, suggestedCriteria } = analyzeRequirementGaps({
      title: issue.title,
      description: issue.description,
      criteria: issue.acceptanceCriteria,
      understanding: pipeline.understanding,
      gaps: pipeline.gaps,
      inferred: pipeline.inferredAc,
      locale,
    });
    const allQuestions: AnalysisQuestion[] = deep
      ? dedupeQuestions([
          ...questions,
          ...deep.questions.map((item) => ({ question: item.question, category: item.category, reason: item.reason, source: "ai" })),
        ])
      : questions;
    const byCategory = (category: string) =>
      allQuestions.filter((item) => item.category === category).map((item) => item.question);
    const questionFields = {
      questionsProduct: byCategory("product"),
      questionsDeveloper: byCategory("developer"),
      questionsBusiness: byCategory("business"),
      questionDetails: allQuestions,
      // AI-proposed criteria carry their evidence and confidence; they stay suggestions.
      suggestedCriteria: [
        ...(deep?.criteria ?? []).map((item) => ({
          text: item.text,
          reason: item.rationale,
          source: item.id,
          confidence: item.confidence,
          evidence: item.evidence,
          grounded: item.grounded,
          category: item.category,
          needsConfirmation: item.needsConfirmation,
        })),
        ...suggestedCriteria,
      ],
    };
    if (deep) {
      data.summary = deep.understanding.summary || data.summary;
      data.ambiguities = [...new Set([...data.ambiguities, ...deep.understanding.assumptions])];
      data.missingScenarios = [
        ...new Set([
          ...data.missingScenarios,
          ...deep.testCases.filter((item) => item.edgeCase).map((item) => item.title),
        ]),
      ];
    }

    const saved = await this.prisma.requirementAnalysis.upsert({
      where: { jiraIssueId: issue.id },
      create: {
        jiraIssueId: issue.id,
        summary: data.summary,
        acceptanceCriteria: data.acceptanceCriteria,
        gaps,
        ambiguities: data.ambiguities,
        missingScenarios: data.missingScenarios,
        potentialRisks: data.potentialRisks,
        ...questionFields,
      },
      update: {
        summary: data.summary,
        acceptanceCriteria: data.acceptanceCriteria,
        gaps,
        ambiguities: data.ambiguities,
        missingScenarios: data.missingScenarios,
        potentialRisks: data.potentialRisks,
        ...questionFields,
      },
    });
    return { ...saved, provider: deep ? ("ai" as const) : ("heuristic" as const) };
  }

  async generateStrategy(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const existing = await this.prisma.testStrategy.findUnique({
      where: { jiraIssueId: issue.id },
    });
    if (existing?.manuallyEdited) {
      throw new BadRequestException(
        "Strategy was manually edited; refuse automatic overwrite",
      );
    }
    const pipeline = await this.pipelineFor(issue, locale);
    const data = pipeline.strategy;
    const saved = await this.prisma.testStrategy.upsert({
      where: { jiraIssueId: issue.id },
      create: {
        jiraIssueId: issue.id,
        scope: data.scope,
        objectives: data.objectives,
        testTypes: data.testTypes,
        environments: data.environments,
        dependencies: data.dependencies,
        assumptions: data.assumptions,
      },
      update: {
        scope: data.scope,
        objectives: data.objectives,
        testTypes: data.testTypes,
        environments: data.environments,
        dependencies: data.dependencies,
        assumptions: data.assumptions,
      },
    });
    return { ...saved, provider: providerOf(pipeline) };
  }

  async generateTestCases(
    jiraIssueId: string,
    localeInput?: unknown,
    modeInput?: unknown,
    acceptanceKeys?: unknown,
  ) {
    const locale = normalizeLocale(localeInput);
    const mode =
      modeInput === "missing" || modeInput === "drafts" ? modeInput : "all";
    const selectedKeys = Array.isArray(acceptanceKeys)
      ? acceptanceKeys.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const pipeline = await this.pipelineFor(issue, locale);
    const designed = selectedKeys.length
      ? pipeline.testCases.filter((item) =>
          item.relatedAcceptanceCriteria.some((key) =>
            selectedKeys.includes(key),
          ),
        )
      : pipeline.testCases;
    const existing = await this.prisma.testCase.findMany({
      where: { jiraIssueId: issue.id },
    });
    const seen = new Set<string>();
    const claimed = new Set<string>();
    const created = [];

    for (const tc of designed) {
      seen.add(tc.conditionKey);
      // Exact identity first; rows saved under the old positional keys
      // (COND-01…) are matched once by identical title so an upgrade does not
      // duplicate every case.
      const match =
        existing.find(
          (row) => !claimed.has(row.id) && row.conditionKey === tc.conditionKey,
        ) ??
        existing.find(
          (row) =>
            !claimed.has(row.id) &&
            isLegacyConditionKey(row.conditionKey) &&
            criterionMatchKey(row.title) === criterionMatchKey(tc.title),
        );
      if (match) claimed.add(match.id);
      if (match && isLockedDesign(match.designStatus, match.manuallyEdited))
        continue;
      if (mode === "missing" && match) continue;
      if (mode === "drafts" && !match) continue;
      if (
        mode === "drafts" &&
        match &&
        match.designStatus !== "AI_DRAFT" &&
        match.designStatus !== "DRAFT_REQUIRES_REVIEW"
      ) {
        continue;
      }

      const data = {
        title: tc.title,
        description: tc.description,
        preconditions: tc.preconditions,
        steps: tc.steps,
        stepExpectations: tc.stepExpectations,
        testData: tc.testData,
        expectedResult: tc.expectedResult,
        priority: tc.priority,
        type: tc.type,
        tags: tc.tags,
        designStatus: tc.designStatus,
        technique: tc.technique,
        conditionKey: tc.conditionKey,
        postconditions: tc.postconditions,
        assumptions: tc.assumptions,
        gapRefs: tc.gapRefs,
        automationSuitability: tc.automationSuitability,
        automationNotes: tc.automationNotes,
        jiraSyncStatus: "NOT_SYNCED",
      };

      if (match) {
        const related = this.linkCriteria(
          issue.acceptanceCriteria,
          tc.relatedAcceptanceCriteria,
        );
        // One update replaces the links atomically: a failure can never leave
        // the case without its AC links.
        created.push(
          await this.prisma.testCase.update({
            where: { id: match.id },
            data: {
              ...data,
              acceptanceLinks: {
                deleteMany: {},
                create: related.map((ac) => ({
                  acceptanceCriterionId: ac.id,
                })),
              },
            },
          }),
        );
        continue;
      }

      const related = this.linkCriteria(
        issue.acceptanceCriteria,
        tc.relatedAcceptanceCriteria,
      );
      created.push(
        await this.prisma.testCase.create({
          data: {
            jiraIssueId: issue.id,
            ...data,
            acceptanceLinks: {
              create: related.map((ac) => ({
                acceptanceCriterionId: ac.id,
              })),
            },
          },
        }),
      );
    }

    if (mode === "all" && selectedKeys.length === 0) {
      for (const row of existing) {
        if (isLockedDesign(row.designStatus, row.manuallyEdited)) continue;
        if (claimed.has(row.id)) continue;
        if (row.conditionKey && seen.has(row.conditionKey)) continue;
        await this.prisma.testCase.update({
          where: { id: row.id },
          data: { designStatus: "POTENTIALLY_OUTDATED" },
        });
      }
    }

    return { created, provider: providerOf(pipeline) };
  }

  async generateEdgeCases(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const pipeline = await this.pipelineFor(issue, locale);
    const designed = pipeline.edgeCases;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.edgeCase.deleteMany({
        where: { jiraIssueId: issue.id, manuallyEdited: false },
      });
      const rows = [];
      for (const edge of designed) {
        rows.push(
          await tx.edgeCase.create({
            data: {
              jiraIssueId: issue.id,
              title: edge.title,
              description: edge.description,
            },
          }),
        );
      }
      return rows;
    });
    return { created, provider: providerOf(pipeline) };
  }

  async generateRisks(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const pipeline = await this.pipelineFor(issue, locale);
    const risks = pipeline.risks;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.risk.deleteMany({
        where: { jiraIssueId: issue.id, manuallyEdited: false },
      });
      const rows = [];
      for (const risk of risks) {
        rows.push(
          await tx.risk.create({
            data: {
              jiraIssueId: issue.id,
              description: risk.description,
              impact: risk.impact,
              likelihood: risk.likelihood,
              mitigation: risk.mitigation,
              releaseBlocking: risk.releaseBlocking,
              acceptanceKeys: risk.acceptanceKeys,
            },
          }),
        );
      }
      return rows;
    });
    return { created, provider: providerOf(pipeline) };
  }

  async generateAutomation(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const pipeline = await this.pipelineFor(issue, locale);
    const candidates = pipeline.automation;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.automationCandidate.deleteMany({
        where: { jiraIssueId: issue.id, manuallyEdited: false },
      });
      const rows = [];
      for (const candidate of candidates) {
        const match = issue.testCases.find(
          (testCase) => testCase.conditionKey === candidate.conditionKey,
        );
        rows.push(
          await tx.automationCandidate.create({
            data: {
              jiraIssueId: issue.id,
              testCaseId: match?.id,
              recommendedLevel: candidate.suitability,
              apiUiRecommendation: candidate.layer,
              reasoning: `${candidate.scenarioStatus}. ${candidate.reason}`,
            },
          }),
        );
      }
      return rows;
    });
    return { created, provider: providerOf(pipeline) };
  }

  async generateAll(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const analysis = await this.analyzeRequirements(jiraIssueId, locale);
    const strategy = await this.generateStrategy(jiraIssueId, locale);
    const testCases = await this.generateTestCases(jiraIssueId, locale);
    const edgeCases = await this.generateEdgeCases(jiraIssueId, locale);
    const risks = await this.generateRisks(jiraIssueId, locale);
    const automation = await this.generateAutomation(jiraIssueId, locale);
    return { analysis, strategy, testCases, edgeCases, risks, automation };
  }

  private async ensureDesignedCriteria(
    issue: Awaited<ReturnType<AnalysisService["loadIssue"]>>,
    locale: AppLocale,
  ) {
    const current = [...issue.acceptanceCriteria].sort(
      (left, right) => left.orderIndex - right.orderIndex,
    );
    const designed = designAcceptanceCriteria({
      title: issue.title,
      description: issue.description,
      rawCriteria: sourceCriteria(issue.rawAcceptanceText, current),
      locale,
    });
    if (
      current.length > 0 &&
      current.every((item) => item.origin === "derived")
    ) {
      for (const item of designed) item.origin = "derived";
    }
    const same =
      current.length === designed.length &&
      current.every(
        (item, index) =>
          item.key === designed[index]?.key &&
          item.text === designed[index]?.text &&
          item.origin === designed[index]?.origin,
      );
    if (same) return issue;

    // Rows are updated in place (see syncAcceptanceCriteria) so that every
    // test case — AI draft, approved or manual — keeps its AC links.
    await this.prisma.$transaction(async (tx) => {
      await syncAcceptanceCriteria(tx, issue.id, designed);
      if (!issue.rawAcceptanceText?.trim() && current.length > 0) {
        await tx.jiraIssue.update({
          where: { id: issue.id },
          data: {
            rawAcceptanceText: current.map((item) => item.text).join("\n"),
          },
        });
      }
    });

    return this.loadIssue(issue.id);
  }

  private async pipelineFor(
    issue: {
      id: string;
      key: string;
      title: string;
      description: string;
      issueType: string | null;
      acceptanceCriteria: Array<{ key: string; text: string; origin: string }>;
    },
    locale: AppLocale,
  ) {
    const input: QaInput = {
      title: issue.title,
      description: issue.description,
      issueKey: issue.key,
      issueType: issue.issueType ?? undefined,
      locale,
      acceptanceCriteria: issue.acceptanceCriteria.map((item) => ({
        key: item.key,
        text: item.text,
        origin: item.origin === "derived" ? "derived" : "cleaned",
      })),
    };
    // One understanding per (issue, content, locale): "generate all" and the
    // per-tab actions reuse it instead of re-analysing the same text. The key
    // includes the content hash, so any change to title, description or
    // criteria is a cache miss.
    const hash = requirementHash(input);
    const deep = await this.deepFor(issue.id, hash, locale);
    const cacheKey = `${issue.id}|${hash}|${input.issueType ?? ""}|${locale}|${deep?.createdAt ?? "-"}`;
    const cached = this.pipelineCache.get(cacheKey);
    if (cached) return cached;
    const base = runQaPipeline(input);
    // A stored model analysis of exactly this content is merged on top of the rule-based design.
    const result = deep ? mergeDeepAnalysis(base, deep, input) : base;
    this.pipelineCache.set(cacheKey, result);
    if (this.pipelineCache.size > PIPELINE_CACHE_SIZE) {
      this.pipelineCache.delete(this.pipelineCache.keys().next().value!);
    }
    const profile = await this.prisma.requirementProfile.findUnique({ where: { jiraIssueId: issue.id } });
    const intelligence = { ...result.intelligence, deep: readDeep(profile?.intelligence) } as Prisma.InputJsonValue;
    await this.prisma.requirementProfile.upsert({
      where: { jiraIssueId: issue.id },
      create: { jiraIssueId: issue.id, intelligence, contentHash: result.contentHash },
      update: { intelligence, contentHash: result.contentHash },
    });
    return result;
  }

  /** The stored model analysis for this content and language, if any. */
  private async deepFor(issueId: string, contentHash: string, locale: AppLocale): Promise<StoredDeep | null> {
    const profile = await this.prisma.requirementProfile.findUnique({ where: { jiraIssueId: issueId } });
    const stored = readDeep(profile?.intelligence)[locale];
    return stored && stored.version === 1 && stored.contentHash === contentHash ? stored : null;
  }

  private async saveDeep(issueId: string, deep: StoredDeep) {
    const profile = await this.prisma.requirementProfile.findUnique({ where: { jiraIssueId: issueId } });
    const current = (profile?.intelligence ?? {}) as Record<string, unknown>;
    const intelligence = { ...current, deep: { ...readDeep(current), [deep.locale]: deep } } as unknown as Prisma.InputJsonValue;
    await this.prisma.requirementProfile.upsert({
      where: { jiraIssueId: issueId },
      create: { jiraIssueId: issueId, intelligence, contentHash: deep.contentHash },
      update: { intelligence },
    });
  }

  private inputOf(
    issue: { key: string; title: string; description: string; issueType: string | null; acceptanceCriteria: Array<{ key: string; text: string; origin: string }> },
    locale: AppLocale,
  ): QaInput {
    return {
      title: issue.title,
      description: issue.description,
      issueKey: issue.key,
      issueType: issue.issueType ?? undefined,
      locale,
      acceptanceCriteria: issue.acceptanceCriteria.map((item) => ({
        key: item.key,
        text: item.text,
        origin: item.origin === "derived" ? "derived" : "cleaned",
      })),
    };
  }

  /**
   * Start a deep analysis in the requested language: the model analyses the
   * requirement in several passes (in the background — it may take minutes),
   * then every artifact is regenerated with its findings merged in. Manually
   * edited and approved items are never overwritten. A stored analysis of the
   * same content and language is reused unless `force`.
   */
  async startDeepAnalysis(jiraIssueId: string, localeInput?: unknown, force = false) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.loadIssue(jiraIssueId);
    const status = await this.ai.analysisStatus();
    if (!status.ready) throw new BadRequestException(`AI analysis is not available: ${status.reason}`);
    const running = this.deepJobs.get(issue.id);
    if (running?.state === "running") return this.deepStatus(issue.id, locale);

    const job: DeepJob & { cancel: AbortController } = {
      state: "running",
      locale,
      step: DEEP_STEPS[0],
      index: 0,
      total: DEEP_STEPS.length + 1,
      startedAt: new Date().toISOString(),
      cancel: new AbortController(),
    };
    this.deepJobs.set(issue.id, job);
    void this.exclusive(issue.id, async () => {
      const designed = await this.ensureDesignedCriteria(await this.loadIssue(issue.id), locale);
      const input = this.inputOf(designed, locale);
      const hash = requirementHash(input);
      const existing = force ? null : await this.deepFor(designed.id, hash, locale);
      if (existing) {
        job.reused = true;
      } else {
        try {
          const deep = await runDeepAnalysis({
            input,
            base: runQaPipeline(input),
            provider: status.provider,
            model: status.model,
            llm: (call) => this.ai.structured(call, { signal: job.cancel.signal }),
            isCancelled: () => job.cancel.signal.aborted,
            onProgress: (progress) => {
              job.step = progress.step;
              job.index = progress.index;
              job.detail = progress.detail;
            },
          });
          await this.saveDeep(designed.id, { ...deep, sourceHash: sourceHashOf(designed) });
        } catch (error) {
          if (job.cancel.signal.aborted) throw error;
          // An unreachable or failing model must not leave the user with nothing.
          job.warning = maskSecrets(error instanceof Error ? error.message : "AI analysis failed").slice(0, 500);
        }
      }
      job.step = "apply";
      job.index = DEEP_STEPS.length + 1;
      job.detail = undefined;
      await this.generateAll(designed.id, locale);
    })
      .then(() => {
        job.state = "done";
      })
      .catch((error: unknown) => {
        job.state = job.cancel.signal.aborted ? "cancelled" : "failed";
        job.error = maskSecrets(error instanceof Error ? error.message : "AI analysis failed").slice(0, 500);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return this.deepStatus(issue.id, locale);
  }

  async cancelDeepAnalysis(jiraIssueId: string) {
    const issue = await this.loadIssue(jiraIssueId);
    this.deepJobs.get(issue.id)?.cancel.abort();
    return { ok: true };
  }

  /**
   * What the workspace needs to show: whether the model can be used, the
   * running job, the analyses stored per language, and — when the issue is
   * written in another language — the model's translation for display.
   */
  async deepStatus(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.loadIssue(jiraIssueId);
    const ai = await this.ai.analysisStatus();
    const profile = await this.prisma.requirementProfile.findUnique({ where: { jiraIssueId: issue.id } });
    const stored = readDeep(profile?.intelligence);
    const sourceHash = sourceHashOf(issue);
    const runs = Object.fromEntries(
      Object.entries(stored).map(([key, deep]) => [
        key,
        {
          createdAt: deep!.createdAt,
          provider: deep!.provider,
          model: deep!.model,
          durationMs: deep!.durationMs,
          hadExplicitCriteria: deep!.hadExplicitCriteria,
          criteria: deep!.criteria.length,
          testCases: deep!.testCases.length,
          questions: deep!.questions.length,
          dropped: deep!.dropped,
          current: deep!.sourceHash === sourceHash,
        },
      ]),
    );
    const own = stored[locale];
    const job = this.deepJobs.get(issue.id);
    return {
      ai,
      job: job ? { ...job, cancel: undefined } : null,
      runs,
      translation: own && own.sourceHash === sourceHash ? own.translation : null,
      sourceLanguage: own?.sourceLanguage ?? null,
    };
  }

  private linkCriteria(
    criteria: Array<{ id: string; key: string; text: string }>,
    refs: string[],
  ) {
    // Traceability must come from an explicit reference: an AC key, or the
    // exact criterion text. Word overlap or substrings never create coverage.
    const wanted = new Set(refs.map(criterionMatchKey));
    return criteria.filter(
      (item) =>
        refs.includes(item.key) || wanted.has(criterionMatchKey(item.text)),
    );
  }
}
