import { rowsToIssues } from "./spreadsheet-import";

describe("spreadsheet import parser", () => {
  it("maps english headers and multi-line AC", () => {
    const issues = rowsToIssues([
      {
        key: "qa-10",
        title: "Cancel order",
        description: "desc",
        issue_type: "Story",
        priority: "High",
        labels: "a,b",
        acceptance_criteria: "Can cancel\nRefund works",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("QA-10");
    expect(issues[0].labels).toEqual(["a", "b"]);
    expect(issues[0].acceptanceCriteria).toEqual([
      "Can cancel",
      "Refund works",
    ]);
  });

  it("accepts persian header aliases", () => {
    const issues = rowsToIssues([
      {
        کلید: "PAY-1",
        عنوان: "Refund",
        "معیار پذیرش": "Refund within 24h | Status becomes REFUNDED",
      },
    ]);
    expect(issues[0].key).toBe("PAY-1");
    expect(issues[0].title).toBe("Refund");
    expect(issues[0].acceptanceCriteria).toHaveLength(2);
  });

  it("skips incomplete rows", () => {
    expect(rowsToIssues([{ key: "QA-1" }, { title: "Only title" }])).toEqual(
      [],
    );
  });
});
