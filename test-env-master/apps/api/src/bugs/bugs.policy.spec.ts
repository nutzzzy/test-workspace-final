import { assertStatusTransition, cleanAuthor, statusDetail } from "./bugs.policy";

describe("bug lifecycle", () => {
  it("allows the supported status path and rejects a skip", () => {
    expect(() => assertStatusTransition("OPEN", "IN_PROGRESS")).not.toThrow();
    expect(() => assertStatusTransition("IN_PROGRESS", "RESOLVED")).not.toThrow();
    expect(() => assertStatusTransition("RESOLVED", "CLOSED")).not.toThrow();
    expect(() => assertStatusTransition("CLOSED", "REOPENED")).not.toThrow();
    expect(() => assertStatusTransition("CLOSED", "IN_PROGRESS")).toThrow(
      /not allowed/,
    );
  });

  it("keeps a short author and describes the status change", () => {
    expect(cleanAuthor("  Ali  ")).toBe("Ali");
    expect(cleanAuthor("")).toBe("QA");
    expect(cleanAuthor("x".repeat(120))).toHaveLength(80);
    expect(statusDetail("OPEN", "IN_PROGRESS")).toBe(
      "changed status from OPEN to IN_PROGRESS",
    );
  });
});
