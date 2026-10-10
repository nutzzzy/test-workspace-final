import type { ExpectedValue } from "./bindings";
import { isFormBody, parseForm, type InputAddress } from "./request-inputs";
import { semanticKeyOf, singular } from "./value-registry";

export type FlowHttpStep = {
  id: string;
  name: string;
  orderIndex: number;
  type?: string;
  config: Record<string, unknown>;
};

export type SampleResponse = {
  stepId: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Cookies a UI step's browser held. */
  cookies?: Record<string, string>;
};

export type DependencyLocation = "url" | "path" | "header" | "query" | "body" | "form" | "cookie";

export type DependencySuggestion = {
  id: string;
  producerStepId: string;
  producerName: string;
  consumerStepId: string;
  consumerName: string;
  sourcePath: string;
  variable: string;
  location: DependencyLocation;
  locationDetail: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  score: number;
  masked: boolean;
  /** The exact request input, addressed like saved mappings and recovery address it. */
  target: InputAddress & { key: string };
  /** response = the value was found in a real response; request = inferred from the requests only. */
  evidence: "response" | "request";
  /** Why it was proposed, for the UI. */
  reason: "same_value" | "auth_token" | "creates_entity" | "returns_entity" | "auth_user" | "recovered";
  /** Request-only suggestions: what to look for in the source response at run time. */
  expect?: ExpectedValue;
};

const COMMON = new Set([
  "0",
  "1",
  "true",
  "false",
  "null",
  "ok",
  "success",
  "error",
  "yes",
  "no",
  "***",
]);

type Leaf = { path: string; value: string; secret: boolean };

