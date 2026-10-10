import { createHash } from "crypto";
import {
  headerKey,
  isFormBody,
  listInputTargets,
  parseForm,
  setInput,
  type HttpRequestSpec,
  type InputLocation,
  type RequestInputTarget,
} from "./request-inputs";
import { normKey, semanticKeyOf, singular, ValueRegistry, type RegistryEntry } from "./value-registry";

export type { HttpRequestSpec } from "./request-inputs";

/**
 * Deterministic failure recovery for HTTP steps.
 *
 * When a request fails its expectation, the planner compares every input of
 * the request (path, query, headers, cookies, JSON body, form fields) with the
 * Runtime Value Registry. A candidate is a substitution justified by named
 * evidence — a saved mapping, an exact semantic key (bikerId ↔ biker.id), an
 * exact key, … — with a categorical confidence. Nothing here guesses or
 * mutates values randomly; no evidence means no candidate.
 */

/** A successful earlier step, as kept in the runtime flow context. */
export type FlowHistoryEntry = {
  stepId?: string;
  orderIndex: number;
  name: string;
  response: { status: number; headers: Record<string, string>; body: unknown; cookies?: Record<string, string> };
};

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type FieldLocation = InputLocation;

export type CandidateReason =
  | "PREVIOUS_MAPPING"
  | "SEMANTIC_KEY"
  | "SAME_KEY"
  | "SAME_KEY_AMBIGUOUS"
  | "ENTITY_ID"
  | "URL_ENTITY"
  | "SIMILAR_KEY"
  | "AI_SUGGESTION"
  | "COMBINED"
  /** Chosen by the user in Manual Recovery (a previous value or a custom one). */
  | "MANUAL";

export type SourceRef = { stepId?: string; stepName: string; orderIndex: number; path: string; ref?: string };

export type CandidateChange = {
  location: FieldLocation;
  /** body path (a.b.0.c), query/header/form/cookie key, or URL segment index as text. */
  field: string;
  /** Field name the match was made on (bikerId). */
  fieldName: string;
  original: string;
  replacement: string;
  source: SourceRef;
  /** Where the original value came from, when it matches an earlier response. */
  originalSource: SourceRef | null;
};

/**
 * One retry. The top-level fields mirror the first change so stored traces
 * written before multi-field candidates keep their shape.
 */
export type RecoveryCandidate = CandidateChange & {
  changes: CandidateChange[];
  confidence: Confidence;
  reason: CandidateReason;
};

export type RecoveryAttempt = {
  candidate: RecoveryCandidate;
  status: number | null;
  expectationMet: boolean;
  failures: string[];
  error?: string;
  /** What was sent (redacted when persisted). */
  request?: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  durationMs?: number;
  /** Error message read from the response body. */
  message?: string;
  /** Chosen by the user in Manual Recovery rather than by the engine. */
  manual?: boolean;
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

export type StopReason =
  | "SUCCESS"
  | "MAX_ATTEMPTS"
  | "NO_CANDIDATES"
  | "CANDIDATES_EXHAUSTED"
  | "UNSAFE_ONLY"
  | "LOW_CONFIDENCE_ONLY"
  | "DISABLED"
  | "CANCELLED";

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
  /** Why the automatic loop ended. */
  stoppedBecause?: StopReason;
  /** The first request as sent, for the attempt history. */
  original?: { method: string; url: string; status: number | null; durationMs?: number; message?: string };
  /** Input most likely to be wrong, by deterministic evidence. */
  likelyField?: { location: FieldLocation; field: string; fieldName: string } | null;
  /** Duplicate candidates that were skipped (same effective request). */
  skippedDuplicates?: number;
  /** Set when the user fixed the step (or tried to) in Manual Recovery. */
  manual?: boolean;
  /** The user's manual mapping was saved on the step for future runs. */
  savedMapping?: boolean;
};

