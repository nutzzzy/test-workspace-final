import { z } from "zod";

export const RequirementAnalysisSchema = z.object({
  summary: z.string().min(1),
  acceptanceCriteria: z.array(z.string()),
  gaps: z.array(z.string()),
  ambiguities: z.array(z.string()),
  missingScenarios: z.array(z.string()),
  potentialRisks: z.array(z.string()),
  questions: z.object({
    product: z.array(z.string()),
    developer: z.array(z.string()),
    business: z.array(z.string()),
  }),
});

export type RequirementAnalysisDto = z.infer<typeof RequirementAnalysisSchema>;

export const TestStrategySchema = z.object({
  scope: z.string().min(1),
  objectives: z.array(z.string()),
  testTypes: z.array(z.string()),
  environments: z.array(z.string()),
  dependencies: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export type TestStrategyDto = z.infer<typeof TestStrategySchema>;

export const GeneratedTestCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  stepExpectations: z.array(z.string()).default([]),
  testData: z.array(z.string()).default([]),
  expectedResult: z.string().min(1),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  type: z
    .enum([
      "FUNCTIONAL",
      "REGRESSION",
      "SMOKE",
      "EDGE",
      "INTEGRATION",
      "API",
      "UI",
    ])
    .default("FUNCTIONAL"),
  relatedAcceptanceCriteria: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const TestCaseGenerationSchema = z.object({
  testCases: z.array(GeneratedTestCaseSchema).min(1),
});

export type GeneratedTestCaseDto = z.infer<typeof GeneratedTestCaseSchema>;

export const EdgeCasesSchema = z.object({
  edgeCases: z.array(
    z.object({
      title: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
});

export const RisksSchema = z.object({
  risks: z.array(
    z.object({
      description: z.string().min(1),
      impact: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
      likelihood: z.enum(["HIGH", "MEDIUM", "LOW"]),
      mitigation: z.string().min(1),
      releaseBlocking: z.boolean().default(false),
      acceptanceKeys: z.array(z.string()).default([]),
    }),
  ),
});

export const AutomationCandidatesSchema = z.object({
  candidates: z.array(
    z.object({
      relatedTestCaseTitle: z.string().min(1),
      recommendedLevel: z.enum(["FULL", "PARTIAL", "MANUAL_ONLY"]),
      apiUiRecommendation: z.enum(["API", "UI", "BOTH", "NONE"]),
      reasoning: z.string().min(1),
    }),
  ),
});

export type NormalizedJiraIssue = {
  key: string;
  title: string;
  description: string;
  issueType?: string;
  priority?: string;
  labels: string[];
  acceptanceCriteria: string[];
  linkedIssues: Array<{ key: string; type?: string; summary?: string }>;
};
