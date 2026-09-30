import { maskValue } from "./crypto.util";
import { isSecretKey, maskDeep } from "./mask.util";

describe("maskDeep", () => {
  it("masks credential-like keys in any spelling", () => {
    for (const key of ["X-Api-Key", "client_secret", "set-cookie", "accessToken", "idToken", "jwt", "passwd", "Authorization"]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["email", "userId", "status", "description"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it("redacts known secret values wherever they appear", () => {
    const out = maskDeep(
      { headers: { "X-Custom": "abc SECRETVALUE123" }, url: "https://x.test/?k=SECRETVALUE123", note: "ok" },
      ["SECRETVALUE123"],
    );
    expect(JSON.stringify(out)).not.toContain("SECRETVALUE123");
    expect(out).toMatchObject({ note: "ok" });
  });

  it("does not redact very short values that would cause false hits", () => {
    expect(maskDeep({ a: "abc" }, ["ab"])).toEqual({ a: "abc" });
  });
});

describe("maskValue", () => {
  it("reveals no characters of a secret", () => {
    expect(maskValue("12345")).toBe("***");
    expect(maskValue("a-long-secret-value")).toBe("***");
    expect(maskValue("")).toBe("");
  });
});
