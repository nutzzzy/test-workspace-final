import type { AppLocale } from "../ai/localize-fa";
import { runQaPipeline } from "../qa-engine/pipeline";
import { designAnalysis } from "./qa-design";
import { analyzeRequirementGaps, dedupeQuestions } from "./requirement-questions";

function analyze(input: {
  title: string;
  description?: string;
  criteria: string[];
  locale?: AppLocale;
  origin?: "cleaned" | "derived";
}) {
  const locale = input.locale ?? "en";
  const criteria = input.criteria.map((text, index) => ({
    key: `AC-0${index + 1}`,
    text,
    origin: input.origin ?? "cleaned",
  }));
  const pipeline = runQaPipeline({
    title: input.title,
    description: input.description ?? "",
    locale,
    acceptanceCriteria: criteria,
  });
  return {
    pipeline,
    ...analyzeRequirementGaps({
      title: input.title,
      description: input.description ?? "",
      criteria,
      understanding: pipeline.understanding,
      gaps: pipeline.gaps,
      inferred: pipeline.inferredAc,
      locale,
    }),
  };
}

const sources = (items: Array<{ source: string }>) => items.map((item) => item.source);

describe("contextual requirement questions", () => {
  it("asks few or no questions for a well-specified requirement", () => {
    const { questions } = analyze({
      title: "Search orders",
      description: "Only admins can search. Search is read-only.",
      criteria: [
        "Admins can search orders by order number.",
        "An invalid order number returns status 400 with error code ORDER_INVALID.",
      ],
    });
    expect(questions.length).toBeLessThanOrEqual(1);
  });

  it("asks a failure question that names this requirement's operation and state", () => {
    const { questions, suggestedCriteria } = analyze({
      title: "Activate biker after identity verification",
      criteria: ["When identity verification succeeds, the biker becomes ACTIVE."],
    });
    const failure = questions.find((item) => item.source === "failure-behaviour");
    expect(failure?.category).toBe("developer");
    expect(failure?.question).toMatch(/ACTIVE/);
    expect(failure?.reason).toBeTruthy();
    expect(sources(suggestedCriteria)).toContain("failure-behaviour");
  });

  it("asks the business question about records already in that state", () => {
    const { questions } = analyze({
      title: "Identity verification for new bikers",
      criteria: ["After a biker becomes ACTIVE, identity verification is required before the first trip."],
    });
    const existing = questions.find((item) => item.source === "existing-records");
    expect(existing?.category).toBe("business");
    expect(existing?.question).toMatch(/already ACTIVE/);
  });

  it("does not ask what the acceptance criteria already answer", () => {
    const { questions } = analyze({
      title: "Activate biker",
      criteria: [
        "Only operators with the ADMIN role can activate a biker.",
        "Activating the same biker twice returns the existing result.",
        "If verification fails, the biker stays PENDING and the API returns 409.",
        "Bikers that were already ACTIVE before release are not affected.",
      ],
    });
    const asked = sources(questions);
    for (const answered of ["failure-behaviour", "authorization", "duplicate-request", "existing-records"]) {
      expect(asked).not.toContain(answered);
    }
  });

  it("removes filler, exact duplicates and paraphrases", () => {
    const kept = dedupeQuestions([
      { question: "What is the expected behavior?", category: "product", reason: "r", source: "a" },
      { question: "آیا این قابلیت درست کار می‌کند؟", category: "product", reason: "r", source: "b" },
      { question: "Which roles may activate a biker?", category: "business", reason: "r", source: "c" },
      { question: "Which roles may activate a biker ?", category: "business", reason: "r", source: "d" },
      { question: "Which HTTP status is returned for a missing phone?", category: "developer", reason: "r", source: "e" },
    ]);
    expect(kept.map((item) => item.source)).toEqual(["c", "e"]);
  });

  it("keeps suggested criteria separate from the Jira criteria", () => {
    const { suggestedCriteria, pipeline } = analyze({
      title: "Register a biker",
      criteria: ["The system creates the biker record."],
    });
    expect(suggestedCriteria.length).toBeGreaterThan(0);
    for (const item of suggestedCriteria) expect(item.reason).toBeTruthy();
    expect(pipeline.explicitAc.map((item) => item.text)).toEqual(["The system creates the biker record."]);
  });
});

describe("output language follows the workspace, not the source", () => {
  const english = {
    title: "Activate biker",
    criteria: ["POST /api/bikers/{{bikerId}}/activate returns 200 with status ACTIVE."],
  };
  const persian = {
    title: "فعال‌سازی بایکر",
    criteria: ["درخواست POST /api/bikers/{{bikerId}}/activate پاسخ 200 با وضعیت ACTIVE برمی‌گرداند."],
  };
  const persianScript = /[؀-ۿ]/;

  const generated = (source: typeof english, locale: AppLocale) => {
    const { pipeline, questions } = analyze({ ...source, locale });
    const analysis = designAnalysis({
      title: source.title,
      criteria: source.criteria.map((text, index) => ({ key: `AC-0${index + 1}`, text, origin: "cleaned", orderIndex: index })),
      locale,
    });
    return { pipeline, questions, analysis };
  };

  // The framing text must be in the output language; quoted source text may keep its own script.
  const framing = (text: string, source: string[]) =>
    source.reduce((rest, piece) => rest.split(piece).join(" "), text);

  it.each([
    ["English source, Persian workspace", english, "fa"],
    ["Persian source, Persian workspace", persian, "fa"],
  ] as const)("%s → Persian content", (_label, source, locale) => {
    const { pipeline, questions, analysis } = generated(source, locale);
    expect(analysis.summary).toMatch(persianScript);
    for (const item of questions) expect(item.question).toMatch(persianScript);
    for (const testCase of pipeline.testCases) {
      expect(framing(testCase.title, source.criteria)).toMatch(persianScript);
    }
    expect(pipeline.strategy.scope).toMatch(persianScript);
  });

  it.each([
    ["Persian source, English workspace", persian, "en"],
    ["English source, English workspace", english, "en"],
  ] as const)("%s → English content", (_label, source, locale) => {
    const { pipeline, questions, analysis } = generated(source, locale);
    expect(framing(analysis.summary, [...source.criteria, source.title])).not.toMatch(persianScript);
    for (const item of questions) {
      expect(framing(item.question, [...source.criteria, source.title])).not.toMatch(persianScript);
    }
    for (const testCase of pipeline.testCases) {
      expect(framing(testCase.title, source.criteria)).not.toMatch(/^(بررسی|موفق)/);
    }
  });

  it("keeps technical identifiers unchanged in either language", () => {
    for (const locale of ["fa", "en"] as const) {
      const { pipeline } = generated(english, locale);
      const text = JSON.stringify(pipeline.testCases);
      expect(text).toContain("/api/bikers/{{bikerId}}/activate");
      expect(text).toContain("POST");
      expect(text).toContain("200");
    }
  });

  it("never labels output as a translation", () => {
    const { analysis, pipeline } = generated(english, "fa");
    const text = JSON.stringify([analysis, pipeline.testCases, pipeline.strategy]);
    expect(text).not.toMatch(/نسخه فارسی|Persian version|translated version|ترجمه شده/);
  });
});
