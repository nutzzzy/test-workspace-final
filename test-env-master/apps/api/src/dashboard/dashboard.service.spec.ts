import { DashboardService } from "./dashboard.service";

function run(status: string, executedAt: string) {
  return { status, executedAt: new Date(executedAt) };
}

function service(data: {
  testCases?: unknown[];
  runs?: unknown[];
  acceptance?: number;
  linked?: number;
}) {
  const prisma = {
    testCase: { findMany: jest.fn().mockResolvedValue(data.testCases ?? []) },
    testRun: { findMany: jest.fn().mockResolvedValue(data.runs ?? []) },
    risk: { findMany: jest.fn().mockResolvedValue([]) },
    acceptanceCriterion: { count: jest.fn().mockResolvedValue(data.acceptance ?? 0) },
    testCaseAcceptanceCriterion: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: data.linked ?? 0 }, (_, i) => ({ acceptanceCriterionId: `ac-${i}` })),
        ),
    },
  };
  return { prisma, svc: new DashboardService(prisma as never) };
}

const tc = (status: string | null, extra: Record<string, unknown> = {}) => ({
  priority: "HIGH",
  automationStatus: "NOT_AUTOMATED",
  runs: status ? [{ status }] : [],
  ...extra,
});

describe("DashboardService.getMetrics", () => {
  const now = new Date("2026-09-30T12:00:00Z");

  it("returns null ratios for an empty workspace instead of 0%", async () => {
    const { svc } = service({});
    const m = await svc.getMetrics("UTC", now);
    expect(m.totalTests).toBe(0);
    expect(m.passRate).toBeNull();
    expect(m.executionProgress).toBeNull();
    expect(m.requirementCoverage).toBeNull();
    expect(m.automationCoverage).toBeNull();
    expect(m.historicalRuns).toHaveLength(14);
  });

  it("uses the latest run per test case and counts blocked/skipped as executed", async () => {
    const { svc } = service({
      testCases: [tc("PASSED"), tc("PASSED"), tc("FAILED"), tc("BLOCKED"), tc("SKIPPED"), tc(null)],
      acceptance: 5,
      linked: 4,
    });
    const m = await svc.getMetrics("UTC", now);
    expect(m.executed).toBe(5);
    expect(m.notRun).toBe(1);
    expect(m.passRate).toBe(40);
    expect(m.executionProgress).toBe(83.3);
    expect(m.requirementCoverage).toBe(80);
    expect(m.acceptanceCovered).toBe(4);
    expect(m.acceptanceTotal).toBe(5);
    expect(m.statusDistribution).toEqual({ PASSED: 2, FAILED: 1, BLOCKED: 1, SKIPPED: 1, NOT_RUN: 1 });
  });

  it("ignores unknown stored statuses instead of inventing a category", async () => {
    const { svc } = service({ testCases: [tc("WEIRD"), tc("PASSED")] });
    const m = await svc.getMetrics("UTC", now);
    expect(Object.keys(m.statusDistribution)).toEqual(["PASSED", "FAILED", "BLOCKED", "SKIPPED", "NOT_RUN"]);
  });

  it("buckets history by the viewer's day and fills empty days", async () => {
    const { svc, prisma } = service({
      runs: [
        run("PASSED", "2026-09-29T21:30:00Z"), // 30 Sep in Tehran
        run("FAILED", "2026-09-30T08:00:00Z"),
        run("BLOCKED", "2026-09-20T08:00:00Z"),
      ],
    });
    const m = await svc.getMetrics("Asia/Tehran", now);
    expect(prisma.testRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executedAt: { gte: expect.any(Date) } } }),
    );
    const last = m.historicalRuns[m.historicalRuns.length - 1]!;
    expect(last).toEqual({ date: "2026-09-30", passed: 1, failed: 1, blocked: 0, skipped: 0 });
    expect(m.historicalRuns.find((d) => d.date === "2026-09-29")).toEqual({
      date: "2026-09-29", passed: 0, failed: 0, blocked: 0, skipped: 0,
    });
    expect(m.historicalRuns.find((d) => d.date === "2026-09-20")?.blocked).toBe(1);
  });
});
