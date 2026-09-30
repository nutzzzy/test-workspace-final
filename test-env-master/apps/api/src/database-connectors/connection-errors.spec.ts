import { publicDatabaseError } from "./connection-errors";

describe("public database errors", () => {
  it("hides passwords and maps connection failures", () => {
    expect(
      publicDatabaseError(new Error("connect ECONNREFUSED 10.0.0.5:5432")),
    ).toBe("Unable to connect to the selected database.");
    expect(
      publicDatabaseError(
        new Error("password authentication failed for user admin password=secret"),
      ),
    ).toBe("Database authentication failed. Check the username and password.");
  });
});
