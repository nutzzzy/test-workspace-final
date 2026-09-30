import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { TestExecutionStatus } from "@qa-workbench/shared";
import { computeCoverage } from "../dashboard/dashboard.math";
import { testCaseContentHash } from "../jira/test-case-document";
import { PrismaService } from "../prisma/prisma.service";

const ALLOWED_STATUSES = new Set(Object.values(TestExecutionStatus));
const CLOSED_BUG_STATUSES = new Set(["RESOLVED", "CLOSED"]);

function profileGaps(value: unknown): Array<{ id: string; description: string; severity: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const gaps = (value as { gaps?: unknown }).gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const gap = item as { id?: unknown; description?: unknown; severity?: unknown };
    if (typeof gap.id !== "string" || typeof gap.description !== "string") return [];
    return [
      {
        id: gap.id,
        description: gap.description,
        severity: typeof gap.severity === "string" ? gap.severity : "MEDIUM",
      },
    ];
  });
}

@Injectable()
export class TestManagementService {
  constructor(private readonly prisma: PrismaService) {}

  listCases(jiraIssueId?: string) {
    return this.prisma.testCase.findMany({
      where: jiraIssueId
        ? {
            OR: [
              { jiraIssueId },
              { jiraIssue: { key: jiraIssueId.toUpperCase() } },
            ],
          }
        : undefined,
      include: {
        acceptanceLinks: { include: { acceptanceCriterion: true } },
        runs: { orderBy: { executedAt: "desc" }, take: 10 },
        bugs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getCase(id: string) {
    const testCase = await this.prisma.testCase.findUnique({
      where: { id },
      include: {
        acceptanceLinks: { include: { acceptanceCriterion: true } },
        runs: { orderBy: { executedAt: "desc" } },
        bugs: true,
        suiteLinks: { include: { suite: true } },
      },
    });
    if (!testCase) throw new NotFoundException("Test case not found");
    return testCase;
  }

  async createCase(input: {
    jiraIssueId: string;
    title: string;
    description?: string;
    preconditions?: string[];
    steps: string[];
    expectedResult: string;
    priority?: string;
    type?: string;
    acceptanceKey?: string;
  }) {
    const title = input.title.trim();
    const steps = input.steps.map((step) => step.trim()).filter(Boolean);
    const expectedResult = input.expectedResult.trim();
    if (!title) throw new BadRequestException("title is required");
    if (steps.length === 0) {
      throw new BadRequestException("at least one step is required");
    }
    if (!expectedResult) {
      throw new BadRequestException("expectedResult is required");
    }
    const priority = input.priority ?? "MEDIUM";
    if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(priority)) {
      throw new BadRequestException("invalid priority");
    }

    const issue = await this.prisma.jiraIssue.findFirst({
      where: {
        OR: [
          { id: input.jiraIssueId },
          { key: input.jiraIssueId.toUpperCase() },
        ],
      },
      include: { acceptanceCriteria: true },
    });
    if (!issue) throw new NotFoundException("Issue not found");

    const acceptanceKey = input.acceptanceKey?.trim();
    const criterion = acceptanceKey
      ? issue.acceptanceCriteria.find((item) => item.key === acceptanceKey)
      : undefined;
    if (acceptanceKey && !criterion) {
      throw new BadRequestException("acceptance criterion not found");
    }

    return this.prisma.testCase.create({
      data: {
        jiraIssueId: issue.id,
        title,
        description: input.description?.trim() ?? "",
        preconditions: (input.preconditions ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
        steps,
        expectedResult,
        priority,
        type: input.type?.trim() || "FUNCTIONAL",
        tags: ["manual"],
        manuallyEdited: true,
        designStatus: "MANUALLY_EDITED",
        ...(criterion
          ? {
              acceptanceLinks: {
                create: [{ acceptanceCriterionId: criterion.id }],
              },
            }
          : {}),
      },
      include: {
        acceptanceLinks: { include: { acceptanceCriterion: true } },
      },
    });
  }

  async updateCase(
    id: string,
    data: Partial<{
      title: string;
      description: string;
      preconditions: string[];
      steps: string[];
      stepExpectations: string[];
      testData: string[];
      expectedResult: string;
      priority: string;
      type: string;
      tags: string[];
      automationStatus: string;
    }>,
  ) {
    const current = await this.getCase(id);
    const next = {
      title: data.title ?? current.title,
      description: data.description ?? current.description,
      preconditions: data.preconditions ?? current.preconditions,
      steps: data.steps ?? current.steps,
      stepExpectations: data.stepExpectations ?? current.stepExpectations,
      testData: data.testData ?? current.testData,
      expectedResult: data.expectedResult ?? current.expectedResult,
      priority: data.priority ?? current.priority,
      type: data.type ?? current.type,
    };
    const hash = testCaseContentHash({ ...current, ...next });
    let jiraSyncStatus = current.jiraSyncStatus;
    if (current.jiraSyncHash && current.jiraSyncHash !== hash) {
      if (current.jiraSyncStatus === "SYNCED" || current.jiraSyncStatus === "MODIFIED") {
        jiraSyncStatus = "MODIFIED";
      }
    } else if (current.jiraSyncHash && current.jiraSyncHash === hash && current.jiraSyncStatus === "MODIFIED") {
      jiraSyncStatus = "SYNCED";
    }
    return this.prisma.testCase.update({
      where: { id },
      data: { ...data, manuallyEdited: true, designStatus: "MANUALLY_EDITED", jiraSyncStatus },
    });
  }

  async recordRun(input: {
    testCaseId: string;
    status: string;
    notes?: string;
    evidence?: string;
  }) {
    if (!ALLOWED_STATUSES.has(input.status as TestExecutionStatus)) {
      throw new BadRequestException(`Invalid status: ${input.status}`);
    }
    if (input.status === TestExecutionStatus.NOT_RUN) {
      throw new BadRequestException("Cannot record NOT_RUN as an execution");
    }

    const testCase = await this.prisma.testCase.findUnique({
      where: { id: input.testCaseId },
    });
    if (!testCase) throw new NotFoundException("Test case not found");

    const notes = input.notes?.trim();
    const evidence = input.evidence?.trim();
    // The run and the case's latest notes are one logical write.
    return this.prisma.$transaction(async (tx) => {
      if (notes !== undefined || evidence !== undefined) {
        await tx.testCase.update({
          where: { id: input.testCaseId },
          data: {
            ...(notes !== undefined ? { executionNotes: notes } : {}),
            ...(evidence !== undefined ? { executionEvidence: evidence } : {}),
          },
        });
      }
      // Always insert — never overwrite previous TestRuns
      return tx.testRun.create({
        data: {
          testCaseId: input.testCaseId,
          status: input.status,
          notes,
          evidence,
        },
      });
    });
  }

  async saveExecution(id: string, input: { notes?: string; evidence?: string }) {
    const current = await this.prisma.testCase.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Test case not found");
    const notes = input.notes !== undefined ? input.notes.trim() : current.executionNotes;
    const evidence =
      input.evidence !== undefined ? input.evidence.trim() : current.executionEvidence;
    const updated = await this.prisma.testCase.update({
      where: { id },
      data: { executionNotes: notes, executionEvidence: evidence },
    });
    const latest = await this.prisma.testRun.findFirst({
      where: { testCaseId: id },
      orderBy: { executedAt: "desc" },
    });
    if (latest) {
      await this.prisma.testRun.update({
        where: { id: latest.id },
        data: { notes: notes || null, evidence: evidence || null },
      });
    }
    return updated;
  }

  listRuns(testCaseId?: string) {
    return this.prisma.testRun.findMany({
      where: testCaseId ? { testCaseId } : undefined,
      include: {
        testCase: true,
        bugs: true,
      },
      orderBy: { executedAt: "desc" },
      take: 200,
    });
  }

  listSuites() {
    return this.prisma.testSuite.findMany({
      include: {
        cases: {
          include: {
            testCase: {
              include: {
                runs: { orderBy: { executedAt: "desc" }, take: 1 },
              },
            },
          },
          orderBy: { orderIndex: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getSuite(id: string) {
    const suite = await this.prisma.testSuite.findUnique({
      where: { id },
      include: {
        cases: {
          include: { testCase: true },
          orderBy: { orderIndex: "asc" },
        },
      },
    });
    if (!suite) throw new NotFoundException("Suite not found");
    return suite;
  }

  async createSuite(input: {
    name: string;
    description?: string;
    kind?: string;
    testCaseIds?: string[];
  }) {
    const kind = (input.kind ?? "CUSTOM").toUpperCase();
    if (!["SMOKE", "REGRESSION", "CUSTOM"].includes(kind)) {
      throw new BadRequestException("kind must be SMOKE, REGRESSION, or CUSTOM");
    }
    const name = input.name.trim();
    if (!name) throw new BadRequestException("name is required");
    const testCaseIds = [...new Set(input.testCaseIds ?? [])];
    if (testCaseIds.length > 0) {
      const found = await this.prisma.testCase.count({ where: { id: { in: testCaseIds } } });
      if (found !== testCaseIds.length) throw new NotFoundException("Test case not found");
    }
    return this.prisma.testSuite.create({
      data: {
        name,
        description: input.description ?? "",
        kind,
        cases: testCaseIds.length
          ? {
              create: testCaseIds.map((testCaseId, orderIndex) => ({
                testCaseId,
                orderIndex,
              })),
            }
          : undefined,
      },
      include: { cases: { include: { testCase: true } } },
    });
  }

  async addCaseToSuite(suiteId: string, testCaseId: string) {
    await this.getSuite(suiteId);
    const testCase = await this.prisma.testCase.findUnique({
      where: { id: testCaseId },
    });
    if (!testCase) throw new NotFoundException("Test case not found");

    // Upsert makes a repeated add (double click, retry) a no-op instead of a
    // unique-constraint error; max+1 keeps positions distinct after removals.
    const { _max } = await this.prisma.testSuiteCase.aggregate({
      where: { suiteId },
      _max: { orderIndex: true },
    });
    return this.prisma.testSuiteCase.upsert({
      where: { suiteId_testCaseId: { suiteId, testCaseId } },
      create: { suiteId, testCaseId, orderIndex: (_max.orderIndex ?? -1) + 1 },
      update: {},
    });
  }

  async removeCaseFromSuite(suiteId: string, testCaseId: string) {
    // Removing a case that is no longer in the suite is already the desired state.
    await this.prisma.testSuiteCase.deleteMany({ where: { suiteId, testCaseId } });
    return { ok: true };
  }

  async deleteSuite(id: string) {
    await this.getSuite(id);
    await this.prisma.testSuite.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Traceability tree:
   * AC → TestCase → latest TestRun (+ linked Bugs)
   */
  async getTraceability(jiraIssueIdOrKey: string) {
    const issue = await this.prisma.jiraIssue.findFirst({
      where: {
        OR: [
          { id: jiraIssueIdOrKey },
          { key: jiraIssueIdOrKey.toUpperCase() },
        ],
      },
      include: {
        acceptanceCriteria: {
          orderBy: { orderIndex: "asc" },
          include: {
            testCases: {
              include: {
                testCase: {
                  include: {
                    runs: { orderBy: { executedAt: "desc" }, take: 1 },
                    bugs: { orderBy: { createdAt: "desc" } },
                    automationCandidates: true,
                  },
                },
              },
            },
          },
        },
        testCases: {
          include: {
            acceptanceLinks: true,
            runs: {
              orderBy: { executedAt: "desc" },
              take: 1,
              include: { bugs: { select: { id: true } } },
            },
            bugs: { select: { id: true, status: true } },
          },
        },
        requirementProfile: true,
      },
    });
    if (!issue) throw new NotFoundException("Issue not found");

    const coveredAcIds = new Set(
      issue.acceptanceCriteria
        .filter((ac) => ac.testCases.length > 0)
        .map((ac) => ac.id),
    );
    const unlinkedCases = issue.testCases.filter(
      (tc) => tc.acceptanceLinks.length === 0,
    );

    return {
      issue: { id: issue.id, key: issue.key, title: issue.title },
      coverage: {
        acceptanceTotal: issue.acceptanceCriteria.length,
        acceptanceCovered: coveredAcIds.size,
        // Same definition as the dashboard: ACs with ≥1 linked test case ÷
        // all ACs; null when the issue has no ACs (nothing to measure).
        requirementCoverage: computeCoverage(
          coveredAcIds.size,
          issue.acceptanceCriteria.length,
        ),
      },
      nodes: issue.acceptanceCriteria.map((ac) => ({
        id: ac.id,
        key: ac.key,
        text: ac.text,
        testCases: ac.testCases.map(({ testCase }) => ({
          id: testCase.id,
          title: testCase.title,
          priority: testCase.priority,
          automationStatus: testCase.automationStatus,
          latestStatus: testCase.runs[0]?.status ?? "NOT_RUN",
          latestRunId: testCase.runs[0]?.id ?? null,
          bugs: testCase.bugs.map((b) => ({
            id: b.id,
            title: b.title,
            severity: b.severity,
          })),
          automationCandidates: testCase.automationCandidates.map((c) => ({
            id: c.id,
            recommendedLevel: c.recommendedLevel,
            apiUiRecommendation: c.apiUiRecommendation,
          })),
        })),
      })),
      unlinkedTestCases: unlinkedCases.map((tc) => ({
        id: tc.id,
        title: tc.title,
        latestStatus: tc.runs[0]?.status ?? "NOT_RUN",
      })),
      uncoveredAcceptance: issue.acceptanceCriteria
        .filter((ac) => ac.testCases.length === 0)
        .map((ac) => ({ id: ac.id, key: ac.key, text: ac.text })),
      // Latest run failed and nothing tracks it: no bug filed for that run
      // and no still-open bug on the case. An old, closed bug from an earlier
      // failure does not hide a new failure.
      failedWithoutBug: issue.testCases
        .filter((tc) => {
          const latest = tc.runs[0];
          if (latest?.status !== "FAILED") return false;
          if (latest.bugs.length > 0) return false;
          return !tc.bugs.some((bug) => !CLOSED_BUG_STATUSES.has(bug.status));
        })
        .map((tc) => ({ id: tc.id, title: tc.title })),
      gaps: profileGaps(issue.requirementProfile?.intelligence),
    };
  }
}
