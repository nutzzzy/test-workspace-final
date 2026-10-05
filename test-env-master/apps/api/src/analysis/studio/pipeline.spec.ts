import type { StageGroup } from "../../ai/ai.service";
import { chunk, isGrounded, runStudio, type StudioLlm, type StudioSource } from "./pipeline";

/** A scripted model: answers by stage, records which group (connection route) was asked and the prompts. */
function scripted(answers: Partial<Record<string, unknown | ((prompt: string) => unknown)>>, failing: string[] = []) {
  const calls: Array<{ group: StageGroup; stage: string; prompt: string }> = [];
  const llm: StudioLlm = async (group, stage, call) => {
    calls.push({ group, stage, prompt: call.prompt });
    if (failing.includes(stage)) throw new Error(`${stage} model unavailable`);
    const answer = answers[stage];
    const data = typeof answer === "function" ? (answer as (prompt: string) => unknown)(call.prompt) : (answer ?? {});
    return { data: call.schema.parse(data), origin: { connectionId: group, name: group, model: "m" } };
  };
  return { llm, calls };
}

/** Shaped like the TEST 2 issue: Persian/English mix, tables, flows, APIs, no written AC. */
const NFC: StudioSource = {
  issueKey: "TEST-2",
  title: "Need For Call (Accounting)",
  description: [
    "برای نیازمندی تماس مربوط به مشکلات حساب کاربری، لازم است هنگام ثبت درخواست، امکان انتخاب Reason و Sub Reason فراهم شود.",
    "Description Rules: اگر Reason برابر Other باشد، ارسال Description الزامی است.",
    "Duplicate Request: برای همان بایکر، درخواست بازی با همان Reason/Sub Reason وجود داشته باشد، درخواست جدید ایجاد نشود.",
    "Active Trip: اگر بایکر سفر فعال داشته باشد، امکان ثبت درخواست وجود ندارد.",
    "Score = | P - (Tc / 60) | — هرچه مقدار Score کوچکتر باشد، اولویت Assign شدن بیشتر است.",
    "POST /mobile/need-for-call/accounting/create Response 200, 400",
  ].join("\n\n"),
  criteria: [
    { key: "AC-01", text: "کاربر بتواند created_at DATETIME زمان ایجاد", origin: "derived" },
  ],
  documents: [],
};

const understanding = {
  summary: "بایکر برای مشکلات حساب کاربری درخواست تماس با Reason ثبت می‌کند و Agentها به ترتیب امتیاز آن را رسیدگی می‌کنند.",
  rules: [
    { text: "اگر Reason برابر Other باشد Description الزامی است.", evidence: "اگر Reason برابر Other باشد، ارسال Description الزامی است", source: "issue" },
    { text: "درخواست تکراری باز با همان Reason ایجاد نمی‌شود.", evidence: "درخواست جدید ایجاد نشود", source: "issue" },
    { text: "با سفر فعال درخواست ثبت نمی‌شود.", evidence: "اگر بایکر سفر فعال داشته باشد", source: "issue" },
  ],
  apis: [{ method: "POST", path: "/mobile/need-for-call/accounting/create", responses: ["200", "400"] }],
  calculations: [{ name: "assignment_score", formula: "Score = | P - (Tc / 60) |" }],
};

const criteria = {
  criteria: [
    { text: "وقتی Reason برابر Other و Description خالی است، ایجاد درخواست با 400 رد می‌شود.", category: "validation", evidence: "اگر Reason برابر Other باشد، ارسال Description الزامی است", ruleRefs: ["R1"], confidence: "HIGH" },
    { text: "وقتی درخواست باز با همان Reason وجود دارد، درخواست جدید ایجاد نمی‌شود.", category: "data_integrity", evidence: "درخواست جدید ایجاد نشود", ruleRefs: ["R2"], confidence: "HIGH" },
    { text: "درخواست ظرف ۵ دقیقه به Agent تخصیص داده می‌شود.", category: "integration", evidence: "within five minutes", confidence: "HIGH" },
  ],
};

