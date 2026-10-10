import { UpdateCaseSchema } from "./test-management.controller";

describe("UpdateCaseSchema", () => {
  it("accepts editable content fields", () => {
    expect(UpdateCaseSchema.safeParse({ title: "Login", priority: "HIGH", steps: ["a"] }).success).toBe(true);
  });

  it("rejects server-owned workflow fields (mass assignment)", () => {
    for (const field of ["jiraSyncStatus", "jiraSyncHash", "designStatus", "jiraIssueId", "manuallyEdited"]) {
      expect(UpdateCaseSchema.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });

  it("rejects values outside the domain", () => {
    expect(UpdateCaseSchema.safeParse({ priority: "urgent" }).success).toBe(false);
    expect(UpdateCaseSchema.safeParse({ automationStatus: "not_automated" }).success).toBe(false);
    expect(UpdateCaseSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(UpdateCaseSchema.safeParse({ title: "   " }).success).toBe(false);
  });
});
