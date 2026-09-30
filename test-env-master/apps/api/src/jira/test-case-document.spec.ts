import { testCaseContentHash, testCaseDocument } from "./test-case-document";

const sample = {
  id: "tc_1",
  title: "Verify successful login using a valid OTP",
  description: "The user can sign in with a one-time code.",
  preconditions: ["User has a valid mobile number"],
  steps: ["Open the Login page.", "Enter the valid OTP."],
  stepExpectations: ["Login page is displayed.", "OTP is accepted."],
  testData: ["09120000000"],
  expectedResult: "The user is authenticated.",
  priority: "HIGH",
  type: "FUNCTIONAL",
};

describe("Jira test case document", () => {
  it("renders readable sections and does not dump JSON", () => {
    const doc = testCaseDocument(sample);
    const encoded = JSON.stringify(doc);
    expect(encoded).toContain("Verify successful login using a valid OTP");
    expect(encoded).toContain("Preconditions");
    expect(encoded).toContain("Expected result: OTP is accepted.");
    expect(encoded).toContain("Final expected result: The user is authenticated.");
    expect(encoded).not.toContain('"steps":[');
  });

  it("changes the hash when a step changes and stays stable otherwise", () => {
    const first = testCaseContentHash(sample);
    expect(testCaseContentHash({ ...sample })).toBe(first);
    expect(
      testCaseContentHash({ ...sample, steps: ["Open the Login page."] }),
    ).not.toBe(first);
  });
});
