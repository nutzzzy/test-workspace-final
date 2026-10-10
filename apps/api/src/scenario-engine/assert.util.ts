/**
 * Resolve a JSON path such as `data.items[0].id`, `[0].id` (root array) or
 * `matrix[1][2]`. Returns undefined when any segment is missing.
 */
export function interpolatePath(obj: unknown, path: string): unknown {
  const cleaned = path
    .replace(/^\$\.?/, "")
    .replace(/^response\./, "")
    .trim();
  if (!cleaned) return obj;

  const tokens = [...cleaned.matchAll(/\[(\d+)\]|[^.[\]]+/g)].map((match) =>
    match[1] !== undefined ? Number(match[1]) : match[0],
  );
  let current: unknown = obj;
  for (const token of tokens) {
    if (typeof token === "number" || (Array.isArray(current) && /^\d+$/.test(token))) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(token)];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function resolveResponsePath(
  path: string,
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  } | null,
): unknown {
  if (!response) return undefined;
  const normalized = path.replace(/^response\./, "");

  if (normalized === "status" || normalized === "status_code") {
    return response.status;
  }
  if (normalized.startsWith("headers.")) {
    const header = normalized.slice("headers.".length);
    return (
      response.headers[header.toLowerCase()] ?? response.headers[header]
    );
  }
  if (normalized === "body") {
    return response.body;
  }
  if (normalized.startsWith("body.")) {
    return interpolatePath(response.body, normalized.slice("body.".length));
  }
  // Convenience: body.data.orderId without body. prefix
  return interpolatePath(
    { status: response.status, headers: response.headers, body: response.body },
    normalized,
  );
}

/** Short, readable rendering of a compared value for failure messages. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined (path not found)";
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Equality used by assertions. Values typed into the UI arrive as text, so a
 * scalar is compared by its text form (200 == "200", true == "true"); objects
 * and arrays are compared structurally, also against a JSON text.
 */
function coerceEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  const scalar = (value: unknown) =>
    typeof value === "number" || typeof value === "string" || typeof value === "boolean";
  if (scalar(actual) && scalar(expected)) return String(actual) === String(expected);
  if (actual && typeof actual === "object") {
    let target = expected;
    if (typeof expected === "string") {
      try {
        target = JSON.parse(expected);
      } catch {
        return false;
      }
    }
    return stableJson(actual) === stableJson(target);
  }
  return false;
}

export function assertValue(
  kind: string,
  actual: unknown,
  expected?: unknown,
): void {
  const got = describeValue(actual);
  const want = describeValue(expected);
  switch (kind) {
    case "status_code":
    case "equals":
      if (!coerceEquals(actual, expected)) {
        throw new Error(`Assertion equals failed: expected ${want}, got ${got}`);
      }
      break;
    case "not_equals":
      if (coerceEquals(actual, expected)) {
        throw new Error(`Assertion not_equals failed: both are ${got}`);
      }
      break;
    case "contains":
      if (typeof actual === "string" || typeof actual === "number") {
        if (!String(actual).includes(String(expected ?? ""))) {
          throw new Error(`Assertion contains failed: ${got} does not contain ${want}`);
        }
        break;
      }
      if (Array.isArray(actual)) {
        if (!actual.some((item) => coerceEquals(item, expected))) {
          throw new Error(`Assertion contains failed: the list ${got} has no item equal to ${want}`);
        }
        break;
      }
      throw new Error(
        `Assertion contains needs text, a number or a list, but the value is ${actual === null ? "null" : typeof actual}: ${got}`,
      );
    case "exists":
      if (actual === undefined || actual === null) {
        throw new Error(`Assertion exists failed: the value is ${got}`);
      }
      break;
    case "not_exists":
      if (actual !== undefined && actual !== null) {
        throw new Error(`Assertion not_exists failed: the value is ${got}`);
      }
      break;
    default:
      throw new Error(`Unknown assertion kind: ${kind}`);
  }
}
