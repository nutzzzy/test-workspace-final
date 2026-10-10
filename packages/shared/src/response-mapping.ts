/**
 * Response mapping: values an HTTP step extracts from its response into
 * scenario variables (`config.extract`), shared by the API (execution and
 * validation) and the web builder (editing and hints).
 *
 * Paths are a deliberately small, safe JSONPath subset — no wildcards, no
 * recursive descent, no filter or script expressions — parsed into segments
 * and walked without evaluating anything.
 */

export type ResponseMappingSource = "body" | "header" | "status";

export type ResponseMapping = {
  /** Variable name, used later as {{variable}}. */
  variable: string;
  /** body: JSONPath ($.data.items[0].id) · header: header name · status: ignored. */
  path: string;
  /** Where to read from; defaults to body. */
  from?: ResponseMappingSource;
  /** A missing or null value skips the variable instead of failing the step. */
  optional?: boolean;
  /** Always mask this value in logs and reports. */
  secret?: boolean;
};

export type JsonPathSegment = string | number;

export type JsonPathResult = { ok: true; segments: JsonPathSegment[] } | { ok: false; error: string };

/** Variable names usable as {{name}} in every request field. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** {{name}} references in a template (whitespace inside the braces is allowed). */
export const VARIABLE_REF = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DOT_NAME = /^[A-Za-z0-9_$-]+/;
const MAX_PATH_LENGTH = 500;

/**
 * Parse `$.data.user.id`, `$.items[0]`, `$.items[-1]` (last), `$['odd key']`
 * or a path without the leading `$` (`data.user.id`).
 */
export function parseJsonPath(input: string): JsonPathResult {
  const path = input.trim();
  if (!path) return { ok: false, error: "path is empty" };
  if (path.length > MAX_PATH_LENGTH) return { ok: false, error: "path is too long" };
  if (path.includes("..")) return { ok: false, error: "recursive descent (..) is not supported" };
  if (/[*?@()]/.test(path.replace(/\[\s*(['"]).*?\1\s*\]/g, ""))) {
    return { ok: false, error: "wildcards, filters and expressions are not supported" };
  }

  let rest = path;
  if (rest.startsWith("$")) rest = rest.slice(1);
  else if (!rest.startsWith("[")) rest = `.${rest}`;

  const segments: JsonPathSegment[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const name = DOT_NAME.exec(rest.slice(1))?.[0];
      if (!name) return { ok: false, error: `expected a property name at "${rest.slice(0, 20)}"` };
      segments.push(name);
      rest = rest.slice(1 + name.length);
      continue;
    }
    if (rest.startsWith("[")) {
      const index = /^\[\s*(-?\d+)\s*\]/.exec(rest);
      if (index) {
        segments.push(Number(index[1]));
        rest = rest.slice(index[0].length);
        continue;
      }
      const quoted = /^\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*\]/.exec(rest);
      if (quoted) {
        segments.push(quoted[2]!.replace(/\\(.)/g, "$1"));
        rest = rest.slice(quoted[0].length);
        continue;
      }
      return { ok: false, error: `invalid bracket at "${rest.slice(0, 20)}"` };
    }
    return { ok: false, error: `unexpected "${rest.slice(0, 20)}"` };
  }
  return { ok: true, segments };
}

/** Walk parsed segments. `found` is false when any segment is missing. */
export function readJsonPath(value: unknown, segments: JsonPathSegment[]): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return { found: false, value: undefined };
      const index = segment < 0 ? current.length + segment : segment;
      if (index < 0 || index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      // "0" on an array, written as a dot segment
      if (Array.isArray(current) && /^\d+$/.test(segment) && Number(segment) < current.length) {
        current = current[Number(segment)];
        continue;
      }
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** `$.data.items[0]['odd key']` from segments (for the builder's tree picker). */
export function formatJsonPath(segments: JsonPathSegment[]): string {
  return segments.reduce<string>((out, segment) => {
    if (typeof segment === "number") return `${out}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) return `${out}.${segment}`;
    return `${out}['${segment.replace(/(['\\])/g, "\\$1")}']`;
  }, "$");
}

export type MappingProblem = {
  index: number;
  variable: string;
  code: "invalid_name" | "duplicate_name" | "invalid_path" | "invalid_header" | "invalid_source" | "invalid_shape";
  detail: string;
};

/** Read `config.extract` leniently: malformed rows are reported by validateMappings. */
export function readMappings(config: Record<string, unknown> | null | undefined): ResponseMapping[] {
  const raw = config?.extract;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      variable: String(item.variable ?? "").trim(),
      path: String(item.path ?? "").trim(),
      ...(item.from !== undefined ? { from: item.from as ResponseMappingSource } : {}),
      ...(item.optional === true ? { optional: true } : {}),
      ...(item.secret === true ? { secret: true } : {}),
    }));
}

/** Every problem of a step's mappings; an empty list means they can be saved and run. */
export function validateMappings(raw: unknown): MappingProblem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [{ index: -1, variable: "", code: "invalid_shape", detail: "extract must be a list" }];
  const problems: MappingProblem[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push({ index, variable: "", code: "invalid_shape", detail: "each mapping must be an object" });
      return;
    }
    const row = item as Record<string, unknown>;
    const variable = typeof row.variable === "string" ? row.variable.trim() : "";
    const from = row.from ?? "body";
    if (!VARIABLE_NAME.test(variable)) {
      problems.push({ index, variable, code: "invalid_name", detail: variable || "(empty)" });
    } else if (seen.has(variable)) {
      problems.push({ index, variable, code: "duplicate_name", detail: variable });
    }
    seen.add(variable);
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (from === "body") {
      const parsed = parseJsonPath(path);
      if (!parsed.ok) problems.push({ index, variable, code: "invalid_path", detail: parsed.error });
    } else if (from === "header") {
      if (!HEADER_NAME.test(path)) problems.push({ index, variable, code: "invalid_header", detail: path || "(empty)" });
    } else if (from !== "status") {
      problems.push({ index, variable, code: "invalid_source", detail: String(from) });
    }
  });
  return problems;
}

/** Unique {{name}} references anywhere in a value (strings of nested objects too). */
export function findVariableRefs(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return [...new Set([...text.matchAll(VARIABLE_REF)].map((match) => match[1]!))];
}
