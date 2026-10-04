import type { ConfigService } from "@nestjs/config";
import { AIService, isExternal } from "../ai/ai.service";
import type { PrismaService } from "../prisma/prisma.service";
import { runQaPipeline, type QaInput } from "../qa-engine/pipeline";
import { detectLanguage, isGrounded, mergeDeepAnalysis, runDeepAnalysis, type StructuredLlm } from "./deep-analysis";

/** A scripted model: answers by the pass the prompt asks for, and records every prompt. */
function scriptedLlm(answers: Record<string, unknown>) {
  const prompts: string[] = [];
  const llm: StructuredLlm = async (call) => {
    prompts.push(call.prompt);
    const pass = /Translate the requirement/.test(call.prompt)
      ? "translate"
      : /extract what it says/.test(call.prompt)
        ? "understand"
        : /criteria":\[\{"text"/.test(call.prompt)
          ? "criteria"
          : /questions to ask/.test(call.prompt)
            ? "questions"
            : /Design concrete test cases/.test(call.prompt)
              ? "cases"
              : "review";
    return call.schema.parse(answers[pass] ?? {});
  };
  return { llm, prompts };
}

const NO_AC: QaInput = {
  title: "Driver withdraws wallet balance",
  description:
    "A driver can request a withdrawal of his wallet balance to his registered bank account. The amount cannot exceed the available balance. Only drivers with a verified bank account can withdraw.",
  acceptanceCriteria: [],
  issueKey: "PAY-12",
  locale: "fa",
};

const answers = {
  translate: { title: "برداشت موجودی کیف پول راننده", description: "راننده می‌تواند ...", acceptanceCriteria: [] },
  understand: {
    summary: "راننده موجودی کیف پول را به حساب بانکی ثبت‌شده برداشت می‌کند.",
    actors: [{ name: "driver", goal: "withdraw" }],
    businessRules: [{ rule: "amount ≤ balance", evidence: "The amount cannot exceed the available balance" }],
    assumptions: ["حداقل مبلغ برداشت مشخص نیست."],
  },
  criteria: {
    criteria: [
      {
        text: "درخواست برداشت با مبلغ بیشتر از موجودی رد می‌شود.",
        category: "validation",
        evidence: "The amount cannot exceed the available balance",
        confidence: "HIGH",
        rationale: "قاعدهٔ صریح",
      },
      {
        text: "راننده بدون حساب بانکی تأییدشده نمی‌تواند برداشت کند.",
        category: "permission",
        evidence: "Only drivers with a verified bank account can withdraw",
        confidence: "HIGH",
        rationale: "",
      },
      // Evidence that is not in the text: kept only as an unconfirmed proposal.
      { text: "برداشت ظرف ۲۴ ساعت واریز می‌شود.", category: "integration", evidence: "paid within 24 hours", confidence: "HIGH", rationale: "" },
      { text: "مبلغ برداشت باید مضرب ۱۰۰۰ باشد.", category: "validation", evidence: "multiple of 1000 rials only", confidence: "MEDIUM", rationale: "" },
    ],
  },
  questions: {
    gaps: [{ description: "حداقل مبلغ برداشت مشخص نیست.", severity: "MEDIUM", impact: "", clarification: "" }],
    questions: [{ question: "حداقل مبلغ برداشت راننده چقدر است؟", category: "product", reason: "مرز پایینی آزمون" }],
    risks: [{ description: "برداشت هم‌زمان دو درخواست ممکن است موجودی را منفی کند.", impact: "HIGH", likelihood: "MEDIUM", mitigation: "", releaseBlocking: true }],
  },
  cases: {
    testCases: [
      {
        criterionRefs: ["AI-AC-01"],
        title: "رد برداشت با مبلغ بیشتر از موجودی",
        type: "NEGATIVE",
        priority: "HIGH",
        preconditions: ["موجودی راننده ۵۰۰٬۰۰۰ ریال است."],
        testData: ["مبلغ: ۶۰۰٬۰۰۰ ریال"],
        steps: [{ action: "درخواست برداشت ۶۰۰٬۰۰۰ ریال ثبت کنید.", expected: "درخواست رد می‌شود و موجودی تغییر نمی‌کند." }],
        expectedResult: "هیچ برداشتی ثبت نمی‌شود و موجودی ۵۰۰٬۰۰۰ ریال می‌ماند.",
        edgeCase: true,
        automation: { suitability: "HIGH", layer: "API" },
      },
    ],
  },
  review: {
    criteria: [
      { id: "AI-AC-03", verdict: "drop", reason: "در متن نیست" },
      { id: "AI-AC-04", verdict: "confirm", reason: "فرض" },
    ],
    testCases: [],
  },
};

