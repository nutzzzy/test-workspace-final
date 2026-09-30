export type FlowIssue = {
  stepId: string;
  severity: "error" | "warning";
  code:
    | "undefined_variable"
    | "used_before_source"
    | "missing_connector"
    | "invalid_url"
    | "duplicate_extraction"
    | "broken_extraction"
    | "circular";
  detail: string;
};

type ValidatedStep = {
  id: string;
  name: string;
  type: string;
  orderIndex: number;
  enabled: boolean;
  config: Record<string, unknown>;
};

const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function validateFlow(
  steps: ValidatedStep[],
  options: {
    environmentKeys?: string[];
    sampleBodies?: Record<string, unknown>;
  } = {},
): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const defined = new Set(options.environmentKeys ?? []);
  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const producers = new Map<string, number>();
  for (const step of ordered) {
    if (step.type !== "SET_VARIABLE" && step.type !== "EXTRACT_VARIABLE") continue;
    const variable = String(step.config.variable ?? step.config.key ?? "").trim();
    if (variable) producers.set(variable, step.orderIndex);
  }
  const extracted = new Map<string, string>();

  for (const step of ordered) {
    if (!step.enabled) continue;
    const text = JSON.stringify(step.config ?? {});
    const used = [...text.matchAll(VAR)].map((match) => match[1] ?? "").filter(Boolean);
    for (const name of used) {
      if (!defined.has(name)) {
        const later = producers.get(name);
        issues.push({
          stepId: step.id,
          severity: "error",
          code: later !== undefined && later > step.orderIndex ? "circular" : "used_before_source",
          detail: name,
        });
      }
    }

    if (step.type === "HTTP_REQUEST") {
      const url = typeof step.config.url === "string" ? step.config.url : "";
      if (url && !url.includes("{{") && !/^https?:\/\//i.test(url)) {
        issues.push({ stepId: step.id, severity: "error", code: "invalid_url", detail: url });
      }
    }

    if (step.type === "DATABASE_ACTION") {
      const connectorId = step.config.connectorId;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        issues.push({ stepId: step.id, severity: "error", code: "missing_connector", detail: step.name });
      }
    }

    if (step.type === "SET_VARIABLE" || step.type === "EXTRACT_VARIABLE") {
      const variable = String(step.config.variable ?? step.config.key ?? "").trim();
      if (variable) {
        if (extracted.has(variable)) {
          issues.push({
            stepId: step.id,
            severity: "warning",
            code: "duplicate_extraction",
            detail: variable,
          });
        }
        extracted.set(variable, step.id);
        defined.add(variable);
        producers.set(variable, step.orderIndex);
      }
    }

    if (step.type === "EXTRACT_VARIABLE") {
      const producerId = previousHttp(ordered, step.orderIndex);
      const sample = producerId ? options.sampleBodies?.[producerId] : undefined;
      const path = String(step.config.path ?? "");
      if (sample !== undefined && path && readBodyPath(sample, path) === undefined) {
        issues.push({ stepId: step.id, severity: "error", code: "broken_extraction", detail: path });
      }
    }
  }

  return issues;
}

function previousHttp(steps: ValidatedStep[], orderIndex: number) {
  const previous = [...steps]
    .filter((step) => step.type === "HTTP_REQUEST" && step.orderIndex < orderIndex)
    .sort((a, b) => b.orderIndex - a.orderIndex);
  return previous[0]?.id;
}

function readBodyPath(body: unknown, path: string): unknown {
  const cleaned = path.replace(/^\$\.?/, "").replace(/^body\.?/, "");
  if (!cleaned) return body;
  let current: unknown = body;
  for (const part of cleaned.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function flowHealth(input: {
  steps: ValidatedStep[];
  dependencies: number;
  issues: FlowIssue[];
}) {
  const http = input.steps.filter((step) => step.type === "HTTP_REQUEST").length;
  const extracts = input.steps.filter((step) => step.type === "EXTRACT_VARIABLE").length;
  const assertions = input.steps.filter((step) => step.type === "ASSERTION").length;
  const errors = input.issues.filter((issue) => issue.severity === "error").length;
  const warnings = input.issues.filter((issue) => issue.severity === "warning").length;
  return {
    ready: errors === 0,
    http,
    dependencies: input.dependencies,
    extracts,
    assertions,
    errors,
    warnings,
  };
}
