import {
  ISTQB_TECHNIQUES,
  QUALITY_DIMENSIONS,
  type CaseFinding,
  type IstqbTechnique,
  type NormalizedTestCase,
  type QualityDimension,
  type QualityNote,
} from "@qa-workbench/shared";
import { norm, overlap, wordSet } from "../text";
import { DEFAULT_QUALITY_CONFIG, qualityLevel, type QualityConfig } from "./config";
import { RX, type TaskProfile } from "./task-profile";

/**
 * The standardized scoring model. Each case gets a 0–100 quality score and
 * findings; a set of cases (one provider's, or the final merged set) gets a
 * score per dimension — null where the dimension does not apply to the task,
 * so it is never penalised — and an overall 0–100 score weighted by the task
 * profile. Everything here is deterministic: the same cases score the same.
 */

const VAGUE =
  /\b(works? (correctly|properly|fine|as expected)|is handled|handled (correctly|properly)|as expected|check (the )?(result|it|that it works)|verify (it|that it) works|should work|correct(ly)? (behaviou?r|result)|appropriate(ly)?|properly|etc|tbd|n\/a)\b|به درستی|به‌درستی|درست کار|مطابق انتظار|بررسی شود|چک شود|رفتار مناسب|به شکل صحیح|به طور صحیح/i;
