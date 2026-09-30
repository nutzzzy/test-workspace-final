import { createHash } from "crypto";
import { collectScalarLeaves } from "./dependency-analyzer";

/**
 * Deterministic failure recovery for HTTP steps.
 *
 * When a request fails its expectation, the planner looks for a request value
 * that disagrees with what earlier successful steps returned for a field of
 * the same name (e.g. body.bikerId = 125, but Step 1 returned
 * data.bikerId = 9821 and 125 was Step 1's data.userId). Each candidate is one
 * substitution with an explicit source and a categorical confidence. Nothing
 * here guesses or mutates values randomly; no candidate means no retry.
 */

/** A resolved (already interpolated) HTTP request. */
export type HttpRequestSpec = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};

/** A successful earlier step, as kept in the runtime flow context. */
export type FlowHistoryEntry = {
  orderIndex: number;
  name: string;
  response: { status: number; headers: Record<string, string>; body: unknown };
};

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type FieldLocation = "body" | "query" | "url";

export type RecoveryCandidate = {
  location: FieldLocation;
  /** body path (a.b.0.c), query key, or URL segment index as text. */
  field: string;
  /** Field name the match was made on (bikerId). */
  fieldName: string;
  original: string;
  replacement: string;
  source: { stepName: string; orderIndex: number; path: string };
  /** Where the original value came from, when it matches an earlier response. */
  originalSource: { stepName: string; orderIndex: number; path: string } | null;
  confidence: Confidence;
  reason: "SAME_KEY" | "SAME_KEY_AMBIGUOUS" | "ENTITY_ID" | "URL_ENTITY";
};

export type RecoveryAttempt = {
  candidate: RecoveryCandidate;
  status: number | null;
  expectationMet: boolean;
  failures: string[];
  error?: string;
};

export type RecoveryOutcome =
  /** The response met its expectation; nothing to recover. */
  | "NOT_NEEDED"
  /** Recovery is disabled for this step. */
  | "DISABLED"
  /** No justified candidate exists; nothing was retried. */
  | "NO_CANDIDATE"
  /** Candidates exist but retrying is not safe or not allowed; shown to the user. */
  | "SUGGESTED"
  /** A retry met the HTTP expectation and every attached assertion. */
  | "RECOVERED"
  /** Every allowed attempt failed, or the budget ran out. */
  | "FAILED";

export type RecoveryTrace = {
  outcome: RecoveryOutcome;
  originalStatus: number | null;
  failures: string[];
  attempts: RecoveryAttempt[];
  /** Candidates that were not executed (unsafe method, confidence too low, over budget). */
  suggestions: RecoveryCandidate[];
  /** Why suggestions were not executed. */
  blockedReason?: "UNSAFE_METHOD" | "CONFIDENCE" | "BUDGET" | "DUPLICATE_REQUEST";
  maxAttempts: number;
};

export type RecoverySettings = {
  enabled: boolean;
  maxAttempts: number;
  allowMedium: boolean;
  /** The user states that repeating this mutating request is safe. */
  idempotent: boolean;
};

export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;
const HARD_MAX_ATTEMPTS = 5;

/** Read `config.recovery`; defaults: on, 3 attempts, HIGH only, not idempotent. */
export function recoverySettings(config: Record<string, unknown>): RecoverySettings {
  const raw =
    config.recovery && typeof config.recovery === "object" && !Array.isArray(config.recovery)
      ? (config.recovery as Record<string, unknown>)
      : {};
  const max = Number(raw.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS);
  return {
    enabled: raw.enabled !== false,
    maxAttempts: Number.isInteger(max) ? Math.min(Math.max(max, 0), HARD_MAX_ATTEMPTS) : DEFAULT_MAX_RECOVERY_ATTEMPTS,
    allowMedium: raw.allowMedium === true,
    idempotent: raw.idempotent === true,
  };
}

/**
 * GET/HEAD/OPTIONS can be repeated. POST/PUT/PATCH only when the user marked
 * the step idempotent. DELETE is never retried automatically.
 */
export function isRetrySafe(method: string, idempotent: boolean): boolean {
  const verb = method.toUpperCase();
  if (verb === "DELETE") return false;
  if (["GET", "HEAD", "OPTIONS"].includes(verb)) return true;
  return idempotent;
}

function sortedRecord(value: Record<string, string> | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, v]) => [key.toLowerCase(), v] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identity of an effective request: method, URL, headers, query and body. */
export function requestFingerprint(request: HttpRequestSpec): string {
  return createHash("sha256")
    .update(
      stableJson({
        method: request.method.toUpperCase(),
        url: request.url,
        headers: sortedRecord(request.headers),
        query: sortedRecord(request.query),
        body: request.body ?? null,
      }),
    )
    .digest("hex");
}

const norm = (key: string) => key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

/** Values too generic to identify anything. */
const GENERIC = /^(true|false|null|0|1|ok|yes|no)$/i;

type Field = { location: FieldLocation; field: string; name: string; value: string };

