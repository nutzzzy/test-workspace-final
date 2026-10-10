import { assertValue, resolveResponsePath } from "../assert.util";
import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

export class AssertionExecutor implements StepExecutor {
  readonly type = "ASSERTION";

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    const kind = String(config.kind ?? "equals");
    const path = config.path
      ? context.interpolate(String(config.path))
      : undefined;
    const expected =
      config.expected === undefined
        ? undefined
        : context.interpolateDeep(config.expected);

    try {
      let actual: unknown = config.actual;

      if (path) {
        actual = resolveResponsePath(path, context.lastHttpResponse);
      } else if (kind === "status_code") {
        actual = context.lastHttpResponse?.status;
      } else if (typeof actual === "string") {
        actual = context.interpolate(actual);
      }

      assertValue(kind, actual, expected);
      return {
        status: "PASSED",
        resolvedInput: { kind, path, expected, actual },
        output: { ok: true },
      };
    } catch (error) {
      return {
        status: "FAILED",
        resolvedInput: { kind, path, expected },
        error: error instanceof Error ? error.message : "Assertion failed",
      };
    }
  }
}
