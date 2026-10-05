import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { maskSecrets } from "@qa-workbench/shared";
import { AIService, type CallOrigin } from "../ai/ai.service";
import { normalizeLocale, type AppLocale } from "../ai/localize-fa";
import { PrismaService } from "../prisma/prisma.service";
import { explainNoEdgeCases } from "./edge-explanation";
import {
  applyAnalysis,
  applyAssessment,
  applyAutomation,
  applyCases,
  applyCriteria,
  applyEdges,
  type IssueForApply,
} from "./studio/apply";
import { cleanDocumentText, extractDocumentText } from "./studio/documents";
import { LearningService, type Artifact } from "./studio/learning";
import { isOfficial, runStudio, type StudioProgress, type StudioStage, type StudioUnderstanding } from "./studio/pipeline";

/** What one analysis run covers. */
export const ANALYSIS_SCOPES = ["all", "requirements", "strategy", "testCases", "edgeCases", "risks", "automation"] as const;
export type AnalysisScope = (typeof ANALYSIS_SCOPES)[number];

const SCOPE_STAGES: Record<AnalysisScope, StudioStage[]> = {
  all: ["understand", "criteria", "assessment", "cases", "edges", "translate", "review", "automation"],
  requirements: ["understand", "criteria", "assessment", "translate"],
  strategy: ["assessment"],
  risks: ["assessment"],
  testCases: ["cases", "review", "automation"],
  edgeCases: ["edges", "review"],
  automation: ["automation"],
};

type StageState = { state: StudioProgress["state"] | "pending"; detail?: string; origins: CallOrigin[] };

export type AnalysisJob = {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  scope: AnalysisScope;
  locale: AppLocale;
  stages: Partial<Record<StudioStage, StageState>>;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Stages that failed while the others completed. */
  warnings: Array<{ stage: StudioStage; message: string }>;
  dropped?: { criteria: number; cases: number; edges: number };
};

type RunMeta = {
  createdAt: string;
  durationMs: number;
  scope: AnalysisScope;
  sourceHash: string;
  stages: Partial<Record<StudioStage, { state: string; origins: Array<{ name: string; model: string }>; error?: string }>>;
  dropped: { criteria: number; cases: number; edges: number };
};

type StudioMemory = {
  runs?: Partial<Record<AppLocale, RunMeta>>;
  translations?: Partial<Record<AppLocale, { sourceHash: string; title: string; description: string; acceptanceCriteria: string[] }>>;
  sourceLanguage?: AppLocale;
};

function readMemory(intelligence: unknown): StudioMemory {
  const studio = (intelligence as { studio?: unknown } | null)?.studio;
  return studio && typeof studio === "object" ? (studio as StudioMemory) : {};
}

/** Fingerprint of the issue text and its documents: a translation or understanding is reused only for the same content. */
function sourceHashOf(issue: { title: string; description: string; acceptanceCriteria: Array<{ text: string; origin: string }> }, documents: Array<{ text: string }>) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        issue.title,
        issue.description,
        issue.acceptanceCriteria.filter((item) => isOfficial(item.origin)).map((item) => item.text),
        documents.map((doc) => doc.text),
      ]),
    )
    .digest("hex");
}

const LIST_FIELDS = ["gaps", "ambiguities", "questionsProduct", "questionsDeveloper", "questionsBusiness"] as const;
const CASE_INCLUDE = {
  runs: { select: { id: true }, take: 1 },
  acceptanceLinks: { include: { acceptanceCriterion: { select: { key: true } } } },
} as const;

