import { analyzeRequirementGaps } from "../analysis/requirement-questions";
import { runQaPipeline } from "../qa-engine/pipeline";
import {
  AutomationCandidatesSchema,
  EdgeCasesSchema,
  RequirementAnalysisSchema,
  RisksSchema,
  TestCaseGenerationSchema,
  TestStrategySchema,
  type NormalizedJiraIssue,
} from "@qa-workbench/shared";
import type { z } from "zod";
import {
  designAcceptanceCriteria,
  designAnalysis,
  designAutomation,
  designEdgeCases,
  designRisks,
  designStrategy,
  designTestCases,
} from "../analysis/qa-design";
import type { AIProvider, AiGenerateOptions } from "./ai-provider";
import { type AppLocale, normalizeLocale } from "./localize-fa";
import { parseAndValidate } from "./ollama.provider";

/**
 * Local deterministic fallback when Ollama is unavailable.
 * Still returns schema-validated structured output.
 */
export class HeuristicAIProvider implements AIProvider {
  readonly name = "heuristic";

  async generateStructured<T>(options: AiGenerateOptions<T>): Promise<T> {
    const issue = extractIssueFromPrompt(options.prompt);
    const locale = normalizeLocale(options.locale);
    const payload = buildHeuristicPayload(options.schema, issue, locale);
    return parseAndValidate(JSON.stringify(payload), options.schema);
  }
}

function extractIssueFromPrompt(prompt: string): Partial<NormalizedJiraIssue> {
  const title = prompt.match(/Title:\s*(.+)/)?.[1]?.trim() ?? "Requirement";
  const description =
    prompt.match(/Description:\s*([\s\S]*?)(?:\nAcceptance|$)/)?.[1]?.trim() ??
    "";
  const acBlock =
    prompt.match(/Acceptance Criteria:\s*([\s\S]*)/)?.[1]?.trim() ?? "";
  const acceptanceCriteria = acBlock
    .split(/\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
  return { title, description, acceptanceCriteria, key: "LOCAL" };
}

function buildHeuristicPayload(
  schema: z.ZodType<unknown>,
  issue: Partial<NormalizedJiraIssue>,
  locale: AppLocale,
): unknown {
  const title = issue.title ?? (locale === "fa" ? "نیازمندی" : "Requirement");
  const criteria = designAcceptanceCriteria({
    title,
    description: issue.description ?? "",
    rawCriteria: issue.acceptanceCriteria ?? [],
    locale,
  });

  if (schema === RequirementAnalysisSchema) {
    // Same contextual question engine as the workspace analysis.
    const pipeline = runQaPipeline({
      title,
      description: issue.description ?? "",
      locale,
      acceptanceCriteria: criteria.map((item) => ({ key: item.key, text: item.text, origin: item.origin })),
    });
    const { questions } = analyzeRequirementGaps({
      title,
      description: issue.description ?? "",
      criteria,
      understanding: pipeline.understanding,
      gaps: pipeline.gaps,
      inferred: pipeline.inferredAc,
      locale,
    });
    const pick = (category: string) =>
      questions.filter((item) => item.category === category).map((item) => item.question);
    return {
      ...designAnalysis({ title, criteria, locale }),
      questions: { product: pick("product"), developer: pick("developer"), business: pick("business") },
    };
  }

  if (schema === TestStrategySchema) {
    return designStrategy(title, criteria, locale);
  }

  if (schema === TestCaseGenerationSchema) {
    return { testCases: designTestCases(criteria, locale) };
  }

  if (schema === EdgeCasesSchema) {
    return { edgeCases: designEdgeCases(criteria, locale) };
  }

  if (schema === RisksSchema) {
    return { risks: designRisks(criteria, locale) };
  }

  if (schema === AutomationCandidatesSchema) {
    return { candidates: designAutomation(criteria, locale) };
  }

  throw new Error("No heuristic payload for schema");
}
