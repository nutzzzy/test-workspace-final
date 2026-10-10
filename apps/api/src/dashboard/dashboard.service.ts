import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  computeCoverage,
  computePassRate,
  dayKey,
  lastDays,
  safeTimeZone,
} from "./dashboard.math";

const HISTORY_DAYS = 14;

export type DashboardMetrics = {
  totalTests: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  notRun: number;
  /** PASSED / executed × 100; null when nothing has been executed. */
  passRate: number | null;
  /** executed / totalTests × 100; null when there are no test cases. */
  executionProgress: number | null;
  /** ACs with ≥1 linked test case / all ACs × 100; null when there are no ACs. */
  requirementCoverage: number | null;
  acceptanceTotal: number;
  acceptanceCovered: number;
  /** automated test cases / totalTests × 100; null when there are no test cases. */
  automationCoverage: number | null;
  riskDistribution: Record<string, number>;
  manualVsAutomated: { manual: number; automated: number };
  priorityDistribution: Record<string, number>;
  statusDistribution: Record<string, number>;
  /** One entry per calendar day (in `timeZone`) for the last 14 days, empty days included. */
  historicalRuns: Array<{
    date: string;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
  }>;
  timeZone: string;
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(timeZoneInput?: unknown, now = new Date()): Promise<DashboardMetrics> {
    const timeZone = safeTimeZone(timeZoneInput);
    const days = lastDays(now, HISTORY_DAYS, timeZone);
    // 15 × 24h back always covers the first calendar day in any zone.
    const since = new Date(now.getTime() - (HISTORY_DAYS + 1) * 24 * 3600_000);
    const [testCases, recentRuns, risks, acceptance, linked] =
      await Promise.all([
        this.prisma.testCase.findMany({
          include: {
            runs: { orderBy: { executedAt: "desc" }, take: 1 },
          },
        }),
        this.prisma.testRun.findMany({
          where: { executedAt: { gte: since } },
          select: { status: true, executedAt: true },
        }),
        this.prisma.risk.findMany(),
        this.prisma.acceptanceCriterion.count(),
        this.prisma.testCaseAcceptanceCriterion.findMany({
          distinct: ["acceptanceCriterionId"],
          select: { acceptanceCriterionId: true },
        }),
      ]);

    const statusOf = (tc: (typeof testCases)[number]) =>
      tc.runs[0]?.status ?? "NOT_RUN";

    const counts = {
      PASSED: 0,
      FAILED: 0,
      BLOCKED: 0,
      SKIPPED: 0,
      NOT_RUN: 0,
    };
    const priorityDistribution: Record<string, number> = {};
    let automated = 0;

    for (const tc of testCases) {
      const status = statusOf(tc);
      if (status in counts) counts[status as keyof typeof counts] += 1;
      priorityDistribution[tc.priority] =
        (priorityDistribution[tc.priority] ?? 0) + 1;
      if (tc.automationStatus !== "NOT_AUTOMATED") automated += 1;
    }

    const totalTests = testCases.length;
    const executed = totalTests - counts.NOT_RUN;
    const passRate = computePassRate(counts.PASSED, executed);
    const executionProgress = computeCoverage(executed, totalTests);
    const requirementCoverage = computeCoverage(linked.length, acceptance);
    const automationCoverage = computeCoverage(automated, totalTests);

    const riskDistribution: Record<string, number> = {};
    for (const risk of risks) {
      riskDistribution[risk.impact] = (riskDistribution[risk.impact] ?? 0) + 1;
    }

    const byDay = new Map(
      days.map((date) => [date, { passed: 0, failed: 0, blocked: 0, skipped: 0 }]),
    );
    for (const run of recentRuns) {
      const bucket = byDay.get(dayKey(run.executedAt, timeZone));
      if (!bucket) continue;
      if (run.status === "PASSED") bucket.passed += 1;
      else if (run.status === "FAILED") bucket.failed += 1;
      else if (run.status === "BLOCKED") bucket.blocked += 1;
      else if (run.status === "SKIPPED") bucket.skipped += 1;
    }
    const historicalRuns = days.map((date) => ({ date, ...byDay.get(date)! }));

    return {
      totalTests,
      executed,
      passed: counts.PASSED,
      failed: counts.FAILED,
      blocked: counts.BLOCKED,
      skipped: counts.SKIPPED,
      notRun: counts.NOT_RUN,
      passRate,
      executionProgress,
      requirementCoverage,
      acceptanceTotal: acceptance,
      acceptanceCovered: linked.length,
      automationCoverage,
      riskDistribution,
      manualVsAutomated: {
        manual: totalTests - automated,
        automated,
      },
      priorityDistribution,
      statusDistribution: counts,
      historicalRuns,
      timeZone,
    };
  }
}