const caseFor = (key: string, title: string) => ({
  criterionKeys: [key],
  title,
  objective: "",
  preconditions: ["بایکر وارد شده است."],
  testData: ['{"reasonId": 5}'],
  steps: [{ action: "POST /mobile/need-for-call/accounting/create را بدون description بفرستید.", expected: "پاسخ 400 برمی‌گردد." }],
  expectedResult: "هیچ رکوردی در need_for_call_accounting ساخته نمی‌شود.",
  priority: "HIGH",
  type: "NEGATIVE",
});

const answers = {
  understand: understanding,
  criteria,
  assessment: {
    gaps: [{ text: "متن پیام خطای درخواست تکراری مشخص نیست.", severity: "MEDIUM" }],
    questions: [{ question: "پیام خطای درخواست تکراری چیست؟", category: "product", reason: "برای assert لازم است" }],
    risks: [{ description: "ثبت هم‌زمان دو درخواست ممکن است تکرار بسازد.", impact: "HIGH", likelihood: "MEDIUM", releaseBlocking: true }],
    strategy: { scope: "API ایجاد و تخصیص درخواست", testTypes: ["API"] },
  },
  cases: (prompt: string) => ({
    testCases: [...prompt.matchAll(/"key":"(AI-\d+)"/g)].map((match) => caseFor(match[1]!, `آزمون ${match[1]}`)),
  }),
  edges: { edgeCases: [{ title: "دو Agent هم‌زمان Start کنند", scenario: "دو Agent در یک لحظه صف را Start می‌کنند.", severity: "HIGH" }] },
  review: {
    criteria: [{ key: "AI-03", verdict: "drop", reason: "در متن نیست" }],
    // Index 0 is the case of AI-01 — the original position, before AI-03's case is dropped.
    testCases: [{ index: 0, verdict: "fix", title: "رد ایجاد درخواست Other بدون Description", reason: "عنوان مبهم بود" }],
    edgeCases: [],
  },
  automation: (prompt: string) => ({
    items: [...prompt.matchAll(/"index":(\d+)/g)].map((match) => ({ index: Number(match[1]), suitability: "HIGH", layer: "API", rationale: "بررسی قطعی API" })),
  }),
};

const all = ["understand", "criteria", "assessment", "cases", "edges", "translate", "review", "automation"] as const;

