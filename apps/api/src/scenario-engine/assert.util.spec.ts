import { assertValue, interpolatePath } from "./assert.util";

describe("interpolatePath", () => {
  const body = { data: { items: [{ id: "a" }, { id: "b" }] }, matrix: [[1, 2], [3, 4]] };

  it("resolves nested keys, indexes, root arrays and nested arrays", () => {
    expect(interpolatePath(body, "data.items[1].id")).toBe("b");
    expect(interpolatePath(body, "data.items.0.id")).toBe("a");
    expect(interpolatePath([{ id: 7 }], "[0].id")).toBe(7);
    expect(interpolatePath([{ id: 7 }], "$[0].id")).toBe(7);
    expect(interpolatePath(body, "matrix[1][0]")).toBe(3);
    expect(interpolatePath(body, "data.missing.id")).toBeUndefined();
  });
});

describe("assertValue", () => {
  it("compares UI text with typed values", () => {
    expect(() => assertValue("equals", true, "true")).not.toThrow();
    expect(() => assertValue("equals", 200, "200")).not.toThrow();
    expect(() => assertValue("equals", { a: 1, b: [2] }, '{"b":[2],"a":1}')).not.toThrow();
    expect(() => assertValue("equals", [1, 2], [1, 2])).not.toThrow();
  });

  it("finds list items typed as text", () => {
    expect(() => assertValue("contains", [1, 2, 3], "2")).not.toThrow();
    expect(() => assertValue("contains", 12345, "234")).not.toThrow();
  });

  it("explains failures with actual and expected values", () => {
    expect(() => assertValue("equals", 500, "200")).toThrow("expected \"200\", got 500");
    expect(() => assertValue("contains", "hello", "bye")).toThrow('"hello" does not contain "bye"');
    expect(() => assertValue("exists", undefined)).toThrow("undefined (path not found)");
    expect(() => assertValue("contains", { a: 1 }, "a")).toThrow("needs text, a number or a list");
  });
});