export type RecoverySettings = {
  enabled: boolean;
  maxAttempts: number;
  /** Retry MEDIUM candidates of safe (read-only) requests. */
  allowMedium: boolean;
  /** MEDIUM candidates were allowed explicitly, which also covers idempotent mutations. */
  allowMediumExplicit: boolean;
  /** The user states that repeating this mutating request is safe. */
  idempotent: boolean;
  /** Ask the configured model to rank LOW candidates when nothing stronger exists. */
  aiAssist: boolean;
  /**
   * Let automatic retries of a mutating request (POST/PUT/PATCH) change its
   * JSON body or form fields. Off by default: business data is never altered
   * just to obtain a passing status.
   */
  allowDataChanges: boolean;
};

/** Absolute ceiling for automatic retries of one step; a ceiling, not a target. */
export const MAX_RECOVERY_ATTEMPTS = 10;
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = MAX_RECOVERY_ATTEMPTS;
const MAX_CANDIDATES = 25;
const MAX_COMBINED_FIELDS = 4;

/** Read `config.recovery`; defaults: on, ≤10 attempts, HIGH + MEDIUM for safe requests, not idempotent. */
export function recoverySettings(config: Record<string, unknown>): RecoverySettings {
  const raw =
    config.recovery && typeof config.recovery === "object" && !Array.isArray(config.recovery)
      ? (config.recovery as Record<string, unknown>)
      : {};
  const max = Number(raw.maxAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS);
  return {
    enabled: raw.enabled !== false,
    maxAttempts: Number.isInteger(max) ? Math.min(Math.max(max, 0), MAX_RECOVERY_ATTEMPTS) : DEFAULT_MAX_RECOVERY_ATTEMPTS,
    allowMedium: raw.allowMedium !== false,
    allowMediumExplicit: raw.allowMedium === true,
    idempotent: raw.idempotent === true,
    aiAssist: raw.aiAssist === true,
    allowDataChanges: raw.allowDataChanges === true,
  };
}

export const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"];

/** The candidate rewrites request data (JSON body or form fields), not just identifiers or credentials. */
export function changesRequestData(candidate: RecoveryCandidate) {
  return (candidate.changes?.length ? candidate.changes : [candidate]).some(
    (change) => change.location === "body" || change.location === "form",
  );
}

/**
 * GET/HEAD/OPTIONS can be repeated. POST/PUT/PATCH only when the user marked
 * the step idempotent or the request carries an Idempotency-Key. DELETE is
 * never retried automatically.
 */
export function isRetrySafe(method: string, idempotent: boolean, headers?: Record<string, string>): boolean {
  const verb = method.toUpperCase();
  if (verb === "DELETE") return false;
  if (READ_ONLY_METHODS.includes(verb)) return true;
  if (idempotent) return true;
  const key = headerKey(headers, "idempotency-key") ?? headerKey(headers, "x-idempotency-key");
  return Boolean(key && String(headers?.[key] ?? "").trim());
}

/** Headers that change per request without changing what the request means. */
const VOLATILE_HEADERS = new Set(["traceparent", "tracestate", "date", "user-agent", "content-length", "x-request-start"]);

function sortedRecord(value: Record<string, string> | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, v]) => [key.toLowerCase(), v] as const)
      .filter(([key]) => !VOLATILE_HEADERS.has(key))
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

/** URL with the explicit query merged in and parameters sorted. */
function normalizedUrl(request: HttpRequestSpec) {
  try {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value));
    url.searchParams.sort();
    url.hash = "";
    return url.toString();
  } catch {
    return `${request.url}?${stableJson(request.query ?? {})}`;
  }
}

/** Identity of an effective request: method, URL + query, semantic headers, body or form fields. */
export function requestFingerprint(request: HttpRequestSpec): string {
  const body = isFormBody(request)
    ? { form: parseForm(request.body).map((pair) => `${pair.key}=${pair.value}`).sort() }
    : request.body ?? null;
  return createHash("sha256")
    .update(
      stableJson({
        method: request.method.toUpperCase(),
        url: normalizedUrl(request),
        headers: sortedRecord(request.headers),
        body,
      }),
    )
    .digest("hex");
}

/** Values too generic to identify anything. */
const GENERIC = /^(true|false|null|undefined|0|1|ok|yes|no|-)$/i;
const TOKEN_NAMES = ["token", "accesstoken", "jwt", "idtoken", "authtoken", "bearertoken", "sessiontoken"];