function requestFields(request: HttpRequestSpec): Field[] {
  const fields: Field[] = [];
  for (const leaf of collectScalarLeaves(request.body)) {
    if (!leaf.key || /^\d+$/.test(leaf.key)) continue;
    fields.push({ location: "body", field: leaf.segments.join("."), name: leaf.key, value: leaf.value });
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    fields.push({ location: "query", field: key, name: key, value: String(value) });
  }
  // A URL segment is named after the collection before it: /bikers/125 → biker id.
  try {
    const segments = new URL(request.url).pathname.split("/");
    segments.forEach((segment, index) => {
      const previous = segments[index - 1] ?? "";
      if (!segment || !previous || !/^[A-Za-z0-9_-]+$/.test(segment)) return;
      if (!/\d/.test(segment)) return; // identifiers only; skip words like "activate"
      const entity = previous.replace(/ies$/i, "y").replace(/s$/i, "");
      fields.push({ location: "url", field: String(index), name: `${entity}Id`, value: decodeURIComponent(segment) });
    });
  } catch {
    // unparsable URL: no URL fields
  }
  return fields.filter((item) => item.value.length >= 2 && !GENERIC.test(item.value));
}

type Source = { stepName: string; orderIndex: number; path: string; key: string; parent: string; value: string };

function historySources(history: FlowHistoryEntry[]): Source[] {
  return history.flatMap((entry) =>
    collectScalarLeaves(entry.response.body).map((leaf) => ({
      stepName: entry.name,
      orderIndex: entry.orderIndex,
      path: leaf.path.replace(/^\$\.?/, "response.body."),
      key: leaf.key,
      parent: [...leaf.segments].reverse().find((segment, index) => index > 0 && !/^\d+$/.test(segment)) ?? "",
      value: leaf.value,
    })),
  );
}

const RANK: Record<Confidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Candidate substitutions for a failed request, strongest first. One
 * candidate changes exactly one field; values that already agree with an
 * earlier response of the same name are never touched.
 */
export function planRecoveryCandidates(
  request: HttpRequestSpec,
  history: FlowHistoryEntry[],
): RecoveryCandidate[] {
  const sources = historySources(history);
  const candidates: RecoveryCandidate[] = [];
  const seen = new Set<string>();

  for (const field of requestFields(request)) {
    const wanted = norm(field.name);
    const origin = sources.find((source) => source.value === field.value) ?? null;
    const originalSource = origin
      ? { stepName: origin.stepName, orderIndex: origin.orderIndex, path: origin.path }
      : null;

    // HIGH: an earlier response has a key with exactly this field's name.
    const sameKey = sources.filter((source) => norm(source.key) === wanted);
    // MEDIUM: entity id by structure, e.g. field bikerId ↔ response biker.id.
    const entityId = sources.filter(
      (source) => norm(source.key) === "id" && source.parent && `${norm(source.parent)}id` === wanted,
    );

    // The value already agrees with a same-named source: no mismatch here.
    if ([...sameKey, ...entityId].some((source) => source.value === field.value)) continue;

    const pick = (pool: Source[], confidence: Confidence, reason: RecoveryCandidate["reason"]) => {
      const distinct = [...new Set(pool.map((source) => source.value))];
      for (const value of distinct) {
        const source = [...pool].reverse().find((item) => item.value === value)!;
        const key = `${field.location}|${field.field}|${value}`;
        if (seen.has(key) || GENERIC.test(value)) continue;
        seen.add(key);
        const ambiguous = distinct.length > 1;
        const level: Confidence = ambiguous && confidence === "HIGH" ? "MEDIUM" : confidence;
        candidates.push({
          location: field.location,
          field: field.field,
          fieldName: field.name,
          original: field.value,
          replacement: value,
          source: { stepName: source.stepName, orderIndex: source.orderIndex, path: source.path },
          originalSource,
          // A bare "id" or a URL segment is named by convention only.
          confidence: field.location === "url" || wanted === "id" ? "MEDIUM" : level,
          reason: ambiguous && reason === "SAME_KEY" ? "SAME_KEY_AMBIGUOUS" : field.location === "url" ? "URL_ENTITY" : reason,
        });
      }
    };
    pick(sameKey, "HIGH", "SAME_KEY");
    pick(entityId, "MEDIUM", "ENTITY_ID");
  }

  return candidates.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
}

/** Apply one candidate to a copy of the request. */
export function applyCandidate(request: HttpRequestSpec, candidate: RecoveryCandidate): HttpRequestSpec {
  const next: HttpRequestSpec = structuredClone(request);
  if (candidate.location === "query") {
    next.query = { ...(next.query ?? {}), [candidate.field]: candidate.replacement };
    return next;
  }
  if (candidate.location === "url") {
    const url = new URL(next.url);
    const segments = url.pathname.split("/");
    segments[Number(candidate.field)] = encodeURIComponent(candidate.replacement);
    url.pathname = segments.join("/");
    next.url = url.toString();
    return next;
  }
  const parts = candidate.field.split(".");
  let cursor: unknown = next.body;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return next;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  const leaf = parts[parts.length - 1]!;
  if (cursor && typeof cursor === "object") {
    const record = cursor as Record<string, unknown>;
    // Keep the original JSON type: a numeric id stays a number.
    record[leaf] =
      typeof record[leaf] === "number" && Number.isFinite(Number(candidate.replacement))
        ? Number(candidate.replacement)
        : candidate.replacement;
  }
  return next;
}
