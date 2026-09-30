import {
  designAcceptanceCriteria,
  designAnalysis,
  dedupeTestCases,
  designEdgeCases,
  designRisks,
  designStrategy,
  designTestCases,
} from "./qa-design";

describe("QA acceptance design", () => {
  it("derives criteria from the description when the task has none", () => {
    const criteria = designAcceptanceCriteria({
      title: "Biker order",
      description:
        "The biker must see the order on the map. The biker should be able to accept the order.",
      rawCriteria: [],
      locale: "en",
    });

    expect(criteria.map((item) => item.origin)).toEqual(["derived", "derived"]);
    expect(criteria.map((item) => item.key)).toEqual(["AC-01", "AC-02"]);
    expect(criteria[0]?.text).toMatch(/see the order/i);
    expect(criteria[1]?.text).toMatch(/accept the order/i);
  });

  it("cleans a messy acceptance list and keeps a stable order", () => {
    const criteria = designAcceptanceCriteria({
      title: "Gold price",
      description: "",
      rawCriteria: [
        "1. user sees the buy price 2. user can refresh the price; error if the symbol is missing",
        "- user sees the buy price",
        "Given the market is open",
        "When the user requests the price",
        "Then the buy price is shown",
      ],
      locale: "en",
    });

    expect(criteria.every((item) => item.origin === "cleaned")).toBe(true);
    expect(criteria.map((item) => item.text)).toEqual([
      "User sees the buy price",
      "User can refresh the price",
      "Error if the symbol is missing",
      "Given the market is open When the user requests the price Then the buy price is shown",
    ]);
    expect(criteria.map((item) => item.key)).toEqual([
      "AC-01",
      "AC-02",
      "AC-03",
      "AC-04",
    ]);
  });

  it("orders test cases by acceptance criterion, positive then negative", () => {
    const criteria = designAcceptanceCriteria({
      title: "Cancel",
      description: "",
      rawCriteria: ["can cancel a pending order", "must keep the refund id"],
      locale: "en",
    });
    const cases = designTestCases(criteria, "en");
    const titles = cases.map((item) => item.title);

    expect(titles[0]).toMatch(/^AC-01 · Positive/);
    expect(titles[1]).toMatch(/^AC-01 · Negative/);
    expect(titles.findIndex((title) => title.startsWith("AC-02"))).toBeGreaterThan(
      titles.findIndex((title) => title.startsWith("AC-01 · Negative")),
    );
    expect(cases.every((item) => item.relatedAcceptanceCriteria.length === 1)).toBe(
      true,
    );
    expect(cases[0]?.steps.join(" ")).toMatch(/cancel a pending order/i);
    expect(cases[0]?.steps.join(" ")).not.toMatch(/Prepare the preconditions/);
  });

  it("keeps a Persian scenario together and writes steps a tester can follow", () => {
    const criteria = designAcceptanceCriteria({
      title: "IVR NFC",
      description: "",
      rawCriteria: [
        "Endpoint /biker/ivr/nfc همچنان شماره موبایل یا ID بایکر را به‌عنوان ورودی دریافت کند.",
        "اگر بایکر پیدا نشود یا bikerId <= 5 باشد:",
        "درخواست NFC Accounting ایجاد نشود.",
        "پاسخ status = 0 و code = 0 برگردانده شود.",
      ],
      locale: "en",
    });

    expect(criteria.map((item) => item.key)).toEqual(["AC-01", "AC-02"]);
    expect(criteria[1]?.text).toMatch(/ایجاد نشود/);
    expect(criteria[1]?.text).toMatch(/status = 0/);
    expect(criteria[0]?.text.startsWith("کاربر بتواند")).toBe(false);

    const cases = designTestCases(criteria, "fa");
    const input = cases.find((item) => item.tags.includes("positive") && item.relatedAcceptanceCriteria[0] === "AC-01");
    const blocked = cases.find((item) => item.tags.includes("positive") && item.relatedAcceptanceCriteria[0] === "AC-02");
    const boundary = cases.find((item) => item.tags.includes("boundary"));

    expect(input?.title).toMatch(/موفق/);
    expect(input?.steps.join(" ")).toMatch(/شماره موبایل/);
    expect(input?.steps.join(" ")).toMatch(/ID بایکر/);
    expect(input?.steps.join(" ")).toMatch(/\/biker\/ivr\/nfc/);
    expect(input?.steps.join(" ")).not.toMatch(/Prepare the preconditions/);
    expect(blocked?.preconditions.join(" ")).toMatch(/bikerId <= 5/);
    expect(blocked?.steps[0]).toMatch(/قبل از اجرا/);
    expect(blocked?.expectedResult).toMatch(/status = 0/);
    expect(blocked?.expectedResult).toMatch(/code = 0/);
    expect(boundary?.steps).toHaveLength(3);
    expect(boundary?.steps.join(" ")).toMatch(/bikerId/);
    expect(boundary?.steps.join(" ")).toMatch(/5/);
    expect(boundary?.expectedResult).toMatch(/ایجاد نشود/);
    expect(boundary?.expectedResult).toMatch(/status = 0/);
    expect(boundary?.expectedResult).not.toMatch(/قبول شود/);
    expect(boundary?.steps[0]).toMatch(/قبل از اجرا|برابر 5/);
  });

  it("marks every criterion as a production gate", () => {
    const criteria = designAcceptanceCriteria({
      title: "لغو سفارش",
      description: "",
      rawCriteria: ["بتواند سفارش را لغو کند"],
      locale: "fa",
    });
    const risks = designRisks(criteria, "fa");
    const blocking = risks.filter((risk) => risk.releaseBlocking);

    expect(blocking).toHaveLength(criteria.length);
    expect(blocking[0]?.acceptanceKeys).toEqual(["AC-01"]);
    expect(blocking[0]?.description).toMatch(/نباید به پروداکشن برود/);
    expect(risks.some((risk) => !risk.releaseBlocking)).toBe(true);
  });

  it("falls back to the title when description and criteria are empty", () => {
    const criteria = designAcceptanceCriteria({
      title: "Empty task",
      description: "",
      rawCriteria: ["", "   "],
      locale: "en",
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.origin).toBe("derived");
    expect(criteria[0]?.text).toMatch(/Empty task/);
  });

  it("writes analysis, strategy, edges and risks a tester can execute", () => {
    const criteria = designAcceptanceCriteria({
      title: "IVR NFC",
      description: "",
      rawCriteria: [
        "Endpoint /biker/ivr/nfc همچنان شماره موبایل یا ID بایکر را به‌عنوان ورودی دریافت کند.",
        "اگر بایکر پیدا نشود یا bikerId <= 5 باشد:",
        "درخواست NFC Accounting ایجاد نشود.",
        "پاسخ status = 0 و code = 0 برگردانده شود.",
      ],
      locale: "fa",
    });
    const analysis = designAnalysis({
      title: "IVR NFC",
      criteria,
      locale: "fa",
    });
    const strategy = designStrategy("IVR NFC", criteria, "fa");
    const edges = designEdgeCases(criteria, "fa");
    const risks = designRisks(criteria, "fa");

    expect(analysis.summary).toMatch(/AC-02/);
    expect(analysis.summary).toMatch(/bikerId <= 5/);
    expect(analysis.gaps.join(" ")).not.toMatch(/احراز صلاحیت/);
    expect(strategy.objectives).toHaveLength(criteria.length);
    expect(strategy.objectives[1]).toMatch(/status = 0/);
    expect(edges.some((edge) => edge.description.includes("شماره موبایل"))).toBe(
      true,
    );
    expect(edges.find((edge) => edge.title.startsWith("AC-02"))?.description).toMatch(
      /ایجاد نشود/,
    );
    expect(edges.find((edge) => edge.title.startsWith("AC-02"))?.description).not.toMatch(
      /قبول شود/,
    );
    expect(edges.some((edge) => edge.description.includes("bikerId"))).toBe(true);
    expect(edges.every((edge) => /قدم/.test(edge.description))).toBe(true);
    expect(risks[1]?.mitigation).toMatch(/bikerId <= 5/);
    expect(risks[1]?.mitigation).toMatch(/status = 0/);
    expect(risks[1]?.description).toMatch(/نباید به پروداکشن برود/);
  });

  it("gives every step an expected result and drops duplicate behavior", () => {
    const criteria = designAcceptanceCriteria({
      title: "Cancel",
      description: "",
      rawCriteria: ["can cancel a pending order"],
      locale: "en",
    });
    const cases = designTestCases(criteria, "en");
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      expect(item.stepExpectations).toHaveLength(item.steps.length);
      expect(item.stepExpectations.every((line) => line.trim().length > 8)).toBe(true);
      expect(item.steps.join(" ")).not.toMatch(/Test the feature/i);
    }
    expect(itemFingerprint(cases)).toBe(itemFingerprint(dedupeTestCases(cases)));
    const duplicated = dedupeTestCases([
      cases[0]!,
      { ...cases[0]!, title: "Same behavior, different title" },
    ]);
    expect(duplicated).toHaveLength(1);
  });

  it("adds a permission case only when the criterion is about access", () => {
    const criteria = designAcceptanceCriteria({
      title: "Admin",
      description: "",
      rawCriteria: ["an unauthorized role must be rejected"],
      locale: "en",
    });
    const cases = designTestCases(criteria, "en");
    expect(cases.some((item) => item.tags.includes("permission"))).toBe(true);
    expect(cases.filter((item) => item.tags.includes("positive"))).toHaveLength(1);
  });
});

function itemFingerprint(
  cases: Array<{ tags: string[]; steps: string[]; expectedResult: string }>,
) {
  return cases
    .map((item) => `${item.tags.join(",")}|${item.steps.join("|")}|${item.expectedResult}`)
    .join("\n");
}