function tokens(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

/** Names a target is known by: its key, its semantic key and, for auth headers, token aliases. */
function wantedNames(target: RequestInputTarget): string[] {
  const names = new Set<string>();
  if (target.location === "header") {
    const lower = target.field.toLowerCase();
    if (lower === "authorization" || /token|jwt/.test(lower)) TOKEN_NAMES.forEach((name) => names.add(name));
    names.add(normKey(lower.replace(/^x-/, "")));
    return [...names];
  }
  names.add(normKey(target.key));
  if (target.location === "body") {
    // body.order.id → orderId
    const segments = target.field.split(".").filter((segment) => !/^\d+$/.test(segment));
    const parent = segments[segments.length - 2];
    if (parent) names.add(normKey(semanticKeyOf(target.key, singular(parent))));
  }
  return [...names];
}

const RANK: Record<Confidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

export type PlanOptions = {
  /** Mappings that already worked earlier in this run: field name → registry ref. */
  previousMappings?: Array<{ fieldName: string; ref: string }>;
};

function refOf(entry: RegistryEntry): SourceRef {
  return { stepId: entry.stepId, stepName: entry.stepName, orderIndex: entry.orderIndex, path: entry.path, ref: entry.ref };
}

function asRegistry(source: FlowHistoryEntry[] | ValueRegistry): ValueRegistry {
  if (source instanceof ValueRegistry) return source;
  const registry = new ValueRegistry();
  for (const entry of source) {
    registry.addResponse({ stepId: entry.stepId, stepName: entry.name, orderIndex: entry.orderIndex }, entry.response);
  }
  return registry;
}

/**
 * Candidate substitutions for a failed request, strongest first. A candidate
 * changes one field, or — once, when several fields each have a HIGH
 * candidate — all of them together. Values that already agree with an
 * earlier response of the same name are never touched.
 */
export function planRecoveryCandidates(
  request: HttpRequestSpec,
  history: FlowHistoryEntry[] | ValueRegistry,
  options: PlanOptions = {},
): RecoveryCandidate[] {
  const registry = asRegistry(history);
  const sources = registry.entries().filter((entry) => entry.text.length > 0);
  const singles: Array<RecoveryCandidate & { evidence: boolean; order: number }> = [];
  const seen = new Set<string>();
  let order = 0;

  const targets = listInputTargets(request).filter(
    (target) => target.currentValue.length >= 1 && !GENERIC.test(target.currentValue),
  );

  for (const target of targets) {
    const wanted = wantedNames(target);
    const bareId = wanted.length === 1 && wanted[0] === "id";
    const origin = [...sources].reverse().find((source) => source.text === target.currentValue) ?? null;

    const sameKey = sources.filter((source) => wanted.includes(normKey(source.key)));
    const semantic = sources.filter(
      (source) => source.semanticKey !== source.key && wanted.includes(normKey(source.semanticKey)),
    );
    // The value already agrees with a same-named source: no mismatch here.
    if ([...sameKey, ...semantic].some((source) => source.text === target.currentValue)) continue;

    const push = (entry: RegistryEntry, confidence: Confidence, reason: CandidateReason) => {
      if (GENERIC.test(entry.text) || entry.text === target.currentValue) return;
      const key = `${target.location}|${target.field}|${entry.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Named by convention only: a bare "id" or a URL segment.
      let level = confidence;
      let why = reason;
      if (target.location === "path") {
        level = lower(level, "MEDIUM");
        why = reason === "PREVIOUS_MAPPING" ? reason : "URL_ENTITY";
      } else if (bareId && reason !== "PREVIOUS_MAPPING") {
        level = lower(level, "MEDIUM");
      }
      const change: CandidateChange = {
        location: target.location,
        field: target.field,
        fieldName: target.key,
        original: target.currentValue,
        replacement: entry.text,
        source: refOf(entry),
        originalSource: origin ? refOf(origin) : null,
      };
      singles.push({ ...change, changes: [change], confidence: level, reason: why, evidence: Boolean(origin), order: order++ });
    };

    const pickAll = (pool: RegistryEntry[], unique: CandidateReason, ambiguous: CandidateReason, base: Confidence) => {
      // Most recent producer first: a later step's value is the likelier intent.
      const distinct = [...new Set([...pool].sort((a, b) => b.sequence - a.sequence).map((source) => source.text))];
      for (const value of distinct) {
        // The most recent step that produced the value.
        const entry = [...pool].reverse().find((item) => item.text === value)!;
        const single = distinct.length === 1;
        push(entry, single ? base : lower(base, "MEDIUM"), single ? unique : ambiguous);
      }
    };

    for (const mapping of options.previousMappings ?? []) {
      if (normKey(mapping.fieldName) !== normKey(target.key)) continue;
      const entry = registry.byRef(mapping.ref);
      if (entry) push(entry, "HIGH", "PREVIOUS_MAPPING");
    }
    pickAll(semantic, "SEMANTIC_KEY", "SAME_KEY_AMBIGUOUS", "HIGH");
    pickAll(sameKey, "SAME_KEY", "SAME_KEY_AMBIGUOUS", "HIGH");

    // Semantic similarity (LOW): currentTripId ↔ tripId. Never run without stronger evidence.
    const targetTokens = new Set(tokens(target.key));
    if (targetTokens.size > 1) {
      const similar = sources.filter((source) => {
        if (sameKey.includes(source) || semantic.includes(source)) return false;
        const parts = tokens(source.semanticKey);
        if (parts.length < 2 || !parts.every((part) => targetTokens.has(part))) return false;
        return target.type !== "number" || /^-?\d+(\.\d+)?$/.test(source.text);
      });
      pickAll(similar, "SIMILAR_KEY", "SIMILAR_KEY", "LOW");
    }
  }

  // One combined candidate when several fields each have a justified correction
  // (/orders/551?bikerId=20 → /orders/782?bikerId=901). Its confidence is the
  // weakest of its parts; it is tried first within that confidence.
  const bestByField = new Map<string, (typeof singles)[number]>();
  for (const candidate of singles) {
    const key = `${candidate.location}|${candidate.field}`;
    const current = bestByField.get(key);
    if (!current || RANK[candidate.confidence] < RANK[current.confidence]) bestByField.set(key, candidate);
  }
  const parts = [...bestByField.values()]
    .filter((candidate) => candidate.confidence !== "LOW")
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || a.order - b.order)
    .slice(0, MAX_COMBINED_FIELDS);
  const pool: Array<RecoveryCandidate & { evidence: boolean; order: number; combined?: boolean }> = [...singles];
  if (parts.length >= 2) {
    const changes = parts.flatMap((candidate) => candidate.changes);
    const confidence = parts.reduce<Confidence>((weakest, candidate) => lower(weakest, candidate.confidence), "HIGH");
    pool.push({ ...changes[0]!, changes, confidence, reason: "COMBINED", evidence: true, order: -1, combined: true });
  }

  return pool
    .sort(
      (a, b) =>
        RANK[a.confidence] - RANK[b.confidence] ||
        Number(Boolean(b.combined)) - Number(Boolean(a.combined)) ||
        Number(b.evidence) - Number(a.evidence) ||
        a.order - b.order,
    )
    .map(({ evidence: _evidence, order: _order, combined: _combined, ...candidate }) => candidate)
    .slice(0, MAX_CANDIDATES);
}

/** Apply one candidate (all of its changes) to a copy of the request. */
export function applyCandidate(request: HttpRequestSpec, candidate: RecoveryCandidate): HttpRequestSpec {
  const changes = candidate.changes?.length ? candidate.changes : [candidate];
  return changes.reduce((next, change) => setInput(next, change, change.replacement), request);
}

/**
 * The input most likely to be wrong: the field of the strongest candidate,
 * preferring one whose current value is known to belong to another key.
 */
export function likelyField(candidates: RecoveryCandidate[]): RecoveryTrace["likelyField"] {
  const singles = candidates.filter((candidate) => candidate.reason !== "COMBINED");
  const pick = singles.find((candidate) => candidate.originalSource) ?? singles[0];
  return pick ? { location: pick.location, field: pick.field, fieldName: pick.fieldName } : null;
}
