import type { CaseFinding, NormalizedTestCase, ProviderEvaluation, ProviderStatus, QualityNote } from "@qa-workbench/shared";
import { norm, overlap, wordSet } from "../text";
import { DEFAULT_QUALITY_CONFIG, type QualityConfig } from "./config";
import { caseText, describe, evaluateSet, findDuplicates, isNegative, type SetEvaluation } from "./evaluate";
import { rescore } from "./normalize";
import type { TaskProfile } from "./task-profile";

/**
 * Cross-provider comparison, best-candidate selection, merging of
 * complementary scenarios, and the final quality gate.
 */

export type ProviderRun = {
  provider: string;
  name: string;
  model: string;
  status: ProviderStatus;
  error?: string;
  processingMs: number;
  cases: NormalizedTestCase[];
};

export type ScoredRun = ProviderRun & { evaluation: SetEvaluation; report: ProviderEvaluation };

export function evaluateProvider(run: ProviderRun, profile: TaskProfile, config: QualityConfig = DEFAULT_QUALITY_CONFIG): ScoredRun {
  const evaluation = evaluateSet(run.cases, profile, config);
  const described = describe(evaluation, config);
  return {
    ...run,
    evaluation,
    report: {
      provider: run.provider,
      name: run.name,
      model: run.model,
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
      processingMs: run.processingMs,
      caseCount: run.cases.length,
      overallScore: evaluation.overallScore,
      qualityLevel: described.qualityLevel,
      dimensionScores: evaluation.dimensionScores,
      requirementCoverage: evaluation.requirementCoverage,
      istqbCoverage: evaluation.istqbCoverage,
      riskCoverage: evaluation.riskCoverage,
      negativeCoverage: evaluation.negativeCoverage,
      duplicateCount: evaluation.duplicateCount,
      detectedRisks: evaluation.detectedRisks,
      missingScenarios: evaluation.missingScenarios,
      applicableISTQBTechniques: profile.techniques.map((entry) => entry.technique),
      strengths: described.strengths,
      weaknesses: described.weaknesses,
      recommendations: described.recommendations,
    },
  };
}

/**
 * The selection order, most important first. Within `closeEnough` points a
 * metric is a tie and the next one decides; a dimension that does not apply
 * to the task never decides.
 */
const SELECTION: Array<(run: ScoredRun) => number | null> = [
  (run) => run.evaluation.requirementCoverage,
  (run) => run.evaluation.dimensionScores.functionalCorrectness,
  (run) => run.evaluation.dimensionScores.businessRules,
  (run) => run.evaluation.dimensionScores.negativeScenarios,
  (run) => run.evaluation.dimensionScores.riskCoverage,
  (run) => run.evaluation.istqbCoverage,
  (run) => (run.cases.length ? 100 - (100 * run.evaluation.duplicateCount) / run.cases.length : 100),
  (run) => run.evaluation.overallScore,
];
/** When every metric is close: more requirements, fewer duplicates, more edge cases, stronger expected results, better traceability. */
const TIE_BREAK: Array<(run: ScoredRun) => number> = [
  (run) => run.evaluation.coveredRequirements.length,
  (run) => -run.evaluation.duplicateCount,
  (run) => run.cases.filter((item) => isNegative(item) || item.testDesignTechniques.includes("Boundary Value Analysis")).length,
  (run) => run.evaluation.dimensionScores.expectedResultQuality ?? 0,
  (run) => run.evaluation.dimensionScores.traceability ?? 0,
];

export function compareRuns(a: ScoredRun, b: ScoredRun, config: QualityConfig = DEFAULT_QUALITY_CONFIG) {
  for (const metric of SELECTION) {
    const left = metric(a);
    const right = metric(b);
    if (left === null || right === null) continue;
    if (Math.abs(left - right) > config.closeEnough) return right - left;
  }
  for (const metric of TIE_BREAK) {
    const diff = metric(b) - metric(a);
    if (diff !== 0) return diff;
  }
  return a.name.localeCompare(b.name);
}

/** What a case adds to a set: requirements, polarity and technique per requirement, rules, risks, transitions, error codes. */
function coverageKeys(item: NormalizedTestCase, profile: TaskProfile) {
  const keys = new Set<string>();
  const negative = isNegative(item);
  const text = norm(caseText(item));
  const words = wordSet(caseText(item));
  for (const req of item.requirementIds) {
    keys.add(`req:${req}`);
    keys.add(`pol:${req}:${negative ? "neg" : "pos"}`);
    for (const technique of item.testDesignTechniques) keys.add(`tech:${req}:${technique}`);
  }
  for (const ref of item.ruleRefs) keys.add(`rule:${ref}`);
  profile.risks.forEach((risk, index) => {
    if (risk.criterionKeys.some((key) => item.requirementIds.includes(key)) || overlap(risk.words, words) >= 0.2) keys.add(`risk:${index}`);
  });
  for (const transition of profile.transitions) if (text.includes(norm(transition.from)) && text.includes(norm(transition.to))) keys.add(`trans:${transition.from}>${transition.to}`);
  for (const code of profile.errorCodes) if (new RegExp(`\\b${code}\\b`).test(text)) keys.add(`err:${code}`);
  return keys;
}

