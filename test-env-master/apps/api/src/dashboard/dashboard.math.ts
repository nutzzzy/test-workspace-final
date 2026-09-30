/**
 * Single source of truth for percentage metrics.
 *
 * A ratio with a zero denominator has no meaningful value ("nothing to
 * measure"), so it is reported as `null` instead of 0% or 100%. Callers must
 * render `null` as "not measurable". Values are rounded once, to one decimal
 * place, at this boundary; counts are always returned alongside so the UI can
 * show numerator / denominator.
 */
export function percentage(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Pass rate = PASSED / executed (executed = every status except NOT_RUN). */
export function computePassRate(passed: number, executed: number): number | null {
  return percentage(passed, executed);
}

/** Coverage = covered / total. */
export function computeCoverage(covered: number, total: number): number | null {
  return percentage(covered, total);
}

const DEFAULT_TIME_ZONE = "UTC";

/** Accept only IANA zones the runtime understands; anything else falls back to UTC. */
export function safeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    return DEFAULT_TIME_ZONE;
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Calendar day (YYYY-MM-DD) of an instant, as seen in `timeZone`. */
export function dayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * The last `days` calendar days ending today in `timeZone`, oldest first.
 * Every day is present so charts never skip empty dates.
 */
export function lastDays(now: Date, days: number, timeZone: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Step back in 12h increments so DST shifts can never skip a calendar day.
  for (let offset = 0; out.length < days && offset < days * 3; offset += 1) {
    const key = dayKey(new Date(now.getTime() - offset * 12 * 3600_000), timeZone);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.reverse();
}
