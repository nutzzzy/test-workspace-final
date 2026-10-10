import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { JiraService } from "../jira/jira.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  assertLevel,
  assertStatusTransition,
  cleanAuthor,
  isBugStatus,
  statusDetail,
} from "./bugs.policy";

const bugInclude = {
  testCase: true,
  testRun: true,
  jiraIssue: true,
  comments: { orderBy: { createdAt: "asc" as const } },
  activities: { orderBy: { createdAt: "asc" as const } },
};

type BugWrite = {
  title?: string;
  description?: string;
  reproductionSteps?: string[];
  expectedResult?: string;
  actualResult?: string;
  severity?: string;
  priority?: string;
  environment?: string;
  evidence?: string;
  assignee?: string;
  reporter?: string;
  jiraIssueId?: string;
  testCaseId?: string;
  testRunId?: string;
  scenarioRunId?: string;
};

@Injectable()
export class BugsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraService,
  ) {}

  list() {
    return this.prisma.bug.findMany({
      include: {
        testCase: true,
        testRun: true,
        jiraIssue: true,
        _count: { select: { comments: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async get(id: string) {
    const bug = await this.prisma.bug.findUnique({
      where: { id },
      include: bugInclude,
    });
    if (!bug) throw new NotFoundException("Bug not found");
    return bug;
  }

  async create(input: BugWrite & { title: string; author?: string }) {
    const title = input.title?.trim() ?? "";
    if (!title) throw new BadRequestException("Title is required");
    const severity = input.severity ?? "MEDIUM";
    const priority = input.priority ?? "MEDIUM";
    this.levels(severity, priority);
    const author = cleanAuthor(input.author ?? input.reporter);
    const bug = await this.prisma.bug.create({
      data: {
        title,
        description: input.description?.trim() ?? "",
        reproductionSteps: this.steps(input.reproductionSteps) as Prisma.InputJsonValue,
        expectedResult: input.expectedResult?.trim() ?? "",
        actualResult: input.actualResult?.trim() ?? "",
        severity,
        priority,
        environment: input.environment?.trim() || null,
        evidence: input.evidence?.trim() || null,
        assignee: input.assignee?.trim() || null,
        reporter: author,
        status: "OPEN",
        jiraIssueId: input.jiraIssueId || null,
        testCaseId: input.testCaseId || null,
        testRunId: input.testRunId || null,
        scenarioRunId: input.scenarioRunId || null,
        activities: {
          create: {
            author,
            action: "CREATED",
            detail: "created the bug",
          },
        },
      },
    });
    return this.get(bug.id);
  }

  async createFromFailedRun(testRunId: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: testRunId },
      include: { testCase: true },
    });
    if (!run) throw new NotFoundException("Test run not found");
    if (run.status !== "FAILED") {
      throw new BadRequestException("Only a failed test run can create a bug");
    }
    // Idempotent: retrying (double click, network retry) returns the bug
    // already filed for this run instead of creating a duplicate.
    const existing = await this.prisma.bug.findFirst({
      where: { testRunId: run.id },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return this.get(existing.id);
    const steps = Array.isArray(run.testCase.steps)
      ? run.testCase.steps.filter((step): step is string => typeof step === "string")
      : [];
    return this.create({
      title: `Bug: ${run.testCase.title}`,
      description: run.notes ?? "Failed test execution",
      reproductionSteps: steps,
      expectedResult: run.testCase.expectedResult,
      actualResult: run.notes ?? "FAILED",
      severity: "HIGH",
      priority: run.testCase.priority,
      evidence: run.evidence ?? undefined,
      jiraIssueId: run.testCase.jiraIssueId ?? undefined,
      testCaseId: run.testCaseId,
      testRunId: run.id,
    });
  }

  async update(id: string, input: BugWrite & { author?: string }) {
    const current = await this.get(id);
    const author = cleanAuthor(input.author);
    if (input.severity) assertLevel(input.severity, "Severity");
    if (input.priority) assertLevel(input.priority, "Priority");
    const data = {
      title: input.title?.trim() || current.title,
      description: input.description !== undefined ? input.description.trim() : current.description,
      reproductionSteps:
        input.reproductionSteps !== undefined
          ? this.steps(input.reproductionSteps)
          : this.steps(
              Array.isArray(current.reproductionSteps)
                ? current.reproductionSteps.filter((step): step is string => typeof step === "string")
                : [],
            ),
      expectedResult:
        input.expectedResult !== undefined
          ? input.expectedResult.trim()
          : current.expectedResult,
      actualResult:
        input.actualResult !== undefined ? input.actualResult.trim() : current.actualResult,
      severity: input.severity ?? current.severity,
      priority: input.priority ?? current.priority,
      environment:
        input.environment !== undefined
          ? input.environment.trim() || null
          : current.environment,
      evidence:
        input.evidence !== undefined ? input.evidence.trim() || null : current.evidence,
      assignee:
        input.assignee !== undefined ? input.assignee.trim() || null : current.assignee,
      reporter: input.reporter?.trim() || current.reporter,
      jiraIssueId:
        input.jiraIssueId !== undefined ? input.jiraIssueId || null : current.jiraIssueId,
      testCaseId: input.testCaseId !== undefined ? input.testCaseId || null : current.testCaseId,
      testRunId: input.testRunId !== undefined ? input.testRunId || null : current.testRunId,
      scenarioRunId:
        input.scenarioRunId !== undefined
          ? input.scenarioRunId || null
          : current.scenarioRunId,
    };
    if (!data.title) throw new BadRequestException("Title is required");

    const changes = this.diff(current, data);
    await this.prisma.$transaction(async (tx) => {
      await tx.bug.update({ where: { id }, data });
      if (changes.length > 0) {
        await tx.bugActivity.createMany({
          data: changes.map((detail) => ({
            bugId: id,
            author,
            action: "UPDATED",
            detail,
          })),
        });
      }
    });

    const jiraLine = changes.find((line) => /severity|priority|Jira/.test(line));
    if (jiraLine && data.jiraIssueId) {
      await this.noteJira(id, data.jiraIssueId, author, [
        `${author} updated bug “${data.title}”.`,
        jiraLine,
      ]);
    }
    return this.get(id);
  }

  async changeStatus(id: string, status: string, authorInput?: string) {
    const current = await this.get(id);
    if (!isBugStatus(status)) {
      throw new BadRequestException("This status change is not allowed.");
    }
    if (current.status === status) return current;
    try {
      assertStatusTransition(current.status, status);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "This status change is not allowed.",
      );
    }
    const author = cleanAuthor(authorInput);
    const detail = statusDetail(current.status, status);
    await this.prisma.$transaction(async (tx) => {
      await tx.bug.update({ where: { id }, data: { status } });
      await tx.bugActivity.create({
        data: { bugId: id, author, action: "STATUS", detail },
      });
    });
    if (current.jiraIssueId) {
      await this.noteJira(id, current.jiraIssueId, author, [
        `${author} ${detail}.`,
        `Bug: ${current.title}`,
      ]);
    }
    return this.get(id);
  }

  async addComment(id: string, input: { author?: string; content?: string }) {
    const current = await this.get(id);
    const content = input.content?.trim() ?? "";
    if (!content) throw new BadRequestException("Comment is required");
    if (content.length > 4000) throw new BadRequestException("Comment is too long");
    const author = cleanAuthor(input.author);
    await this.prisma.$transaction(async (tx) => {
      await tx.bugComment.create({ data: { bugId: id, author, content } });
      await tx.bugActivity.create({
        data: {
          bugId: id,
          author,
          action: "COMMENT",
          detail: "added a comment",
        },
      });
      await tx.bug.update({ where: { id }, data: { updatedAt: new Date() } });
    });
    if (current.jiraIssueId) {
      await this.noteJira(id, current.jiraIssueId, author, [
        `${author} commented on bug “${current.title}”.`,
        content,
      ]);
    }
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.bug.delete({ where: { id } });
    return { ok: true };
  }

  private levels(severity: string, priority: string) {
    try {
      assertLevel(severity, "Severity");
      assertLevel(priority, "Priority");
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Severity is invalid",
      );
    }
  }

  private steps(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((step): step is string => typeof step === "string")
      .map((step) => step.trim())
      .filter(Boolean);
  }

  private diff(
    current: {
      title: string;
      description: string;
      severity: string;
      priority: string;
      assignee: string | null;
      expectedResult: string;
      actualResult: string;
      jiraIssueId: string | null;
    },
    next: {
      title: string;
      description: string;
      severity: string;
      priority: string;
      assignee: string | null;
      expectedResult: string;
      actualResult: string;
      jiraIssueId: string | null;
    },
  ): string[] {
    const lines: string[] = [];
    if (current.title !== next.title) lines.push("changed the title");
    if (current.description !== next.description) lines.push("changed the description");
    if (current.severity !== next.severity) {
      lines.push(`changed severity from ${current.severity} to ${next.severity}`);
    }
    if (current.priority !== next.priority) {
      lines.push(`changed priority from ${current.priority} to ${next.priority}`);
    }
    if ((current.assignee ?? "") !== (next.assignee ?? "")) {
      lines.push(
        next.assignee
          ? `assigned the bug to ${next.assignee}`
          : "cleared the assignee",
      );
    }
    if (current.expectedResult !== next.expectedResult) {
      lines.push("changed the expected result");
    }
    if (current.actualResult !== next.actualResult) {
      lines.push("changed the actual result");
    }
    if ((current.jiraIssueId ?? "") !== (next.jiraIssueId ?? "")) {
      lines.push(
        next.jiraIssueId ? "linked the bug to a Jira issue" : "removed the Jira link",
      );
    }
    return lines;
  }

  private async noteJira(
    bugId: string,
    jiraIssueId: string,
    author: string,
    lines: string[],
  ) {
    try {
      await this.jira.notifyIssue(jiraIssueId, lines);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Jira issue could not be updated.";
      await this.prisma.bugActivity.create({
        data: {
          bugId,
          author,
          action: "JIRA",
          detail: `Jira sync failed: ${message}`,
        },
      });
    }
  }
}
