import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskSecrets } from "./secrets";

describe("maskSecrets", () => {
  it("masks bearer tokens", () => {
    assert.match(
      maskSecrets("Authorization: Bearer abc.def.ghi"),
      /Bearer \*\*\*/,
    );
  });

  it("masks password fields in json-like text", () => {
    const masked = maskSecrets('{"password":"super-secret"}');
    assert.match(masked, /\*\*\*/);
    assert.equal(masked.includes("super-secret"), false);
  });

  it("leaves non-secret text unchanged", () => {
    assert.equal(
      maskSecrets("order status is PENDING"),
      "order status is PENDING",
    );
  });
});
