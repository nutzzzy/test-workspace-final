import { ExecutionContext } from "./types";
import { StepExecutorRegistry } from "./step-executor.registry";
import { SetVariableExecutor } from "./executors/set-variable.executor";
import { DatabaseActionExecutor } from "./executors/database-action.executor";
import { orchestrateSteps } from "./orchestrate";
import type { DatabaseActionRequest } from "../database-connectors/database-connectors.service";

function fakePort(
  impl?: (input: DatabaseActionRequest) => Promise<{
    result: { rows: Array<Record<string, unknown>>; rowCount: number };
    resolvedQuery: string;
  }>,
) {
  const calls: DatabaseActionRequest[] = [];
  return {
    calls,
    async executeAction(input: DatabaseActionRequest) {
      calls.push(input);
      if (impl) return impl(input);
      return {
        result: {
          rows: [{ name: "Ada", password: "hunter2" }],
          rowCount: 1,
        },
        resolvedQuery: "SELECT name FROM users WHERE id = $1",
      };
    },
  };
}

describe("DATABASE_ACTION executor", () => {
  it("binds variables, extracts fields, and masks secrets", async () => {
    const port = fakePort();
    const executor = new DatabaseActionExecutor(port);
    const ctx = new ExecutionContext({ userId: "42", token: "Bearer abc.def" });
    const result = await executor.execute(
      {
        connectorId: "c1",
        operation: "SELECT",
        query: "SELECT name FROM users WHERE id = {{userId}} AND token = {{token}}",
        inputMapping: { userId: "userId", token: "token" },
        outputMapping: { user_name: "name" },
      },
      ctx,
    );

    expect(result.status).toBe("PASSED");
    expect(port.calls[0].bindings).toEqual(["42", "Bearer abc.def"]);
    expect(port.calls[0].boundQuery).toBe(
      "SELECT name FROM users WHERE id = __wb_bind_0__ AND token = __wb_bind_1__",
    );
    expect(ctx.get("user_name")).toBe("Ada");
    expect(JSON.stringify(result.resolvedInput)).not.toContain("Bearer abc.def");
    expect(JSON.stringify(result.output)).not.toContain("hunter2");
    expect(JSON.stringify(result.output)).toContain("Ada");
  });

  it("returns failed when the connector rejects the step", async () => {
    const executor = new DatabaseActionExecutor({
      executeAction: async () => {
        throw new Error("Connector is inactive");
      },
    });
    const result = await executor.execute(
      { connectorId: "c1", operation: "SELECT", query: "SELECT 1" },
      new ExecutionContext(),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("Connector is inactive");
  });

  it("cancels before opening a connection", async () => {
    const port = fakePort();
    const executor = new DatabaseActionExecutor(port);
    const ctx = new ExecutionContext();
    ctx.cancel();
    const result = await executor.execute(
      { connectorId: "c1", operation: "SELECT", query: "SELECT 1" },
      ctx,
    );
    expect(result.status).toBe("CANCELLED");
    expect(port.calls).toHaveLength(0);
  });

  it("runs in order and can continue after a database failure", async () => {
    const registry = new StepExecutorRegistry();
    registry.register(new SetVariableExecutor());
    registry.register(
      new DatabaseActionExecutor({
        executeAction: async (input) => {
          if (input.connectorId === "bad") throw new Error("Database connector not found");
          return {
            result: { rows: [{ name: "ok" }], rowCount: 1 },
            resolvedQuery: "SELECT 1",
          };
        },
      }),
    );
    const ctx = new ExecutionContext();
    const result = await orchestrateSteps(
      [
        {
          name: "set",
          type: "SET_VARIABLE",
          enabled: true,
          orderIndex: 0,
          config: { variable: "userId", value: "7" },
        },
        {
          name: "db-fail",
          type: "DATABASE_ACTION",
          enabled: true,
          orderIndex: 1,
          config: {
            connectorId: "bad",
            operation: "SELECT",
            query: "SELECT 1",
            continueOnFailure: true,
          },
        },
        {
          name: "db-ok",
          type: "DATABASE_ACTION",
          enabled: true,
          orderIndex: 2,
          config: {
            connectorId: "good",
            operation: "SELECT",
            query: "SELECT {{userId}}",
            outputMapping: { found: "name" },
          },
        },
      ],
      registry,
      ctx,
      { stopOnFailure: true },
    );

    expect(result.stepResults.map((step) => step.status)).toEqual([
      "PASSED",
      "FAILED",
      "PASSED",
    ]);
    expect(ctx.get("found")).toBe("ok");
    expect(ctx.get("userId")).toBe("7");
  });
});
