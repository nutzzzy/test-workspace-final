import {
  applyQualityGate,
  isLockedDesign,
  runQaPipeline,
  type EngineCase,
} from "./pipeline";

const BANNED =
  /این کار را انجام دهید|خروجی باید این باشد|قانونی که باید برقرار شود|perform the requirement|do this:|check ac\b/i;

const FIXTURES = {
  bikers: {
    locale: "fa" as const,
    title: "نمایش بایکرهای ثبت‌نام‌شده",
    description:
      "بایکرهایی که ثبت‌نام اولیه خود را از هر کانالی انجام می‌دهند، اطلاعاتشان در صفحه Registered Bikers نمایش داده می‌شود",
    acceptanceCriteria: [],
  },
  form: {
    locale: "en" as const,
    title: "Signup form",
    description:
      "The signup form requires email and password. Phone is optional. Password must be at least 8 characters.",
    acceptanceCriteria: [],
  },
  api: {
    locale: "en" as const,
    title: "Create order",
    description:
      "POST /orders creates an order. Required fields: customerId and amount. Invalid requests return 400. A successful response returns 201 and the order id.",
    acceptanceCriteria: [],
  },
  state: {
    locale: "en" as const,
    title: "Application lifecycle",
    description:
      "An application moves from PENDING to APPROVED when an admin approves it, then from APPROVED to ACTIVE when the start date is reached.",
    acceptanceCriteria: [],
  },
  auth: {
    locale: "en" as const,
    title: "Catalog permissions",
    description: "Only an Admin can edit the catalog. Customers can view it.",
    acceptanceCriteria: [],
  },
  search: {
    locale: "en" as const,
    title: "Product search",
    description:
      "Users can search products by name. Results can be filtered by category and sorted by price.",
    acceptanceCriteria: [],
  },
  payment: {
    locale: "en" as const,
    title: "Order payment",
    description:
      "A successful payment marks the order PAID. A failed payment leaves the order UNPAID. The customer can retry a failed payment.",
    acceptanceCriteria: [],
  },
  database: {
    locale: "en" as const,
    title: "Customer persistence",
    description:
      "Saving a customer writes a row in the customers table with a unique email. If the email already exists, the save is rejected.",
    acceptanceCriteria: [],
  },
};

function titles(result: ReturnType<typeof runQaPipeline>) {
  return result.testCases.map((item) => item.title);
}

function assertExecutable(testCase: EngineCase, source: string) {
  expect(testCase.title.trim().length).toBeGreaterThan(0);
  expect(testCase.description.trim().length).toBeGreaterThan(0);
  expect(testCase.steps.length).toBeGreaterThan(0);
  expect(testCase.steps.length).toBe(testCase.stepExpectations.length);
  testCase.steps.forEach((step, index) => {
    expect(step.trim()).not.toBe(testCase.stepExpectations[index]?.trim());
    expect(step).not.toBe(source);
    expect(step).not.toMatch(BANNED);
    expect(testCase.stepExpectations[index]).not.toMatch(BANNED);
  });
  expect(testCase.title).not.toMatch(/^AC-\d+/);
  expect(testCase.expectedResult.trim().length).toBeGreaterThan(0);
}

