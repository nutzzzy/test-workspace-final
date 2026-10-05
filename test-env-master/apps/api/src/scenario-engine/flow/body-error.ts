import type { StepBinding } from "./bindings";
import { listInputTargets, type HttpRequestSpec, type InputAddress, type RequestInputTarget } from "./request-inputs";
import { normKey } from "./value-registry";

/**
 * Errors an API reports in the response body, whatever the status code says.
 * Many APIs answer 200 with { "success": false, "message": "Order not found" };
 * a step like that has not done its job. The error is also tied to the request
 * input it is about (a field the body names, or one the message mentions), and
 * to the mapping that fills that input, so the user — and automatic recovery —
 * know where to look.
 */
export type ResponseError = {
  message: string;
  code: string | null;
  /** Which part of the body showed the error, e.g. `success = false`. */
  signal: string;
  /** The request input the error is about, when it can be told. */
  field: (InputAddress & { key: string }) | null;
  /** How the field was found: the body named it, or the message mentions it. */
  fieldEvidence: "named" | "mentioned" | "auth" | null;
  /** The saved mapping that fills that field, if any. */
  mapping: { stepName: string | null; orderIndex: number | null; path: string | null; fixedValue: boolean } | null;
};

type Json = Record<string, unknown>;

const FLAG_KEYS = ["success", "succeeded", "isSuccess", "is_success", "ok", "isSuccessful", "successful"];
const STATUS_KEYS = ["status", "result", "outcome", "state"];
const FAILED_WORDS = /^(error|errors|fail|failed|failure|fault|invalid|denied|rejected|unauthorized|forbidden)$/i;
const MESSAGE_KEYS = ["message", "msg", "error_description", "errorMessage", "error_message", "detail", "description", "title", "reason"];
const CODE_KEYS = ["errorCode", "error_code", "code", "errCode", "statusCode", "status_code"];
const FIELD_KEYS = ["field", "fieldName", "field_name", "param", "parameter", "property", "path", "key", "attribute", "name", "loc"];
const AUTH_WORDS = /(token|unauthori[sz]ed|unauthenticated|authenticat|session|expired|signature|jwt|bearer|login|credential|not logged)/i;
/** Codes that mean "fine" in APIs that always send a code. */
const OK_CODES = /^(0|00|000|200|201|204|ok|success|succeeded|none)$/i;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function pick(record: Json, keys: string[]): string | null {
  for (const key of keys) {
    const found = Object.keys(record).find((item) => item.toLowerCase() === key.toLowerCase());
    const value = found ? text(record[found]) : null;
    if (value) return value;
  }
  return null;
}

/** First readable message of an error value: a string, { message }, or a list of those. */
function messageOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(messageOf).filter((item): item is string => Boolean(item));
    return parts.length ? parts.slice(0, 3).join("; ") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  return pick(record, MESSAGE_KEYS) ?? pick(record, ["error"]);
}

/** A field the error names explicitly: { field: "orderId" }, errors[0].param, FastAPI loc: ["body", "orderId"]. */
function namedField(value: unknown): string | null {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    for (const key of FIELD_KEYS) {
      const found = Object.keys(record).find((name) => name.toLowerCase() === key.toLowerCase());
      if (!found) continue;
      const raw = record[found];
      const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      const name = text(last);
      if (name && /^[A-Za-z_][\w.[\]-]{0,80}$/.test(name)) return name.split(".").pop()!.replace(/\[\d+\]$/, "");
    }
  }
  return null;
}

/**
 * Validation maps like { errors: { orderId: ["is required"] } }: the keys are
 * the fields.
 */
function fieldMap(value: unknown): { field: string; message: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, item] of Object.entries(record)) {
    const message = messageOf(item);
    if (message && /^[A-Za-z_][\w-]{0,80}$/.test(key)) return { field: key, message: `${key}: ${message}` };
  }
  return null;
}

/**
 * The error the body reports, or null when it reports none. Only clear
 * signals count — a top-level failure flag, a failure status word, or a
 * non-empty error/errors member — so an entity whose own `status` is
 * "FAILED" deeper in the body is not mistaken for an error.
 */