/** Something an observer can check: a value, a quote, an endpoint, an identifier, a status. */
const CONCRETE = /\d|["'«»`]|\b(GET|POST|PUT|PATCH|DELETE)\b|\/[\w-]+|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w*\b|=|\b[A-Z]{3,}\b/;
const NEGATIVE_CASE =
  /\b(invalid|without|missing|empty|wrong|unauthori[sz]ed|forbidden|denied|reject(ed|s)?|exceed(s|ed|ing)?|duplicate|not allowed|fails?|error|expired|negative|blank|malformed|too (long|short|many))\b|نامعتبر|بدون|خالی|اشتباه|غیرمجاز|رد شود|رد می|رد شده|خطا|تکراری|بیش از|منقضی|نادرست/i;
const NEEDS_DATA = /\b(enter|input|send|submit|payload|body|field|value|request|upload|type in|fill)\b|وارد|ارسال|مقدار|فیلد|بدنه|درخواست|پر کن/i;
const HTTP_CODES = new Set(["200", "201", "202", "204", "301", "302", "304", "400", "401", "403", "404", "405", "409", "410", "412", "415", "422", "429", "500", "502", "503", "504"]);
const SECURITY_CASE = RX.security;
const PERFORMANCE_CASE = RX.performance;

const TECHNIQUE_ALIASES: Array<[RegExp, IstqbTechnique]> = [
  [/equivalen|partition|\bep\b|ecp|افراز|کلاس.? هم/i, "Equivalence Partitioning"],
  [/boundar|\bbva\b|edge value|limit|مرز/i, "Boundary Value Analysis"],
  [/decision|truth table|cause.?effect|business rule|جدول تصمیم/i, "Decision Table Testing"],
  [/state|transition|حالت|گذار/i, "State Transition Testing"],
  [/use.?case|scenario|user flow|journey|happy path|سناریو|مورد کاربرد/i, "Use Case Testing"],
  [/error guess|fault attack|حدس خطا/i, "Error Guessing"],
  [/exploratory|اکتشاف/i, "Exploratory Testing"],
  [/risk|ریسک/i, "Risk-based Testing"],
];

export const caseText = (item: NormalizedTestCase) =>
  [item.title, item.objective, ...item.preconditions, ...item.testData, ...item.steps.flatMap((step) => [step.action, step.expected]), ...item.expectedResults].join("\n");

export function isNegative(item: NormalizedTestCase) {
  if (item.testType.some((type) => type === "NEGATIVE" || type === "SECURITY")) return true;
  return NEGATIVE_CASE.test([item.title, item.objective, ...item.steps.map((step) => step.action), ...item.testData].join("\n"));
}

const vagueText = (text: string, min: number) => text.trim().length < min || (VAGUE.test(text) && !CONCRETE.test(text));

/** The techniques a case applies: what it declares plus what its content shows, limited to those that apply to the task. */
export function detectTechniques(item: NormalizedTestCase, declared: string, profile: TaskProfile): IstqbTechnique[] {
  const allowed = new Set(profile.techniques.map((entry) => entry.technique));
  const found = new Set<IstqbTechnique>();
  for (const [pattern, technique] of TECHNIQUE_ALIASES) if (declared && pattern.test(declared)) found.add(technique);
  const text = caseText(item);
  const negative = isNegative(item);
  const reqs = profile.requirements.filter((req) => item.requirementIds.includes(req.key));
  if (item.testType.includes("BOUNDARY") || (RX.limit.test(text) && /\d/.test(text)) || RX.quantity.test(text) || reqs.some((req) => profile.worthy.boundary.has(req.key) && /\d/.test(text))) {
    found.add("Boundary Value Analysis");
  }
  if (reqs.some((req) => profile.worthy.equivalence.has(req.key)) && (negative || item.testData.length > 0)) found.add("Equivalence Partitioning");
  const conditions = (text.match(new RegExp(RX.conditional.source, "gi")) ?? []).length;
  if (item.ruleRefs.length >= 2 || conditions >= 2 || profile.rules.some((rule) => rule.conditional && item.ruleRefs.includes(rule.id))) found.add("Decision Table Testing");
  const lower = norm(text);
  const statesNamed = profile.states.filter((state) => state.length > 1 && lower.includes(norm(state))).length;
  if (statesNamed >= 2 || (statesNamed >= 1 && profile.transitions.length > 0 && /transition|change|move|becomes|status|تغییر|وضعیت/i.test(text))) {
    found.add("State Transition Testing");
  }
  if (!negative && item.steps.length >= 3) found.add("Use Case Testing");
  if (RX.errorGuess.test(text)) found.add("Error Guessing");
  if (coversRisk(item, profile)) found.add("Risk-based Testing");
  return ISTQB_TECHNIQUES.filter((technique) => found.has(technique) && allowed.has(technique));
}

function coversRisk(item: NormalizedTestCase, profile: TaskProfile, words = wordSet(caseText(item))) {
  return profile.risks.some((risk) => riskCovered(risk, item, words));
}
function riskCovered(risk: TaskProfile["risks"][number], item: NormalizedTestCase, words: Set<string>) {
  return (
    risk.criterionKeys.some((key) => item.requirementIds.includes(key)) || risk.ruleRefs.some((ref) => item.ruleRefs.includes(ref)) || overlap(risk.words, words) >= 0.2
  );
}

/** A case's own quality (0–100) and what is wrong with it. */
export function scoreCase(item: NormalizedTestCase, profile: TaskProfile): { score: number; findings: CaseFinding[] } {
  const findings: CaseFinding[] = [];
  let score = 0;
  const finals = item.expectedResults.filter((text) => text.trim());
  const stepExpected = item.steps.filter((step) => step.expected.trim());

  // Expected result (25): observable and specific.
  if (finals.length === 0 && stepExpected.length === 0) findings.push("missingExpectedResult");
  else if (finals.length > 0 && finals.every((text) => !vagueText(text, 12))) score += 25;
  else if (stepExpected.some((step) => !vagueText(step.expected, 12))) score += 18;
  else {
    score += 8;
    findings.push("vagueExpectedResult");
  }

  // Step clarity (20): executable actions.
  if (item.steps.length === 0) findings.push("noSteps");
  else {
    const clear = item.steps.filter((step) => !vagueText(step.action, 8)).length / item.steps.length;
    score += 20 * clear;
    if (clear < 0.5) findings.push("vagueSteps");
  }

  // Pass/fail criteria (10): every step checkable, or a concrete end state.
  const finalConcrete = finals.some((text) => !vagueText(text, 12));
  if (finalConcrete || (item.steps.length > 0 && stepExpected.length === item.steps.length)) score += 10;
  else {
    score += stepExpected.length > 0 ? 4 : 0;
    if (!findings.includes("missingExpectedResult")) findings.push("unclearPassFail");
  }

  // Preconditions (10).
  if (item.preconditions.length > 0) score += 10;
  else {
    score += 3;
    findings.push("missingPreconditions");
  }

  // Test data (10) when the case feeds input to the system.
  const text = caseText(item);
  const needsData = NEEDS_DATA.test(text) || item.testDesignTechniques.some((technique) => technique === "Boundary Value Analysis" || technique === "Equivalence Partitioning");
  if (item.testData.length > 0 || !needsData) score += 10;
  else findings.push("missingTestData");

  // Traceability (15).
  if (item.requirementIds.length > 0) score += 15;
  else if (profile.requirements.length > 0) findings.push("untraceable");
  else score += 15;

  // Relevance and grounding (10): about this task, and no values the source does not give.
  const words = wordSet(text);
  let relevance = 0;
  for (const word of words) if (profile.corpusWords.has(word)) relevance += 1;
  const relevant = words.size === 0 ? false : relevance / words.size >= 0.15 || item.requirementIds.length > 0;
  if (!relevant) findings.push("irrelevant");
  else {
    const values = [...[...item.expectedResults, ...item.testData].join(" ").matchAll(/\d{2,}(?:[.,]\d+)?/g)].map((match) => match[0]);
    const unsupported = values.filter((value) => !HTTP_CODES.has(value) && !profile.corpus.includes(value));
    if (unsupported.length > 0 && !/<to confirm>|نیاز به تایید/i.test(item.testData.join(" "))) {
      score += 5;
      findings.push("unsupportedAssumption");
    } else score += 10;
  }
  return { score: Math.round(Math.max(0, Math.min(100, score))), findings };
}

/** Pairs of cases that test the same scenario of the same requirement (index pairs, i < j). */
export function findDuplicates(cases: NormalizedTestCase[], threshold: number) {
  const sigs = cases.map((item) => ({
    all: wordSet([item.title, ...item.steps.map((step) => step.action), ...item.expectedResults].join(" ")),
    title: wordSet(item.title),
    reqs: new Set(item.requirementIds),
    negative: isNegative(item),
  }));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < cases.length; i += 1) {
    for (let j = i + 1; j < cases.length; j += 1) {
      const a = sigs[i]!;
      const b = sigs[j]!;
      // Cases of different requirements are not duplicates, even when worded alike.
      const shared = a.reqs.size === 0 && b.reqs.size === 0 ? true : [...a.reqs].some((key) => b.reqs.has(key));
      if (!shared || a.negative !== b.negative) continue;
      if (overlap(a.all, b.all) >= threshold || overlap(a.title, b.title) >= 0.85) pairs.push([i, j]);
    }
  }
  return pairs;
}