/**
 * Requirement analysis for the Test Workspace, with a language model at its
 * core (see studio/pipeline). Runs are background jobs per issue; every
 * artifact can be edited, and each edit teaches the analysis (studio/learning).
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly jobs = new Map<string, AnalysisJob & { cancel: AbortController }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIService,
    private readonly learning: LearningService,
  ) {}

  /** One write at a time per issue (double clicks, two tabs). */
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

  private async loadIssue(jiraIssueId: string) {
    const issue = await this.prisma.jiraIssue.findFirst({
      where: { OR: [{ id: jiraIssueId }, { key: jiraIssueId.toUpperCase() }] },
      include: {
        acceptanceCriteria: { orderBy: { orderIndex: "asc" } },
        testCases: { include: CASE_INCLUDE, orderBy: { createdAt: "asc" } },
        requirementAnalysis: true,
        requirementProfile: true,
        documents: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!issue) throw new NotFoundException("Issue not found");
    return issue;
  }

  // ── runs ──────────────────────────────────────────────────────────────

  /**
   * Start an analysis in the background. The requested language is the
   * language every generated artifact is written in, whatever language the
   * issue uses. `acceptanceKeys` limits a test-case run to those criteria.
   */
  async start(jiraIssueId: string, input: { scope?: unknown; locale?: unknown; acceptanceKeys?: unknown }) {
    const scope = ANALYSIS_SCOPES.includes(input.scope as AnalysisScope) ? (input.scope as AnalysisScope) : "all";
    const locale = normalizeLocale(input.locale);
    const issue = await this.loadIssue(jiraIssueId);
    const status = await this.ai.analysisStatus();
    if (!status.ready) throw new BadRequestException(`AI analysis is not available: ${status.reason}`);
    const running = this.jobs.get(issue.id);
    if (running?.state === "running") return this.status(issue.id, locale);
    const acceptanceKeys = Array.isArray(input.acceptanceKeys)
      ? input.acceptanceKeys.filter((key): key is string => typeof key === "string" && issue.acceptanceCriteria.some((row) => row.key === key))
      : [];

    const job: AnalysisJob & { cancel: AbortController } = {
      id: createHash("sha1").update(`${issue.id}${Date.now()}`).digest("hex").slice(0, 12),
      state: "running",
      scope,
      locale,
      stages: Object.fromEntries(SCOPE_STAGES[scope].map((stage) => [stage, { state: "pending", origins: [] }])),
      startedAt: new Date().toISOString(),
      warnings: [],
      cancel: new AbortController(),
    };
    this.jobs.set(issue.id, job);
    void this.exclusive(issue.id, () => this.run(issue.id, job, acceptanceKeys))
      .then(() => {
        job.state = "done";
      })
      .catch((error: unknown) => {
        job.state = job.cancel.signal.aborted ? "cancelled" : "failed";
        job.error = maskSecrets(error instanceof Error ? error.message : "AI analysis failed").slice(0, 800);
        this.logger.warn(`Analysis ${issue.key} failed: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return this.status(issue.id, locale);
  }

  private async run(issueId: string, job: AnalysisJob & { cancel: AbortController }, acceptanceKeys: string[]) {
    const started = Date.now();
    const issue = await this.loadIssue(issueId);
    const { locale, scope } = job;
    const sourceHash = sourceHashOf(issue, issue.documents);
    const memory = readMemory(issue.requirementProfile?.intelligence);
    const stored = issue.requirementAnalysis?.understanding as (StudioUnderstanding & { _sourceHash?: string }) | null;
    // A stored understanding is reused by partial runs only if the source did not change.
    const previous = stored && stored._sourceHash === sourceHash && Array.isArray(stored.rules) ? stored : null;
    const stages = SCOPE_STAGES[scope];
    if (!previous && !stages.includes("understand")) {
      job.stages = { understand: { state: "pending", origins: [] }, ...job.stages };
    }
    const result = await runStudio({
      source: {
        issueKey: issue.key,
        title: issue.title,
        description: issue.description,
        criteria: issue.acceptanceCriteria.map((row) => ({ key: row.key, text: row.text, origin: row.origin })),
        documents: issue.documents.map((doc) => ({ title: doc.title, text: doc.text })),
      },
      locale,
      stages,
      previous: { understanding: previous },
      targetKeys: acceptanceKeys,
      existingCases:
        scope === "automation"
          ? issue.testCases.map((row) => ({
              title: row.title,
              steps: Array.isArray(row.steps) ? (row.steps as string[]) : [],
              expectedResult: row.expectedResult,
              type: row.type,
            }))
          : undefined,
      guidance: await this.learning.guidance(),
      budgetChars: await this.ai.contextBudget("analysis"),
      isCancelled: () => job.cancel.signal.aborted,
      llm: (group, stage, call) =>
        this.ai.call(group, call, {
          signal: job.cancel.signal,
          onConnection: (origin) => {
            const entry = (job.stages[stage] ??= { state: "running", origins: [] });
            entry.detail = `${origin.name} · ${origin.model}`;
          },
        }),
      onProgress: (progress) => {
        const entry = (job.stages[progress.stage] ??= { state: "pending", origins: [] });
        entry.state = progress.state;
        if (progress.detail) entry.detail = progress.detail;
        if (progress.origin && !entry.origins.some((item) => item.connectionId === progress.origin!.connectionId)) entry.origins.push(progress.origin);
      },
    });
    for (const [stage, message] of Object.entries(result.errors)) job.warnings.push({ stage: stage as StudioStage, message: message! });
    job.dropped = result.dropped;

    // Everything is applied in one transaction: a failure leaves the previous state intact.
    await this.prisma.$transaction(
      async (tx) => {
        const reload = async () =>
          (await tx.jiraIssue.findUniqueOrThrow({
            where: { id: issue.id },
            include: { acceptanceCriteria: { orderBy: { orderIndex: "asc" } }, testCases: { include: CASE_INCLUDE } },
          })) as unknown as IssueForApply;
        const keyMap = result.proposed ? await applyCriteria(tx, await reload(), result.proposed) : new Map<string, string>();
        let caseIds: Array<string | null> = [];
        if (result.cases) {
          caseIds = await applyCases(tx, await reload(), result.cases, keyMap, acceptanceKeys.length ? acceptanceKeys : null);
        } else if (scope === "automation") {
          caseIds = issue.testCases.map((row) => row.id);
        }
        if (result.edges) await applyEdges(tx, issue.id, result.edges, keyMap, locale);
        if (result.assessment) await applyAssessment(tx, issue.id, result, keyMap);
        if (result.understanding || result.assessment) {
          const criteria = await tx.acceptanceCriterion.findMany({ where: { jiraIssueId: issue.id }, orderBy: { orderIndex: "asc" } });
          await applyAnalysis(
            tx,
            issue.id,
            { ...result, understanding: result.understanding ? ({ ...result.understanding, _sourceHash: sourceHash } as StudioUnderstanding) : null },
            criteria.map((row) => row.text),
          );
        }
        if (result.automation) await applyAutomation(tx, issue.id, result.automation, caseIds);

        // Run memory, display translation, and the gap list traceability shows.
        const nextMemory: StudioMemory = {
          ...memory,
          sourceLanguage: result.sourceLanguage,
          runs: {
            ...memory.runs,
            [locale]: {
              createdAt: new Date().toISOString(),
              durationMs: Date.now() - started,
              scope,
              sourceHash,
              dropped: result.dropped,
              stages: Object.fromEntries(
                Object.entries(job.stages).map(([stage, entry]) => [
                  stage,
                  {
                    state: entry!.state,
                    origins: entry!.origins.map((item) => ({ name: item.name, model: item.model })),
                    ...(result.errors[stage as StudioStage] ? { error: result.errors[stage as StudioStage] } : {}),
                  },
                ]),
              ),
            },
          },
          translations: result.translation ? { ...memory.translations, [locale]: { sourceHash, ...result.translation } } : memory.translations,
        };
        const previousIntelligence = (issue.requirementProfile?.intelligence ?? {}) as Record<string, unknown>;
        const gaps = result.assessment
          ? result.assessment.gaps.map((gap, index) => ({ id: `GAP-${index + 1}`, description: gap.text, severity: gap.severity }))
          : previousIntelligence.gaps;
        const intelligence = { ...previousIntelligence, gaps, studio: nextMemory } as Prisma.InputJsonValue;
        await tx.requirementProfile.upsert({
          where: { jiraIssueId: issue.id },
          create: { jiraIssueId: issue.id, intelligence, contentHash: sourceHash },
          update: { intelligence, contentHash: sourceHash },
        });
      },
      { timeout: 120_000 },
    );
  }

  async cancel(jiraIssueId: string) {
    const issue = await this.loadIssue(jiraIssueId);
    this.jobs.get(issue.id)?.cancel.abort();
    return { ok: true };
  }

  /** The running job, the last run per language, AI readiness and the display translation. */
  async status(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.loadIssue(jiraIssueId);
    const memory = readMemory(issue.requirementProfile?.intelligence);
    const sourceHash = sourceHashOf(issue, issue.documents);
    const job = this.jobs.get(issue.id);
    const translation = memory.translations?.[locale];
    return {
      ai: await this.ai.analysisStatus(),
      job: job ? { ...job, cancel: undefined } : null,
      runs: Object.fromEntries(Object.entries(memory.runs ?? {}).map(([key, run]) => [key, { ...run, current: run!.sourceHash === sourceHash }])),
      translation: translation && translation.sourceHash === sourceHash ? translation : null,
      sourceLanguage: memory.sourceLanguage ?? null,
      documents: issue.documents.length,
    };
  }

  /** Why the edge-case list is empty, from the last run of this issue. */
  async explainEdgeCases(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.loadIssue(jiraIssueId);
    const memory = readMemory(issue.requirementProfile?.intelligence);
    const run = memory.runs?.[locale] ?? Object.values(memory.runs ?? {})[0] ?? null;
    return explainNoEdgeCases({
      run: run ? { edges: run.stages.edges ?? null, dropped: run.dropped.edges, current: run.sourceHash === sourceHashOf(issue, issue.documents) } : null,
      understanding: (issue.requirementAnalysis?.understanding as StudioUnderstanding | null) ?? null,
      aiReady: (await this.ai.analysisStatus()).ready,
      locale,
    });
  }

  // ── documents (PRD) ───────────────────────────────────────────────────

  async listDocuments(jiraIssueId: string) {
    const issue = await this.loadIssue(jiraIssueId);
    return issue.documents.map((doc) => ({ ...doc, text: doc.text.slice(0, 2000), length: doc.text.length }));
  }

  async getDocument(id: string) {
    const doc = await this.prisma.issueDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException("Document not found");
    return doc;
  }

  async addDocumentText(jiraIssueId: string, input: { title?: unknown; text?: unknown; kind?: unknown }) {
    const issue = await this.loadIssue(jiraIssueId);
    const text = cleanDocumentText(String(input.text ?? ""));
    return this.prisma.issueDocument.create({
      data: {
        jiraIssueId: issue.id,
        kind: input.kind === "OTHER" ? "OTHER" : "PRD",
        title: String(input.title ?? "").trim().slice(0, 200) || "PRD",
        text,
        sizeBytes: Buffer.byteLength(text),
      },
    });
  }

  async uploadDocument(jiraIssueId: string, file: Express.Multer.File | undefined, input: { title?: unknown; kind?: unknown }) {
    if (!file) throw new BadRequestException("Choose a file");
    const issue = await this.loadIssue(jiraIssueId);
    const text = await extractDocumentText(file);
    return this.prisma.issueDocument.create({
      data: {
        jiraIssueId: issue.id,
        kind: input.kind === "OTHER" ? "OTHER" : "PRD",
        title: String(input.title ?? "").trim().slice(0, 200) || file.originalname.replace(/\.[^.]+$/, "").slice(0, 200),
        fileName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        text,
      },
    });
  }

  async deleteDocument(id: string) {
    await this.prisma.issueDocument.delete({ where: { id } }).catch(() => {
      throw new NotFoundException("Document not found");
    });
    return { ok: true };
  }

  // ── editing: every edit teaches the analysis ──────────────────────────

  private async feedback(artifact: Artifact, action: "edit" | "delete" | "accept" | "reject" | "add", jiraIssueId: string, before?: unknown, after?: unknown) {
    try {
      await this.learning.record({ artifact, action, jiraIssueId, before, after });
    } catch (error) {
      this.logger.warn(`Feedback not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async addCriterion(jiraIssueId: string, input: { text?: unknown }) {
    const issue = await this.loadIssue(jiraIssueId);
    const text = String(input.text ?? "").trim();
    if (!text) throw new BadRequestException("Write the acceptance criterion");
    // Own key space (M-01 …): Jira's AC-xx keys can never collide with it.
    const keys = new Set(issue.acceptanceCriteria.map((row) => row.key));
    let index = 1;
    while (keys.has(`M-${String(index).padStart(2, "0")}`)) index += 1;
    const created = await this.prisma.acceptanceCriterion.create({
      data: {
        jiraIssueId: issue.id,
        key: `M-${String(index).padStart(2, "0")}`,
        text,
        origin: "manual",
        orderIndex: issue.acceptanceCriteria.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1,
      },
    });
    await this.feedback("criterion", "add", issue.id, undefined, { text });
    return created;
  }

  /** Edit and/or confirm a criterion: a confirmed AI proposal becomes an official criterion. */
  async updateCriterion(id: string, input: { text?: unknown; confirm?: unknown }) {
    const row = await this.prisma.acceptanceCriterion.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Acceptance criterion not found");
    const text = input.text === undefined ? row.text : String(input.text).trim();
    if (!text) throw new BadRequestException("Write the acceptance criterion");
    const proposal = !isOfficial(row.origin);
    const confirm = proposal && (input.confirm === true || text !== row.text);
    const updated = await this.prisma.acceptanceCriterion.update({
      where: { id },
      data: {
        text,
        ...(confirm ? { origin: "confirmed" } : {}),
        ...(!proposal && text !== row.text && row.origin !== "manual" ? { origin: "edited" } : {}),
      },
    });
    if (text !== row.text) await this.feedback("criterion", "edit", row.jiraIssueId, { text: row.text }, { text });
    else if (confirm) await this.feedback("criterion", "accept", row.jiraIssueId, { text: row.text, evidence: row.evidence });
    if (confirm) {
      // Its cases no longer rest on an unconfirmed proposal.
      await this.prisma.testCase.updateMany({
        where: { acceptanceLinks: { some: { acceptanceCriterionId: id } }, designStatus: "DRAFT_REQUIRES_REVIEW" },
        data: { designStatus: "AI_DRAFT" },
      });
    }
    return updated;
  }

  async deleteCriterion(id: string) {
    const row = await this.prisma.acceptanceCriterion.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Acceptance criterion not found");
    if (row.origin === "imported" || row.origin === "cleaned") {
      throw new BadRequestException("Criteria imported from Jira are edited on the Jira page");
    }
    await this.prisma.acceptanceCriterion.delete({ where: { id } });
    await this.feedback("criterion", isOfficial(row.origin) ? "delete" : "reject", row.jiraIssueId, { text: row.text, evidence: row.evidence, rationale: row.rationale });
    return { ok: true };
  }

  /** Edit the analysis (summary, gaps, ambiguities, questions); edited fields survive re-runs. */
  async updateAnalysis(jiraIssueId: string, input: Record<string, unknown>) {
    const issue = await this.loadIssue(jiraIssueId);
    const current = issue.requirementAnalysis;
    if (!current) throw new NotFoundException("Run the analysis first");
    const understanding = (current.understanding ?? {}) as { _edited?: unknown };
    const edited = new Set<string>(Array.isArray(understanding._edited) ? (understanding._edited as string[]) : []);
    const data: Record<string, unknown> = {};
    if (typeof input.summary === "string" && input.summary.trim() !== current.summary) {
      data.summary = input.summary.trim();
      edited.add("summary");
      await this.feedback("summary", "edit", issue.id, current.summary, data.summary);
    }
    for (const field of LIST_FIELDS) {
      if (!Array.isArray(input[field])) continue;
      const next = (input[field] as unknown[]).map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
      const before = (current[field] as string[]) ?? [];
      if (JSON.stringify(next) === JSON.stringify(before)) continue;
      data[field] = next;
      edited.add(field);
      const artifact: Artifact = field === "gaps" || field === "ambiguities" ? "gap" : "question";
      const removed = before.filter((item) => !next.includes(item));
      const added = next.filter((item) => !before.includes(item));
      if (removed.length && !added.length) await this.feedback(artifact, "delete", issue.id, removed);
      else await this.feedback(artifact, "edit", issue.id, removed, added);
      if (field.startsWith("questions")) {
        data.questionDetails = ((current.questionDetails as Array<{ question: string }>) ?? []).filter(
          (item) => next.includes(item.question) || !before.includes(item.question),
        );
        edited.add("questionDetails");
      }
    }
    if (Object.keys(data).length === 0) return current;
    return this.prisma.requirementAnalysis.update({
      where: { id: current.id },
      data: { ...data, understanding: { ...(current.understanding as object), _edited: [...edited] } as Prisma.InputJsonValue },
    });
  }

  async updateStrategy(jiraIssueId: string, input: Record<string, unknown>) {
    const issue = await this.loadIssue(jiraIssueId);
    const current = await this.prisma.testStrategy.findUnique({ where: { jiraIssueId: issue.id } });
    if (!current) throw new NotFoundException("Run the analysis first");
    const data: Record<string, unknown> = {};
    if (typeof input.scope === "string") data.scope = input.scope.trim();
    for (const field of ["objectives", "testTypes", "environments", "dependencies", "assumptions"] as const) {
      if (Array.isArray(input[field])) data[field] = (input[field] as unknown[]).map((item) => String(item).trim()).filter(Boolean).slice(0, 50);
    }
    const updated = await this.prisma.testStrategy.update({ where: { id: current.id }, data: { ...data, manuallyEdited: true } });
    await this.feedback("strategy", "edit", issue.id, { scope: current.scope, objectives: current.objectives, testTypes: current.testTypes }, data);
    return updated;
  }

  async updateEdgeCase(id: string, input: { title?: unknown; description?: unknown; rationale?: unknown; severity?: unknown }) {
    const row = await this.prisma.edgeCase.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Edge case not found");
    const data = {
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : row.title,
      description: typeof input.description === "string" ? input.description.trim() : row.description,
      rationale: typeof input.rationale === "string" ? input.rationale.trim() : row.rationale,
      severity: ["HIGH", "MEDIUM", "LOW"].includes(String(input.severity)) ? String(input.severity) : row.severity,
    };
    const updated = await this.prisma.edgeCase.update({ where: { id }, data: { ...data, manuallyEdited: true } });
    await this.feedback("edgeCase", "edit", row.jiraIssueId, { title: row.title, description: row.description, rationale: row.rationale }, data);
    return updated;
  }

  async deleteEdgeCase(id: string) {
    const row = await this.prisma.edgeCase.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Edge case not found");
    await this.prisma.edgeCase.delete({ where: { id } });
    await this.feedback("edgeCase", "delete", row.jiraIssueId, { title: row.title, description: row.description });
    return { ok: true };
  }

  async addEdgeCase(jiraIssueId: string, input: { title?: unknown; description?: unknown }) {
    const issue = await this.loadIssue(jiraIssueId);
    const title = String(input.title ?? "").trim();
    if (!title) throw new BadRequestException("Title is required");
    const created = await this.prisma.edgeCase.create({
      data: { jiraIssueId: issue.id, title, description: String(input.description ?? "").trim(), manuallyEdited: true },
    });
    await this.feedback("edgeCase", "add", issue.id, undefined, { title, description: created.description });
    return created;
  }

  /** An edge case becomes a test case to review and complete. */
  async edgeCaseToTestCase(id: string) {
    const row = await this.prisma.edgeCase.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Edge case not found");
    const criteria = await this.prisma.acceptanceCriterion.findMany({ where: { jiraIssueId: row.jiraIssueId, key: { in: row.acceptanceKeys } } });
    const [scenario, expected] = row.description.split(/\n\n(?=[^\n]*:)/);
    return this.prisma.testCase.create({
      data: {
        jiraIssueId: row.jiraIssueId,
        title: row.title,
        description: row.rationale,
        preconditions: [],
        steps: [scenario ?? row.description],
        stepExpectations: [expected?.replace(/^[^:]*:\s*/, "") ?? ""],
        expectedResult: expected?.replace(/^[^:]*:\s*/, "") ?? "",
        priority: row.severity,
        type: "BOUNDARY",
        tags: ["edge", "from-edge-case"],
        designStatus: "DRAFT_REQUIRES_REVIEW",
        acceptanceLinks: { create: criteria.map((criterion) => ({ acceptanceCriterionId: criterion.id })) },
      },
    });
  }

  async updateRisk(id: string, input: Record<string, unknown>) {
    const row = await this.prisma.risk.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Risk not found");
    const level = (value: unknown, fallback: string) => (["HIGH", "MEDIUM", "LOW"].includes(String(value)) ? String(value) : fallback);
    const data = {
      description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : row.description,
      mitigation: typeof input.mitigation === "string" ? input.mitigation.trim() : row.mitigation,
      impact: level(input.impact, row.impact),
      likelihood: level(input.likelihood, row.likelihood),
      releaseBlocking: typeof input.releaseBlocking === "boolean" ? input.releaseBlocking : row.releaseBlocking,
    };
    const updated = await this.prisma.risk.update({ where: { id }, data: { ...data, manuallyEdited: true } });
    await this.feedback("risk", "edit", row.jiraIssueId, { description: row.description, mitigation: row.mitigation, impact: row.impact, releaseBlocking: row.releaseBlocking }, data);
    return updated;
  }

  async deleteRisk(id: string) {
    const row = await this.prisma.risk.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Risk not found");
    await this.prisma.risk.delete({ where: { id } });
    await this.feedback("risk", "delete", row.jiraIssueId, { description: row.description, impact: row.impact });
    return { ok: true };
  }

  async updateAutomation(id: string, input: Record<string, unknown>) {
    const row = await this.prisma.automationCandidate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Automation suggestion not found");
    const data = {
      recommendedLevel: ["HIGH", "MEDIUM", "LOW"].includes(String(input.recommendedLevel)) ? String(input.recommendedLevel) : row.recommendedLevel,
      apiUiRecommendation: ["API", "UI", "DB", "Integration", "Manual"].includes(String(input.apiUiRecommendation))
        ? String(input.apiUiRecommendation)
        : row.apiUiRecommendation,
      reasoning: typeof input.reasoning === "string" ? input.reasoning.trim() : row.reasoning,
      tooling: typeof input.tooling === "string" ? input.tooling.trim() : row.tooling,
      prerequisites: Array.isArray(input.prerequisites) ? input.prerequisites.map(String).filter(Boolean) : (row.prerequisites as string[]),
    };
    const updated = await this.prisma.automationCandidate.update({ where: { id }, data: { ...data, manuallyEdited: true } });
    await this.feedback("automation", "edit", row.jiraIssueId, { recommendedLevel: row.recommendedLevel, layer: row.apiUiRecommendation, reasoning: row.reasoning }, data);
    return updated;
  }

  async deleteAutomation(id: string) {
    const row = await this.prisma.automationCandidate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Automation suggestion not found");
    await this.prisma.automationCandidate.delete({ where: { id } });
    await this.feedback("automation", "delete", row.jiraIssueId, { reasoning: row.reasoning });
    return { ok: true };
  }

  /** Read-only display translation of the issue into the workspace language (made by a run). */
  async localizeIssueForRequest(jiraIssueId: string, localeInput?: unknown) {
    const locale = normalizeLocale(localeInput);
    const issue = await this.loadIssue(jiraIssueId);
    const translation = readMemory(issue.requirementProfile?.intelligence).translations?.[locale];
    if (!translation || translation.sourceHash !== sourceHashOf(issue, issue.documents)) return issue;
    const official = issue.acceptanceCriteria.filter((row) => isOfficial(row.origin));
    return {
      ...issue,
      title: translation.title || issue.title,
      description: translation.description || issue.description,
      acceptanceCriteria: issue.acceptanceCriteria.map((row) => {
        const index = official.indexOf(row);
        return index >= 0 && translation.acceptanceCriteria[index] ? { ...row, text: translation.acceptanceCriteria[index] } : row;
      }),
      localizedPreview: true as const,
    };
  }
}
