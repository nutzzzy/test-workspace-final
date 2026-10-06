/**
 * Test-case quality evaluation: the shapes the API reports and the web app
 * displays. Scoring itself lives in the API (analysis/studio/quality); the UI
 * only renders these reports.
 */

export const ISTQB_TECHNIQUES = [
  "Equivalence Partitioning",
  "Boundary Value Analysis",
  "Decision Table Testing",
  "State Transition Testing",
  "Use Case Testing",
  "Error Guessing",
  "Exploratory Testing",
  "Risk-based Testing",
] as const;
export type IstqbTechnique = (typeof ISTQB_TECHNIQUES)[number];

export const QUALITY_DIMENSIONS = [
  "requirementCoverage",
  "functionalCorrectness",
  "positiveScenarios",
  "negativeScenarios",
  "boundaryValueAnalysis",
  "equivalencePartitioning",
  "businessRules",
  "stateTransition",
  "errorHandling",
  "dataValidation",
  "preconditionsDependencies",
  "testStepsClarity",
  "expectedResultQuality",
  "testability",
  "traceability",
  "duplicateDetection",
  "riskCoverage",
  "security",
  "performance",
  "maintainability",
] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

export type QualityLevel = "Excellent" | "Very Good" | "Good" | "Needs Improvement" | "Poor";
export type CasePriority = "Critical" | "High" | "Medium" | "Low";

/** The provider-independent test case every provider output is converted into. */
export type NormalizedTestCase = {
  id: string;
  title: string;
  objective: string;
  requirementIds: string[];
  priority: CasePriority;
  riskLevel: CasePriority;
  testType: string[];
  testDesignTechniques: IstqbTechnique[];
  preconditions: string[];
  testData: string[];
  steps: Array<{ action: string; expected: string }>;
  expectedResults: string[];
  postconditions: string[];
  tags: string[];
  sourceProviders: string[];
  qualityScore: number;
  /** Business-rule ids (R1 …) the case exercises. */
  ruleRefs: string[];
  /** Quality findings on this case (codes, see CASE_FINDINGS). */
  findings: CaseFinding[];
};

export const CASE_FINDINGS = [
  "missingExpectedResult",
  "vagueSteps",
  "vagueExpectedResult",
  "missingPreconditions",
  "missingTestData",
  "untraceable",
  "irrelevant",
  "unsupportedAssumption",
  "unclearPassFail",
  "noSteps",
] as const;
export type CaseFinding = (typeof CASE_FINDINGS)[number];

export type ProviderStatus = "running" | "ok" | "partial" | "failed" | "timeout";

/** A reason code with values; the UI words it in the reader's language. */
export type QualityNote = { code: string; values?: Record<string, string | number> };

export type ProviderEvaluation = {
  /** Connection id (or "default" for the single-route run). */
  provider: string;
  name: string;
  model: string;
  status: ProviderStatus;
  error?: string;
  processingMs: number;
  caseCount: number;
  overallScore: number;
  qualityLevel: QualityLevel;
  /** null = not applicable to this task (not penalised). */
  dimensionScores: Partial<Record<QualityDimension, number | null>>;
  requirementCoverage: number;
  /** null = no ISTQB technique / risk / negative path applies to this task. */
  istqbCoverage: number | null;
  riskCoverage: number | null;
  negativeCoverage: number | null;
  duplicateCount: number;
  detectedRisks: string[];
  missingScenarios: QualityNote[];
  applicableISTQBTechniques: IstqbTechnique[];
  strengths: QualityNote[];
  weaknesses: QualityNote[];
  recommendations: QualityNote[];
};

export type QualityTiming = {
  taskParsingMs: number;
  requirementExtractionMs: number;
  /** Provider name → execution ms. */
  providers: Record<string, number>;
  normalizationMs: number;
  scoringMs: number;
  deduplicationMs: number;
  selectionMs: number;
  qualityGateMs: number;
  totalMs: number;
};

export type QualityReport = {
  applicableTechniques: Array<{ technique: IstqbTechnique; reason: string }>;
  /** Effective weight of each applicable dimension (sum 100); missing = not applicable. */
  weights: Partial<Record<QualityDimension, number>>;
  /** Task kinds that shifted the weights (payment, api, ui, …). */
  emphasis: string[];
  providers: ProviderEvaluation[];
  selection: {
    base: string | null;
    merged: Array<{ provider: string; added: number }>;
    reasons: QualityNote[];
  };
  final: {
    overallScore: number;
    qualityLevel: QualityLevel;
    caseCount: number;
    requirementCoverage: number;
    istqbCoverage: number | null;
    riskCoverage: number | null;
    negativeCoverage: number | null;
    dimensionScores: Partial<Record<QualityDimension, number | null>>;
    duplicatesRemoved: number;
    rejected: Array<{ title: string; provider: string; reasons: CaseFinding[] }>;
    improved: number;
    untracedRequirements: string[];
    missingScenarios: QualityNote[];
  } | null;
  timing: QualityTiming;
};
