import { localizeIssueContentToFa, localizeTextToFa } from "./localize-fa";

describe("localize-fa", () => {
  it("translates gherkin keywords", () => {
    expect(localizeTextToFa("Given: the Biker has no previous transactions")).toMatch(
      /با فرض اینکه/,
    );
    expect(localizeTextToFa("When: a new transaction is created")).toMatch(
      /هنگامی که/,
    );
    expect(localizeTextToFa("Then: the system should calculate")).toMatch(/آنگاه/);
  });

  it("localizes issue bundle", () => {
    const out = localizeIssueContentToFa({
      title: "Calculate and Store Cumulative Balance for Biker Transactions",
      description: "As a Biker Transaction system, I want to calculate cumulative_balance",
      acceptanceCriteria: ["Scenario 1: Create the first transaction for a Biker"],
    });
    expect(out.title).toMatch(/موجودی تجمعی|بایکر|محاسبه/);
    expect(out.description).toMatch(/به عنوان|می‌خواهم|موجودی/);
    expect(out.acceptanceCriteria[0]).toMatch(/سناریو/);
  });
});