describe("qa pipeline", () => {
  it("designs the biker sentence from generic signals and records the gaps", () => {
    const source = FIXTURES.bikers.description;
    const result = runQaPipeline(FIXTURES.bikers);
    expect(result.classification).toContain("UI");
    expect(result.classification).not.toContain("API");
    expect(result.classification).not.toContain("INTEGRATION");
    expect(result.gaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining(["GAP-CHANNEL", "GAP-FIELDS"]),
    );
    expect(result.testCases).toHaveLength(1);
    const testCase = result.testCases[0];
    assertExecutable(testCase, source);
    expect(testCase.title).toMatch(/بایکر/);
    expect(testCase.title).toMatch(/Registered Bikers/);
    expect(testCase.expectedResult).not.toMatch(/اپلیکیشن|وب‌سایت|USSD/);
    expect(testCase.steps.join(" ")).not.toContain(source);
    expect(testCase.gapRefs).toEqual(expect.arrayContaining(["GAP-CHANNEL", "GAP-FIELDS"]));
    expect(result.testCases.filter((item) => /کانال/.test(item.partition)).length).toBe(0);
    expect(result.techniques).toContain("Use Case Testing");
    expect(result.strategy.objectives.join(" ")).not.toMatch(/Functional testing should be performed/);
  });

  it("uses different techniques for different requirement shapes", () => {
    const form = runQaPipeline(FIXTURES.form);
    const api = runQaPipeline(FIXTURES.api);
    const state = runQaPipeline(FIXTURES.state);
    const auth = runQaPipeline(FIXTURES.auth);
    const search = runQaPipeline(FIXTURES.search);
    const payment = runQaPipeline(FIXTURES.payment);
    const database = runQaPipeline(FIXTURES.database);

    expect(form.classification).toEqual(expect.arrayContaining(["UI", "VALIDATION"]));
    expect(form.techniques).toContain("Boundary Value Analysis");
    expect(titles(form).join(" ")).toMatch(/password/i);
    expect(form.classification).not.toContain("API");

    expect(api.classification).toContain("API");
    expect(api.techniques).toContain("Integration Contract Testing");
    expect(titles(api).join(" ")).toMatch(/POST \/orders/);
    expect(titles(api).join(" ")).toMatch(/201/);
    expect(titles(api).join(" ")).toMatch(/400/);
    expect(api.techniques).not.toContain("State Transition Testing");
    expect(api.automation.some((item) => item.scenarioStatus === "READY")).toBe(true);

    expect(state.classification).toContain("STATE_TRANSITION");
    expect(state.techniques).toContain("State Transition Testing");
    expect(titles(state).join(" ")).toMatch(/PENDING/);
    expect(titles(state).join(" ")).toMatch(/ACTIVE/);
    expect(state.classification).not.toContain("FINANCIAL");

    expect(auth.classification).toContain("AUTHORIZATION");
    expect(auth.techniques).toContain("Permission Matrix");
    expect(titles(auth).join(" ")).toMatch(/Admin/);
    expect(titles(auth).join(" ")).toMatch(/Customer/);
    expect(auth.testCases.some((item) => item.partition.includes("deny"))).toBe(true);

    expect(search.classification).toContain("SEARCH");
    expect(search.testCases.some((item) => item.partition.startsWith("search:exact"))).toBe(true);
    expect(search.testCases.some((item) => item.partition.includes("filter"))).toBe(true);
    expect(search.testCases.find((item) => item.partition === "search:empty")?.designStatus).toBe(
      "DRAFT_REQUIRES_REVIEW",
    );

    expect(payment.classification).toContain("FINANCIAL");
    expect(payment.testCases.map((item) => item.partition)).toEqual(
      expect.arrayContaining(["payment:success", "payment:failure", "payment:retry"]),
    );
    expect(payment.risks.some((risk) => /PAID/.test(risk.description))).toBe(true);
    expect(payment.automation.every((item) => item.scenarioStatus !== "READY")).toBe(true);

    expect(database.classification).toEqual(
      expect.arrayContaining(["DATABASE", "DATA_INTEGRITY"]),
    );
    expect(database.techniques).toContain("Data Integrity Testing");
    expect(database.automation.some((item) => item.scenarioStatus === "REQUIRES_CONFIGURATION")).toBe(
      true,
    );
    expect(database.testCases.some((item) => /customers/.test(item.title))).toBe(true);

    for (const result of [form, api, state, auth, search, payment, database]) {
      for (const testCase of result.testCases) {
        assertExecutable(
          testCase,
          "",
        );
      }
    }
  });

  it("does not turn a requirement gap into a fabricated expected result", () => {
    const result = runQaPipeline(FIXTURES.bikers);
    const gapText = result.gaps.map((gap) => gap.description).join(" ");
    for (const testCase of result.testCases) {
      expect(testCase.expectedResult).not.toContain("فهرست کانال");
      expect(gapText).not.toContain(testCase.expectedResult);
    }
  });

  it("detects a duplicate condition and preserves Persian text", () => {
    const doubled = runQaPipeline({
      ...FIXTURES.bikers,
      title: FIXTURES.bikers.description,
    });
    expect(doubled.testCases).toHaveLength(1);
    expect(doubled.testCases[0].steps.join(" ")).toMatch(/[\u0600-\u06FF]/);
  });

  it("downgrades a case that copies the source into a step", () => {
    const source = "The account is created";
    const bad: EngineCase = {
      conditionKey: "x",
      title: "AC-01 Success",
      description: "objective",
      preconditions: [],
      steps: [source],
      stepExpectations: [source],
      testData: [],
      expectedResult: source,
      priority: "MEDIUM",
      type: "FUNCTIONAL",
      tags: [],
      relatedAcceptanceCriteria: [],
      designStatus: "AI_DRAFT",
      technique: "Use Case Testing",
      gapRefs: [],
      assumptions: [],
      postconditions: [],
      automationSuitability: "LOW",
      automationLayer: "UI",
      automationNotes: "",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      partition: "x",
    };
    const gated = applyQualityGate(bad, source);
    expect(gated.designStatus).toBe("DRAFT_REQUIRES_REVIEW");
  });

  it("covers every stored acceptance criterion and merges only the same behavior", () => {
    const result = runQaPipeline({
      locale: "fa",
      title: "فعال شدن احراز بایکر بعد از فعال سازی اولیه",
      description: "",
      acceptanceCriteria: [
        {
          key: "AC-01",
          origin: "derived",
          text: "بایکرهایی که ثبت‌نام اولیه خود را از هر کانالی انجام می‌دهند، اطلاعاتشان در صفحه Registered Bikers نمایش داده می‌شود",
        },
        {
          key: "AC-02",
          origin: "derived",
          text: "نیاز است پس از ساخته‌شدن آیدی بایکر، فرآیند احراز هویت نیز برای همان بایکر فعال شود تا بایکر بتواند مرحله احراز هویت را در اپ/فرآیند مربوطه ادامه دهد",
        },
        {
          key: "AC-03",
          origin: "derived",
          text: "اطلاعات بایکر در صفحه Registered Bikers نمایش داده می‌شود",
        },
        {
          key: "AC-04",
          origin: "derived",
          text: "کاربر بتواند ثبت یا نمایش وضعیت خطا در صورت ناموفق بودن فعال‌سازی احراز هویت",
        },
        {
          key: "AC-05",
          origin: "derived",
          text: "اگر فعال‌سازی احراز هویت ناموفق بود، خطا باید به‌صورت قابل پیگیری ثبت یا نمایش داده شود",
        },
        {
          key: "AC-06",
          origin: "derived",
          text: "تغییرات جدید نباید باعث اختلال در فرآیند فعلی Approve و Active کردن بایکر شود",
        },
      ],
    });
    const linked = new Set(result.testCases.flatMap((item) => item.relatedAcceptanceCriteria));
    expect(linked).toEqual(new Set(["AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06"]));
    const visibility = result.testCases.filter((item) =>
      item.relatedAcceptanceCriteria.includes("AC-01"),
    );
    expect(visibility).toHaveLength(1);
    expect(visibility[0].relatedAcceptanceCriteria).toEqual(expect.arrayContaining(["AC-01", "AC-03"]));
    expect(result.testCases.length).toBeGreaterThanOrEqual(5);
    expect(result.testCases.length).toBeLessThan(6);
    for (const testCase of result.testCases) {
      expect(testCase.title).not.toMatch(/^AC-\d+/);
      expect(testCase.steps.join("\n")).not.toMatch(/این کار را انجام دهید/);
    }
  });

  it("does not treat an approved or manually edited case as replaceable", () => {
    expect(isLockedDesign("APPROVED", false)).toBe(true);
    expect(isLockedDesign("AI_DRAFT", true)).toBe(true);
    expect(isLockedDesign("MANUALLY_EDITED", false)).toBe(true);
    expect(isLockedDesign("AI_DRAFT", false)).toBe(false);
    expect(isLockedDesign("DRAFT_REQUIRES_REVIEW", false)).toBe(false);
  });

  describe("identity and traceability", () => {
    const base = {
      locale: "en" as const,
      title: "Order cancellation",
      description: "",
      acceptanceCriteria: [
        { key: "AC-01", origin: "cleaned" as const, text: "User can cancel an order before shipping" },
        { key: "AC-02", origin: "cleaned" as const, text: "Cancelled orders are refunded to the original card" },
      ],
    };

    it("keeps condition keys stable when a criterion is inserted before others", () => {
      const before = runQaPipeline(base);
      const after = runQaPipeline({
        ...base,
        acceptanceCriteria: [
          { key: "AC-01", origin: "cleaned", text: "Admins can see every order in the dashboard list" },
          { ...base.acceptanceCriteria[0]!, key: "AC-02" },
          { ...base.acceptanceCriteria[1]!, key: "AC-03" },
        ],
      });
      const keysAfter = new Set(after.testCases.map((item) => item.conditionKey));
      for (const item of before.testCases) expect(keysAfter.has(item.conditionKey)).toBe(true);
    });

    it("produces the same condition keys regardless of generation language", () => {
      const en = runQaPipeline(base).testCases.map((item) => item.conditionKey).sort();
      const fa = runQaPipeline({ ...base, locale: "fa" }).testCases.map((item) => item.conditionKey).sort();
      expect(fa).toEqual(en);
    });

    it("gives every case a unique condition key", () => {
      const keys = runQaPipeline(base).testCases.map((item) => item.conditionKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("reports each gap once", () => {
      const result = runQaPipeline({
        ...base,
        description: "POST /orders rejects invalid payload",
        acceptanceCriteria: [],
      });
      const ids = result.gaps.map((gap) => gap.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("flags weak generic wording for review", () => {
      const gated = applyQualityGate(
        {
          ...runQaPipeline(base).testCases[0]!,
          designStatus: "AI_DRAFT",
          steps: ["Open the order page"],
          stepExpectations: ["The page opens"],
          expectedResult: "The result is correct",
        },
        [],
      );
      expect(gated.designStatus).toBe("DRAFT_REQUIRES_REVIEW");
      expect(gated.assumptions).toContain("generic expected result");
    });
  });
});
