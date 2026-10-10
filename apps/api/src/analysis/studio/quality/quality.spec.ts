import type { NormalizedTestCase } from "@qa-workbench/shared";
import type { StudioUnderstanding } from "../pipeline";
import type { GeneratedCase } from "../schemas";
import { DEFAULT_QUALITY_CONFIG, qualityLevel, resolveQualityConfig } from "./config";
import { evaluateSet } from "./evaluate";
import { normalizeCases, ProviderCasesSchema } from "./normalize";
import { evaluateProvider, qualityGate, selectAndMerge, type ProviderRun } from "./select";
import { analyzeTask, effectiveWeights } from "./task-profile";

/** A login API: validation, limits, states, auth — most dimensions apply. */
const understanding = {
  summary: "Users log in with email and password; the account locks after 5 failed attempts.",
  rules: [
    { text: "If the password is wrong, the API answers 401.", evidence: "", source: "issue", id: "R1", grounded: true },
    { text: "If 5 attempts fail, the account status becomes LOCKED.", evidence: "", source: "issue", id: "R2", grounded: true },
    { text: "Email is required and must be a valid format.", evidence: "", source: "issue", id: "R3", grounded: true },
  ],
  apis: [{ method: "POST", path: "/auth/login", purpose: "log in", request: '{"email","password"}', responses: ["200 token", "400 invalid email", "401 wrong password", "423 locked"], auth: "" }],
  states: [{ name: "ACTIVE", meaning: "" }, { name: "LOCKED", meaning: "" }],
  transitions: [{ from: "ACTIVE", to: "LOCKED", trigger: "5 failed attempts", conditions: "" }],
  calculations: [],
  configurations: [{ key: "max_attempts", meaning: "5" }],
  flows: [{ name: "login", steps: ["enter email", "enter password", "submit"] }],
  entities: [],
  actors: [{ name: "User", description: "" }],
  integrations: [],
  nonFunctional: [],
  assumptions: [],
  outOfScope: [],
} as unknown as StudioUnderstanding;

const requirements = [
  { key: "AC-1", text: "A user with a valid email and password receives a token (200).", category: "happy_path" },
  { key: "AC-2", text: "When the email is empty or invalid, login is rejected with 400.", category: "validation" },
  { key: "AC-3", text: "After 5 failed attempts the account becomes LOCKED and login answers 423.", category: "state" },
];
const corpus = "POST /auth/login email password 200 token 400 invalid email 401 wrong password 423 locked 5 failed attempts LOCKED ACTIVE max_attempts";
const profile = analyzeTask({ understanding, requirements, corpus });

const raw = (over: Partial<GeneratedCase>): GeneratedCase => ({
  criterionKeys: ["AC-1"],
  ruleRefs: [],
  title: "Login with valid credentials returns a token",
  objective: "",
  preconditions: ["User u1@example.com exists and is ACTIVE"],
  testData: ['{"email":"u1@example.com","password":"Secret#1"}'],
  steps: [{ action: "POST /auth/login with the test data", expected: "Status 200 with a token field" }],
  expectedResult: "Response 200; body contains a non-empty token",
  priority: "HIGH",
  type: "FUNCTIONAL",
  technique: "",
  ...over,
});

const positive = raw({});
const invalidEmail = raw({
  criterionKeys: ["AC-2"],
  ruleRefs: ["R3"],
  title: "Login with an invalid email format is rejected",
  testData: ['{"email":"not-an-email","password":"Secret#1"}'],
  steps: [{ action: "POST /auth/login with email not-an-email", expected: "Status 400" }],
  expectedResult: "Response 400; no token is issued",
  type: "NEGATIVE",
  technique: "Equivalence Partitioning",
});
const lockout = raw({
  criterionKeys: ["AC-3"],
  ruleRefs: ["R2"],
  title: "Fifth failed attempt locks the account (boundary 5)",
  testData: ['{"email":"u1@example.com","password":"wrong"}'],
  steps: [
    { action: "POST /auth/login with a wrong password 4 times", expected: "Status 401 each time; status stays ACTIVE" },
    { action: "POST /auth/login with a wrong password a 5th time", expected: "Status 401; account status becomes LOCKED" },
    { action: "POST /auth/login with the right password", expected: "Status 423" },
  ],
  expectedResult: "Account status changes from ACTIVE to LOCKED after exactly 5 failures; login answers 423",
  type: "BOUNDARY",
  technique: "BVA, state transition",
});
const run = (provider: string, cases: GeneratedCase[], status: ProviderRun["status"] = "ok"): ProviderRun => ({
  provider,
  name: provider,
  model: "m",
  status,
  processingMs: 100,
  cases: normalizeCases(cases, provider, profile),
});