const mergeSources = (into: NormalizedTestCase, from: NormalizedTestCase): NormalizedTestCase => ({
  ...into,
  sourceProviders: [...new Set([...into.sourceProviders, ...from.sourceProviders])],
});

/** Drop duplicates inside one set, keeping the better case of each pair. */
export function dedupe(cases: NormalizedTestCase[], config: QualityConfig = DEFAULT_QUALITY_CONFIG) {
  const pairs = findDuplicates(cases, config.duplicateSimilarity);
  const removed = new Set<number>();
  const kept = [...cases];
  for (const [i, j] of pairs) {
    if (removed.has(i) || removed.has(j)) continue;
    const [keep, drop] = cases[j]!.qualityScore > cases[i]!.qualityScore ? [j, i] : [i, j];
    kept[keep] = mergeSources(kept[keep]!, cases[drop]!);
    removed.add(drop);
  }
  return { cases: kept.filter((_, index) => !removed.has(index)), removed: removed.size };
}

export type Selection = {
  base: ScoredRun | null;
  cases: NormalizedTestCase[];
  merged: Array<{ provider: string; added: number }>;
  reasons: QualityNote[];
  duplicatesRemoved: number;
  lowQualityFiltered: number;
  timing: { deduplicationMs: number; selectionMs: number };
};

