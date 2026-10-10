import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppLocale } from "../../ai/localize-fa";
import { isOfficial, similarity, type CaseWithKeys, type StudioResult } from "./pipeline";

/**
 * Writing a studio result into the workspace tables. The rules:
 * - anything the user wrote, edited, approved or confirmed is never touched;
 * - AI-proposed criteria are rows with origin "ai" (keys AI-NN) until the user
 *   confirms them; they are matched to the previous proposals by wording so
 *   their test-case links survive a re-run;
 * - generated test cases have a stable identity (criteria + type + ordinal);
 *   generated cases the new run no longer produces are deleted, unless they
 *   were executed — those stay, marked "potentially outdated".
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export type IssueForApply = {
  id: string;
  acceptanceCriteria: Array<{ id: string; key: string; text: string; origin: string; orderIndex: number }>;
  testCases: Array<{
    id: string;
    conditionKey: string | null;
    designStatus: string;
    manuallyEdited: boolean;
    tags: string[];
    jiraSyncStatus: string;
    runs: Array<{ id: string }>;
    acceptanceLinks: Array<{ acceptanceCriterion: { key: string } }>;
  }>;
};

export const isLockedDesign = (status: string | null | undefined, manuallyEdited: boolean) =>
  manuallyEdited || status === "APPROVED" || status === "MANUALLY_EDITED";

/** Save AI-proposed criteria; returns run key (AI-01 …) → stored key. */
export async function applyCriteria(tx: Tx, issue: IssueForApply, proposed: NonNullable<StudioResult["proposed"]>) {
  const keyMap = new Map<string, string>();
  const replaceable = issue.acceptanceCriteria.filter((row) => !isOfficial(row.origin));
  const used = new Set<string>();
  const taken = new Set(issue.acceptanceCriteria.map((row) => row.key));
  let next = 1;
  const freshKey = () => {
    while (taken.has(`AI-${String(next).padStart(2, "0")}`)) next += 1;
    const key = `AI-${String(next).padStart(2, "0")}`;
    taken.add(key);
    return key;
  };
  let order = issue.acceptanceCriteria.filter((row) => isOfficial(row.origin)).reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
  for (const item of proposed) {
    const fields = {
      text: item.text,
      origin: "ai",
      evidence: item.evidence,
      confidence: item.confidence,
      rationale: item.rationale,
      category: item.category,
      orderIndex: order++,
    };
    const match = replaceable
      .filter((row) => !used.has(row.id))
      .map((row) => ({ row, score: similarity(row.text, item.text) }))
      .sort((a, b) => b.score - a.score)[0];
    if (match && match.score >= 0.5) {
      used.add(match.row.id);
      // A legacy rule-derived row is renamed to the AI key space.
      const key = match.row.key.startsWith("AI-") ? match.row.key : freshKey();
      await tx.acceptanceCriterion.update({ where: { id: match.row.id }, data: { ...fields, key } });
      keyMap.set(item.key, key);
      continue;
    }
    const key = freshKey();
    await tx.acceptanceCriterion.create({ data: { jiraIssueId: issue.id, key, ...fields } });
    keyMap.set(item.key, key);
  }
  // Earlier proposals the run no longer makes go, unless a kept test case still relies on them.
  for (const row of replaceable) {
    if (used.has(row.id)) continue;
    const relied = issue.testCases.some(
      (testCase) =>
        testCase.acceptanceLinks.some((link) => link.acceptanceCriterion.key === row.key) &&
        (isLockedDesign(testCase.designStatus, testCase.manuallyEdited) || testCase.runs.length > 0),
    );
    if (!relied) await tx.acceptanceCriterion.delete({ where: { id: row.id } });
  }
  return keyMap;
}

