import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
import { analyzeRequirementGaps } from "./requirement-questions";
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

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService) {}

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
    const byCategory = (category: string) =>
      questions.filter((item) => item.category === category).map((item) => item.question);
    const questionFields = {
      questionsProduct: byCategory("product"),
      questionsDeveloper: byCategory("developer"),
      questionsBusiness: byCategory("business"),
      questionDetails: questions,
      suggestedCriteria,
    };

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
    return { ...saved, provider: "heuristic" as const };
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
    const data = (await this.pipelineFor(issue, locale)).strategy;
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
    return { ...saved, provider: "heuristic" as const };
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

    return { created, provider: "heuristic" as const };
  }

  async generateEdgeCases(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const designed = (await this.pipelineFor(issue, locale)).edgeCases;
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
    return { created, provider: "heuristic" as const };
  }

  async generateRisks(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const risks = (await this.pipelineFor(issue, locale)).risks;
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
    return { created, provider: "heuristic" as const };
  }

  async generateAutomation(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.ensureDesignedCriteria(
      await this.loadIssue(jiraIssueId),
      locale,
    );
    const candidates = (await this.pipelineFor(issue, locale)).automation;
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
    return { created, provider: "heuristic" as const };
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
    const cacheKey = `${issue.id}|${requirementHash(input)}|${input.issueType ?? ""}|${locale}`;
    const cached = this.pipelineCache.get(cacheKey);
    if (cached) return cached;
    const result = runQaPipeline(input);
    this.pipelineCache.set(cacheKey, result);
    if (this.pipelineCache.size > PIPELINE_CACHE_SIZE) {
      this.pipelineCache.delete(this.pipelineCache.keys().next().value!);
    }
    await this.prisma.requirementProfile.upsert({
      where: { jiraIssueId: issue.id },
      create: {
        jiraIssueId: issue.id,
        intelligence: result.intelligence as Prisma.InputJsonValue,
        contentHash: result.contentHash,
      },
      update: {
        intelligence: result.intelligence as Prisma.InputJsonValue,
        contentHash: result.contentHash,
      },
    });
    return result;
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
