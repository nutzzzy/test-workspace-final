import { TestExecutionStatus } from "@qa-workbench/shared";
import { TestManagementService } from "./test-management.service";

function createPrismaMock(overrides: Record<string, unknown> = {}) {
  const mock: Record<string, unknown> = {
    testCase: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    testRun: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    testSuite: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    testSuiteCase: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    jiraIssue: {
      findFirst: jest.fn(),
    },
    ...overrides,
  };
  mock.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(mock));
  return mock as typeof mock & {
    testCase: Record<string, jest.Mock>;
    testRun: Record<string, jest.Mock>;
    testSuite: Record<string, jest.Mock>;
    testSuiteCase: Record<string, jest.Mock>;
    jiraIssue: Record<string, jest.Mock>;
  };
}

describe("TestManagementService", () => {
  it("records a new TestRun without overwriting history", async () => {
    const prisma = createPrismaMock();
    (prisma.testCase.findUnique as jest.Mock).mockResolvedValue({
      id: "tc-1",
      title: "Cancel order",
    });
    (prisma.testRun.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "run-1", ...data, executedAt: new Date() }),
    );

    const service = new TestManagementService(prisma as never);
    const first = await service.recordRun({
      testCaseId: "tc-1",
      status: TestExecutionStatus.PASSED,
      notes: "ok",
    });
    const second = await service.recordRun({
      testCaseId: "tc-1",
      status: TestExecutionStatus.FAILED,
      notes: "broke",
    });

    expect(prisma.testRun.create).toHaveBeenCalledTimes(2);
    expect(first.status).toBe("PASSED");
    expect(second.status).toBe("FAILED");
    expect(prisma.testRun.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
  });

  it("saves notes and evidence without marking the case manually edited", async () => {
    const prisma = createPrismaMock();
    (prisma.testCase.findUnique as jest.Mock).mockResolvedValue({
      id: "tc-1",
      executionNotes: "",
      executionEvidence: "",
    });
    (prisma.testCase.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "tc-1", manuallyEdited: false, ...data }),
    );
    (prisma.testRun.findFirst as jest.Mock).mockResolvedValue({ id: "run-1" });
    (prisma.testRun.update as jest.Mock).mockResolvedValue({ id: "run-1" });

    const service = new TestManagementService(prisma as never);
    await service.saveExecution("tc-1", { notes: "یادداشت", evidence: "شواهد" });

    expect(prisma.testCase.update).toHaveBeenCalledWith({
      where: { id: "tc-1" },
      data: { executionNotes: "یادداشت", executionEvidence: "شواهد" },
    });
    expect(prisma.testRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { notes: "یادداشت", evidence: "شواهد" },
    });
  });

  it("rejects invalid status changes", async () => {
    const prisma = createPrismaMock();
    const service = new TestManagementService(prisma as never);
    await expect(
      service.recordRun({ testCaseId: "tc-1", status: "DONE" }),
    ).rejects.toThrow(/Invalid status/);
  });

  it("rejects NOT_RUN as an execution status", async () => {
    const prisma = createPrismaMock();
    const service = new TestManagementService(prisma as never);
    await expect(
      service.recordRun({
        testCaseId: "tc-1",
        status: TestExecutionStatus.NOT_RUN,
      }),
    ).rejects.toThrow(/NOT_RUN/);
  });

  it("builds AC → TC → run/bug traceability relations", async () => {
    const prisma = createPrismaMock();
    (prisma.jiraIssue.findFirst as jest.Mock).mockResolvedValue({
      id: "issue-1",
      key: "QA-1",
      title: "Cancel order",
      acceptanceCriteria: [
        {
          id: "ac-1",
          key: "AC-1",
          text: "User can cancel",
          testCases: [
            {
              testCase: {
                id: "tc-1",
                title: "TC-01 cancel happy path",
                priority: "HIGH",
                automationStatus: "NOT_AUTOMATED",
                runs: [{ id: "run-1", status: "FAILED" }],
                bugs: [{ id: "bug-1", title: "Cancel 500", severity: "HIGH" }],
                automationCandidates: [],
              },
            },
          ],
        },
        {
          id: "ac-2",
          key: "AC-2",
          text: "Refund issued",
          testCases: [],
        },
      ],
      testCases: [
        {
          id: "tc-1",
          title: "TC-01 cancel happy path",
          acceptanceLinks: [{ acceptanceCriterionId: "ac-1" }],
          runs: [{ status: "FAILED", bugs: [] }],
          bugs: [],
        },
        {
          id: "tc-orphan",
          title: "Unlinked case",
          acceptanceLinks: [],
          runs: [],
          bugs: [],
        },
      ],
    });

    const service = new TestManagementService(prisma as never);
    const tree = await service.getTraceability("QA-1");

    expect(tree.coverage.acceptanceTotal).toBe(2);
    expect(tree.coverage.acceptanceCovered).toBe(1);
    expect(tree.coverage.requirementCoverage).toBe(50);
    expect(tree.nodes[0].testCases[0].latestStatus).toBe("FAILED");
    expect(tree.nodes[0].testCases[0].bugs[0].id).toBe("bug-1");
    expect(tree.unlinkedTestCases).toHaveLength(1);
    expect(tree.failedWithoutBug).toEqual([{ id: "tc-1", title: "TC-01 cancel happy path" }]);
  });

  it("flags a new failure even when an old bug of the case is closed", async () => {
    const prisma = createPrismaMock();
    const issue = (cases: unknown[]) => ({
      id: "issue-1",
      key: "QA-1",
      title: "x",
      acceptanceCriteria: [],
      testCases: cases,
    });
    const tc = (id: string, runBugs: unknown[], bugs: Array<{ status: string }>) => ({
      id,
      title: id,
      acceptanceLinks: [],
      runs: [{ status: "FAILED", bugs: runBugs }],
      bugs,
    });
    prisma.jiraIssue.findFirst.mockResolvedValue(
      issue([
        tc("old-closed", [], [{ status: "CLOSED" }]),
        tc("open-bug", [], [{ status: "IN_PROGRESS" }]),
        tc("run-bug", [{ id: "b" }], []),
      ]),
    );
    const tree = await new TestManagementService(prisma as never).getTraceability("QA-1");
    expect(tree.failedWithoutBug.map((item) => item.id)).toEqual(["old-closed"]);
    expect(tree.coverage.requirementCoverage).toBeNull();
  });

  it("adds a case to a suite idempotently at max+1", async () => {
    const prisma = createPrismaMock({
      testSuiteCase: {
        aggregate: jest.fn().mockResolvedValue({ _max: { orderIndex: 2 } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });
    prisma.testSuite.findUnique.mockResolvedValue({ id: "s1", cases: [] });
    prisma.testCase.findUnique.mockResolvedValue({ id: "tc-1" });
    await new TestManagementService(prisma as never).addCaseToSuite("s1", "tc-1");
    expect(prisma.testSuiteCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { suiteId: "s1", testCaseId: "tc-1", orderIndex: 3 }, update: {} }),
    );
  });

  it("stores a manual test case linked to an acceptance criterion", async () => {
    const prisma = createPrismaMock();
    (prisma.jiraIssue.findFirst as jest.Mock).mockResolvedValue({
      id: "issue-1",
      acceptanceCriteria: [{ id: "ac-1", key: "AC-01" }],
    });
    (prisma.testCase.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "tc-new", ...data }),
    );

    const service = new TestManagementService(prisma as never);
    const created = await service.createCase({
      jiraIssueId: "BX-1",
      title: "  تماس با شماره موبایل  ",
      steps: [" درخواست را بفرستید ", ""],
      expectedResult: " پذیرفته شود ",
      acceptanceKey: "AC-01",
    });

    expect(created.manuallyEdited).toBe(true);
    expect(created.steps).toEqual(["درخواست را بفرستید"]);
    expect(created.title).toBe("تماس با شماره موبایل");
    expect(prisma.testCase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jiraIssueId: "issue-1",
          tags: ["manual"],
          acceptanceLinks: {
            create: [{ acceptanceCriterionId: "ac-1" }],
          },
        }),
      }),
    );
  });

  it("rejects a manual test case without steps", async () => {
    const prisma = createPrismaMock();
    const service = new TestManagementService(prisma as never);
    await expect(
      service.createCase({
        jiraIssueId: "BX-1",
        title: "کیس",
        steps: ["  "],
        expectedResult: "نتیجه",
      }),
    ).rejects.toThrow(/at least one step/);
  });

  it("rejects a manual test case for an unknown acceptance criterion", async () => {
    const prisma = createPrismaMock();
    (prisma.jiraIssue.findFirst as jest.Mock).mockResolvedValue({
      id: "issue-1",
      acceptanceCriteria: [{ id: "ac-1", key: "AC-01" }],
    });
    const service = new TestManagementService(prisma as never);
    await expect(
      service.createCase({
        jiraIssueId: "BX-1",
        title: "کیس",
        steps: ["قدم"],
        expectedResult: "نتیجه",
        acceptanceKey: "AC-99",
      }),
    ).rejects.toThrow(/acceptance criterion not found/);
  });

  it("rejects a manual test case when the issue does not exist", async () => {
    const prisma = createPrismaMock();
    (prisma.jiraIssue.findFirst as jest.Mock).mockResolvedValue(null);
    const service = new TestManagementService(prisma as never);
    await expect(
      service.createCase({
        jiraIssueId: "MISSING",
        title: "کیس",
        steps: ["قدم"],
        expectedResult: "نتیجه",
      }),
    ).rejects.toThrow(/Issue not found/);
  });
});