function conditionKeys(cases: CaseWithKeys[], keyOf: (key: string) => string) {
  const seen = new Map<string, number>();
  return cases.map((item) => {
    const keys = [...new Set(item.criterionKeys.map(keyOf))].sort().join("+");
    const base = `ai:${keys}:${item.type}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return `${base}:${count}`;
  });
}

/**
 * Save generated test cases. `scopeKeys` limits the cleanup to cases of
 * those criteria (a "regenerate for this AC" run); null means the whole issue.
 * Returns the stored case id of each generated case (same order).
 */
export async function applyCases(
  tx: Tx,
  issue: IssueForApply,
  cases: CaseWithKeys[],
  keyMap: Map<string, string>,
  scopeKeys: string[] | null,
): Promise<Array<string | null>> {
  const keyOf = (key: string) => keyMap.get(key) ?? key;
  const criteria = await tx.acceptanceCriterion.findMany({ where: { jiraIssueId: issue.id } });
  const byKey = new Map(criteria.map((row) => [row.key, row]));
  const identities = conditionKeys(cases, keyOf);
  const ids: Array<string | null> = [];
  const produced = new Set<string>();

  for (const [index, item] of cases.entries()) {
    const conditionKey = identities[index]!;
    produced.add(conditionKey);
    const links = [...new Set(item.criterionKeys.map(keyOf))].map((key) => byKey.get(key)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const proposedOnly = links.length > 0 && links.every((row) => !isOfficial(row.origin));
    const data = {
      title: item.title,
      description: item.objective,
      preconditions: item.preconditions,
      steps: item.steps.map((step) => step.action),
      stepExpectations: item.steps.map((step) => step.expected),
      testData: item.testData,
      expectedResult: item.expectedResult,
      priority: item.priority,
      type: item.type,
      technique: item.technique,
      tags: ["ai", item.type.toLowerCase(), ...item.ruleRefs.map((ref) => `rule:${ref}`)],
      designStatus: proposedOnly || links.some((row) => !isOfficial(row.origin)) ? "DRAFT_REQUIRES_REVIEW" : "AI_DRAFT",
      conditionKey,
      gapRefs: item.ruleRefs,
      assumptions: item.reviewNote ? [item.reviewNote] : [],
    };
    const existing = issue.testCases.find((row) => row.conditionKey === conditionKey);
    if (existing && isLockedDesign(existing.designStatus, existing.manuallyEdited)) {
      ids.push(existing.id);
      continue;
    }
    if (existing) {
      await tx.testCase.update({
        where: { id: existing.id },
        data: {
          ...data,
          jiraSyncStatus: existing.jiraSyncStatus === "SYNCED" ? "MODIFIED" : existing.jiraSyncStatus,
          acceptanceLinks: { deleteMany: {}, create: links.map((row) => ({ acceptanceCriterionId: row.id })) },
        },
      });
      ids.push(existing.id);
      continue;
    }
    const created = await tx.testCase.create({
      data: { jiraIssueId: issue.id, ...data, acceptanceLinks: { create: links.map((row) => ({ acceptanceCriterionId: row.id })) } },
    });
    ids.push(created.id);
  }

  // Generated cases this run did not produce again.
  const scope = scopeKeys ? new Set(scopeKeys.map(keyOf)) : null;
  for (const row of issue.testCases) {
    if (isLockedDesign(row.designStatus, row.manuallyEdited) || row.tags.includes("manual")) continue;
    if (row.conditionKey && produced.has(row.conditionKey)) continue;
    if (scope && !row.acceptanceLinks.some((link) => scope.has(link.acceptanceCriterion.key))) continue;
    if (row.runs.length > 0) {
      await tx.testCase.update({ where: { id: row.id }, data: { designStatus: "POTENTIALLY_OUTDATED" } });
    } else {
      await tx.testCase.delete({ where: { id: row.id } });
    }
  }
  return ids;
}

export async function applyEdges(tx: Tx, issueId: string, edges: NonNullable<StudioResult["edges"]>, keyMap: Map<string, string>, locale: AppLocale) {
  await tx.edgeCase.deleteMany({ where: { jiraIssueId: issueId, manuallyEdited: false } });
  const expected = locale === "fa" ? "رفتار مورد انتظار" : "Expected behaviour";
  for (const item of edges) {
    await tx.edgeCase.create({
      data: {
        jiraIssueId: issueId,
        title: item.title,
        description: item.expectedBehavior ? `${item.scenario}\n\n${expected}: ${item.expectedBehavior}` : item.scenario,
        rationale: item.whyItMatters,
        severity: item.severity,
        ruleRefs: item.ruleRefs,
        acceptanceKeys: item.criterionKeys.map((key) => keyMap.get(key) ?? key),
      },
    });
  }
}

export async function applyAssessment(tx: Tx, issueId: string, result: StudioResult, keyMap: Map<string, string>) {
  const assessment = result.assessment!;
  await tx.risk.deleteMany({ where: { jiraIssueId: issueId, manuallyEdited: false } });
  for (const risk of assessment.risks) {
    await tx.risk.create({
      data: {
        jiraIssueId: issueId,
        description: risk.description,
        impact: risk.impact,
        likelihood: risk.likelihood,
        mitigation: risk.mitigation,
        releaseBlocking: risk.releaseBlocking,
        acceptanceKeys: risk.criterionKeys.map((key) => keyMap.get(key) ?? key),
      },
    });
  }
  const strategy = await tx.testStrategy.findUnique({ where: { jiraIssueId: issueId } });
  if (!strategy?.manuallyEdited) {
    const data = {
      scope: assessment.strategy.scope,
      objectives: assessment.strategy.objectives,
      testTypes: assessment.strategy.testTypes,
      environments: assessment.strategy.environments,
      dependencies: assessment.strategy.dependencies,
      assumptions: assessment.strategy.assumptions,
    };
    await tx.testStrategy.upsert({ where: { jiraIssueId: issueId }, create: { jiraIssueId: issueId, ...data }, update: data });
  }
}

/** The requirement analysis row: understanding, gaps, questions — fields the user edited are kept. */
export async function applyAnalysis(tx: Tx, issueId: string, result: StudioResult, criteriaTexts: string[]) {
  const current = await tx.requirementAnalysis.findUnique({ where: { jiraIssueId: issueId } });
  const edited = new Set<string>(
    Array.isArray((current?.understanding as { _edited?: unknown } | null)?._edited) ? ((current!.understanding as { _edited: string[] })._edited) : [],
  );
  const assessment = result.assessment;
  const writtenIssues = result.writtenIssues.map((item) => `${item.key}: ${item.problem}${item.suggestion ? ` — ${item.suggestion}` : ""}`);
  const questions = assessment?.questions ?? [];
  const byCategory = (category: string) => questions.filter((item) => item.category === category).map((item) => item.question);
  const generated = {
    summary: result.understanding?.summary ?? current?.summary ?? "",
    acceptanceCriteria: criteriaTexts,
    gaps: assessment ? [...assessment.gaps.map((item) => item.text), ...writtenIssues] : (current?.gaps as string[] | undefined) ?? [],
    ambiguities: assessment?.ambiguities ?? (current?.ambiguities as string[] | undefined) ?? [],
    missingScenarios: [],
    potentialRisks: assessment ? assessment.risks.map((item) => item.description) : (current?.potentialRisks as string[] | undefined) ?? [],
    questionsProduct: assessment ? byCategory("product") : ((current?.questionsProduct as string[] | undefined) ?? []),
    questionsDeveloper: assessment ? byCategory("developer") : ((current?.questionsDeveloper as string[] | undefined) ?? []),
    questionsBusiness: assessment ? byCategory("business") : ((current?.questionsBusiness as string[] | undefined) ?? []),
    questionDetails: assessment
      ? questions.map((item) => ({ question: item.question, category: item.category, reason: item.reason, source: item.ruleRefs.join(",") || "ai" }))
      : ((current?.questionDetails as Prisma.InputJsonValue | undefined) ?? []),
    suggestedCriteria: [],
    understanding: { ...(result.understanding ?? (current?.understanding as object) ?? {}), _edited: [...edited] },
  };
  // A field the user edited keeps the user's version.
  const data = Object.fromEntries(
    Object.entries(generated).map(([key, value]) => [key, edited.has(key) && current ? (current as Record<string, unknown>)[key] : value]),
  ) as typeof generated;
  await tx.requirementAnalysis.upsert({
    where: { jiraIssueId: issueId },
    create: { ...(data as unknown as Omit<Prisma.RequirementAnalysisUncheckedCreateInput, "jiraIssueId">), jiraIssueId: issueId },
    update: data as unknown as Prisma.RequirementAnalysisUncheckedUpdateInput,
  });
}

export async function applyAutomation(
  tx: Tx,
  issueId: string,
  items: NonNullable<StudioResult["automation"]>,
  caseIds: Array<string | null>,
) {
  await tx.automationCandidate.deleteMany({ where: { jiraIssueId: issueId, manuallyEdited: false } });
  for (const item of items) {
    const testCaseId = caseIds[item.caseIndex] ?? null;
    if (!testCaseId) continue;
    await tx.automationCandidate.create({
      data: {
        jiraIssueId: issueId,
        testCaseId,
        recommendedLevel: item.suitability,
        apiUiRecommendation: item.layer,
        reasoning: item.rationale,
        prerequisites: item.prerequisites,
        tooling: item.tooling,
      },
    });
    await tx.testCase.update({
      where: { id: testCaseId },
      data: { automationSuitability: item.suitability, automationNotes: item.rationale },
    });
  }
}
