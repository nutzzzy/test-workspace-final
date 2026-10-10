import { z } from "zod";

/**
 * Answer shapes of every analysis stage. They are deliberately forgiving:
 * over-long text is cut, unknown enum values fall back to a default and
 * missing lists are empty — a rejected answer from a slow local model would
 * cost a whole extra call. Keys are English; content is in the target language.
 */

const text = (max: number) => z.coerce.string().transform((value) => value.trim().slice(0, max));
const opt = (max: number) => text(max).optional().default("");
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .preprocess(
      // A single value where a list was asked ("preconditions": "logged in") is a list of one.
      (value) => (value === null || value === undefined || Array.isArray(value) ? value : value === "" ? [] : [value]),
      z.array(item).nullish(),
    )
    .transform((items) => (items ?? []).slice(0, max));
const strings = (max: number, length = 400) => list(text(length), max).transform((items) => items.filter(Boolean));
const level = z.enum(["HIGH", "MEDIUM", "LOW"]).catch("MEDIUM");

export const CRITERION_CATEGORIES = [
  "happy_path",
  "validation",
  "error_handling",
  "permission",
  "state",
  "boundary",
  "data_integrity",
  "integration",
  "calculation",
  "configuration",
  "non_functional",
  "ui",
] as const;

export const CASE_TYPES = ["FUNCTIONAL", "NEGATIVE", "BOUNDARY", "SECURITY", "INTEGRATION", "UI", "PERFORMANCE", "DATA"] as const;

export const DigestSchema = z.object({
  notes: list(
    z.object({
      kind: z.enum(["rule", "api", "entity", "flow", "state", "configuration", "calculation", "validation", "other"]).catch("other"),
      text: text(800),
      evidence: opt(400),
    }),
    80,
  ),
});

/**
 * Fields are in order of importance: a model writes them in this order, so an
 * answer stopped at the writing time limit still has the rules and APIs.
 */
export const UnderstandingSchema = z.object({
  summary: text(2000),
  rules: list(z.object({ text: text(600), evidence: opt(500), source: z.enum(["issue", "document"]).catch("issue") }), 60),
  apis: list(
    z.object({
      method: text(10),
      path: text(300),
      purpose: opt(400),
      request: opt(600),
      responses: strings(10, 200),
      auth: opt(200),
    }),
    30,
  ),
  states: list(z.object({ name: text(80), meaning: opt(300) }), 20),
  transitions: list(z.object({ from: text(80), to: text(80), trigger: opt(300), conditions: opt(300) }), 30),
  calculations: list(z.object({ name: text(160), formula: text(400), meaning: opt(400) }), 10),
  configurations: list(z.object({ key: text(160), meaning: opt(400) }), 30),
  flows: list(z.object({ name: text(160), steps: strings(15, 300) }), 12),
  entities: list(
    z.object({
      name: text(120),
      description: opt(400),
      fields: list(z.object({ name: text(120), type: opt(80), notes: opt(300) }), 40),
    }),
    20,
  ),
  actors: list(z.object({ name: text(120), description: opt(400) }), 15),
  integrations: strings(15),
  nonFunctional: strings(15),
  assumptions: strings(20),
  outOfScope: strings(15),
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

export const CriteriaSchema = z.object({
  criteria: list(
    z.object({
      text: text(700),
      category: z.enum(CRITERION_CATEGORIES).catch("happy_path"),
      evidence: opt(500),
      ruleRefs: strings(8, 20),
      confidence: level,
      rationale: opt(500),
    }),
    40,
  ),
  /** Problems with criteria that were written in the issue (vague, untestable, contradictory). */
  writtenIssues: list(z.object({ key: text(20), problem: text(500), suggestion: opt(500) }), 20),
});

export const AssessmentSchema = z.object({
  gaps: list(z.object({ text: text(600), impact: opt(400), severity: level }), 25),
  ambiguities: strings(20, 500),
  questions: list(
    z.object({
      question: text(500),
      category: z.enum(["product", "developer", "business"]).catch("product"),
      reason: opt(400),
      ruleRefs: strings(6, 20),
    }),
    30,
  ),
  risks: list(
    z.object({
      description: text(600),
      impact: level,
      likelihood: level,
      mitigation: opt(500),
      releaseBlocking: z.boolean().catch(false),
      criterionKeys: strings(8, 20),
      ruleRefs: strings(8, 20),
    }),
    20,
  ),
  strategy: z
    .object({
      scope: opt(1500),
      objectives: strings(12),
      testTypes: strings(12, 200),
      environments: strings(10, 300),
      dependencies: strings(12),
      assumptions: strings(12),
    })
    .catch({ scope: "", objectives: [], testTypes: [], environments: [], dependencies: [], assumptions: [] }),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const CasesSchema = z.object({
  testCases: list(
    z.object({
      criterionKeys: strings(6, 20),
      ruleRefs: strings(6, 20),
      title: text(220),
      objective: opt(600),
      preconditions: strings(10),
      testData: strings(15, 300),
      steps: list(z.object({ action: text(600), expected: opt(600) }), 20),
      expectedResult: text(700),
      priority: level,
      type: z.enum(CASE_TYPES).catch("FUNCTIONAL"),
      technique: opt(80),
    }),
    15,
  ),
});
export type GeneratedCase = z.infer<typeof CasesSchema>["testCases"][number];

export const EdgesSchema = z.object({
  edgeCases: list(
    z.object({
      title: text(220),
      scenario: text(800),
      expectedBehavior: opt(600),
      whyItMatters: opt(600),
      severity: level,
      ruleRefs: strings(6, 20),
      criterionKeys: strings(6, 20),
    }),
    25,
  ),
});
export type GeneratedEdge = z.infer<typeof EdgesSchema>["edgeCases"][number];

export const ReviewSchema = z.object({
  criteria: list(
    z.object({ key: text(20), verdict: z.enum(["keep", "drop", "fix"]).catch("keep"), fixedText: opt(700), reason: opt(400) }),
    60,
  ),
  testCases: list(
    z.object({
      index: z.coerce.number().int(),
      verdict: z.enum(["keep", "drop", "fix"]).catch("keep"),
      reason: opt(400),
      title: opt(220),
      expectedResult: opt(700),
      steps: list(z.object({ action: text(600), expected: opt(600) }), 20),
    }),
    200,
  ),
  edgeCases: list(z.object({ index: z.coerce.number().int(), verdict: z.enum(["keep", "drop"]).catch("keep"), reason: opt(400) }), 60),
});

export const AutomationSchema = z.object({
  items: list(
    z.object({
      index: z.coerce.number().int(),
      suitability: level,
      layer: z.enum(["API", "UI", "DB", "Integration", "Manual"]).catch("API"),
      rationale: text(600),
      prerequisites: strings(8, 300),
      tooling: opt(200),
    }),
    60,
  ),
});

/** Short parts first; a part missing from a shortened answer shows in the original language. */
export const TranslationSchema = z.object({
  title: opt(500),
  acceptanceCriteria: strings(80, 2000),
  description: opt(40_000),
});
export type Translation = z.infer<typeof TranslationSchema>;

export const DistillSchema = z.object({
  guidelines: list(
    z.object({
      scope: z
        .enum(["all", "criteria", "questions", "testCases", "edgeCases", "risks", "strategy", "automation", "summary"])
        .catch("all"),
      text: text(400),
      basedOn: strings(20, 40),
    }),
    40,
  ),
});
