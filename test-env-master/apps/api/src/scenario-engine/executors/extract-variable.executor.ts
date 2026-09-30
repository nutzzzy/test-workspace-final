import { interpolatePath } from "../assert.util";
import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

export class ExtractVariableExecutor implements StepExecutor {
  readonly type = "EXTRACT_VARIABLE";

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    const path = context.interpolate(String(config.path ?? ""));
    const variable = String(config.variable ?? "")
      .replace(/[{}]/g, "")
      .trim();
    if (!path || !variable) {
      return {
        status: "FAILED",
        error: "EXTRACT_VARIABLE requires path and variable",
      };
    }

    if (!context.lastHttpResponse) {
      return {
        status: "FAILED",
        error: "No HTTP response available for extraction",
        resolvedInput: { path, variable },
      };
    }

    const source = {
      status: context.lastHttpResponse.status,
      headers: context.lastHttpResponse.headers,
      body: context.lastHttpResponse.body,
    };

    let value: unknown;
    const normalized = path.replace(/^response\./, "");
    if (normalized === "status") {
      value = source.status;
    } else if (normalized.startsWith("headers.")) {
      const header = normalized.slice("headers.".length);
      value =
        source.headers[header.toLowerCase()] ?? source.headers[header];
    } else if (normalized.startsWith("body.")) {
      value = interpolatePath(source.body, normalized.slice("body.".length));
    } else if (normalized === "body") {
      value = source.body;
    } else {
      // Support response.body.data.orderId and body.data.orderId and data.orderId
      value =
        interpolatePath(source, normalized) ??
        interpolatePath(source.body, normalized);
    }

    if (value === undefined || value === null) {
      return {
        status: "FAILED",
        error: `Extraction failed for path: ${path}`,
        resolvedInput: { path, variable },
      };
    }

    const asString =
      typeof value === "string" ? value : JSON.stringify(value);
    context.set(variable, asString);
    return {
      status: "PASSED",
      resolvedInput: { path, variable },
      extractedVars: { [variable]: asString },
      output: { [variable]: asString },
    };
  }
}
