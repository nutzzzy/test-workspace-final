import { isFormBody, parseForm, serializeForm } from "./flow/request-inputs";
import type { ExecutionContext, ValueSource } from "./types";

const ALIAS_GROUPS = [
  ["token", "access_token", "accessToken", "jwt", "id_token", "idToken"],
  ["refresh_token", "refreshToken"],
  ["userId", "user_id", "user.id"],
  ["orderId", "order_id", "order.id"],
];

function normalizeKey(key: string) {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function aliasesFor(path: string[]): string[] {
  const leaf = path[path.length - 1] ?? "";
  const dotted = path.join(".");
  const keys = new Set<string>([leaf, dotted]);
  const norm = normalizeKey(leaf);
  for (const group of ALIAS_GROUPS) {
    if (group.some((item) => normalizeKey(item) === norm)) {
      for (const item of group) keys.add(item);
    }
  }
  if (norm.endsWith("id") && path.length > 1) {
    const parent = path[path.length - 2] ?? "";
    keys.add(`${parent}Id`);
    keys.add(`${parent}_id`);
    keys.add(`${parent}.id`);
  }
  return [...keys];
}

function isUsefulScalar(value: unknown): value is string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 0 && text.length <= 500;
}

/** Remember scalar fields from an API response so later requests can reuse them. */
export function captureResponse(
  body: unknown,
  context: ExecutionContext,
  origin?: string,
): Record<string, string> {
  const learned: Record<string, string> = {};

  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...path, key]);
      }
      return;
    }
    if (!isUsefulScalar(value) || path.length === 0) return;
    const leaf = path[path.length - 1] ?? "";
    if (/^\d+$/.test(leaf)) return;
    const text = String(value);
    for (const key of aliasesFor(path)) {
      if (context.isInitial(key) || context.get(key) !== undefined) continue;
      context.set(key, text);
      context.describeVariable(key, { type: typeof value, path: `response.body.${path.join(".")}` });
      learned[key] = text;
    }
  };

  visit(body, []);
  if (origin && TOKEN_KEYS.some((key) => key in learned)) context.tokenOrigin = origin;
  return learned;
}

const TOKEN_KEYS = ALIAS_GROUPS[0]!;
const BASE_URL_KEYS = ["base_url", "baseUrl", "BASE_URL", "baseURL"];

function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * A bearer token is only added automatically for the API it belongs to: the
 * origin whose response returned it, or — for a token supplied by the
 * environment — the environment's base URL. Any other host must set the
 * Authorization header explicitly, so a token is never leaked to a
 * third-party endpoint called later in the same scenario.
 */
function tokenAllowedFor(url: unknown, context: ExecutionContext): boolean {
  const target = originOf(url);
  if (!target) return false;
  if (context.tokenOrigin) return context.tokenOrigin === target;
  return BASE_URL_KEYS.some((key) => originOf(context.get(key)) === target);
}

function lookup(key: string, context: ExecutionContext): string | undefined {
  const direct = context.get(key);
  if (direct !== undefined) return direct;
  const norm = normalizeKey(key);
  for (const [name, value] of Object.entries(context.entries())) {
    if (normalizeKey(name) === norm) return value;
  }
  for (const group of ALIAS_GROUPS) {
    if (!group.some((item) => normalizeKey(item) === norm)) continue;
    for (const item of group) {
      const value = context.get(item);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export type ConsumedVar = { variable: string; location: string; source?: ValueSource };

function bindString(
  input: string,
  context: ExecutionContext,
  location: string,
  consumed: ConsumedVar[],
  fieldKey?: string,
) {
  const use = (variable: string, value: string | undefined) => {
    if (value !== undefined) {
      const source = context.sourceOf(variable);
      consumed.push({ variable, location, ...(source ? { source } : {}) });
    }
    return value;
  };
  let next = input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    return use(key, lookup(key, context)) ?? match;
  });
  next = next.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    return use(key, lookup(key, context)) ?? match;
  });
  if (
    fieldKey &&
    (next.trim() === "" || next === fieldKey || next === `:${fieldKey}`)
  ) {
    const found = use(fieldKey, lookup(fieldKey, context));
    if (found !== undefined) return found;
  }
  return next;
}

const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;

/**
 * A JSON body field that is exactly "{{orderId}}" takes the variable in its
 * original JSON type: a numeric id from an earlier response stays a number.
 * Environment/text variables stay text.
 */
function typedBodyValue(value: string, context: ExecutionContext, location: string, consumed: ConsumedVar[]) {
  if (!location.startsWith("body")) return undefined;
  const match = WHOLE_PLACEHOLDER.exec(value.trim());
  if (!match) return undefined;
  const typed = context.typedValue(match[1]!);
  if (typed === undefined || typeof typed === "string") return undefined;
  const source = context.sourceOf(match[1]!);
  consumed.push({ variable: match[1]!, location, ...(source ? { source } : {}) });
  return typed;
}

/** form-urlencoded body: bind each field by name and re-encode its value. */
function bindForm(body: string, context: ExecutionContext, consumed: ConsumedVar[]) {
  return serializeForm(
    parseForm(body).map((pair) => ({
      key: pair.key,
      // An unresolved {{x}} must fail loudly, not be sent URL-encoded.
      value: context.interpolate(bindString(pair.value, context, `form.${pair.key}`, consumed, pair.key)),
    })),
  );
}

function bindValue(
  value: unknown,
  context: ExecutionContext,
  location: string,
  consumed: ConsumedVar[],
  fieldKey?: string,
): unknown {
  if (typeof value === "string") {
    const typed = typedBodyValue(value, context, location, consumed);
    if (typed !== undefined) return typed;
    return bindString(value, context, location, consumed, fieldKey);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => bindValue(item, context, `${location}.${index}`, consumed));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = bindValue(child, context, location ? `${location}.${key}` : key, consumed, key);
    }
    return out;
  }
  return value;
}

/** Fill request fields from values captured in earlier API responses. */
export function bindRequest(
  config: Record<string, unknown>,
  context: ExecutionContext,
  consumed: ConsumedVar[] = [],
): Record<string, unknown> {
  const form = isFormBody({ body: config.body, headers: config.headers as Record<string, string> | undefined });
  const bound = bindValue(form ? { ...config, body: undefined } : config, context, "", consumed) as Record<string, unknown>;
  if (form) bound.body = bindForm(config.body as string, context, consumed);
  const token = lookup("token", context);
  if (!token || !tokenAllowedFor(bound.url, context)) return bound;

  const headers = {
    ...((bound.headers as Record<string, unknown> | undefined) ?? {}),
  };
  const authorization = headers.Authorization ?? headers.authorization;
  const missing =
    authorization === undefined ||
    (typeof authorization === "string" &&
      (authorization.trim() === "" ||
        authorization.trim() === "Bearer" ||
        authorization.includes("{{")));
  if (missing) {
    consumed.push({ variable: "token", location: "headers.Authorization" });
    headers.Authorization = `Bearer ${token}`;
    delete headers.authorization;
    bound.headers = headers;
  }
  return bound;
}
