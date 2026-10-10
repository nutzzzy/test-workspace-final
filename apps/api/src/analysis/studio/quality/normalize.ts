import { createHash } from "crypto";
import type { CasePriority, NormalizedTestCase } from "@qa-workbench/shared";
import { z } from "zod";
import type { CaseWithKeys } from "../pipeline";
import { CASE_TYPES, CasesSchema, type GeneratedCase } from "../schemas";
import { norm } from "../text";
import { detectTechniques, isNegative, scoreCase } from "./evaluate";
import type { TaskProfile } from "./task-profile";

/**
 * Provider output normalization. Models answer the same request with
 * different keys (test_cases, cases, name, expected, steps as plain strings, …)
 * and vocabularies (P1, "critical", "Negative Test"); every answer is first
 * mapped onto the studio's case shape, then into the provider-independent
 * NormalizedTestCase that scoring, comparison and merging work on.
 */

const LIST_KEYS = ["testCases", "test_cases", "testcases", "cases", "tests", "items", "scenarios", "results", "result", "data"];
const pick = (item: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const found = Object.keys(item).find((name) => name.toLowerCase() === key.toLowerCase());
    if (found !== undefined && item[found] !== undefined && item[found] !== null && item[found] !== "") return item[found];
  }
  return undefined;
};
const asList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const asText = (value: unknown): string =>
  Array.isArray(value) ? value.map(asText).filter(Boolean).join("\n") : value && typeof value === "object" ? Object.values(value).map(asText).join(" ") : String(value ?? "");

function aliasPriority(value: unknown) {
  const text = asText(value).toLowerCase();
  if (/crit|block|urgent|p0|p1|high|highest|بالا|بحرانی|فوری/.test(text)) return "HIGH";
  if (/low|minor|trivial|p3|p4|پایین|کم/.test(text)) return "LOW";
  return "MEDIUM";
}

function aliasType(value: unknown) {
  const text = asText(value).toUpperCase();
  return CASE_TYPES.find((type) => text.includes(type)) ?? (/EDGE|LIMIT/.test(text) ? "BOUNDARY" : /AUTH|PERMISSION/.test(text) ? "SECURITY" : "FUNCTIONAL");
}

function aliasSteps(value: unknown): Array<{ action: string; expected: string }> {
  // "1. do x\n2. do y" or "1) do x 2) do y": one step per numbered part, numbers removed.
  const items =
    typeof value === "string"
      ? value
          .split(/\n+/)
          .flatMap((line) => line.split(/\s(?=\d+[.)]\s)/))
          .map((part) => part.replace(/^\s*\d+[.)]\s*/, "").trim())
          .filter(Boolean)
      : asList(value);
  return items
    .map((step) => {
      if (step && typeof step === "object") {
        const record = step as Record<string, unknown>;
        return {
          action: asText(pick(record, ["action", "step", "description", "do", "when", "instruction"]) ?? ""),
          expected: asText(pick(record, ["expected", "expectedResult", "expected_result", "result", "then", "outcome"]) ?? ""),
        };
      }
      return { action: asText(step), expected: "" };
    })
    .filter((step) => step.action.trim());
}

function aliasCase(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  const expected = pick(item, ["expectedResult", "expected_result", "expectedResults", "expected_results", "expected", "expectedOutcome", "expected_outcome", "then"]);
  return {
    criterionKeys: asList(pick(item, ["criterionKeys", "criterion_keys", "criteria", "criterion", "acceptanceCriteria", "acceptance_criteria", "requirementIds", "requirement_ids", "requirements", "ac", "acKeys"])).map(asText),
    ruleRefs: asList(pick(item, ["ruleRefs", "rule_refs", "rules", "ruleIds", "rule_ids"])).map(asText),
    title: asText(pick(item, ["title", "name", "summary", "testName", "test_name", "scenario"]) ?? ""),
    objective: asText(pick(item, ["objective", "purpose", "goal", "description"]) ?? ""),
    preconditions: asList(pick(item, ["preconditions", "pre_conditions", "precondition", "given", "setup"])).map(asText),
    testData: asList(pick(item, ["testData", "test_data", "data", "inputs", "input"])).map(asText),
    steps: aliasSteps(pick(item, ["steps", "testSteps", "test_steps", "procedure", "actions"])),
    expectedResult: asText(expected ?? ""),
    priority: aliasPriority(pick(item, ["priority", "severity", "importance"])),
    type: aliasType(pick(item, ["type", "testType", "test_type", "category", "kind"])),
    technique: asText(pick(item, ["technique", "techniques", "testDesignTechnique", "testDesignTechniques", "test_design_technique", "designTechnique"]) ?? ""),
  };
}

/** Find the list of cases in whatever wrapper the provider used. */
const caseObjects = (items: unknown[]) => items.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map(aliasCase);

export function aliasAnswer(value: unknown): unknown {
  if (Array.isArray(value)) return { testCases: caseObjects(value) };
  if (!value || typeof value !== "object") return { testCases: [] };
  const record = value as Record<string, unknown>;
  const list = pick(record, LIST_KEYS);
  if (Array.isArray(list)) return { testCases: caseObjects(list) };
  if (list && typeof list === "object") return aliasAnswer(list);
  return { testCases: [] };
}

