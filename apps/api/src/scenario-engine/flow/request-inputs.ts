import { isSecretKey } from "../../common/mask.util";
import { singular } from "./value-registry";

/**
 * Unified request input model. Every dynamic value of an HTTP request — URL
 * path segment, query parameter, header, cookie, JSON body field or form
 * field — is addressed the same way, so dependency resolution, recovery,
 * saved mappings and manual recovery all read and write through one API.
 */

export type InputLocation = "url" | "path" | "query" | "header" | "body" | "form" | "cookie";

/** A resolved (already interpolated) HTTP request. */
export type HttpRequestSpec = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};

/** Where a value lives: body path (a.b.0.c), query/header/form/cookie key, or path segment index. */
export type InputAddress = { location: InputLocation; field: string };

export type RequestInputTarget = InputAddress & {
  /** Human name of the value (bikerId; the collection name for a path segment). */
  key: string;
  currentValue: string;
  type: "number" | "string" | "boolean";
  secret: boolean;
};

export function headerKey(headers: Record<string, string> | undefined, name: string) {
  return Object.keys(headers ?? {}).find((key) => key.toLowerCase() === name.toLowerCase());
}

/** A string body sent as application/x-www-form-urlencoded (or that looks like one). */
export function isFormBody(request: Pick<HttpRequestSpec, "body" | "headers">): request is { body: string; headers?: Record<string, string> } {
  if (typeof request.body !== "string" || !request.body.trim()) return false;
  const typeKey = headerKey(request.headers, "content-type");
  const type = typeKey ? String(request.headers?.[typeKey] ?? "").toLowerCase() : "";
  if (type.includes("application/x-www-form-urlencoded")) return true;
  if (type && !type.includes("text/plain")) return false;
  return /^[^=&\s{}[\]"]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(request.body.trim());
}

type FormPair = { key: string; value: string };

export function parseForm(body: string): FormPair[] {
  return body
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
      return { key: safeDecode(rawKey), value: safeDecode(rawValue) };
    });
}

export function serializeForm(pairs: FormPair[]) {
  return pairs.map((pair) => `${encodeURIComponent(pair.key)}=${encodeURIComponent(pair.value)}`).join("&");
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function parseCookies(header: string): FormPair[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? { key: part, value: "" } : { key: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
}

const BEARER = /^(Bearer|Token|JWT)\s+(.+)$/i;

/** A path segment that identifies something (has a digit, or is a UUID/opaque id). */
function isIdentifierSegment(segment: string) {
  return /^[A-Za-z0-9_.~-]+$/.test(segment) && /\d/.test(segment);
}

function scalarType(value: unknown): RequestInputTarget["type"] {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

/** Every input value of the request, in a stable order. */
export function listInputTargets(request: HttpRequestSpec): RequestInputTarget[] {
  const targets: RequestInputTarget[] = [];

  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    url = null;
  }
  if (url) {
    const segments = url.pathname.split("/");
    segments.forEach((raw, index) => {
      const segment = safeDecode(raw);
      const previous = safeDecode(segments[index - 1] ?? "");
      if (!segment || !previous || !isIdentifierSegment(segment)) return;
      if (isIdentifierSegment(previous)) return; // /v1/2 style: no entity name to go by
      targets.push({
        location: "path",
        field: String(index),
        key: `${singular(previous).replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))}Id`,
        currentValue: segment,
        type: /^\d{1,15}$/.test(segment) ? "number" : "string",
        secret: false,
      });
    });
    const explicit = new Set(Object.keys(request.query ?? {}));
    url.searchParams.forEach((value, key) => {
      if (explicit.has(key)) return;
      targets.push({ location: "query", field: key, key, currentValue: value, type: "string", secret: isSecretKey(key) });
    });
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    targets.push({ location: "query", field: key, key, currentValue: String(value), type: "string", secret: isSecretKey(key) });
  }

  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (lower === "cookie") {
      for (const pair of parseCookies(value)) {
        targets.push({ location: "cookie", field: pair.key, key: pair.key, currentValue: pair.value, type: "string", secret: true });
      }
      continue;
    }
    if (["content-type", "accept", "content-length", "user-agent", "host", "accept-encoding", "connection"].includes(lower)) continue;
    const bearer = BEARER.exec(value.trim());
    targets.push({
      location: "header",
      field: name,
      key: name,
      currentValue: bearer ? bearer[2]!.trim() : value,
      type: "string",
      secret: isSecretKey(name) || Boolean(bearer),
    });
  }

  if (isFormBody(request)) {
    for (const pair of parseForm(request.body)) {
      targets.push({ location: "form", field: pair.key, key: pair.key, currentValue: pair.value, type: "string", secret: isSecretKey(pair.key) });
    }
  } else if (request.body && typeof request.body === "object") {
    const visit = (value: unknown, path: string[], depth: number) => {
      if (depth > 10 || targets.length > 400) return;
      if (Array.isArray(value)) {
        value.slice(0, 50).forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key], depth + 1);
        return;
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
      const key = [...path].reverse().find((segment) => !/^\d+$/.test(segment)) ?? "";
      if (!key) return;
      targets.push({
        location: "body",
        field: path.join("."),
        key,
        currentValue: String(value),
        type: scalarType(value),
        secret: isSecretKey(key),
      });
    };
    visit(request.body, [], 0);
  }
  return targets;
}

