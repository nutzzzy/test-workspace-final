import type { QualityDimension, QualityLevel } from "@qa-workbench/shared";

/**
 * The scoring model's knobs. The 20 ISTQB-oriented dimensions are scored
 * individually and weighted in 13 groups (the senior-QA base weighting); a
 * group none of whose dimensions apply to the task is dropped and its weight
 * goes to the rest, so the score is always 0–100 of what the task needs.
 */

export const WEIGHT_GROUPS: Array<{ key: string; weight: number; dimensions: QualityDimension[] }> = [
  { key: "requirementCoverage", weight: 15, dimensions: ["requirementCoverage"] },
  { key: "functionalCorrectness", weight: 12, dimensions: ["functionalCorrectness", "expectedResultQuality"] },
  { key: "positiveScenarios", weight: 8, dimensions: ["positiveScenarios"] },
  { key: "negativeScenarios", weight: 10, dimensions: ["negativeScenarios"] },
  { key: "boundaryEquivalence", weight: 8, dimensions: ["boundaryValueAnalysis", "equivalencePartitioning"] },
  { key: "businessRules", weight: 8, dimensions: ["businessRules"] },
  { key: "stateTransition", weight: 6, dimensions: ["stateTransition"] },
  { key: "errorHandling", weight: 7, dimensions: ["errorHandling"] },
  { key: "dataValidation", weight: 6, dimensions: ["dataValidation"] },
  { key: "traceability", weight: 6, dimensions: ["traceability"] },
  { key: "riskCoverage", weight: 6, dimensions: ["riskCoverage"] },
  {
    key: "testabilityMaintainability",
    weight: 4,
    dimensions: ["testability", "testStepsClarity", "preconditionsDependencies", "maintainability", "duplicateDetection"],
  },
  { key: "securityPerformance", weight: 4, dimensions: ["security", "performance"] },
];

export type TaskKind = "payment" | "api" | "ui" | "stateful";

export type QualityConfig = {
  /** Lowest score of each level, best first. */
  levels: Array<{ min: number; level: QualityLevel }>;
  /** Weight multipliers per task kind (by group key); the result is renormalised to 100. */
  emphasis: Record<TaskKind, Record<string, number>>;
  /** Two providers whose selection metric differs by at most this many points are "close enough". */
  closeEnough: number;
  /** Providers scoring below this never contribute cases to the merge. */
  mergeMinProviderScore: number;
  /** A case from another provider must reach this quality to be merged. */
  mergeMinCaseQuality: number;
  /** Below this a case is rejected by the final quality gate. */
  gateMinCaseQuality: number;
  /** Text similarity (0–1) at which two cases are the same scenario. */
  duplicateSimilarity: number;
  /** Merged cases per requirement at most (no bloat from many providers). */
  maxCasesPerRequirement: number;
  /** After one provider covers every requirement, the others get this long before they are stopped. */
  stragglerGraceMs: number;
};

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  levels: [
    { min: 90, level: "Excellent" },
    { min: 80, level: "Very Good" },
    { min: 70, level: "Good" },
    { min: 60, level: "Needs Improvement" },
    { min: 0, level: "Poor" },
  ],
  emphasis: {
    // Money: rules, failures, states, security and risk matter most.
    payment: { businessRules: 1.6, negativeScenarios: 1.3, stateTransition: 1.4, securityPerformance: 1.75, riskCoverage: 1.4, dataValidation: 1.2 },
    // CRUD APIs: validation, authorization, negative paths, integrity and boundaries.
    api: { dataValidation: 1.4, negativeScenarios: 1.25, securityPerformance: 1.5, boundaryEquivalence: 1.25, errorHandling: 1.2 },
    // A UI change: what the user sees and does.
    ui: { positiveScenarios: 1.3, functionalCorrectness: 1.2 },
    stateful: { stateTransition: 1.3 },
  },
  closeEnough: 5,
  // Only junk providers are kept out; every merged case must still pass `mergeMinCaseQuality`.
  mergeMinProviderScore: 25,
  mergeMinCaseQuality: 70,
  gateMinCaseQuality: 45,
  duplicateSimilarity: 0.72,
  maxCasesPerRequirement: 8,
  stragglerGraceMs: 30_000,
};

/** Saved overrides on top of the defaults; invalid values fall back to the default. */
export function resolveQualityConfig(saved: unknown): QualityConfig {
  const input = (saved && typeof saved === "object" ? saved : {}) as Partial<Record<keyof QualityConfig, unknown>>;
  const num = (key: keyof QualityConfig, min: number, max: number) => {
    const value = Number(input[key]);
    return input[key] !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : (DEFAULT_QUALITY_CONFIG[key] as number);
  };
  let levels = DEFAULT_QUALITY_CONFIG.levels;
  if (Array.isArray(input.levels)) {
    const parsed = DEFAULT_QUALITY_CONFIG.levels.map((fallback) => {
      const match = (input.levels as Array<{ level?: unknown; min?: unknown }>).find((item) => item?.level === fallback.level);
      const min = Number(match?.min);
      return { level: fallback.level, min: match && Number.isFinite(min) ? Math.min(100, Math.max(0, min)) : fallback.min };
    });
    // Levels must stay in descending order to be meaningful.
    if (parsed.every((item, index) => index === 0 || parsed[index - 1]!.min >= item.min)) levels = parsed;
  }
  return {
    ...DEFAULT_QUALITY_CONFIG,
    levels,
    closeEnough: num("closeEnough", 0, 50),
    mergeMinProviderScore: num("mergeMinProviderScore", 0, 100),
    mergeMinCaseQuality: num("mergeMinCaseQuality", 0, 100),
    gateMinCaseQuality: num("gateMinCaseQuality", 0, 100),
    duplicateSimilarity: num("duplicateSimilarity", 0.3, 1),
    maxCasesPerRequirement: Math.round(num("maxCasesPerRequirement", 1, 50)),
    stragglerGraceMs: Math.round(num("stragglerGraceMs", 0, 300_000)),
  };
}

export function qualityLevel(score: number, config: QualityConfig = DEFAULT_QUALITY_CONFIG): QualityLevel {
  return config.levels.find((item) => score >= item.min)?.level ?? "Poor";
}