/** The answer schema a provider's test cases are parsed with: any common shape is accepted. */
export const ProviderCasesSchema = z.preprocess(aliasAnswer, CasesSchema);

const PRIORITY: Record<string, CasePriority> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const RANK: Record<CasePriority, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

/** Stable id from the case content: the same case gets the same id on every run and from every provider. */
export function caseId(requirementIds: string[], title: string, steps: Array<{ action: string }>) {
  const basis = [[...requirementIds].sort().join(","), norm(title), ...steps.map((step) => norm(step.action))].join("|");
  return `TC-${createHash("sha1").update(basis).digest("hex").slice(0, 10)}`;
}

export function normalizeCase(raw: GeneratedCase & { reviewNote?: string }, provider: string, profile: TaskProfile): NormalizedTestCase {
  const known = new Set(profile.requirements.map((item) => item.key));
  const requirementIds = [...new Set(raw.criterionKeys.map((key) => key.trim()).filter((key) => known.has(key)))];
  const ruleIds = new Set(profile.rules.map((rule) => rule.id));
  const ruleRefs = [...new Set(raw.ruleRefs.map((ref) => ref.trim().toUpperCase()).filter((ref) => ruleIds.has(ref)))];
  const steps = raw.steps.map((step) => ({ action: step.action.trim(), expected: step.expected.trim() })).filter((step) => step.action);
  const critical = profile.requirements.some((item) => item.critical && requirementIds.includes(item.key));
  let priority: CasePriority = PRIORITY[raw.priority] ?? "Medium";
  if (priority === "High" && critical) priority = "Critical";
  // The risk level is the highest of the case's own priority and the risks it covers.
  const riskHits = profile.risks.filter((risk) => risk.criterionKeys.some((key) => requirementIds.includes(key)) || risk.ruleRefs.some((ref) => ruleRefs.includes(ref)));
  let riskLevel: CasePriority = priority;
  if (riskHits.some((risk) => risk.critical) && RANK[riskLevel] < RANK.High) riskLevel = "High";

  const base: NormalizedTestCase = {
    id: caseId(requirementIds, raw.title, steps),
    title: raw.title.trim(),
    objective: raw.objective.trim(),
    requirementIds,
    priority,
    riskLevel,
    testType: [raw.type],
    testDesignTechniques: [],
    preconditions: raw.preconditions.map((item) => item.trim()).filter(Boolean),
    testData: raw.testData.map((item) => item.trim()).filter(Boolean),
    steps,
    expectedResults: raw.expectedResult.trim() ? [raw.expectedResult.trim()] : [],
    postconditions: [],
    tags: [],
    sourceProviders: [provider],
    qualityScore: 0,
    ruleRefs,
    findings: [],
  };
  const negative = isNegative(base);
  if (negative && !base.testType.includes("NEGATIVE") && base.testType[0] === "FUNCTIONAL") base.testType = ["FUNCTIONAL", "NEGATIVE"];
  base.tags = [negative ? "negative" : "positive", ...ruleRefs.map((ref) => `rule:${ref}`)];
  base.testDesignTechniques = detectTechniques(base, raw.technique, profile);
  return rescore(base, profile);
}

/** Recompute a case's quality score and findings (after it changed). */
export function rescore(item: NormalizedTestCase, profile: TaskProfile): NormalizedTestCase {
  const scored = scoreCase(item, profile);
  return { ...item, qualityScore: scored.score, findings: scored.findings };
}

/** Normalize one provider's answers; order is deterministic (requirement order, then answer order). */
export function normalizeCases(raws: Array<GeneratedCase & { reviewNote?: string }>, provider: string, profile: TaskProfile): NormalizedTestCase[] {
  const order = new Map(profile.requirements.map((item, index) => [item.key, index]));
  const rank = (item: NormalizedTestCase) => Math.min(...item.requirementIds.map((key) => order.get(key) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  return raws
    .filter((raw) => raw.title.trim())
    .map((raw, index) => ({ item: normalizeCase(raw, provider, profile), index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** Back to the studio's case shape, for review, automation and saving (the stored test-case contract is unchanged). */
export function toStudioCase(item: NormalizedTestCase, reviewNote?: string): CaseWithKeys {
  const type = (CASE_TYPES as readonly string[]).includes(item.testType[0] ?? "") ? (item.testType[0] as GeneratedCase["type"]) : "FUNCTIONAL";
  return {
    criterionKeys: item.requirementIds,
    ruleRefs: item.ruleRefs,
    title: item.title,
    objective: item.objective,
    preconditions: item.preconditions,
    testData: item.testData,
    steps: item.steps,
    expectedResult: item.expectedResults.join("\n"),
    priority: item.priority === "Critical" || item.priority === "High" ? "HIGH" : item.priority === "Low" ? "LOW" : "MEDIUM",
    type,
    technique: item.testDesignTechniques.join(", "),
    qualityId: item.id,
    ...(reviewNote ? { reviewNote } : {}),
  };
}
