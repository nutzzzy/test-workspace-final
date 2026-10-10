import { ISTQB_TECHNIQUES, QUALITY_DIMENSIONS, type IstqbTechnique, type QualityDimension } from "@qa-workbench/shared";
import type { StudioUnderstanding } from "../pipeline";
import { norm, wordSet } from "../text";
import { DEFAULT_QUALITY_CONFIG, WEIGHT_GROUPS, type QualityConfig, type TaskKind } from "./config";

/**
 * Task analysis for the quality evaluation: which requirements, rules, risks,
 * states and error paths a good test set must cover, which ISTQB techniques
 * apply (and why), and therefore which scoring dimensions apply and how they
 * are weighted. Built once per run from the extracted understanding — no model
 * call — and shared by every provider's evaluation.
 */

export type Requirement = { key: string; text: string; category: string; critical: boolean; words: Set<string> };
export type TaskRisk = { description: string; criterionKeys: string[]; ruleRefs: string[]; critical: boolean; words: Set<string> };

export type TaskProfile = {
  requirements: Requirement[];
  rules: Array<{ id: string; text: string; conditional: boolean; words: Set<string> }>;
  risks: TaskRisk[];
  states: string[];
  transitions: Array<{ from: string; to: string }>;
  /** Documented error responses (4xx/5xx). */
  errorCodes: string[];
  /** Requirement keys for which a kind of scenario is meaningful. */
  worthy: Record<"negative" | "boundary" | "equivalence" | "validation" | "security" | "performance" | "errorHandling", Set<string>>;
  applicable: Record<QualityDimension, boolean>;
  techniques: Array<{ technique: IstqbTechnique; reason: string }>;
  kinds: TaskKind[];
  /** Effective weight per applicable dimension (sums to 100). */
  weights: Partial<Record<QualityDimension, number>>;
  corpusWords: Set<string>;
  /** Normalised source text, to check values a case relies on. */
  corpus: string;
  hasFlows: boolean;
};

export type TaskInput = {
  understanding: StudioUnderstanding | null;
  requirements: Array<{ key: string; text: string; category?: string }>;
  risks?: Array<{ description: string; impact?: string; releaseBlocking?: boolean; criterionKeys?: string[]; ruleRefs?: string[] }>;
  corpus: string;
};

