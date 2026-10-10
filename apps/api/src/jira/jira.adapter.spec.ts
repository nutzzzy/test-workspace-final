import { extractAcceptanceCriteria } from "./jira.adapter";

describe("extractAcceptanceCriteria", () => {
  it("extracts bullet list under Acceptance Criteria", () => {
    const description = `Some intro

Acceptance Criteria:
- User can cancel
- Refund is issued

Notes:
Ignore me`;
    const result = extractAcceptanceCriteria(description);
    expect(result.some((l) => l.includes("cancel"))).toBe(true);
    expect(result.some((l) => l.includes("Refund"))).toBe(true);
  });

  it("falls back to description when no bullets", () => {
    const result = extractAcceptanceCriteria("Plain requirement text only");
    expect(result[0]).toContain("Plain requirement");
  });
});