export function analyzeDependencies(
  steps: FlowHttpStep[],
  samples: SampleResponse[],
): DependencySuggestion[] {
  // HTTP steps consume and produce; a UI step produces too (cookies, storage, URL of the page it left).
  const flow = [...steps]
    .filter((step) => ["HTTP_REQUEST", "UI_FLOW"].includes(step.type ?? "HTTP_REQUEST"))
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const suggestions: DependencySuggestion[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < flow.length; index += 1) {
    const producer = flow[index];
    if (!producer) continue;
    const sample = samples.find((item) => item.stepId === producer.id);
    if (!sample) continue;
    const found = [...leaves(sample.body, sample.status), ...cookieLeaves(producer.type === "UI_FLOW" ? sample.cookies : undefined)];
    const counts = new Map<string, number>();
    for (const leaf of found) counts.set(leaf.value, (counts.get(leaf.value) ?? 0) + 1);

    for (const consumer of flow.slice(index + 1).filter((step) => (step.type ?? "HTTP_REQUEST") === "HTTP_REQUEST")) {
      for (const target of requestTargets(consumer.config)) {
        if (target.value.includes("{{")) continue;
        for (const leaf of found) {
          if (!tokenPresent(target.value, leaf.value)) continue;
          const unique = counts.get(leaf.value) === 1;
          const score = scoreMatch(leaf, target, unique);
          const confidence = score >= 0.85 ? "HIGH" : score >= 0.6 ? "MEDIUM" : "LOW";
          const key = `${producer.id}|${consumer.id}|${leaf.path}|${target.location}|${target.detail}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const shared = suggestions.find(
            (item) => item.producerStepId === producer.id && item.sourcePath === leaf.path,
          );
          suggestions.push({
            id: key,
            producerStepId: producer.id,
            producerName: producer.name,
            consumerStepId: consumer.id,
            consumerName: consumer.name,
            sourcePath: leaf.path,
            variable: shared?.variable ?? variableName(leaf.path, suggestions.map((item) => item.variable)),
            location: target.location,
            locationDetail: target.detail,
            confidence,
            score: Math.round(score * 100) / 100,
            masked: leaf.secret,
            target: target.address,
            evidence: "response",
            reason: "same_value",
          });
        }
      }
    }
  }

  return suggestions.sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath));
}

/** One scalar value inside a JSON document, with its path segments. */
export type ScalarLeaf = { segments: string[]; path: string; key: string; value: string };

/**
 * Walk a JSON value and return its scalar leaves (bounded depth/size). Shared
 * by design-time dependency discovery and runtime recovery so both read a
 * response the same way.
 */
export function collectScalarLeaves(body: unknown, limit = 200): ScalarLeaf[] {
  const found: ScalarLeaf[] = [];
  const visit = (value: unknown, path: string[], depth: number) => {
    if (found.length >= limit || depth > 8) return;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...path, key], depth + 1);
      }
      return;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    const text = String(value).trim();
    if (!text) return;
    found.push({
      segments: path,
      path: `$.${path.join(".")}`,
      key: path[path.length - 1] ?? "",
      value: text,
    });
  };
  visit(body, [], 0);
  return found;
}

function leaves(body: unknown, status?: number): Leaf[] {
  return collectScalarLeaves(body)
    .filter(
      (leaf) =>
        !COMMON.has(leaf.value.toLowerCase()) &&
        !(status !== undefined && leaf.value === String(status)) &&
        leaf.value.length >= 2,
    )
    .map((leaf) => ({
      path: leaf.path,
      value: leaf.value,
      secret: /token|password|secret|authorization|cookie|api[_-]?key/i.test(leaf.key),
    }));
}

/** Cookies of a UI step, addressed the way the value registry stores them. */
function cookieLeaves(cookies: Record<string, string> | undefined): Leaf[] {
  if (!cookies) return [];
  return Object.entries(cookies)
    .filter(([, value]) => typeof value === "string" && value.length >= 2 && !COMMON.has(value.toLowerCase()))
    .map(([name, value]) => ({ path: `response.cookies.${name}`, value, secret: true }));
}

type Target = { location: DependencyLocation; detail: string; value: string; address: InputAddress & { key: string } };

function requestTargets(config: Record<string, unknown>): Target[] {
  const targets: Target[] = [];
  if (typeof config.url === "string") targets.push(...urlTargets(config.url));
  const headers = asRecord(config.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (key.toLowerCase() === "cookie") {
      for (const part of value.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          const name = part.slice(0, eq).trim();
          targets.push({ location: "cookie", detail: name, value: part.slice(eq + 1).trim(), address: { location: "cookie", field: name, key: name } });
        }
      }
      continue;
    }
    targets.push({ location: "header", detail: key, value, address: { location: "header", field: key, key } });
  }
  const query = asRecord(config.query);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" || typeof value === "number") {
      targets.push({ location: "query", detail: key, value: String(value), address: { location: "query", field: key, key } });
    }
  }
  if (isFormBody({ body: config.body, headers: headers as Record<string, string> })) {
    for (const pair of parseForm(config.body as string)) {
      targets.push({ location: "form", detail: pair.key, value: pair.value, address: { location: "form", field: pair.key, key: pair.key } });
    }
  } else {
    collectBody(config.body, [], targets);
  }
  return targets;
}

/**
 * URL path segments (named after the collection before them: /trips/8912 →
 * tripId) and query parameters written into the URL. The host is never a target.
 */
function urlTargets(raw: string): Target[] {
  const targets: Target[] = [];
  const pathStart = raw.search(/[^/:]\/(?!\/)/);
  const rest = pathStart >= 0 ? raw.slice(pathStart + 1) : raw;
  const [path = "", query = ""] = rest.split("?");
  const segments = path.split("/");
  segments.forEach((segment, index) => {
    if (!segment || segment.includes("{{")) return;
    const previous = segments[index - 1] ?? "";
    const name = previous && !/\d/.test(previous) ? `${singular(previous).replace(/[^A-Za-z0-9]/g, "")}Id` : `segment${index}`;
    targets.push({ location: "path", detail: name, value: decodeSafe(segment), address: { location: "path", field: String(index), key: name } });
  });
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = decodeSafe(pair.slice(0, eq));
      targets.push({ location: "query", detail: key, value: decodeSafe(pair.slice(eq + 1)), address: { location: "query", field: key, key } });
    }
  }
  return targets;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectBody(value: unknown, path: string[], targets: Target[]) {
  if (typeof value === "string" || typeof value === "number") {
    const detail = path.reduce((out, part) => (/^\d+$/.test(part) ? `${out}[${part}]` : `${out}.${part}`), "body");
    const key = [...path].reverse().find((part) => !/^\d+$/.test(part)) ?? "body";
    targets.push({ location: "body", detail, value: String(value), address: { location: "body", field: path.join("."), key } });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBody(item, [...path, String(index)], targets));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectBody(child, [...path, key], targets);
    }
  }
}

function tokenPresent(haystack: string, needle: string): boolean {
  if (!needle || haystack === needle) return haystack === needle && needle.length > 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(haystack);
}

function scoreMatch(leaf: Leaf, target: Target, unique: boolean): number {
  let score = 0.4;
  const segment =
    (target.location === "url" && target.value.split(/[/?#=&]/).includes(leaf.value)) ||
    (target.location === "path" && target.value === leaf.value);
  if (segment) score += 0.35;
  if (target.location === "header" && /authorization/i.test(target.detail)) score += 0.4;
  else if (target.location === "header" || target.location === "cookie") score += 0.2;
  if (target.location === "query" || target.location === "form") score += 0.25;
  if (target.location === "body") score += 0.25;
  if (leaf.value.length >= 8) score += 0.15;
  if (unique) score += 0.1;
  const leafName = leaf.path.split(".").pop() ?? "";
  if (normalize(leafName) && normalize(leafName) === normalize(target.detail.split(".").pop() ?? "")) {
    score += 0.05;
  }
  if (leaf.value.length <= 2) score -= 0.45;
  return score;
}

/** Name a variable after what it identifies: $.data.trip.id → tripId. */
function variableName(path: string, taken: string[]): string {
  const segments = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  const key = segments[segments.length - 1] ?? "";
  const parent = [...segments.slice(0, -1)].reverse().find((segment) => !/^\d+$/.test(segment) && !/^(data|result|payload|body|response)$/i.test(segment));
  const leaf = semanticKeyOf(key, parent ? singular(parent) : "").replace(/[^A-Za-z0-9_]/g, "") || "value";
  const base = /^[A-Za-z_]/.test(leaf) ? leaf : `value${leaf}`;
  if (!taken.includes(base)) return base;
  let index = 2;
  while (taken.includes(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function normalize(value: string) {
  return value.replace(/[_-]/g, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function replaceToken(input: string, value: string, variable: string): string {
  if (!value) return input;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return input.replace(
    new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "g"),
    (_match, start: string, end: string) => `${start}{{${variable}}}${end}`,
  );
}