export function detectBodyError(body: unknown): Omit<ResponseError, "field" | "fieldEvidence" | "mapping"> & { named: string | null } | null {
  const root = asRecord(body);
  if (!root) return null;
  const result = (signal: string, message: string | null, named: string | null) => ({
    message: (message ?? "The response reports an error").slice(0, 300),
    code: (() => {
      const code = pick(root, CODE_KEYS);
      return code && !OK_CODES.test(code) ? code.slice(0, 60) : null;
    })(),
    signal,
    named,
  });

  const errorsMember = Object.keys(root).find((key) => /^errors?$/i.test(key));
  const errorsValue = errorsMember ? root[errorsMember] : undefined;
  const hasErrors =
    errorsValue !== undefined &&
    errorsValue !== null &&
    errorsValue !== false &&
    !(Array.isArray(errorsValue) && errorsValue.length === 0) &&
    !(typeof errorsValue === "string" && !errorsValue.trim()) &&
    !(asRecord(errorsValue) && Object.keys(asRecord(errorsValue)!).length === 0);
  const generalMessage = () => pick(root, MESSAGE_KEYS) ?? (hasErrors ? (messageOf(errorsValue) ?? fieldMap(errorsValue)?.message ?? null) : null);
  const generalField = () => (hasErrors ? (namedField(errorsValue) ?? fieldMap(errorsValue)?.field ?? null) : null) ?? namedField(root);

  for (const key of FLAG_KEYS) {
    const found = Object.keys(root).find((name) => name.toLowerCase() === key.toLowerCase());
    if (!found) continue;
    const value = root[found];
    if (value === false || value === "false" || value === 0) return result(`${found} = false`, generalMessage(), generalField());
    if (value === true || value === "true") return null;
  }
  for (const key of STATUS_KEYS) {
    const found = Object.keys(root).find((name) => name.toLowerCase() === key.toLowerCase());
    const value = found ? root[found] : undefined;
    if (typeof value === "string" && FAILED_WORDS.test(value.trim())) return result(`${found} = "${value.trim()}"`, generalMessage(), generalField());
  }
  if (hasErrors) {
    // A message is only an error when there is no data next to it (GraphQL sends both on partial success).
    const data = Object.keys(root).find((key) => /^(data|result|payload)$/i.test(key));
    if (data && root[data] !== null && root[data] !== undefined && Array.isArray(errorsValue)) {
      return result(`${errorsMember} (with partial data)`, generalMessage(), generalField());
    }
    return result(errorsMember!, generalMessage(), generalField());
  }
  // Some APIs always send a code; a non-OK code next to a message is an error.
  const errorCode = pick(root, ["errorCode", "error_code", "errCode"]);
  if (errorCode && !OK_CODES.test(errorCode)) return result(`errorCode = ${errorCode}`, pick(root, MESSAGE_KEYS), namedField(root));
  return null;
}

/** Words of a key: orderId → order id, order_id → order id. */
function words(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .toLowerCase()
    .trim();
}

function mentions(message: string, key: string) {
  const spoken = words(key);
  if (spoken.length < 2) return false;
  const haystack = ` ${words(message)} `;
  return haystack.includes(` ${spoken} `) || message.toLowerCase().includes(key.toLowerCase());
}

/**
 * The request input an error is about: the field the body names, else a
 * field the message mentions (longest name wins: "orderItemId" over "id"),
 * else — for token/session errors — the credential header or cookie.
 */
export function linkErrorToInput(
  error: { message: string; named: string | null },
  request: HttpRequestSpec,
): { field: (InputAddress & { key: string }) | null; evidence: ResponseError["fieldEvidence"] } {
  let targets: RequestInputTarget[] = [];
  try {
    targets = listInputTargets(request);
  } catch {
    return { field: null, evidence: null };
  }
  const address = (target: RequestInputTarget) => ({ location: target.location, field: target.field, key: target.key });
  if (error.named) {
    const wanted = normKey(error.named);
    const match = targets.find((target) => normKey(target.key) === wanted) ?? targets.find((target) => normKey(target.field) === wanted);
    if (match) return { field: address(match), evidence: "named" };
  }
  const mentioned = targets
    .filter((target) => mentions(error.message, target.key))
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (mentioned) return { field: address(mentioned), evidence: "mentioned" };
  if (AUTH_WORDS.test(error.message)) {
    const credential = targets.find(
      (target) =>
        (target.location === "header" && /^(authorization|x-?(access|auth|session)-?token|token)$/i.test(target.field)) ||
        (target.location === "cookie" && /(session|token|auth|sid)/i.test(target.field)),
    );
    if (credential) return { field: address(credential), evidence: "auth" };
  }
  return { field: null, evidence: null };
}

/** The saved mapping that fills `field`, described for the UI. */
export function mappingFor(field: InputAddress | null, bindings: StepBinding[]): ResponseError["mapping"] {
  if (!field) return null;
  const binding = bindings.find(
    (item) => item.enabled !== false && item.target.location === field.location && item.target.field === field.field,
  );
  if (!binding) return null;
  const source = binding.source as { stepName?: string; orderIndex?: number; path?: string; value?: unknown };
  if ("value" in source && source.value !== undefined) return { stepName: null, orderIndex: null, path: null, fixedValue: true };
  return { stepName: source.stepName ?? null, orderIndex: typeof source.orderIndex === "number" ? source.orderIndex : null, path: source.path ?? null, fixedValue: false };
}

/** Everything the step result says about an error in the response. */
export function describeResponseError(
  body: unknown,
  status: number | null,
  request: HttpRequestSpec,
  bindings: StepBinding[],
  fallbackMessage?: string,
): ResponseError | null {
  const detected = detectBodyError(body);
  // 4xx/5xx always is an error; the body explains which one.
  const error =
    detected ??
    (status !== null && status >= 400 ? { message: fallbackMessage ?? messageOf(body) ?? `HTTP ${status}`, code: null, signal: `HTTP ${status}`, named: namedField(asRecord(body)?.errors ?? body) } : null);
  if (!error) return null;
  const link = linkErrorToInput(error, request);
  return {
    message: error.message,
    code: error.code,
    signal: error.signal,
    field: link.field,
    fieldEvidence: link.evidence,
    mapping: mappingFor(link.field, bindings),
  };
}

/** Assertion paths that check the error members themselves (a negative test): then the body check stays out. */
export function assertsOnErrorMembers(assertions: Array<Record<string, unknown>>) {
  return assertions.some((assertion) =>
    /(^|\.)(success|succeeded|issuccess|ok|status|result|error|errors|errorcode|error_code|code|message)$/i.test(String(assertion.path ?? "").trim()),
  );
}
