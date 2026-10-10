import type { StageGroup } from "../../ai/ai.service";
import { chunk, isGrounded, runStudio, type StudioLlm, type StudioResult, type StudioSource } from "./pipeline";
import { DEFAULT_QUALITY_CONFIG } from "./quality/config";

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

  it("finishes within the run's time limit: a slow stage is skipped, finished stages are kept", async () => {
    const { llm: fast } = scripted(answers);
    const seenDeadlines: Record<string, number | undefined> = {};
    // The edge-case model hangs until its stage deadline, like a slow model that never answers.
    const llm: StudioLlm = async (group, stage, call) => {
      seenDeadlines[stage] = call.deadlineAt;
      if (stage === "edges") {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, call.deadlineAt! - Date.now())));
        throw new Error("The model did not answer in time");
      }
      return fast(group, stage, call);
    };
    const started = Date.now();
    const result = await runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000, deadline: started + 1_500 });

    expect(Date.now() - started).toBeLessThan(1_700);
    expect(result.cases!.length).toBeGreaterThan(0);
    expect(result.assessment).not.toBeNull();
    expect(result.edges).toBeNull();
    expect(result.errors.edges).toBe("The analysis reached its time limit");
    // Each stage gets a deadline inside the run's limit, earlier stages earlier.
    expect(seenDeadlines.understand!).toBeLessThan(seenDeadlines.cases!);
    expect(seenDeadlines.automation!).toBeLessThanOrEqual(started + 1_500);
  });

  it("does not start a stage whose share of the time is already used up", async () => {
    const { llm, calls } = scripted(answers);
    await expect(runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000, deadline: Date.now() - 1 })).rejects.toThrow(
      "The analysis reached its time limit",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("answer shapes", () => {
  it("accepts a single value where a list was asked", async () => {
    const { CasesSchema } = await import("./schemas");
    const parsed = CasesSchema.parse({
      testCases: [{ criterionKeys: "AC-01", title: "t", preconditions: "بایکر وارد شده است.", steps: [{ action: "a", expected: "e" }], expectedResult: "r" }],
    });
    expect(parsed.testCases[0]).toMatchObject({ criterionKeys: ["AC-01"], preconditions: ["بایکر وارد شده است."] });
  });
});

describe("test-case quality across providers", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Every stage answers from the script; the cases stage answers per provider (connection). */
  function providers(behaviour: Record<string, (prompt: string, call: { signal?: AbortSignal; deadlineAt?: number }) => Promise<unknown>>) {
    const { llm: base } = scripted(answers);
    const inFlight = new Set<string>();
    let overlapSeen = 0;
    const llm: StudioLlm = async (group, stage, call) => {
      if (stage !== "cases" || !call.connectionId) return base(group, stage, call);
      inFlight.add(call.connectionId);
      overlapSeen = Math.max(overlapSeen, inFlight.size);
      try {
        const data = await behaviour[call.connectionId]!(call.prompt, call);
        return { data: call.schema.parse(data), origin: { connectionId: call.connectionId, name: call.connectionId, model: "m" } };
      } finally {
        inFlight.delete(call.connectionId);
      }
    };
    return { llm, overlap: () => overlapSeen };
  }
  const good = async (prompt: string) => {
    await sleep(80);
    return answers.cases(prompt);
  };
  /** Another provider's shape for the same scenarios (snake_case keys, steps as text, P1 priority). */
  const otherShape = async (prompt: string) => {
    await sleep(80);
    return {
      test_cases: [...prompt.matchAll(/"key":"(AI-\d+)"/g)].map((match) => ({
        name: `Reject request without description for ${match[1]}`,
        requirement_ids: match[1],
        severity: "P1",
        test_type: "Negative",
        preconditions: "بایکر وارد شده است.",
        test_data: '{"reasonId": 5}',
        steps: "1. POST /mobile/need-for-call/accounting/create را بدون description بفرستید.",
        expected: "پاسخ 400 برمی‌گردد و رکوردی در need_for_call_accounting ساخته نمی‌شود.",
      })),
    };
  };
  const hang = (_prompt: string, call: { signal?: AbortSignal; deadlineAt?: number }) =>
    new Promise((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => reject(new Error("AI analysis was cancelled")));
      if (call.deadlineAt) setTimeout(() => reject(new Error("The model did not answer in time")), Math.max(0, call.deadlineAt - Date.now()));
    });
  const three = [
    { id: "A", name: "A", model: "m" },
    { id: "B", name: "B", model: "m" },
    { id: "C", name: "C", model: "m" },
  ];

  it("single provider: the route's answer is normalized, scored and gated, with timings", async () => {
    const { llm } = scripted(answers);
    const result = await runStudio({ source: NFC, locale: "fa", stages: [...all], llm, guidance: () => "", budgetChars: 50_000 });
    const quality = result.quality!;
    expect(quality.providers).toHaveLength(1);
    expect(quality.providers[0]).toMatchObject({ provider: "default", status: "ok" });
    expect(quality.selection.reasons[0]!.code).toBe("singleProvider");
    expect(quality.final!.overallScore).toBeGreaterThan(0);
    expect(quality.final!.overallScore).toBeLessThanOrEqual(100);
    // The criterion the review dropped is no longer a requirement of the final report.
    expect(quality.final!.untracedRequirements).not.toContain("AI-03");
    expect(Object.keys(quality.timing)).toEqual(
      expect.arrayContaining(["taskParsingMs", "requirementExtractionMs", "providers", "normalizationMs", "scoringMs", "deduplicationMs", "selectionMs", "qualityGateMs", "totalMs"]),
    );
    // Final cases keep the stored test-case contract and carry their ISTQB techniques.
    expect(result.cases!.every((item) => typeof item.technique === "string" && item.criterionKeys.length > 0)).toBe(true);
  });

  it("runs providers at the same time, normalizes a different answer shape, and survives a failing provider", async () => {
    const { llm, overlap } = providers({
      A: good,
      B: otherShape,
      C: async () => {
        throw new Error("C is down");
      },
    });
    const reports: Array<NonNullable<StudioResult["quality"]>> = [];
    const started = Date.now();
    const result = await runStudio({
      source: NFC,
      locale: "fa",
      stages: ["understand", "criteria", "assessment", "cases"],
      llm,
      guidance: () => "",
      budgetChars: 50_000,
      caseProviders: three,
      onQuality: (report) => reports.push(report),
    });
    // Two 80 ms providers side by side, not one after the other.
    expect(overlap()).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(1_000);
    const byName = Object.fromEntries(result.quality!.providers.map((item) => [item.name, item]));
    expect(byName.A!.status).toBe("ok");
    expect(byName.B!.status).toBe("ok");
    expect(byName.B!.caseCount).toBeGreaterThan(0);
    expect(byName.C).toMatchObject({ status: "failed", caseCount: 0 });
    expect(result.errors.cases).toMatch(/C: failed/);
    expect(result.cases!.length).toBeGreaterThan(0);
    // The same scenario from A and B is one case, credited to both — not two.
    expect(result.quality!.final!.duplicatesRemoved).toBeGreaterThan(0);
    // Results are exposed as providers finish: an early report already has a finished provider while C/others still run or failed.
    expect(reports[0]!.providers.every((item) => item.status === "running")).toBe(true);
    expect(reports.some((report) => report.final === null && report.providers.some((item) => item.status !== "running"))).toBe(true);
    expect(reports.at(-1)!.final).not.toBeNull();
  });

  it("marks a slow provider as timed out at its own limit and continues with the others", async () => {
    const { llm } = providers({ A: good, B: otherShape, C: hang });
    const started = Date.now();
    const result = await runStudio({
      source: NFC,
      locale: "fa",
      stages: ["understand", "criteria", "cases"],
      llm,
      guidance: () => "",
      budgetChars: 50_000,
      caseProviders: three,
      providerTimeoutMs: 300,
      deadline: started + 300_000,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    const c = result.quality!.providers.find((item) => item.name === "C")!;
    expect(c.status).toBe("timeout");
    expect(result.quality!.selection.reasons).toEqual(expect.arrayContaining([{ code: "providerUnavailable", values: { provider: "C", status: "timeout" } }]));
    expect(result.cases!.length).toBeGreaterThan(0);
  });

  it("stops waiting for a straggler once another provider covered every requirement", async () => {
    const { llm } = providers({ A: good, B: hang });
    const started = Date.now();
    const result = await runStudio({
      source: NFC,
      locale: "fa",
      stages: ["understand", "criteria", "cases"],
      llm,
      guidance: () => "",
      budgetChars: 50_000,
      caseProviders: three.slice(0, 2),
      quality: { ...DEFAULT_QUALITY_CONFIG, stragglerGraceMs: 100 },
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.quality!.providers.find((item) => item.name === "B")!.status).toBe("timeout");
    expect(result.quality!.selection.base).toBe("A");
  });

  it("reports the stage as failed but keeps the rest of the run when no provider answers", async () => {
    const down = async () => {
      throw new Error("down");
    };
    const { llm } = providers({ A: down, B: down });
    const result = await runStudio({ source: NFC, locale: "fa", stages: ["understand", "criteria", "assessment", "cases"], llm, guidance: () => "", budgetChars: 50_000, caseProviders: three.slice(0, 2) });
    expect(result.errors.cases).toMatch(/No provider produced test cases/);
    expect(result.cases).toBeNull();
    expect(result.assessment).not.toBeNull();
  });
});