describe("task analysis", () => {
  it("finds the applicable ISTQB techniques and dimensions from the requirement", () => {
    const techniques = profile.techniques.map((entry) => entry.technique);
    expect(techniques).toEqual(expect.arrayContaining(["Equivalence Partitioning", "Boundary Value Analysis", "State Transition Testing", "Use Case Testing"]));
    expect(profile.applicable).toMatchObject({ negativeScenarios: true, boundaryValueAnalysis: true, stateTransition: true, errorHandling: true, performance: false });
    expect(profile.errorCodes).toEqual(["400", "401", "423"]);
  });

  it("does not require or penalise anything for a UI text change with no applicable technique", () => {
    const ui = analyzeTask({
      understanding: { ...understanding, rules: [{ id: "R1", text: "The save button reads 'Save changes'.", evidence: "", source: "issue", grounded: true }], apis: [], states: [], transitions: [], configurations: [], flows: [], actors: [] } as unknown as StudioUnderstanding,
      requirements: [{ key: "AC-1", text: "The save button label reads 'Save changes'.", category: "ui" }],
      corpus: "The save button label reads 'Save changes'.",
    });
    expect(ui.techniques).toEqual([]);
    expect(ui.applicable).toMatchObject({ performance: false, security: false, boundaryValueAnalysis: false, stateTransition: false, negativeScenarios: false });
    const [item] = normalizeCases(
      [raw({ title: "Save button shows the new label", testData: [], preconditions: ["The settings page is open"], steps: [{ action: "Open the settings page", expected: "The button reads 'Save changes'" }], expectedResult: "The save button label is exactly 'Save changes'" })],
      "p",
      ui,
    );
    expect(item!.testDesignTechniques).toEqual([]);
    const evaluation = evaluateSet([item!], ui);
    expect(evaluation.istqbCoverage).toBeNull();
    expect(evaluation.dimensionScores.performance).toBeNull();
    expect(evaluation.overallScore).toBeGreaterThanOrEqual(90);
  });

  it("redistributes weights: non-applicable groups drop out, task kinds shift emphasis, the sum stays 100", () => {
    const sum = (weights: Record<string, number | undefined>) => Object.values(weights).reduce((total: number, value) => total + (value ?? 0), 0);
    expect(sum(profile.weights)).toBeCloseTo(100, 6);
    expect(profile.weights.performance).toBeUndefined();
    const all = Object.fromEntries(Object.keys(profile.applicable).map((key) => [key, true])) as typeof profile.applicable;
    const plain = effectiveWeights(all, []);
    const payment = effectiveWeights(all, ["payment"]);
    expect(sum(plain)).toBeCloseTo(100, 6);
    expect(sum(payment)).toBeCloseTo(100, 6);
    expect(plain.requirementCoverage).toBeCloseTo(15, 6);
    expect(payment.businessRules!).toBeGreaterThan(plain.businessRules!);
    expect(payment.security!).toBeGreaterThan(plain.security!);
  });

  it("uses configurable quality levels", () => {
    expect(qualityLevel(87)).toBe("Very Good");
    expect(qualityLevel(59)).toBe("Poor");
    const strict = resolveQualityConfig({ levels: [{ level: "Excellent", min: 95 }, { level: "Very Good", min: 88 }] });
    expect(qualityLevel(90, strict)).toBe("Very Good");
    // An unordered set of thresholds is ignored.
    expect(resolveQualityConfig({ levels: [{ level: "Excellent", min: 10 }, { level: "Very Good", min: 50 }] }).levels).toEqual(DEFAULT_QUALITY_CONFIG.levels);
  });
});