/** Pick the best provider's set as the base, then add other providers' unique, high-quality scenarios that add coverage. */
export function selectAndMerge(runs: ScoredRun[], profile: TaskProfile, config: QualityConfig = DEFAULT_QUALITY_CONFIG): Selection {
  const selectStart = performance.now();
  const reasons: QualityNote[] = [];
  for (const run of runs) if (run.status === "failed" || run.status === "timeout") reasons.push({ code: "providerUnavailable", values: { provider: run.name, status: run.status } });
  const candidates = runs.filter((run) => run.cases.length > 0 && run.status !== "running");
  if (candidates.length === 0) {
    return { base: null, cases: [], merged: [], reasons, duplicatesRemoved: 0, lowQualityFiltered: 0, timing: { deduplicationMs: 0, selectionMs: performance.now() - selectStart } };
  }
  let base = candidates[0]!;
  for (const run of candidates.slice(1)) if (compareRuns(run, base, config) < 0) base = run;
  reasons.push({
    code: candidates.length === 1 ? "singleProvider" : "baseSelected",
    values: { provider: base.name, score: base.evaluation.overallScore, coverage: base.evaluation.requirementCoverage },
  });
  const others = candidates.filter((run) => run !== base).sort((a, b) => b.evaluation.overallScore - a.evaluation.overallScore);
  for (const run of others) {
    if (Math.abs(run.evaluation.overallScore - base.evaluation.overallScore) <= config.closeEnough) {
      reasons.push({ code: "closeCompetitor", values: { provider: run.name, score: run.evaluation.overallScore } });
    }
  }
  const selectionMs = performance.now() - selectStart;

  const dedupStart = performance.now();
  let lowQualityFiltered = 0;
  const baseCases = base.cases.filter((item) => {
    const keep = item.qualityScore >= config.gateMinCaseQuality;
    if (!keep) lowQualityFiltered += 1;
    return keep;
  });
  const first = dedupe(baseCases, config);
  let duplicatesRemoved = first.removed;
  const final = first.cases;
  const covered = new Set<string>();
  const perReq = new Map<string, number>();
  const finalWords = final.map((item) => wordSet([item.title, ...item.steps.map((step) => step.action), ...item.expectedResults].join(" ")));
  for (const item of final) {
    for (const key of coverageKeys(item, profile)) covered.add(key);
    for (const req of item.requirementIds) perReq.set(req, (perReq.get(req) ?? 0) + 1);
  }

  const merged: Selection["merged"] = [];
  for (const run of others) {
    if (run.evaluation.overallScore < config.mergeMinProviderScore) {
      reasons.push({ code: "providerTooWeak", values: { provider: run.name, score: run.evaluation.overallScore } });
      continue;
    }
    let added = 0;
    for (const item of [...run.cases].sort((a, b) => b.qualityScore - a.qualityScore)) {
      if (item.qualityScore < config.mergeMinCaseQuality || item.findings.includes("irrelevant") || item.findings.includes("untraceable")) {
        lowQualityFiltered += 1;
        continue;
      }
      const words = wordSet([item.title, ...item.steps.map((step) => step.action), ...item.expectedResults].join(" "));
      const negative = isNegative(item);
      const twin = final.findIndex(
        (existing, index) =>
          isNegative(existing) === negative &&
          (existing.requirementIds.some((key) => item.requirementIds.includes(key)) || (existing.requirementIds.length === 0 && item.requirementIds.length === 0)) &&
          overlap(finalWords[index]!, words) >= config.duplicateSimilarity,
      );
      if (twin >= 0) {
        // The same scenario: one case, both providers credited; the clearly better wording wins.
        const better = item.qualityScore > final[twin]!.qualityScore + 10 ? { ...item, sourceProviders: final[twin]!.sourceProviders } : final[twin]!;
        final[twin] = mergeSources(better, item);
        finalWords[twin] = wordSet([final[twin]!.title, ...final[twin]!.steps.map((step) => step.action), ...final[twin]!.expectedResults].join(" "));
        duplicatesRemoved += 1;
        continue;
      }
      const keys = coverageKeys(item, profile);
      const adds = [...keys].some((key) => !covered.has(key));
      const room = item.requirementIds.every((req) => (perReq.get(req) ?? 0) < config.maxCasesPerRequirement);
      if (!adds || !room) {
        duplicatesRemoved += 1;
        continue;
      }
      final.push(item);
      finalWords.push(words);
      for (const key of keys) covered.add(key);
      for (const req of item.requirementIds) perReq.set(req, (perReq.get(req) ?? 0) + 1);
      added += 1;
    }
    merged.push({ provider: run.name, added });
    if (added > 0) reasons.push({ code: "merged", values: { provider: run.name, added } });
  }
  if (duplicatesRemoved > 0) reasons.push({ code: "duplicatesRemoved", values: { count: duplicatesRemoved } });
  if (lowQualityFiltered > 0) reasons.push({ code: "lowQualityFiltered", values: { count: lowQualityFiltered } });

  // Keep the requirement order of the task.
  const order = new Map(profile.requirements.map((item, index) => [item.key, index]));
  const rank = (item: NormalizedTestCase) => Math.min(...item.requirementIds.map((key) => order.get(key) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  const sorted = final.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
  return {
    base,
    cases: sorted,
    merged,
    reasons,
    duplicatesRemoved,
    lowQualityFiltered,
    timing: { deduplicationMs: performance.now() - dedupStart, selectionMs },
  };
}

const TO_CONFIRM = "<to confirm>";
const BLOCKING: CaseFinding[] = ["noSteps", "missingExpectedResult", "irrelevant"];

/**
 * The final gate before cases reach the user. Fixable problems are improved
 * (end state taken from the last checked step, a trace to the matching
 * requirement, required-but-unknown data marked "to confirm"); cases that stay
 * unusable are rejected.
 */
export function qualityGate(cases: NormalizedTestCase[], profile: TaskProfile, config: QualityConfig = DEFAULT_QUALITY_CONFIG) {
  const kept: NormalizedTestCase[] = [];
  const rejected: Array<{ title: string; provider: string; reasons: CaseFinding[] }> = [];
  let improved = 0;
  for (const original of cases) {
    let item = original;
    let changed = false;
    if (item.expectedResults.length === 0) {
      const last = [...item.steps].reverse().find((step) => step.expected.trim());
      if (last) {
        item = { ...item, expectedResults: [last.expected.trim()] };
        changed = true;
      }
    }
    if (item.requirementIds.length === 0 && profile.requirements.length > 0) {
      const words = wordSet(caseText(item));
      const best = profile.requirements.map((req) => ({ key: req.key, score: overlap(req.words, words) })).sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.2) {
        item = { ...item, requirementIds: [best.key] };
        changed = true;
      }
    }
    if (item.findings.includes("missingTestData") && item.testData.length === 0) {
      item = { ...item, testData: [TO_CONFIRM] };
      changed = true;
    }
    if (changed) item = rescore(item, profile);
    const blocking = item.findings.filter((finding) => BLOCKING.includes(finding));
    const untraced = item.findings.includes("untraceable");
    const unclear = item.findings.includes("vagueSteps") && (item.findings.includes("vagueExpectedResult") || item.findings.includes("unclearPassFail"));
    if (blocking.length || untraced || unclear || item.qualityScore < config.gateMinCaseQuality) {
      rejected.push({ title: item.title, provider: item.sourceProviders.join(", "), reasons: item.findings.length ? item.findings : ["unclearPassFail"] });
      continue;
    }
    if (changed) improved += 1;
    kept.push(item);
  }
  const deduped = dedupe(kept, config);
  const traced = new Set(deduped.cases.flatMap((item) => item.requirementIds));
  return {
    cases: deduped.cases,
    rejected,
    improved,
    duplicatesRemoved: deduped.removed,
    untracedRequirements: profile.requirements.filter((req) => !traced.has(req.key)).map((req) => req.key),
  };
}
