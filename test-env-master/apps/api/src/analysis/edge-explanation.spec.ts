import { runQaPipeline, type QaInput } from "../qa-engine/pipeline";
import { explainNoEdgeCases } from "./edge-explanation";

const vague: QaInput = {
  title: "Improve the driver profile",
  description: "The driver profile should be better.",
  acceptanceCriteria: [],
  locale: "en",
};

describe("why there are no edge cases", () => {
  it("names the details this requirement is missing, and points to AI analysis", () => {
    const result = runQaPipeline(vague);
    expect(result.edgeCases).toHaveLength(0);
    const { reasons, suggestions } = explainNoEdgeCases({ result, deep: null, aiReady: true, locale: "en" });
    expect(reasons.join(" ")).toMatch(/executable action/);
    expect(reasons.join(" ")).toMatch(/No numeric limit/);
    expect(reasons.join(" ")).toMatch(/required or optional fields/);
    expect(reasons.at(-1)).toMatch(/Only the rule-based engine/);
    expect(suggestions.some((item) => /Persian analysis/.test(item))).toBe(true);
  });

  it("explains in Persian, including items the AI review removed", () => {
    const result = runQaPipeline({ ...vague, locale: "fa" });
    const { reasons } = explainNoEdgeCases({
      result,
      deep: { testCases: [], dropped: { criteria: 0, testCases: 2 } },
      aiReady: true,
      locale: "fa",
    });
    expect(reasons.at(-1)).toContain("بازبینی 2 مورد");
    expect(reasons.every((reason) => /[؀-ۿ]/.test(reason))).toBe(true);
  });

  it("reads limits written with Persian digits", () => {
    const result = runQaPipeline({ ...vague, locale: "fa", title: "تغییر نام نمایشی", description: "نام نمایشی الزامی است و حداکثر ۳۰ کاراکتر باشد." });
    const { reasons, suggestions } = explainNoEdgeCases({ result, deep: null, aiReady: true, locale: "fa" });
    expect(reasons.join(" ")).toContain("به یک محدودیت عددی اشاره می‌کند");
    expect(suggestions.filter((item) => item.includes("تحلیل"))).toHaveLength(1);
  });

  it("does not claim a limit is missing when the requirement gives one", () => {
    const result = runQaPipeline({
      ...vague,
      description: "The display name is required and must be at most 30 characters.",
      acceptanceCriteria: [{ key: "AC-1", text: "Display name length must be at most 30 characters", origin: "cleaned" }],
    });
    const { reasons } = explainNoEdgeCases({ result, deep: null, aiReady: false, locale: "en" });
    expect(reasons.join(" ")).not.toMatch(/No numeric limit/);
    expect(reasons.join(" ")).toMatch(/mentions a numeric limit, but the rule engine could not/);
    expect(reasons.join(" ")).toMatch(/required or optional, but the rule engine could not tell which fields/);
    expect(reasons.at(-1)).toMatch(/AI analysis is not set up/);
  });
});