export function readInput(request: HttpRequestSpec, address: InputAddress): string | undefined {
  return listInputTargets(request).find(
    (target) => target.location === address.location && sameField(target, address),
  )?.currentValue;
}

function sameField(target: InputAddress, address: InputAddress) {
  return target.location === "header" ? target.field.toLowerCase() === address.field.toLowerCase() : target.field === address.field;
}

/** Keep the JSON type of the value being replaced: a numeric id stays a number. */
export function coerceLike(current: unknown, next: string | number | boolean): unknown {
  if (typeof current === "number") {
    const numeric = typeof next === "number" ? next : Number(next);
    return Number.isFinite(numeric) && String(next).trim() !== "" ? numeric : next;
  }
  if (typeof current === "boolean") {
    if (next === "true" || next === true) return true;
    if (next === "false" || next === false) return false;
    return next;
  }
  return typeof next === "string" ? next : String(next);
}

/**
 * Return a copy of the request with one input replaced. Unknown addresses
 * leave it unchanged. A JSON body field keeps its current type unless
 * `keepSourceType` is set, in which case the value is written as given (a
 * number from an earlier response replaces a "{{placeholder}}" as a number).
 */
export function setInput(
  request: HttpRequestSpec,
  address: InputAddress,
  value: string | number | boolean,
  options: { keepSourceType?: boolean } = {},
): HttpRequestSpec {
  const next: HttpRequestSpec = structuredClone(request);
  const text = String(value);
  switch (address.location) {
    case "path":
    case "url": {
      const url = new URL(next.url);
      const segments = url.pathname.split("/");
      const index = Number(address.field);
      if (!Number.isInteger(index) || index <= 0 || index >= segments.length) return next;
      segments[index] = encodeURIComponent(text);
      url.pathname = segments.join("/");
      next.url = url.toString();
      return next;
    }
    case "query": {
      if (next.query && address.field in next.query) {
        next.query = { ...next.query, [address.field]: text };
        return next;
      }
      try {
        const url = new URL(next.url);
        if (url.searchParams.has(address.field)) {
          url.searchParams.set(address.field, text);
          next.url = url.toString();
          return next;
        }
      } catch {
        // fall through: add as an explicit query parameter
      }
      next.query = { ...(next.query ?? {}), [address.field]: text };
      return next;
    }
    case "header": {
      const headers = { ...(next.headers ?? {}) };
      const key = headerKey(headers, address.field) ?? address.field;
      const current = headers[key];
      const bearer = typeof current === "string" ? BEARER.exec(current.trim()) : null;
      headers[key] = bearer ? `${bearer[1]} ${text}` : text;
      next.headers = headers;
      return next;
    }
    case "cookie": {
      const headers = { ...(next.headers ?? {}) };
      const key = headerKey(headers, "cookie") ?? "Cookie";
      const pairs = parseCookies(headers[key] ?? "");
      const hit = pairs.find((pair) => pair.key === address.field);
      if (hit) hit.value = text;
      else pairs.push({ key: address.field, value: text });
      headers[key] = pairs.map((pair) => `${pair.key}=${pair.value}`).join("; ");
      next.headers = headers;
      return next;
    }
    case "form": {
      if (!isFormBody(next)) return next;
      const pairs = parseForm(next.body as string);
      const hit = pairs.find((pair) => pair.key === address.field);
      if (hit) hit.value = text;
      else pairs.push({ key: address.field, value: text });
      next.body = serializeForm(pairs);
      return next;
    }
    case "body": {
      const parts = address.field.split(".").filter(Boolean);
      if (parts.length === 0 || !next.body || typeof next.body !== "object") return next;
      let cursor: unknown = next.body;
      for (const part of parts.slice(0, -1)) {
        if (!cursor || typeof cursor !== "object") return next;
        cursor = (cursor as Record<string, unknown>)[part];
      }
      const leaf = parts[parts.length - 1]!;
      if (cursor && typeof cursor === "object") {
        const record = cursor as Record<string, unknown>;
        record[leaf] =
          options.keepSourceType && typeof value !== "string" && typeof record[leaf] !== typeof value
            ? value
            : coerceLike(record[leaf], value);
      }
      return next;
    }
  }
}

/** "query.bikerId", "path[3] (bikerId)", "header.Authorization" — for traces and the UI. */
export function describeAddress(target: InputAddress & { key?: string }) {
  if (target.location === "path" || target.location === "url") return `path.${target.key ?? target.field}`;
  return `${target.location}.${target.field}`;
}