describe("normalization", () => {
  it("accepts other providers' shapes and vocabularies (malformed for the studio schema)", () => {
    const parsed = ProviderCasesSchema.parse({
      test_cases: [
        {
          name: "Invalid email is rejected",
          requirement_ids: "AC-2",
          severity: "P1",
          test_type: "Negative Test",
          steps: "1. POST /auth/login with email x\n2. Read the response",
          expected_results: ["Status 400", "No token"],
          testDesignTechniques: ["Equivalence Partitioning"],
        },
        "garbage",
      ],
    });
    expect(parsed.testCases[0]).toMatchObject({
      title: "Invalid email is rejected",
      criterionKeys: ["AC-2"],
      priority: "HIGH",
      type: "NEGATIVE",
      steps: [{ action: "POST /auth/login with email x" }, { action: "Read the response" }],
      expectedResult: "Status 400\nNo token",
      technique: "Equivalence Partitioning",
    });
    // A bare list and an unknown wrapper are understood too; nonsense becomes an empty answer.
    expect(ProviderCasesSchema.parse([{ title: "t", steps: ["a"] }]).testCases).toHaveLength(1);
    expect(ProviderCasesSchema.parse({ data: { cases: [{ title: "t" }] } }).testCases).toHaveLength(1);
    expect(ProviderCasesSchema.parse("not json at all").testCases).toEqual([]);
  });

  it("is deterministic: same input → same ids, order, techniques and scores; ids do not depend on the provider", () => {
    const a = normalizeCases([lockout, invalidEmail, positive], "A", profile);
    const b = normalizeCases([lockout, invalidEmail, positive], "B", profile);
    expect(a.map((item) => item.id)).toEqual(b.map((item) => item.id));
    expect(a.map((item) => item.requirementIds[0])).toEqual(["AC-1", "AC-2", "AC-3"]);
    expect(normalizeCases([lockout, invalidEmail, positive], "A", profile)).toEqual(a);
    const lock = a.find((item) => item.requirementIds[0] === "AC-3")!;
    expect(lock.testDesignTechniques).toEqual(expect.arrayContaining(["Boundary Value Analysis", "State Transition Testing"]));
    expect(lock.priority).toBe("Critical");
    expect(a.find((item) => item.requirementIds[0] === "AC-2")!.testDesignTechniques).toContain("Equivalence Partitioning");
  });
});

