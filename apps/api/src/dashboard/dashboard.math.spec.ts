import {
  computeCoverage,
  computePassRate,
  dayKey,
  lastDays,
  percentage,
  safeTimeZone,
} from "./dashboard.math";

describe("percentage", () => {
  it("computes normal, partial, complete and single values", () => {
    expect(percentage(8, 10)).toBe(80);
    expect(percentage(1, 1)).toBe(100);
    expect(percentage(0, 5)).toBe(0);
    expect(percentage(4, 5)).toBe(80);
  });

  it("reports an empty denominator as not measurable, never 0% or NaN", () => {
    expect(percentage(0, 0)).toBeNull();
    expect(computePassRate(0, 0)).toBeNull();
    expect(computeCoverage(0, 0)).toBeNull();
    expect(percentage(Number.NaN, 3)).toBeNull();
    expect(percentage(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds once to one decimal place", () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(2, 3)).toBe(66.7);
    expect(percentage(1, 8)).toBe(12.5);
    expect(percentage(999, 1000)).toBe(99.9);
    expect(percentage(9999, 10000)).toBe(100);
  });

  it("handles large values", () => {
    expect(percentage(1_234_567, 2_469_134)).toBe(50);
  });
});

describe("calendar days", () => {
  it("buckets an instant by the viewer's time zone", () => {
    // 21:30 UTC on 30 Sep is already 1 Oct in Tehran (UTC+03:30).
    const instant = new Date("2026-09-30T21:30:00Z");
    expect(dayKey(instant, "UTC")).toBe("2026-09-30");
    expect(dayKey(instant, "Asia/Tehran")).toBe("2026-10-01");
  });

  it("returns every day in the window, oldest first", () => {
    const days = lastDays(new Date("2026-09-30T12:00:00Z"), 14, "UTC");
    expect(days).toHaveLength(14);
    expect(days[0]).toBe("2026-09-17");
    expect(days[13]).toBe("2026-09-30");
    expect(new Set(days).size).toBe(14);
  });

  it("falls back to UTC for unknown zones", () => {
    expect(safeTimeZone("Asia/Tehran")).toBe("Asia/Tehran");
    expect(safeTimeZone("Not/AZone")).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
  });
});
