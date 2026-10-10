import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

export class SetVariableExecutor implements StepExecutor {
  readonly type = "SET_VARIABLE";

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    if (context.isCancelled()) {
      return { status: "CANCELLED", error: "Cancelled before set variable" };
    }

    const variable = String(config.variable ?? "").replace(/[{}]/g, "").trim();
    if (!variable) {
      return { status: "FAILED", error: "SET_VARIABLE requires variable" };
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(variable)) {
      return { status: "FAILED", error: "Invalid variable name" };
    }

    const rawValue = config.value;
    const value =
      typeof rawValue === "string"
        ? context.interpolate(rawValue)
        : rawValue === undefined || rawValue === null
          ? ""
          : context.interpolate(String(rawValue));

    context.set(variable, value);
    return {
      status: "PASSED",
      resolvedInput: { variable, value },
      extractedVars: { [variable]: value },
      output: { [variable]: value },
    };
  }
}
