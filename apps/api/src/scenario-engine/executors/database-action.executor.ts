import type { DatabaseActionRequest } from "../../database-connectors/database-connectors.service";
import type { ExecutionContext, StepExecutionResult, StepExecutor } from "../types";

type DatabaseActionPort = {
  executeAction(input: DatabaseActionRequest): Promise<{
    result: { rows: Array<Record<string, unknown>>; rowCount: number };
    resolvedQuery: string;
  }>;
};

function asMapping(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && key.trim()) out[key] = item;
  }
  return out;
}

function bindSql(
  query: string,
  mapping: Record<string, string>,
  variables: Record<string, string>,
) {
  const bindings: string[] = [];
  const boundQuery = query.replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_, key: string) => {
      const source = mapping[key] ?? key;
      if (!(source in variables)) {
        throw new Error(`Unresolved variable: {{${key}}}`);
      }
      bindings.push(variables[source]);
      return `__wb_bind_${bindings.length - 1}__`;
    },
  );
  return { boundQuery, bindings };
}

function readPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, row);
}

function asVariable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export class DatabaseActionExecutor implements StepExecutor {
  readonly type = "DATABASE_ACTION";

  constructor(private readonly connectors: DatabaseActionPort) {}

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult> {
    if (context.isCancelled()) {
      return { status: "CANCELLED", error: "Cancelled before database action" };
    }

    const connectorId = String(config.connectorId ?? "").trim();
    const operation = String(config.operation ?? "SELECT");
    const query = String(config.query ?? "");
    const inputMapping = asMapping(config.inputMapping);
    const outputMapping = asMapping(config.outputMapping);
    const variables = context.entries();

    let bound: { boundQuery: string; bindings: string[] };
    try {
      bound = bindSql(query, inputMapping, variables);
    } catch (error) {
      return {
        status: "FAILED",
        error: error instanceof Error ? error.message : "Database step is invalid",
      };
    }

    const resolvedInput = context.redact({
      connectorId,
      operation,
      query: bound.boundQuery,
      bindings: bound.bindings.map((value) => context.redact(value)),
    });

    try {
      const executed = await this.connectors.executeAction({
        connectorId,
        operation,
        query,
        boundQuery: bound.boundQuery,
        bindings: bound.bindings,
        variables,
        inputMapping,
      });
      const assertionError = checkAssertion(
        operation,
        config,
        executed.result.rowCount,
        executed.result.rows,
      );
      if (assertionError) {
        return {
          status: "FAILED",
          error: assertionError,
          resolvedInput,
          output: context.redact({
            rowCount: executed.result.rowCount,
            rows: executed.result.rows,
            resolvedQuery: executed.resolvedQuery,
          }),
        };
      }
      const row = executed.result.rows[0] ?? {};
      const extracted: Record<string, string> = {};
      for (const [variable, path] of Object.entries(outputMapping)) {
        const value = asVariable(readPath(row, path));
        context.set(variable, value);
        extracted[variable] = value;
      }
      return {
        status: "PASSED",
        resolvedInput,
        extractedVars: extracted,
        output: context.redact({
          rowCount: executed.result.rowCount,
          rows: executed.result.rows,
          resolvedQuery: executed.resolvedQuery,
        }),
      };
    } catch (error) {
      return {
        status: "FAILED",
        error: error instanceof Error ? error.message : "Database step is invalid",
        resolvedInput,
      };
    }
  }
}

function checkAssertion(
  operation: string,
  config: Record<string, unknown>,
  rowCount: number,
  rows: Array<Record<string, unknown>>,
): string | null {
  const mode =
    config.assertion === "ROW_COUNT" || config.assertion === "CONTAINS"
      ? config.assertion
      : operation === "ASSERTION"
        ? "ROW_COUNT"
        : "";
  if (!mode) return null;
  const expected = typeof config.expected === "string" ? config.expected.trim() : "";
  if (!expected) return "Expected result is required";
  if (mode === "ROW_COUNT") {
    if (String(rowCount) !== expected) {
      return `Expected ${expected} row(s) but the query returned ${rowCount}`;
    }
    return null;
  }
  const blob = JSON.stringify(rows);
  if (!blob.includes(expected)) {
    return "The query result does not contain the expected value";
  }
  return null;
}