describe("deep requirement analysis", () => {
  it("derives a careful criteria set when the task has no AC, and checks every claim against the text", async () => {
    const { llm, prompts } = scriptedLlm(answers);
    const steps: string[] = [];
    const deep = await runDeepAnalysis({
      input: NO_AC,
      base: runQaPipeline(NO_AC),
      llm,
      provider: "openai",
      model: "test",
      onProgress: (progress) => steps.push(progress.step),
    });

    expect(prompts.some((prompt) => prompt.includes("NO written acceptance criteria"))).toBe(true);
    expect(deep.hadExplicitCriteria).toBe(false);
    // English task, Persian workspace: translated for display, analysed in Persian.
    expect(deep.sourceLanguage).toBe("en");
    expect(deep.translation?.title).toBe("برداشت موجودی کیف پول راننده");
    expect(steps).toEqual(expect.arrayContaining(["translate", "understand", "criteria", "questions", "cases", "review"]));

    const byId = Object.fromEntries(deep.criteria.map((item) => [item.id, item]));
    expect(byId["AI-AC-01"]).toMatchObject({ grounded: true, confidence: "HIGH", needsConfirmation: false });
    // Invented detail: dropped by the review pass.
    expect(byId["AI-AC-03"]).toBeUndefined();
    // Not grounded and marked "confirm": kept as a LOW proposal that needs confirmation.
    expect(byId["AI-AC-04"]).toMatchObject({ grounded: false, confidence: "LOW", needsConfirmation: true });
    expect(deep.dropped.criteria).toBe(1);
    // The requirement text sent to the model is wrapped as data, never as instructions.
    expect(prompts.every((prompt) => prompt.includes("<requirement>"))).toBe(true);
  });

  it("only complements written AC, and does not translate a task already in the workspace language", async () => {
    const { llm, prompts } = scriptedLlm({ ...answers, criteria: { criteria: [] }, review: {} });
    const input: QaInput = {
      ...NO_AC,
      locale: "en",
      acceptanceCriteria: [{ key: "AC-1", text: "The amount cannot exceed the available balance", origin: "cleaned" }],
    };
    const deep = await runDeepAnalysis({ input, base: runQaPipeline(input), llm, provider: "ollama", model: "m" });
    expect(prompts.some((prompt) => prompt.includes("do NOT cover"))).toBe(true);
    expect(prompts.some((prompt) => /Translate the requirement/.test(prompt))).toBe(false);
    expect(deep.translation).toBeNull();
  });

  it("merges AI cases as reviewable drafts, never as official coverage, and replaces the 'not enough information' draft", async () => {
    const { llm } = scriptedLlm(answers);
    const base = runQaPipeline(NO_AC);
    const deep = await runDeepAnalysis({ input: NO_AC, base, llm, provider: "openai", model: "test" });
    const merged = mergeDeepAnalysis(base, deep, NO_AC);

    expect(merged.testCases.some((item) => item.partition === "insufficient")).toBe(false);
    const ai = merged.testCases.filter((item) => item.tags.includes("ai"));
    expect(ai).toHaveLength(1);
    expect(ai[0]).toMatchObject({ designStatus: "DRAFT_REQUIRES_REVIEW", relatedAcceptanceCriteria: [] });
    expect(ai[0]!.tags).toContain("ai-ac:AI-AC-01");
    expect(merged.inferredAc.map((item) => item.id)).toEqual(expect.arrayContaining(["AI-AC-01", "AI-AC-04"]));
    expect(merged.risks.some((item) => item.releaseBlocking)).toBe(true);
    expect(merged.edgeCases.length).toBeGreaterThan(0);
    expect(merged.intelligence.ai).toMatchObject({ provider: "openai" });
  });

  it("recognises quotes and languages", () => {
    expect(isGrounded("amount cannot exceed the available balance", NO_AC.description)).toBe(true);
    expect(isGrounded("paid within 24 hours", NO_AC.description)).toBe(false);
    expect(detectLanguage("برداشت موجودی کیف پول")).toBe("fa");
    expect(detectLanguage("Driver withdraws balance (API /v1/wallet)")).toBe("en");
  });
});

describe("AI service", () => {
  function service(settings: Record<string, string>) {
    const prisma = {
      systemSetting: {
        findMany: async () => Object.entries(settings).map(([key, value]) => ({ key, value })),
        findUnique: async ({ where }: { where: { key: string } }) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null),
      },
    } as unknown as PrismaService;
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    return new AIService(config, prisma);
  }

  afterEach(() => jest.restoreAllMocks());

  it("never sends requirement text to an external service without explicit permission", async () => {
    const fetch = jest.spyOn(global, "fetch");
    const ai = service({ "ai.provider": "openai", "ai.baseUrl": "https://api.groq.com/openai/v1", "ai.model": "m" });
    expect(await ai.analysisStatus()).toMatchObject({ ready: false, reason: "external_not_allowed" });
    const { z } = await import("zod");
    await expect(ai.structured({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) })).rejects.toThrow(/not available/);
    expect(fetch).not.toHaveBeenCalled();
    expect(isExternal("http://localhost:11434")).toBe(false);
    expect(isExternal("http://10.0.0.5:8000/v1")).toBe(false);
    expect(isExternal("https://openrouter.ai/api/v1")).toBe(true);
  });

  it("retries a rate limit and an invalid answer, then returns validated data", async () => {
    const replies = [
      new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }),
      new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] })),
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })),
    ];
    const fetch = jest.spyOn(global, "fetch").mockImplementation(async () => replies.shift()!);
    const ai = service({ "ai.provider": "openai", "ai.baseUrl": "http://127.0.0.1:1234/v1", "ai.model": "local" });
    const { z } = await import("zod");
    await expect(ai.structured({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    // The second retry tells the model what was wrong.
    const lastBody = JSON.parse(String(fetch.mock.calls[2]![1]!.body)) as { messages: Array<{ content: string }> };
    expect(lastBody.messages[1]!.content).toContain("previous answer was rejected");
  });
});