describe("analysis studio pipeline", () => {
  it("derives criteria for an issue without written AC, grounded in the text, and replaces rule-derived junk", async () => {
    const { llm, calls } = scripted(answers);
    const result = await runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000 });

    expect(calls.find((call) => call.stage === "criteria")!.prompt).toContain("NO written acceptance criteria");
    // The old rule-derived row is not treated as a written criterion.
    expect(calls.find((call) => call.stage === "criteria")!.prompt).not.toContain("created_at DATETIME");
    expect(result.understanding!.rules.map((rule) => rule.id)).toEqual(["R1", "R2", "R3"]);
    expect(result.understanding!.rules.every((rule) => rule.grounded)).toBe(true);

    // The invented "5 minutes" criterion: ungrounded → LOW, then dropped by the review.
    expect(result.proposed!.map((item) => item.key)).toEqual(["AI-01", "AI-02"]);
    expect(result.dropped.criteria).toBe(1);
    expect(result.proposed![0]).toMatchObject({ grounded: true, confidence: "HIGH" });

    // Review fixes are applied to the right case, and the dropped criterion's case goes with it.
    expect(result.cases!.map((item) => item.criterionKeys[0])).toEqual(["AI-01", "AI-02"]);
    expect(result.cases![0]).toMatchObject({ title: "رد ایجاد درخواست Other بدون Description", reviewNote: "عنوان مبهم بود" });
    expect(result.automation!.map((item) => item.caseIndex)).toEqual([0, 1]);
    expect(result.assessment!.risks[0]!.releaseBlocking).toBe(true);
    expect(result.edges).toHaveLength(1);
  });

  it("routes stages to their own connection groups and lets a stage fail without losing the rest", async () => {
    const { llm, calls } = scripted(answers, ["edges"]);
    const result = await runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000 });
    const groups = Object.fromEntries(calls.map((call) => [call.stage, call.group]));
    expect(groups).toMatchObject({ understand: "analysis", criteria: "analysis", cases: "testCases", edges: "edgeCases", review: "review", automation: "automation" });
    expect(result.errors.edges).toMatch(/edges model unavailable/);
    expect(result.edges).toBeNull();
    expect(result.cases!.length).toBeGreaterThan(0);
  });

  it("stops when the requirement cannot be understood: nothing else is generated from nothing", async () => {
    const { llm } = scripted(answers, ["understand"]);
    await expect(runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000 })).rejects.toThrow(/understand/);
  });

  it("only complements written criteria and reports problems in them", async () => {
    const { llm, calls } = scripted({
      ...answers,
      criteria: { criteria: [], writtenIssues: [{ key: "AC-1", problem: "قابل آزمون نیست", suggestion: "نتیجه را مشخص کنید" }, { key: "AC-9", problem: "x" }] },
    });
    const source = { ...NFC, criteria: [{ key: "AC-1", text: "سیستم باید سریع باشد", origin: "imported" }] };
    const result = await runStudio({ source, locale: "fa", stages: ["understand", "criteria"], llm, guidance: () => "", budgetChars: 50_000 });
    expect(calls.find((call) => call.stage === "criteria")!.prompt).toContain("Do NOT repeat or reword them");
    // Only issues about criteria that exist are kept.
    expect(result.writtenIssues).toEqual([{ key: "AC-1", problem: "قابل آزمون نیست", suggestion: "نتیجه را مشخص کنید" }]);
  });

  it("condenses a source that does not fit the model's context, and translates only across languages", async () => {
    const big = { ...NFC, documents: [{ title: "PRD", text: Array.from({ length: 40 }, (_, i) => `Section ${i}: ${"rule text ".repeat(60)}`).join("\n\n") }] };
    const { llm, calls } = scripted({ ...answers, digest: { notes: [{ kind: "rule", text: "note", evidence: "rule text" }] } });
    await runStudio({ source: big, locale: "en", stages: ["understand", "translate"], llm, guidance: () => "", budgetChars: 8_000 });
    expect(calls.filter((call) => call.stage === "digest").length).toBeGreaterThan(1);
    expect(calls.find((call) => call.stage === "understand")!.prompt).toContain("NOTES EXTRACTED FROM THE FULL MATERIAL");
    // A mostly-Persian issue analysed in English is translated for display; in Persian it is not.
    expect(calls.some((call) => call.stage === "translate")).toBe(true);
    const persian = scripted(answers);
    await runStudio({ source: NFC, locale: "fa", stages: ["understand", "translate"], llm: persian.llm, guidance: () => "", budgetChars: 50_000 });
    expect(persian.calls.some((call) => call.stage === "translate")).toBe(false);
  });

  it("puts learned guidance into the stage it belongs to, after the shared context", async () => {
    const { llm, calls } = scripted(answers);
    await runStudio({
      source: NFC,
      locale: "fa",
      stages: ["understand", "criteria", "cases"],
      llm,
      guidance: (scope) => (scope === "testCases" ? "TEAM GUIDELINES:\n- Titles start with the endpoint." : ""),
      budgetChars: 50_000,
    });
    const casesPrompt = calls.find((call) => call.stage === "cases")!.prompt;
    expect(casesPrompt).toContain("Titles start with the endpoint");
    expect(casesPrompt.indexOf("<source>")).toBeLessThan(casesPrompt.indexOf("TEAM GUIDELINES"));
    expect(calls.find((call) => call.stage === "criteria")!.prompt).not.toContain("Titles start with the endpoint");
    // Every stage shares the same prefix (prompt-cache friendly).
    const prefix = calls[0]!.prompt.slice(0, calls[0]!.prompt.indexOf("</source>"));
    expect(calls.every((call) => call.prompt.startsWith(prefix))).toBe(true);
  });

  it("checks quotes against the source and splits long text on paragraphs", () => {
    expect(isGrounded("ارسال Description الزامی است", NFC.description)).toBe(true);
    expect(isGrounded("within five minutes", NFC.description)).toBe(false);
    const parts = chunk("a".repeat(50) + "\n\n" + "b".repeat(50) + "\n\n" + "c".repeat(50), 110);
    expect(parts).toHaveLength(2);
  });
});
