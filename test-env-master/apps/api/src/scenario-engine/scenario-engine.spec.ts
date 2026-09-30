import { ExecutionContext } from "./types";
import { StepExecutorRegistry } from "./step-executor.registry";
import { SetVariableExecutor } from "./executors/set-variable.executor";
import { ExtractVariableExecutor } from "./executors/extract-variable.executor";
import { AssertionExecutor } from "./executors/assertion.executor";
import { DelayExecutor } from "./executors/delay.executor";
import { ConditionExecutor } from "./executors/condition.executor";
import { maskDeep } from "../common/mask.util";

describe("Scenario engine foundation", () => {
  const registry = new StepExecutorRegistry();
  beforeAll(() => {
    for (const ex of [
      new SetVariableExecutor(),
      new ExtractVariableExecutor(),
      new AssertionExecutor(),
      new DelayExecutor(),
      new ConditionExecutor(),
    ]) {
      registry.register(ex);
    }
  });

  it("resolves known executors and rejects unknown", () => {
    expect(registry.resolve("SET_VARIABLE").type).toBe("SET_VARIABLE");
    expect(() => registry.resolve("PLAYWRIGHT")).toThrow(/Unknown StepType/);
  });

  it("isolates variables between contexts", async () => {
    const a = new ExecutionContext({ token: "a" });
    const b = new ExecutionContext({ token: "b" });
    await registry.resolve("SET_VARIABLE").execute(
      { variable: "token", value: "changed" },
      a,
    );
    expect(a.get("token")).toBe("changed");
    expect(b.get("token")).toBe("b");
  });

  it("interpolates variables", () => {
    const ctx = new ExecutionContext({ base_url: "https://api.test" });
    expect(ctx.interpolate("{{base_url}}/orders")).toBe("https://api.test/orders");
  });

  it("extracts and asserts", async () => {
    const ctx = new ExecutionContext();
    ctx.lastHttpResponse = {
      status: 200,
      headers: {},
      body: { data: { orderId: "ORD-1" } },
      rawBody: "",
    };
    const extracted = await registry.resolve("EXTRACT_VARIABLE").execute(
      { path: "body.data.orderId", variable: "order_id" },
      ctx,
    );
    expect(extracted.status).toBe("PASSED");
    expect(ctx.get("order_id")).toBe("ORD-1");

    const assertion = await registry.resolve("ASSERTION").execute(
      { kind: "status_code", expected: 200 },
      ctx,
    );
    expect(assertion.status).toBe("PASSED");
  });

  it("fails extraction clearly", async () => {
    const ctx = new ExecutionContext();
    ctx.lastHttpResponse = { status: 200, headers: {}, body: {}, rawBody: "" };
    const result = await registry.resolve("EXTRACT_VARIABLE").execute(
      { path: "body.missing", variable: "x" },
      ctx,
    );
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/Extraction failed/);
  });

  it("supports delay cancellation", async () => {
    const ctx = new ExecutionContext();
    const promise = registry.resolve("DELAY").execute({ ms: 500 }, ctx);
    ctx.cancel();
    const result = await promise;
    expect(result.status).toBe("CANCELLED");
  });

  it("evaluates conditions", async () => {
    const ctx = new ExecutionContext({ status: "CREATED" });
    const ok = await registry.resolve("CONDITION").execute(
      { left: "{{status}}", op: "equals", right: "CREATED" },
      ctx,
    );
    expect(ok.status).toBe("PASSED");
  });

  it("masks secrets in nested payloads", () => {
    const masked = maskDeep({
      headers: { Authorization: "Bearer secret-token-value" },
      password: "hunter2",
    }) as { headers: { Authorization: string }; password: string };
    expect(masked.headers.Authorization).toContain("***");
    expect(masked.password).toBe("***");
  });
});
