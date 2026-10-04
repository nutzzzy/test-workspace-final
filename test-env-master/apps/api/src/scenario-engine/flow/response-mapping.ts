import {
  parseJsonPath,
  readJsonPath,
  readMappings,
  validateMappings,
  type ResponseMapping,
} from "@qa-workbench/shared";
import { isSecretKey } from "../../common/mask.util";
import type { ExecutionContext, ValueSource } from "../types";
import { isTokenKey } from "./value-registry";

/**
 * Response mapping at run time: after an HTTP step succeeds, each configured
 * mapping (`config.extract`) reads one value from the response into a
 * variable of this run's ExecutionContext. Values are only stored once every
 * required mapping succeeded, so a later step never sees half a step's output.
 */

export type ExtractionStatus = "EXTRACTED" | "MISSING" | "NULL" | "SKIPPED" | "INVALID";

/** What the run report shows per mapping. Never contains the value itself. */
export type ExtractionOutcome = {
  variable: string;
  from: "body" | "header" | "status";
  path: string;
  status: ExtractionStatus;
  type?: "string" | "number" | "boolean" | "object" | "array";
  secret?: boolean;
  reason?: string;
};

type MappedResponse = { status: number; headers: Record<string, string>; body: unknown; rawBody: string };

const SKIP_REASON = { MISSING: "not found in the response", NULL: "the value is null" } as const;

function valueType(value: unknown): ExtractionOutcome["type"] {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  if (typeof value === "number" || typeof value === "boolean") return typeof value as "number" | "boolean";
  return "string";
}

function describeTarget(mapping: ResponseMapping) {
  const from = mapping.from ?? "body";
  return from === "status" ? "response status" : from === "header" ? `header ${mapping.path}` : `body ${mapping.path}`;
}

/** response.body.data.user.id · response.headers.x-request-id · response.status */
function sourcePath(mapping: ResponseMapping) {
  const from = mapping.from ?? "body";
  if (from === "status") return "response.status";
  if (from === "header") return `response.headers.${mapping.path.toLowerCase()}`;
  const rest = mapping.path.trim().replace(/^\$/, "");
  return `response.body${rest === "" || /^[.[]/.test(rest) ? rest : `.${rest}`}`;
}

function looksSecret(mapping: ResponseMapping) {
  if (mapping.secret || isSecretKey(mapping.variable) || isTokenKey(mapping.variable)) return true;
  if ((mapping.from ?? "body") === "header") return isSecretKey(mapping.path);
  const parsed = parseJsonPath(mapping.path);
  return parsed.ok && parsed.segments.some((segment) => typeof segment === "string" && (isSecretKey(segment) || isTokenKey(segment)));
}

/** Read one mapping from a response; `found` is false for a missing path. */
function readMapping(mapping: ResponseMapping, response: MappedResponse): { found: boolean; value: unknown; reason?: string } {
  const from = mapping.from ?? "body";
  if (from === "status") return { found: true, value: response.status };
  if (from === "header") {
    const key = Object.keys(response.headers).find((name) => name.toLowerCase() === mapping.path.toLowerCase());
    return key === undefined ? { found: false, value: undefined } : { found: true, value: response.headers[key] };
  }
  const parsed = parseJsonPath(mapping.path);
  if (!parsed.ok) return { found: false, value: undefined, reason: `invalid path (${parsed.error})` };
  if (!response.rawBody.trim()) return { found: false, value: undefined, reason: "the response body is empty" };
  if (typeof response.body === "string" && parsed.segments.length > 0) {
    return { found: false, value: undefined, reason: "the response body is not JSON" };
  }
  return readJsonPath(response.body, parsed.segments);
}

/**
 * Apply a step's mappings to its response. Returns the outcomes for the
 * report and, when a required mapping failed, the error that fails the step
 * (naming the variable and path, never the value).
 */