// Keyword families (English and Persian). Persian has no word boundaries, so only distinctive forms are listed.
export const RX = {
  conditional: /\b(if|when|unless|only|otherwise|whenever|in case|provided that|except)\b|اگر|وقتی|زمانی که|در صورتی|فقط|مگر|درصورت/i,
  negativeReq:
    /\b(invalid|reject(ed|s)?|errors?|fails?|must not|cannot|can't|not allowed|deny|denied|forbidden|unauthori[sz]ed|required|mandatory|missing|empty|duplicate|exceed(s|ed)?|limit|only)\b|نامعتبر|رد شود|رد می|خطا|نباید|نمی‌تواند|نمیتواند|غیرمجاز|الزامی|اجباری|خالی|تکراری|بیش از|حداکثر|حداقل|فقط/i,
  limit:
    /\b(max(imum)?|min(imum)?|at least|at most|up to|limit|between|less than|more than|greater than|exceed(s|ed)?|length|characters?|range|older than|within)\b|حداکثر|حداقل|بیشتر از|کمتر از|بیش از|سقف|طول|کاراکتر|بازه|ظرف/i,
  /** A counted quantity (5 attempts, 30 days, 255 characters): a threshold with a boundary. */
  quantity:
    /\b\d+(st|nd|rd|th)?\s*(\p{L}+\s+)?(attempts?|times|tries|failures?|days?|hours?|minutes?|mins?|seconds?|secs?|items?|characters?|chars|digits?|years?|months?|%|percent|mb|kb|gb|requests?)\b|\d+\s*(\p{L}+\s+)?(بار|روز|ساعت|دقیقه|ثانیه|کاراکتر|رقم|سال|ماه|درصد|درخواست)/iu,
  inputClass: /\b(valid|invalid|format|type|one of|allowed values?|status|role|reason|enum|category)\b|معتبر|فرمت|نوع|وضعیت|نقش|دلیل/i,
  validation: /\b(valid(ate|ation)?|format|required|mandatory|must be|field|pattern|regex|length)\b|الزامی|اجباری|فرمت|معتبر|فیلد|اعتبارسنجی/i,
  security:
    /\b(auth\w*|token|log ?in|password|permission|role|access|admin|otp|encrypt\w*|pii|personal data|privacy|session|csrf|xss|injection)\b|دسترسی|نقش|رمز|توکن|احراز|ورود|مجوز|نشست/i,
  performance:
    /\b(performance|latency|response time|load|throughput|concurren\w*|scal\w*|within \d+ ?(ms|s|sec|seconds|minutes?))\b|عملکرد|کارایی|زمان پاسخ|بار زیاد|هم‌زمان|همزمان/i,
  payment:
    /\b(payment|pay|wallet|refund|invoice|amount|price|charge|transaction|settle\w*|balance|billing|checkout)\b|پرداخت|کیف پول|مبلغ|تراکنش|بازپرداخت|فاکتور|موجودی|تسویه|صورتحساب/i,
  errorGuess:
    /\b(timeout|time out|network|concurren\w*|simultaneous\w*|double|twice|retry|race|crash|offline|null|special char\w*|injection|unavailable|outage)\b|هم‌زمان|همزمان|دوبار|قطع|تکرار|در دسترس نیست/i,
};

const CRITICAL_CATEGORIES = new Set(["permission", "data_integrity", "calculation", "state", "validation", "boundary", "error_handling"]);
const STATUS_ERROR = /\b([45]\d\d)\b/g;

export function analyzeTask(input: TaskInput, config: QualityConfig = DEFAULT_QUALITY_CONFIG): TaskProfile {
  const u = input.understanding;
  const rules = (u?.rules ?? []).map((rule) => ({ id: rule.id, text: rule.text, conditional: RX.conditional.test(rule.text), words: wordSet(rule.text) }));
  const apis = u?.apis ?? [];
  const nonFunctional = (u?.nonFunctional ?? []).join("\n");
  const allText = [input.corpus, ...input.requirements.map((item) => item.text), ...rules.map((rule) => rule.text), nonFunctional].join("\n");

  const risks: TaskRisk[] = (input.risks ?? []).map((risk) => ({
    description: risk.description,
    criterionKeys: risk.criterionKeys ?? [],
    ruleRefs: risk.ruleRefs ?? [],
    critical: Boolean(risk.releaseBlocking) || risk.impact === "HIGH",
    words: wordSet(risk.description),
  }));
  const riskKeys = new Set(risks.filter((risk) => risk.critical).flatMap((risk) => risk.criterionKeys));
  const payment = RX.payment.test(allText);

  const requirements: Requirement[] = input.requirements.map((item) => {
    const category = item.category ?? "";
    return {
      key: item.key,
      text: item.text,
      category,
      critical: CRITICAL_CATEGORIES.has(category) || riskKeys.has(item.key) || (payment && RX.payment.test(item.text)),
      words: wordSet(item.text),
    };
  });

  const worthy: TaskProfile["worthy"] = {
    negative: new Set(),
    boundary: new Set(),
    equivalence: new Set(),
    validation: new Set(),
    security: new Set(),
    performance: new Set(),
    errorHandling: new Set(),
  };
  for (const item of requirements) {
    const text = item.text;
    if (["validation", "error_handling", "permission", "boundary", "data_integrity", "state"].includes(item.category) || RX.negativeReq.test(text)) worthy.negative.add(item.key);
    if (item.category === "boundary" || (RX.limit.test(text) && /\d/.test(text)) || RX.quantity.test(text)) worthy.boundary.add(item.key);
    if (["validation", "boundary", "calculation", "configuration", "permission"].includes(item.category) || RX.inputClass.test(text)) worthy.equivalence.add(item.key);
    if (item.category === "validation" || RX.validation.test(text)) worthy.validation.add(item.key);
    if (item.category === "permission" || RX.security.test(text)) worthy.security.add(item.key);
    if (item.category === "non_functional" ? RX.performance.test(text) || /\d/.test(text) : RX.performance.test(text)) worthy.performance.add(item.key);
    if (["error_handling", "integration"].includes(item.category) || /\b[45]\d\d\b/.test(text)) worthy.errorHandling.add(item.key);
  }

  const errorCodes = [...new Set(apis.flatMap((api) => api.responses.join(" ").match(STATUS_ERROR) ?? []))];
  const states = (u?.states ?? []).map((state) => state.name).filter(Boolean);
  const transitions = (u?.transitions ?? []).filter((item) => item.from && item.to).map((item) => ({ from: item.from, to: item.to }));
  const conditionalRules = rules.filter((rule) => rule.conditional);
  const hasFlows = (u?.flows?.length ?? 0) > 0;
  const uiOnly = apis.length === 0 && requirements.length > 0 && requirements.every((item) => item.category === "ui" || item.category === "happy_path");

  const always: QualityDimension[] = [
    "requirementCoverage",
    "functionalCorrectness",
    "expectedResultQuality",
    "positiveScenarios",
    "traceability",
    "testability",
    "testStepsClarity",
    "preconditionsDependencies",
    "maintainability",
    "duplicateDetection",
  ];
  const applicable = Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, always.includes(dimension)])) as Record<QualityDimension, boolean>;
  applicable.negativeScenarios = worthy.negative.size > 0 || apis.length > 0 || conditionalRules.length > 0;
  const numericConfig = (u?.configurations ?? []).some((item) => /\d/.test(`${item.key} ${item.meaning}`) || RX.limit.test(`${item.key} ${item.meaning}`));
  applicable.boundaryValueAnalysis = worthy.boundary.size > 0 || (u?.calculations?.length ?? 0) > 0 || numericConfig;
  applicable.equivalencePartitioning = worthy.equivalence.size > 0 || apis.some((api) => api.request);
  applicable.businessRules = conditionalRules.length > 0 || (u?.calculations?.length ?? 0) > 0;
  applicable.stateTransition = states.length >= 2 || transitions.length > 0 || requirements.some((item) => item.category === "state");
  applicable.errorHandling = errorCodes.length > 0 || worthy.errorHandling.size > 0 || (u?.integrations?.length ?? 0) > 0;
  applicable.dataValidation = worthy.validation.size > 0 || apis.some((api) => api.request);
  applicable.riskCoverage = risks.length > 0 || requirements.some((item) => item.critical);
  applicable.security = worthy.security.size > 0 || apis.some((api) => api.auth);
  applicable.performance = worthy.performance.size > 0 || RX.performance.test(nonFunctional);

  // Techniques are only proposed where the task gives them something to work on.
  const techniques: TaskProfile["techniques"] = [];
  const add = (technique: IstqbTechnique, when: boolean, reason: string) => when && techniques.push({ technique, reason });
  add("Equivalence Partitioning", applicable.equivalencePartitioning, "inputClasses");
  add("Boundary Value Analysis", applicable.boundaryValueAnalysis, "numericLimits");
  add("Decision Table Testing", conditionalRules.length >= 2 || (u?.calculations?.length ?? 0) > 0, "conditionalRules");
  add("State Transition Testing", applicable.stateTransition, "states");
  add("Use Case Testing", hasFlows || ((u?.actors?.length ?? 0) > 0 && apis.length > 0), "userFlows");
  add("Error Guessing", applicable.negativeScenarios && (apis.length > 0 || (u?.integrations?.length ?? 0) > 0 || RX.errorGuess.test(allText)), "failureModes");
  add("Exploratory Testing", (u?.assumptions?.length ?? 0) > 0 && !uiOnly, "openAssumptions");
  add("Risk-based Testing", applicable.riskCoverage, "risks");
  techniques.sort((a, b) => ISTQB_TECHNIQUES.indexOf(a.technique) - ISTQB_TECHNIQUES.indexOf(b.technique));

  const kinds: TaskKind[] = [];
  if (payment) kinds.push("payment");
  if (apis.some((api) => /^(POST|PUT|PATCH|DELETE)$/i.test(api.method))) kinds.push("api");
  if (uiOnly) kinds.push("ui");
  if (transitions.length > 0) kinds.push("stateful");

  return {
    requirements,
    rules,
    risks,
    states,
    transitions,
    errorCodes,
    worthy,
    applicable,
    techniques,
    kinds,
    weights: effectiveWeights(applicable, kinds, config),
    corpusWords: wordSet(allText),
    corpus: norm(allText),
    hasFlows,
  };
}

/**
 * Base group weights × task-kind emphasis, without the groups that do not
 * apply, scaled to 100; a group's weight is shared by its applicable dimensions.
 */
export function effectiveWeights(applicable: Record<QualityDimension, boolean>, kinds: TaskKind[], config: QualityConfig = DEFAULT_QUALITY_CONFIG) {
  const groups = WEIGHT_GROUPS.map((group) => {
    const dimensions = group.dimensions.filter((dimension) => applicable[dimension]);
    const multiplier = kinds.reduce((product, kind) => product * (config.emphasis[kind]?.[group.key] ?? 1), 1);
    return { dimensions, weight: dimensions.length ? group.weight * multiplier : 0 };
  });
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  const weights: Partial<Record<QualityDimension, number>> = {};
  if (total === 0) return weights;
  for (const group of groups) {
    for (const dimension of group.dimensions) weights[dimension] = (group.weight / total) * (100 / group.dimensions.length);
  }
  return weights;
}