describe("provider scoring and selection", () => {
  it("scores a single provider on the 0–100 scale with level, coverage and findings", () => {
    const scored = evaluateProvider(run("A", [positive, invalidEmail, lockout]), profile);
    expect(scored.report.overallScore).toBeGreaterThanOrEqual(0);
    expect(scored.report.overallScore).toBeLessThanOrEqual(100);
    expect(scored.report.requirementCoverage).toBe(100);
    expect(scored.report.qualityLevel).toBe(qualityLevel(scored.report.overallScore));
    expect(scored.report.dimensionScores.performance).toBeNull();
    const selection = selectAndMerge([scored], profile);
    expect(selection.reasons[0]).toMatchObject({ code: "singleProvider" });
    expect(selection.cases).toHaveLength(3);
  });

  it("scores a low-quality provider low and rejects its vague cases at the gate", () => {
    const vague = raw({ title: "Login works", preconditions: [], testData: [], steps: [{ action: "check", expected: "" }], expectedResult: "works correctly" });
    const scored = evaluateProvider(run("Weak", [vague]), profile);
    expect(scored.report.overallScore).toBeLessThan(60);
    expect(scored.report.qualityLevel).toBe("Poor");
    expect(scored.report.weaknesses.length).toBeGreaterThan(0);
    const gate = qualityGate(scored.cases, profile);
    expect(gate.cases).toHaveLength(0);
    expect(gate.rejected[0]!.reasons).toEqual(expect.arrayContaining(["vagueSteps"]));
  });

  it("removes duplicate cases inside one provider and counts them", () => {
    const twin = { ...positive, title: "Login with valid credentials returns a token!" };
    const scored = evaluateProvider(run("A", [positive, twin, invalidEmail]), profile);
    expect(scored.report.duplicateCount).toBe(1);
    expect(selectAndMerge([scored], profile).cases).toHaveLength(2);
  });

  it("identical provider outputs: one set, both providers credited, nothing added twice", () => {
    const a = evaluateProvider(run("A", [positive, invalidEmail, lockout]), profile);
    const b = evaluateProvider(run("B", [positive, invalidEmail, lockout]), profile);
    const selection = selectAndMerge([a, b], profile);
    expect(selection.cases).toHaveLength(3);
    expect(selection.cases.every((item) => item.sourceProviders.length === 2)).toBe(true);
    expect(selection.merged).toEqual([{ provider: "B", added: 0 }]);
  });

  it("complementary providers: the base keeps its strengths and gains the other's unique high-quality scenarios", () => {
    // A: strong functional tests, no negative ones. B: negative and boundary tests, plus a weak one.
    const a = evaluateProvider(run("A", [positive, raw({ criterionKeys: ["AC-2"], title: "Login with a well-formed email succeeds", testData: ['{"email":"a.b@example.com","password":"Secret#1"}'] }), raw({ criterionKeys: ["AC-3"], title: "An active account logs in", steps: [{ action: "POST /auth/login with an ACTIVE account", expected: "Status 200" }] })]), profile);
    const weak = raw({ criterionKeys: ["AC-2"], title: "Errors", preconditions: [], testData: [], steps: [{ action: "try", expected: "" }], expectedResult: "handled properly" });
    const b = evaluateProvider(run("B", [invalidEmail, lockout, weak]), profile);
    const selection = selectAndMerge([a, b], profile);
    const titles = selection.cases.map((item) => item.title);
    expect(titles).toEqual(expect.arrayContaining([positive.title, invalidEmail.title, lockout.title]));
    expect(titles).not.toContain("Errors");
    expect(selection.lowQualityFiltered).toBeGreaterThan(0);
    expect(selection.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["merged"]));
    const merged = evaluateSet(selection.cases, profile);
    expect(merged.overallScore).toBeGreaterThan(Math.max(a.evaluation.overallScore, b.evaluation.overallScore));
    expect(merged.negativeCoverage).toBeGreaterThan(a.evaluation.negativeCoverage!);
  });

  it("does not pick the highest raw score blindly: requirement coverage decides first", () => {
    // B scores higher on its few cases but covers fewer requirements.
    const a = evaluateProvider(run("A", [positive, invalidEmail, raw({ criterionKeys: ["AC-3"], title: "Account locks", preconditions: [], steps: [{ action: "Fail login 5 times", expected: "" }], expectedResult: "LOCKED" })]), profile);
    const b = evaluateProvider(run("B", [positive, lockout]), profile);
    expect(a.evaluation.requirementCoverage).toBeGreaterThan(b.evaluation.requirementCoverage);
    expect(selectAndMerge([a, b], profile).base!.name).toBe("A");
  });

  it("treats close providers as a tie and still merges the runner-up's unique scenarios", () => {
    const a = evaluateProvider(run("A", [positive, invalidEmail, lockout]), profile);
    const extra = raw({ criterionKeys: ["AC-2"], ruleRefs: ["R3"], title: "Login with an empty email is rejected", testData: ['{"email":"","password":"Secret#1"}'], steps: [{ action: "POST /auth/login with an empty email", expected: "Status 400" }], expectedResult: "Response 400; no token", type: "NEGATIVE" });
    const b = evaluateProvider(run("B", [positive, invalidEmail, lockout, extra]), profile);
    const selection = selectAndMerge([a, b], profile, { ...DEFAULT_QUALITY_CONFIG, closeEnough: 100 });
    expect(selection.cases.map((item) => item.title)).toContain(extra.title);
  });

  it("final quality gate improves what it can and rejects untraceable or irrelevant cases", () => {
    const [noFinal, untraced, offTopic] = normalizeCases(
      [
        raw({ expectedResult: "", steps: [{ action: "POST /auth/login with the test data", expected: "Status 200 with a token field" }] }),
        raw({ criterionKeys: [], title: "Wrong password is rejected with 401", steps: [{ action: "POST /auth/login with a wrong password", expected: "Status 401" }], expectedResult: "Response 401" }),
        raw({ criterionKeys: [], title: "Weather widget shows tomorrow", preconditions: ["Weather widget enabled"], testData: [], steps: [{ action: "Open the weather widget", expected: "Forecast for tomorrow displayed" }], expectedResult: "Forecast for tomorrow is displayed" }),
      ].map((item, index) => ({ ...item, title: `${item.title} ${index}` })),
      "A",
      profile,
    );
    const gate = qualityGate([noFinal!, untraced!, offTopic!].filter(Boolean), profile);
    expect(gate.improved).toBeGreaterThanOrEqual(1);
    const kept = gate.cases.find((item) => item.title.startsWith("Login with valid"));
    expect(kept!.expectedResults).toEqual(["Status 200 with a token field"]);
    expect(gate.rejected.map((item) => item.title)).toContain("Weather widget shows tomorrow 2");
    expect(gate.untracedRequirements).toEqual(expect.arrayContaining(["AC-3"]));
  });

  it("skips failed and timed-out providers and says so", () => {
    const a = evaluateProvider(run("A", [positive, invalidEmail, lockout]), profile);
    const down = evaluateProvider({ ...run("B", []), status: "timeout" }, profile);
    const selection = selectAndMerge([a, down], profile);
    expect(selection.base!.name).toBe("A");
    expect(selection.reasons).toEqual(expect.arrayContaining([{ code: "providerUnavailable", values: { provider: "B", status: "timeout" } }]));
  });

  it("scores the same cases the same every time", () => {
    const cases: NormalizedTestCase[] = normalizeCases([positive, invalidEmail, lockout], "A", profile);
    expect(evaluateSet(cases, profile)).toEqual(evaluateSet(cases, profile));
  });
});