export function runExtractions(
  config: Record<string, unknown>,
  response: MappedResponse,
  context: ExecutionContext,
  step: { stepId?: string; stepName: string; orderIndex: number },
): { outcomes: ExtractionOutcome[]; learned: Record<string, string>; error?: string } {
  const problems = validateMappings(config.extract);
  if (problems.length > 0) {
    const first = problems[0]!;
    return { outcomes: [], learned: {}, error: `Invalid response mapping ${first.variable ? `{{${first.variable}}}` : `#${first.index + 1}`}: ${first.code} (${first.detail})` };
  }
  const outcomes: ExtractionOutcome[] = [];
  const pending: Array<{ mapping: ResponseMapping; value: unknown; secret: boolean }> = [];
  const errors: string[] = [];

  for (const mapping of readMappings(config)) {
    const from = mapping.from ?? "body";
    const secret = looksSecret(mapping);
    const base = { variable: mapping.variable, from, path: from === "status" ? "status" : mapping.path, ...(secret ? { secret } : {}) };
    const read = readMapping(mapping, response);
    const failure = read.reason ? "INVALID" : !read.found ? "MISSING" : read.value === null ? "NULL" : null;
    if (failure) {
      const reason = read.reason ?? SKIP_REASON[failure as "MISSING" | "NULL"];
      if (mapping.optional) {
        outcomes.push({ ...base, status: "SKIPPED", reason });
      } else {
        outcomes.push({ ...base, status: failure, reason });
        errors.push(`Extraction failed for {{${mapping.variable}}} (${describeTarget(mapping)}): ${reason}`);
      }
      continue;
    }
    outcomes.push({ ...base, status: "EXTRACTED", type: valueType(read.value) });
    pending.push({ mapping, value: read.value, secret });
  }

  if (errors.length > 0) return { outcomes, learned: {}, error: errors.join("; ") };

  const learned: Record<string, string> = {};
  for (const { mapping, value, secret } of pending) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (secret) context.markSecret(text);
    context.set(mapping.variable, text);
    const source: ValueSource = {
      stepId: step.stepId,
      stepName: step.stepName,
      orderIndex: step.orderIndex,
      path: sourcePath(mapping),
    };
    context.describeVariable(mapping.variable, { type: valueType(value), source });
    // An explicit mapping wins over an auto-learned alias of the same name.
    context.pendingPaths.delete(mapping.variable);
    learned[mapping.variable] = text;
  }
  return { outcomes, learned };
}

// ---------------------------------------------------------------------------
// Raw JSON text bodies (e.g. from cURL)
// ---------------------------------------------------------------------------

export type TypedLookup = (name: string) => { value: unknown } | undefined;

/**
 * Substitute {{name}} in a JSON *text* body so the result stays valid JSON:
 * inside a string literal the value is JSON-escaped; a whole `"{{name}}"` or a
 * bare `{{name}}` takes the value's JSON form (numbers stay numbers, objects
 * stay objects). Unknown names are reported, not left in place.
 */
export function interpolateJsonText(
  text: string,
  lookup: TypedLookup,
): { text: string; used: string[]; missing: string[] } {
  const used: string[] = [];
  const missing: string[] = [];
  const at = (index: number) => {
    const match = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/.exec(text.slice(index));
    return match ? { name: match[1]!, length: match[0].length } : null;
  };
  const resolve = (name: string) => {
    const hit = lookup(name);
    if (hit === undefined) missing.push(name);
    else used.push(name);
    return hit;
  };
  const literal = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "null");

  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; ) {
    const char = text[index]!;
    if (!inString) {
      // bare {{name}} or a string that is exactly "{{name}}"
      const whole = char === '"' ? at(index + 1) : null;
      if (whole && text[index + 1 + whole.length] === '"') {
        const hit = resolve(whole.name);
        out += hit ? literal(hit.value) : '""';
        index += whole.length + 2;
        continue;
      }
      const bare = char === "{" ? at(index) : null;
      if (bare) {
        const hit = resolve(bare.name);
        out += hit ? literal(hit.value) : "null";
        index += bare.length;
        continue;
      }
      if (char === '"') inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === "\\") escaped = true;
    else if (char === '"') inString = false;
    else if (char === "{") {
      const inner = at(index);
      if (inner) {
        const hit = resolve(inner.name);
        if (hit) out += JSON.stringify(typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value)).slice(1, -1);
        index += inner.length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return { text: out, used: [...new Set(used)], missing: [...new Set(missing)] };
}

/** A string body that is (or is declared as) JSON. */
export function isJsonText(body: unknown, headers: Record<string, string> | undefined): body is string {
  if (typeof body !== "string" || !body.trim()) return false;
  const typeKey = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === "content-type");
  const type = typeKey ? String(headers?.[typeKey] ?? "").toLowerCase() : "";
  if (type.includes("json")) return true;
  if (type && !type.includes("text/plain")) return false;
  const trimmed = body.trim();
  // "{{payload}}" alone is a placeholder, not a JSON object.
  return (trimmed.startsWith("{") && !trimmed.startsWith("{{")) || trimmed.startsWith("[");
}

