import { ExecutionContext } from "./types";
import { StepExecutorRegistry } from "./step-executor.registry";
import { HttpRequestExecutor } from "./executors/http-request.executor";
import { AssertionExecutor } from "./executors/assertion.executor";
import { ExtractVariableExecutor } from "./executors/extract-variable.executor";
import { resolveResponsePath, assertValue } from "./assert.util";

describe("Phase 4 scenario foundation", () => {
  const registry = new StepExecutorRegistry();

  beforeAll(() => {
    for (const ex of [
      new HttpRequestExecutor(),
      new AssertionExecutor(),
      new ExtractVariableExecutor(),
    ]) {
      registry.register(ex);
    }
  });

  it("interpolates variables inside URL, headers and body", () => {
    const ctx = new ExecutionContext({
      base_url: "https://api.test",
      token: "abc",
      restaurant_id: "42",
    });
    expect(ctx.interpolate("{{base_url}}/restaurants/{{restaurant_id}}")).toBe(
      "https://api.test/restaurants/42",
    );
    expect(
      ctx.interpolateDeep({
        headers: { Authorization: "Bearer {{token}}" },
        body: { restaurantId: "{{restaurant_id}}" },
      }),
    ).toEqual({
      headers: { Authorization: "Bearer abc" },
      body: { restaurantId: "42" },
    });
  });

  it("resolves response paths for assertions/extraction", () => {
    const response = {
      status: 201,
      headers: { "content-type": "application/json" },
      body: { data: { orderId: "ORD-9", items: [{ id: 1 }] } },
    };
    expect(resolveResponsePath("response.status", response)).toBe(201);
    expect(resolveResponsePath("body.data.orderId", response)).toBe("ORD-9");
    expect(resolveResponsePath("body.data.items.0.id", response)).toBe(1);
  });

  it("asserts status code with string/number coercion", () => {
    expect(() => assertValue("status_code", 200, "200")).not.toThrow();
    expect(() => assertValue("equals", "CREATED", "CREATED")).not.toThrow();
    expect(() => assertValue("contains", "hello world", "world")).not.toThrow();
    expect(() => assertValue("exists", 0)).not.toThrow();
    expect(() => assertValue("not_exists", undefined)).not.toThrow();
  });

  it("extracts nested body fields into isolated variables", async () => {
    const ctx = new ExecutionContext();
    ctx.lastHttpResponse = {
      status: 200,
      headers: {},
      body: { data: { orderId: "ORD-77" } },
      rawBody: "",
    };
    const result = await registry.resolve("EXTRACT_VARIABLE").execute(
      { path: "body.data.orderId", variable: "order_id" },
      ctx,
    );
    expect(result.status).toBe("PASSED");
    expect(ctx.get("order_id")).toBe("ORD-77");
  });

  it("runs assertion against previous HTTP response", async () => {
    const ctx = new ExecutionContext();
    ctx.lastHttpResponse = {
      status: 200,
      headers: {},
      body: { ok: true },
      rawBody: "",
    };
    const passed = await registry.resolve("ASSERTION").execute(
      { kind: "status_code", expected: 200 },
      ctx,
    );
    expect(passed.status).toBe("PASSED");

    const failed = await registry.resolve("ASSERTION").execute(
      { kind: "equals", path: "body.ok", expected: false },
      ctx,
    );
    expect(failed.status).toBe("FAILED");
  });

  it("rejects unknown step types via registry", () => {
    expect(() => registry.resolve("KAFKA")).toThrow(/Unknown StepType/);
  });
});
