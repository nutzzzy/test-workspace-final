export type ResponseAnalysis = {
  status: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  contentType: string | null;
  importantFields: Array<{ path: string; label: string; preview: string; masked: boolean }>;
  candidateOutputs: Array<{ path: string; name: string; preview: string }>;
  arraySummaries: Array<{ path: string; length: number; fields: string[]; previewCount: number }>;
  errorInformation: { message: string; code: string | null } | null;
  warnings: string[];
};

const SECRET = /token|password|secret|authorization|cookie|api[_-]?key/i;
const USEFUL = /(id|status|state|code|message|error|total|page|result|type|name)$/i;

export function analyzeResponse(input: {
  status?: number | null;
  headers?: Record<string, string> | null;
  body?: unknown;
  durationMs?: number | null;
  raw?: string | null;
  consumedPaths?: string[];
}): ResponseAnalysis {
  const headers = input.headers ?? {};
  const contentType = header(headers, "content-type");
  const raw = input.raw ?? "";
  const sizeBytes = raw ? Buffer.byteLength(raw) : jsonSize(input.body);
  const consumed = new Set(input.consumedPaths ?? []);
  const important: ResponseAnalysis["importantFields"] = [];
  const outputs: ResponseAnalysis["candidateOutputs"] = [];
  const arrays: ResponseAnalysis["arraySummaries"] = [];

  const visit = (value: unknown, path: string[], depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      const fields = objectFields(value[0]);
      arrays.push({
        path: path.length ? `$.${path.join(".")}` : "$",
        length: value.length,
        fields,
        previewCount: Math.min(5, value.length),
      });
      if (value.length > 20) return;
      value.slice(0, 5).forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...path, key], depth + 1);
      }
      return;
    }
    if (path.length === 0) return;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    const jsonPath = `$.${path.join(".")}`;
    const leaf = path[path.length - 1] ?? "";
    const masked = SECRET.test(leaf);
    const useful = consumed.has(jsonPath) || USEFUL.test(leaf) || depth <= 2;
    if (!useful || important.length >= 12) return;
    const preview = masked ? "••••••••" : clip(String(value));
    important.push({ path: jsonPath, label: leaf, preview, masked });
    if (consumed.has(jsonPath) || (typeof value === "string" && value.length >= 4 && !masked)) {
      outputs.push({ path: jsonPath, name: leaf, preview });
    }
  };

  visit(input.body, [], 0);

  return {
    status: input.status ?? null,
    durationMs: input.durationMs ?? null,
    sizeBytes,
    contentType,
    importantFields: dedupe(important),
    candidateOutputs: dedupe(outputs).slice(0, 8),
    arraySummaries: arrays.filter((item) => item.length > 5).slice(0, 6),
    errorInformation: errorInfo(input.status, input.body),
    warnings: arrays.some((item) => item.length > 50)
      ? ["Large arrays are previewed. Open the raw response for every record."]
      : [],
  };
}

function errorInfo(status: number | null | undefined, body: unknown) {
  if (status == null || status < 400) return null;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = firstString(record, ["message", "error", "detail", "title"]) ?? `HTTP ${status}`;
  const code = firstString(record, ["code", "errorCode", "error_code"]);
  return { message, code };
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function header(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] ?? null : null;
}

function objectFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 8);
}

function jsonSize(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? ""));
  } catch {
    return 0;
  }
}

function clip(value: string) {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function dedupe<T extends { path: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}
