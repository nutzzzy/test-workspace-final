import { applyCases, applyCriteria, type IssueForApply } from "./apply";
import type { CaseWithKeys, ProposedCriterion } from "./pipeline";

/** Just enough of Prisma, in memory, for the apply rules. */
function fakeDb(seed: { criteria: Array<Record<string, unknown>>; cases: Array<Record<string, unknown>> }) {
  let id = 100;
  const criteria = seed.criteria.map((row) => ({ evidence: "", confidence: null, rationale: "", category: null, orderIndex: 0, ...row })) as Array<Record<string, unknown>>;
  const cases = seed.cases.map((row) => ({ links: [] as string[], ...row })) as Array<Record<string, unknown>>;
  const linksOf = (data: { acceptanceLinks?: { create?: Array<{ acceptanceCriterionId: string }> } }) =>
    (data.acceptanceLinks?.create ?? []).map((link) => link.acceptanceCriterionId);
  const strip = (data: Record<string, unknown>) => {
    const { acceptanceLinks: _links, ...rest } = data;
    void _links;
    return rest;
  };
  const tx = {
    acceptanceCriterion: {
      findMany: async () => criteria,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `c${id++}`, ...data };
        criteria.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(criteria.find((row) => row.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        criteria.splice(criteria.findIndex((row) => row.id === where.id), 1);
      },
    },
    testCase: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `t${id++}`, ...strip(data), links: linksOf(data) };
        cases.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = cases.find((item) => item.id === where.id)!;
        Object.assign(row, strip(data));
        if ((data as { acceptanceLinks?: unknown }).acceptanceLinks) row.links = linksOf(data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        cases.splice(cases.findIndex((row) => row.id === where.id), 1);
      },
    },
  };
  const issue = (): IssueForApply => ({
    id: "issue",
    acceptanceCriteria: criteria as never,
    testCases: cases.map((row) => ({
      ...(row as object),
      runs: (row.runs as Array<{ id: string }>) ?? [],
      tags: (row.tags as string[]) ?? [],
      manuallyEdited: Boolean(row.manuallyEdited),
      acceptanceLinks: ((row.links as string[]) ?? []).map((cid) => ({ acceptanceCriterion: { key: String(criteria.find((c) => c.id === cid)?.key) } })),
    })) as never,
  });
  return { tx: tx as never, criteria, cases, issue };
}

const proposal = (key: string, text: string): ProposedCriterion => ({
  key,
  text,
  category: "validation",
  evidence: "quote",
  grounded: true,
  ruleRefs: [],
  confidence: "HIGH",
  rationale: "",
});

const generated = (keys: string[], title: string): CaseWithKeys => ({
  criterionKeys: keys,
  ruleRefs: ["R1"],
  title,
  objective: "",
  preconditions: [],
  testData: [],
  steps: [{ action: "do", expected: "see" }],
  expectedResult: "result",
  priority: "HIGH",
  type: "NEGATIVE",
  technique: "",
});

describe("applying a studio run", () => {
  it("replaces rule-derived junk criteria, keeps confirmed and manual ones, and reuses matching proposals", async () => {
    const db = fakeDb({
      criteria: [
        { id: "j1", key: "AC-01", text: "کاربر بتواند created_at DATETIME زمان ایجاد", origin: "derived" },
        { id: "p1", key: "AI-01", text: "When Reason is Other and Description is empty the request is rejected", origin: "ai" },
        { id: "k1", key: "AI-02", text: "Confirmed by the user", origin: "confirmed" },
        { id: "m1", key: "AC-02", text: "Written by the user", origin: "manual" },
      ],
      cases: [],
    });
    const keyMap = await applyCriteria(db.tx, db.issue(), [
      proposal("AI-01", "When Reason is Other and the Description is empty, the request is rejected with 400"),
      proposal("AI-02", "A duplicate open request with the same reason is not created"),
    ]);
    expect(db.criteria.map((row) => `${row.key}:${row.origin}`).sort()).toEqual(["AC-02:manual", "AI-01:ai", "AI-02:confirmed", "AI-03:ai"]);
    // The similar proposal kept its row (and therefore its test-case links).
    expect(db.criteria.find((row) => row.id === "p1")!.text).toMatch(/rejected with 400/);
    expect(keyMap.get("AI-01")).toBe("AI-01");
    expect(keyMap.get("AI-02")).toBe("AI-03");
  });

  it("never touches approved or edited cases, updates the rest in place, and cleans up what is no longer produced", async () => {
    const db = fakeDb({
      criteria: [{ id: "c1", key: "AI-01", text: "x", origin: "ai" }],
      cases: [
        { id: "approved", conditionKey: "ai:AI-01:NEGATIVE:1", title: "Old approved", designStatus: "APPROVED", jiraSyncStatus: "NOT_SYNCED", links: ["c1"] },
        { id: "junk", conditionKey: "COND-abc", title: "بررسی معیار AC-01", designStatus: "DRAFT_REQUIRES_REVIEW", jiraSyncStatus: "NOT_SYNCED", links: [] },
        { id: "ran", conditionKey: "COND-def", title: "Executed draft", designStatus: "AI_DRAFT", jiraSyncStatus: "NOT_SYNCED", links: [], runs: [{ id: "r" }] },
        { id: "mine", conditionKey: null, title: "Manual", designStatus: "MANUALLY_EDITED", manuallyEdited: true, tags: ["manual"], jiraSyncStatus: "NOT_SYNCED", links: [] },
      ],
    });
    const ids = await applyCases(db.tx, db.issue(), [generated(["AI-01"], "New title"), generated(["AI-01"], "Second negative")], new Map(), null);
    expect(db.cases.find((row) => row.id === "approved")!.title).toBe("Old approved");
    expect(ids[0]).toBe("approved");
    expect(db.cases.some((row) => row.id === "junk")).toBe(false);
    expect(db.cases.find((row) => row.id === "ran")!.designStatus).toBe("POTENTIALLY_OUTDATED");
    expect(db.cases.find((row) => row.id === "mine")!.title).toBe("Manual");
    const created = db.cases.find((row) => row.title === "Second negative")!;
    // Cases of an unconfirmed proposal always need review.
    expect(created).toMatchObject({ conditionKey: "ai:AI-01:NEGATIVE:2", designStatus: "DRAFT_REQUIRES_REVIEW", links: ["c1"] });
  });

  it("limits the cleanup of a per-criterion run to that criterion's cases", async () => {
    const db = fakeDb({
      criteria: [
        { id: "c1", key: "AC-01", text: "a", origin: "imported" },
        { id: "c2", key: "AC-02", text: "b", origin: "imported" },
      ],
      cases: [{ id: "other", conditionKey: "ai:AC-02:FUNCTIONAL:1", title: "Other criterion", designStatus: "AI_DRAFT", jiraSyncStatus: "SYNCED", links: ["c2"] }],
    });
    await applyCases(db.tx, db.issue(), [generated(["AC-01"], "For AC-01")], new Map(), ["AC-01"]);
    expect(db.cases.map((row) => row.id)).toContain("other");
    expect(db.cases.find((row) => row.title === "For AC-01")).toMatchObject({ designStatus: "AI_DRAFT" });
  });
});
