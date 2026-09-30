import { ExecutionContext } from "./types";
import { StepExecutorRegistry } from "./step-executor.registry";
import { SetVariableExecutor } from "./executors/set-variable.executor";
import { DelayExecutor } from "./executors/delay.executor";
import { ConditionExecutor } from "./executors/condition.executor";
import { AssertionExecutor } from "./executors/assertion.executor";
import { orchestrateSteps } from "./orchestrate";
import { maskDeep } from "../common/mask.util";

function buildRegistry() {
  const registry = new StepExecutorRegistry();
  for (const ex of [
    new SetVariableExecutor(),
    new DelayExecutor(),
    new ConditionExecutor(),
    new AssertionExecutor(),
  ]) {
    registry.register(ex);
  }
  return registry;
}

describe("Phase 5 scenario advanced", () => {
  const registry = buildRegistry();

  it("SET_VARIABLE interpolates and stores values", async () => {
    const ctx = new ExecutionContext({ prefix: "ORD" });
    const result = await registry.resolve("SET_VARIABLE").execute(
      { variable: "order_id", value: "{{prefix}}-99" },
      ctx,
    );
    expect(result.status).toBe("PASSED");
    expect(ctx.get("order_id")).toBe("ORD-99");
  });

  it("rejects invalid SET_VARIABLE names", async () => {
    const ctx = new ExecutionContext();
    const result = await registry.resolve("SET_VARIABLE").execute(
      { variable: "bad name", value: "x" },
      ctx,
    );
    expect(result.status).toBe("FAILED");
  });

  it("DELAY respects cancellation", async () => {
    const ctx = new ExecutionContext();
    const promise = registry.resolve("DELAY").execute({ ms: 2000 }, ctx);
    setTimeout(() => ctx.cancel(), 30);
    const result = await promise;
    expect(result.status).toBe("CANCELLED");
  });

  it("CONDITION evaluates equals / contains / response paths", async () => {
    const ctx = new ExecutionContext({ status: "CREATED" });
    ctx.lastHttpResponse = {
      status: 201,
      headers: {},
      body: { data: { state: "READY" } },
      rawBody: "",
    };

    const ok = await registry.resolve("CONDITION").execute(
      { left: "{{status}}", op: "equals", right: "CREATED" },
      ctx,
    );
    expect(ok.status).toBe("PASSED");

    const bodyOk = await registry.resolve("CONDITION").execute(
      { left: "body.data.state", op: "equals", right: "READY" },
      ctx,
    );
    expect(bodyOk.status).toBe("PASSED");

    const failed = await registry.resolve("CONDITION").execute(
      { left: "{{status}}", op: "equals", right: "CANCELLED" },
      ctx,
    );
    expect(failed.status).toBe("FAILED");
  });

  it("executes steps in order and stops on failure when configured", async () => {
    const ctx = new ExecutionContext();
    const result = await orchestrateSteps(
      [
        {
          name: "set",
          type: "SET_VARIABLE",
          enabled: true,
          orderIndex: 0,
          config: { variable: "a", value: "1" },
        },
        {
          name: "fail",
          type: "CONDITION",
          enabled: true,
          orderIndex: 1,
          config: { left: "{{a}}", op: "equals", right: "2" },
        },
        {
          name: "after",
          type: "SET_VARIABLE",
          enabled: true,
          orderIndex: 2,
          config: { variable: "b", value: "should-not-run" },
        },
      ],
      registry,
      ctx,
      { stopOnFailure: true },
    );
    expect(result.status).toBe("FAILED");
    expect(result.stepResults.map((s) => s.name)).toEqual(["set", "fail"]);
    expect(ctx.get("b")).toBeUndefined();
  });

  it("continues after failure when stopOnFailure is false", async () => {
    const ctx = new ExecutionContext();
    const result = await orchestrateSteps(
      [
        {
          name: "fail",
          type: "CONDITION",
          enabled: true,
          orderIndex: 0,
          config: { left: "x", op: "equals", right: "y" },
        },
        {
          name: "set",
          type: "SET_VARIABLE",
          enabled: true,
          orderIndex: 1,
          config: { variable: "recovered", value: "yes" },
        },
      ],
      registry,
      ctx,
      { stopOnFailure: false },
    );
    expect(result.status).toBe("FAILED");
    expect(result.stepResults).toHaveLength(2);
    expect(ctx.get("recovered")).toBe("yes");
  });

  it("skips disabled steps and cancels mid-run", async () => {
    const ctx = new ExecutionContext();
    const promise = orchestrateSteps(
      [
        {
          name: "skip-me",
          type: "SET_VARIABLE",
          enabled: false,
          orderIndex: 0,
          config: { variable: "x", value: "1" },
        },
        {
          name: "wait",
          type: "DELAY",
          enabled: true,
          orderIndex: 1,
          config: { ms: 3000 },
        },
        {
          name: "late",
          type: "SET_VARIABLE",
          enabled: true,
          orderIndex: 2,
          config: { variable: "late", value: "1" },
        },
      ],
      registry,
      ctx,
      { stopOnFailure: true },
    );
    setTimeout(() => ctx.cancel(), 40);
    const result = await promise;
    expect(result.status).toBe("CANCELLED");
    expect(result.stepResults[0].status).toBe("SKIPPED");
    expect(ctx.get("late")).toBeUndefined();
  });

  it("rejects unknown StepType via registry", () => {
    expect(() => registry.resolve("SCRIPT")).toThrow(/Unknown StepType/);
  });

  it("masks secrets in nested execution payloads", () => {
    const masked = maskDeep({
      headers: { Authorization: "Bearer secret-token-value" },
      apiKey: "super-secret",
      nested: { password: "hunter2" },
    }) as {
      headers: { Authorization: string };
      apiKey: string;
      nested: { password: string };
    };
    expect(masked.headers.Authorization).toContain("***");
    expect(masked.apiKey).toBe("***");
    expect(masked.nested.password).toBe("***");
  });

  it("isolates variables across ExecutionContext instances", async () => {
    const a = new ExecutionContext({ token: "a" });
    const b = new ExecutionContext({ token: "b" });
    await registry.resolve("SET_VARIABLE").execute(
      { variable: "token", value: "changed" },
      a,
    );
    expect(a.get("token")).toBe("changed");
    expect(b.get("token")).toBe("b");
  });
});