export type SetEvaluation = {
  dimensionScores: Record<QualityDimension, number | null>;
  overallScore: number;
  requirementCoverage: number;
  istqbCoverage: number | null;
  riskCoverage: number | null;
  negativeCoverage: number | null;
  duplicateCount: number;
  coveredRequirements: string[];
  missingScenarios: QualityNote[];
  detectedRisks: string[];
  usedTechniques: IstqbTechnique[];
};

const pct = (part: number, whole: number) => (whole === 0 ? 100 : Math.round((100 * part) / whole));

/** Score a set of cases on every applicable dimension. */
export function evaluateSet(cases: NormalizedTestCase[], profile: TaskProfile, config: QualityConfig = DEFAULT_QUALITY_CONFIG): SetEvaluation {
  const missing: QualityNote[] = [];
  const usable = cases.filter((item) => item.qualityScore >= config.gateMinCaseQuality);
  const texts = cases.map((item) => norm(caseText(item)));
  const words = cases.map((item) => wordSet(caseText(item)));
  const negative = cases.map(isNegative);
  const byReq = (key: string, test: (item: NormalizedTestCase, index: number) => boolean = () => true) =>
    cases.some((item, index) => item.requirementIds.includes(key) && item.qualityScore >= config.gateMinCaseQuality && test(item, index));
  const hasTechnique = (technique: IstqbTechnique) => (item: NormalizedTestCase) => item.testDesignTechniques.includes(technique);
  const reqKeys = profile.requirements.map((item) => item.key);

  /** Share of the worthy requirements with a matching case; without worthy requirements, at least `min` matching cases. */
  const worthyShare = (worthy: Set<string>, test: (item: NormalizedTestCase, index: number) => boolean, min = 1, note?: string) => {
    if (worthy.size > 0) {
      const covered = [...worthy].filter((key) => byReq(key, test));
      if (note) for (const key of worthy) if (!covered.includes(key)) missing.push({ code: note, values: { key } });
      return pct(covered.length, worthy.size);
    }
    return Math.min(100, Math.round((100 * usable.filter((item) => test(item, cases.indexOf(item))).length) / min));
  };

  const scores = Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, null])) as Record<QualityDimension, number | null>;
  const on = (dimension: QualityDimension, value: () => number) => {
    if (profile.applicable[dimension]) scores[dimension] = Math.round(Math.max(0, Math.min(100, value())));
  };

  const covered = reqKeys.filter((key) => byReq(key));
  for (const key of reqKeys) if (!covered.includes(key)) missing.push({ code: "uncoveredRequirement", values: { key } });
  on("requirementCoverage", () => (reqKeys.length ? pct(covered.length, reqKeys.length) : cases.length ? 100 : 0));
  on("functionalCorrectness", () => (cases.length ? cases.reduce((sum, item) => sum + item.qualityScore, 0) / cases.length : 0));
  on("expectedResultQuality", () => pct(cases.filter((item) => !item.findings.some((f) => f === "missingExpectedResult" || f === "vagueExpectedResult")).length, cases.length || 1));
  on("positiveScenarios", () => (reqKeys.length ? pct(reqKeys.filter((key) => byReq(key, (_, index) => !negative[index])).length, reqKeys.length) : 0));
  on("negativeScenarios", () => worthyShare(profile.worthy.negative, (_, index) => negative[index]!, Math.max(1, Math.ceil(reqKeys.length / 3)), "noNegative"));
  on("boundaryValueAnalysis", () => worthyShare(profile.worthy.boundary, hasTechnique("Boundary Value Analysis"), 1, "noBoundary"));
  on("equivalencePartitioning", () => worthyShare(profile.worthy.equivalence, hasTechnique("Equivalence Partitioning")));
  on("businessRules", () => {
    const rules = profile.rules.filter((rule) => rule.conditional);
    const target = rules.length ? rules : profile.rules;
    if (target.length === 0) return worthyShare(new Set(), hasTechnique("Decision Table Testing"));
    const hit = target.filter((rule) => cases.some((item, index) => item.ruleRefs.includes(rule.id) || overlap(rule.words, words[index]!) >= 0.25));
    for (const rule of target) if (!hit.includes(rule)) missing.push({ code: "uncoveredRule", values: { rule: rule.id } });
    return pct(hit.length, target.length);
  });
  on("stateTransition", () => {
    if (profile.transitions.length > 0) {
      const hit = profile.transitions.filter((transition) => texts.some((text) => text.includes(norm(transition.from)) && text.includes(norm(transition.to))));
      for (const transition of profile.transitions) if (!hit.includes(transition)) missing.push({ code: "uncoveredTransition", values: { from: transition.from, to: transition.to } });
      return pct(hit.length, profile.transitions.length);
    }
    const named = profile.states.filter((state) => texts.some((text) => text.includes(norm(state))));
    return profile.states.length ? pct(named.length, profile.states.length) : worthyShare(new Set(), hasTechnique("State Transition Testing"));
  });
  on("errorHandling", () => {
    const parts: number[] = [];
    if (profile.errorCodes.length > 0) {
      const hit = profile.errorCodes.filter((code) => texts.some((text) => new RegExp(`\\b${code}\\b`).test(text)));
      for (const code of profile.errorCodes) if (!hit.includes(code)) missing.push({ code: "uncoveredErrorCode", values: { status: code } });
      parts.push(pct(hit.length, profile.errorCodes.length));
    }
    if (profile.worthy.errorHandling.size > 0 || parts.length === 0) parts.push(worthyShare(profile.worthy.errorHandling, (_, index) => negative[index]!, 2));
    return parts.reduce((sum, value) => sum + value, 0) / parts.length;
  });
  on("dataValidation", () =>
    worthyShare(profile.worthy.validation, (item, index) => negative[index]! && (item.testData.length > 0 || item.testDesignTechniques.some((t) => t !== "Use Case Testing")), 1, "noValidation"),
  );
  on("preconditionsDependencies", () => pct(cases.filter((item) => item.preconditions.length > 0).length, cases.length || 1));
  on("testStepsClarity", () =>
    cases.length ? (100 * cases.reduce((sum, item) => sum + (item.steps.length ? item.steps.filter((step) => !vagueText(step.action, 8)).length / item.steps.length : 0), 0)) / cases.length : 0,
  );
  on("testability", () => pct(cases.filter((item) => !item.findings.some((f) => f === "unclearPassFail" || f === "missingExpectedResult")).length, cases.length || 1));
  on("traceability", () => {
    const traced = pct(cases.filter((item) => item.requirementIds.length > 0).length, cases.length || 1);
    return profile.rules.length ? 0.8 * traced + 0.2 * pct(cases.filter((item) => item.ruleRefs.length > 0).length, cases.length || 1) : traced;
  });
  const duplicateCount = findDuplicates(cases, config.duplicateSimilarity).length;
  on("duplicateDetection", () => (cases.length ? 100 - (200 * duplicateCount) / cases.length : 100));
  const coveredRisks = profile.risks.filter((risk) => cases.some((item, index) => riskCovered(risk, item, words[index]!)));
  on("riskCoverage", () => {
    if (profile.risks.length > 0) {
      for (const risk of profile.risks) if (!coveredRisks.includes(risk)) missing.push({ code: "uncoveredRisk", values: { risk: risk.description.slice(0, 140) } });
      return pct(coveredRisks.length, profile.risks.length);
    }
    const critical = profile.requirements.filter((item) => item.critical);
    return pct(critical.filter((req) => byReq(req.key, (item, index) => negative[index]! || item.priority === "Critical" || item.priority === "High")).length, critical.length);
  });
  on("security", () =>
    worthyShare(profile.worthy.security, (item, index) => item.testType.includes("SECURITY") || (negative[index]! && SECURITY_CASE.test(caseText(item))), 1, "noSecurity"),
  );
  on("performance", () => worthyShare(profile.worthy.performance, (item) => item.testType.includes("PERFORMANCE") || PERFORMANCE_CASE.test(caseText(item)), 1, "noPerformance"));
  on("maintainability", () =>
    cases.length
      ? (100 *
          cases.reduce(
            (sum, item) => sum + ((item.title.length >= 8 && item.title.length <= 140 ? 1 : 0) + (item.steps.length <= 15 ? 1 : 0) + (item.requirementIds.length <= 3 ? 1 : 0)) / 3,
            0,
          )) /
        cases.length
      : 0,
  );

  let overall = 0;
  for (const dimension of QUALITY_DIMENSIONS) {
    const weight = profile.weights[dimension];
    if (weight && scores[dimension] !== null) overall += (weight * scores[dimension]!) / 100;
  }
  const usedTechniques = ISTQB_TECHNIQUES.filter((technique) => cases.some((item) => item.testDesignTechniques.includes(technique)));
  const applicableTechniques = profile.techniques.map((entry) => entry.technique);
  return {
    dimensionScores: scores,
    overallScore: cases.length ? Math.round(overall) : 0,
    requirementCoverage: reqKeys.length ? pct(covered.length, reqKeys.length) : cases.length ? 100 : 0,
    istqbCoverage: applicableTechniques.length ? pct(applicableTechniques.filter((technique) => usedTechniques.includes(technique)).length, applicableTechniques.length) : null,
    riskCoverage: scores.riskCoverage,
    negativeCoverage: scores.negativeScenarios,
    duplicateCount,
    coveredRequirements: covered,
    missingScenarios: missing.slice(0, 20),
    detectedRisks: coveredRisks.map((risk) => risk.description),
    usedTechniques,
  };
}

/** Strengths, weaknesses and recommendations, as codes the UI words. */
export function describe(evaluation: SetEvaluation, config: QualityConfig = DEFAULT_QUALITY_CONFIG) {
  const strengths: QualityNote[] = [];
  const weaknesses: QualityNote[] = [];
  const recommendations: QualityNote[] = [];
  for (const dimension of QUALITY_DIMENSIONS) {
    const score = evaluation.dimensionScores[dimension];
    if (score === null) continue;
    if (score >= 85) strengths.push({ code: "strongDimension", values: { dimension, score } });
    else if (score < 60) {
      weaknesses.push({ code: "weakDimension", values: { dimension, score } });
      recommendations.push({ code: `improve.${dimension}` });
    }
  }
  if (evaluation.duplicateCount > 0) recommendations.push({ code: "removeDuplicates", values: { count: evaluation.duplicateCount } });
  return { qualityLevel: qualityLevel(evaluation.overallScore, config), strengths: strengths.slice(0, 6), weaknesses: weaknesses.slice(0, 6), recommendations: recommendations.slice(0, 6) };
}