// ---------------------------------------------------------------------------
// Design-time catalog: who produces which variable
// ---------------------------------------------------------------------------

export type VariableProducer = {
  name: string;
  stepId?: string;
  stepName: string;
  orderIndex: number;
  kind: "mapping" | "extract_step" | "set_step" | "database";
  from?: "body" | "header" | "status";
  path?: string;
  optional?: boolean;
  secret?: boolean;
};

type CatalogStep = { id?: string; name: string; type: string; orderIndex: number; enabled: boolean; config: Record<string, unknown> };

/** Every variable the scenario's enabled steps declare, in step order. */
export function variableCatalog(steps: CatalogStep[]): VariableProducer[] {
  const out: VariableProducer[] = [];
  for (const step of [...steps].sort((a, b) => a.orderIndex - b.orderIndex)) {
    if (!step.enabled) continue;
    const base = { stepId: step.id, stepName: step.name, orderIndex: step.orderIndex };
    const config = step.config ?? {};
    if (step.type === "HTTP_REQUEST") {
      for (const mapping of readMappings(config)) {
        if (!mapping.variable) continue;
        out.push({
          ...base,
          name: mapping.variable,
          kind: "mapping",
          from: mapping.from ?? "body",
          path: mapping.path,
          ...(mapping.optional ? { optional: true } : {}),
          ...(looksSecret(mapping) ? { secret: true } : {}),
        });
      }
    } else if (step.type === "EXTRACT_VARIABLE" || step.type === "SET_VARIABLE") {
      const name = String(config.variable ?? "").replace(/[{}]/g, "").trim();
      if (name) {
        out.push({
          ...base,
          name,
          kind: step.type === "EXTRACT_VARIABLE" ? "extract_step" : "set_step",
          ...(step.type === "EXTRACT_VARIABLE" ? { path: String(config.path ?? "") } : {}),
          ...(isSecretKey(name) ? { secret: true } : {}),
        });
      }
    } else if (step.type === "DATABASE_ACTION" && config.outputMapping && typeof config.outputMapping === "object") {
      for (const name of Object.keys(config.outputMapping as Record<string, unknown>)) {
        out.push({ ...base, name, kind: "database", ...(isSecretKey(name) ? { secret: true } : {}) });
      }
    }
  }
  return out;
}

/**
 * Turn "Unresolved variable: {{x}}" into an actionable message: which step
 * should have produced it, or that it is used before it is produced.
 */
export function explainUnresolved(message: string, step: { orderIndex: number }, catalog: VariableProducer[]): string {
  const match = /^Unresolved variable: \{\{([^}]+)\}\}$/.exec(message);
  if (!match) return message;
  const name = match[1]!;
  const producers = catalog.filter((item) => item.name === name);
  const earlier = producers.filter((item) => item.orderIndex < step.orderIndex).pop();
  if (earlier) {
    return `Variable {{${name}}} was not produced: step ${earlier.orderIndex + 1} (${earlier.stepName}) did not provide it`;
  }
  const later = producers.find((item) => item.orderIndex >= step.orderIndex);
  if (later) return `Variable {{${name}}} is used before step ${later.orderIndex + 1} (${later.stepName}) produces it`;
  return message;
}
