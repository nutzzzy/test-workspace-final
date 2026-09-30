import { resolveResponsePath } from "../assert.util";
import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

export class ConditionExecutor implements StepExecutor {
  readonly type = "CONDITION";

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    if (context.isCancelled()) {
      return { status: "CANCELLED", error: "Cancelled before condition" };
    }

    const leftRaw = String(config.left ?? "");
    const op = String(config.op ?? "equals");
    const right = context.interpolate(String(config.right ?? ""));

    let left = leftRaw;
    if (leftRaw.includes("{{")) {
      left = context.interpolate(leftRaw);
    } else if (
      leftRaw.startsWith("response.") ||
      leftRaw.startsWith("body.") ||
      leftRaw.startsWith("headers.") ||
      leftRaw === "status" ||
      leftRaw === "status_code"
    ) {
      const value = resolveResponsePath(leftRaw, context.lastHttpResponse);
      left = value === undefined || value === null ? "" : String(value);
    }

    let ok = false;
    switch (op) {
      case "equals":
        ok = left === right;
        break;
      case "not_equals":
        ok = left !== right;
        break;
      case "contains":
        ok = left.includes(right);
        break;
      case "exists":
        ok = left.length > 0;
        break;
      case "not_exists":
        ok = left.length === 0;
        break;
      default:
        return { status: "FAILED", error: `Unknown condition op: ${op}` };
    }

    if (!ok) {
      return {
        status: "FAILED",
        resolvedInput: { left, op, right },
        error: `Condition evaluated to false: ${JSON.stringify(left)} ${op} ${JSON.stringify(right)}`,
      };
    }
    return {
      status: "PASSED",
      resolvedInput: { left, op, right },
      output: { ok: true },
    };
  }
}
