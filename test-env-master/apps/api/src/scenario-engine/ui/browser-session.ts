import type { BrowserContext } from "playwright-core";
import { z } from "zod";
import { lookup } from "../auto-bind";
import { resolveSource, type ResponseSource } from "../flow/bindings";
import { isTokenKey } from "../flow/value-registry";
import type { ExecutionContext } from "../types";

/**
 * Open a UI step's browser as the user the earlier steps signed in as:
 * - cookies the earlier requests received (Set-Cookie) or sent (Cookie header);
 * - their credential headers (Authorization, X-Auth-Token, …), added to the
 *   browser's own requests to the same servers when the page does not send one;
 * - page storage entries the step names (many single-page apps keep the token
 *   in localStorage under their own key), filled from an earlier response, a
 *   {{variable}}, or the latest token any earlier step received.
 */

export const StorageSeedSchema = z.object({
  area: z.enum(["localStorage", "sessionStorage"]),
  key: z.string().min(1).max(200),
  /** Literal or {{variable}}; empty with no source = the latest token of an earlier step. */
  value: z.string().max(20_000).optional(),
  /** A value of an earlier step's response, like a Data Mapping source. */
  source: z
    .object({ stepId: z.string().optional(), stepName: z.string().optional(), orderIndex: z.number().int(), path: z.string().max(500) })
    .optional(),
  /** Store this JSON with the value put at `jsonPath` (e.g. {"token": …}): for apps that keep an object. */
  jsonTemplate: z.string().max(5000).optional(),
});
export type StorageSeed = z.infer<typeof StorageSeedSchema>;

export const SessionConfigSchema = z.object({
  /** Carry cookies and credential headers of earlier requests (default on). */
  fromEarlierSteps: z.boolean().optional(),
  /** Only these earlier steps supply the session (cookies, headers, latest token); all when absent. */
  fromSteps: z.array(z.string().max(100)).max(100).optional(),
  storage: z.array(StorageSeedSchema).max(20).optional(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export type BrowserCookie = { name: string; value: string; url: string };
export type SessionSeed = {
  /** The token the storage entries were filled with when none were named (to learn the app's own key). */
  token?: string;
  /** Keys filled by guess (no key named on the step yet). */
  guessed?: string[];
  cookies: BrowserCookie[];
  /** Origin → headers to add to the browser's requests there. */
  headers: Array<{ origin: string; headers: Record<string, string> }>;
  storage: Array<{ origin: string; area: StorageSeed["area"]; key: string; value: string }>;
  /** What could not be filled, for the step result. */
  missing: string[];
};

/** Where single-page apps usually keep their token, used until the app's own key is learned. */
export const GUESSED_KEYS = ["token", "accessToken", "access_token", "authToken", "auth_token", "jwt"];

/** Headers that carry a credential an earlier call obtained. */
const CREDENTIAL_HEADER = /^(authorization|x-[a-z0-9-]*(token|auth|session|api-?key)[a-z0-9-]*|token|api-?key|apikey)$/i;

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function cookiePairs(header: string) {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const eq = part.indexOf("=");
      return eq > 0 ? [{ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() }] : [];
    });
}

/** The latest token an earlier step (of the chosen ones) received (accessToken, token, jwt, …; never a refresh token). */
function latestToken(context: ExecutionContext, from?: ReadonlySet<string>): string | undefined {
  const entries = context.registry
    .entries()
    .filter((entry) => !from || (entry.stepId !== undefined && from.has(entry.stepId)))
    .filter((entry) => entry.kind === "body" && isTokenKey(entry.key) && !/refresh/i.test(entry.key) && entry.text.length >= 8);
  return entries.sort((a, b) => b.sequence - a.sequence)[0]?.text;
}

function fillTemplate(template: string, context: ExecutionContext) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = lookup(key, context);
    if (value === undefined) throw new Error(`Unresolved variable: {{${key}}}`);
    return value;
  });
}

/** What the browser needs to start signed in, from what this run did so far. */
export function seedFromContext(context: ExecutionContext, startUrl: string, config: SessionConfig | undefined): SessionSeed {
  const seed: SessionSeed = { cookies: [], headers: [], storage: [], missing: [] };
  // Chosen steps only (an empty choice carries nothing); every earlier step when no choice was made.
  const from = config?.fromSteps ? new Set(config.fromSteps) : undefined;
  if (config?.fromEarlierSteps !== false) {
    const cookies = new Map<string, BrowserCookie>();
    const headers = new Map<string, Record<string, string>>();
    // Oldest first, so the latest value of a cookie or header wins.
    for (const exchange of context.exchanges) {
      const origin = originOf(exchange.url);
      if (!origin || exchange.status >= 400) continue;
      if (from && (!exchange.stepId || !from.has(exchange.stepId))) continue;
      for (const [name, value] of Object.entries(exchange.headers)) {
        if (name.toLowerCase() === "cookie") {
          for (const pair of cookiePairs(value)) cookies.set(`${origin}|${pair.name}`, { ...pair, url: origin });
        } else if (CREDENTIAL_HEADER.test(name) && value && !value.includes("{{") && !/^basic\s/i.test(value)) {
          headers.set(origin, { ...(headers.get(origin) ?? {}), [name]: value });
        }
      }
      for (const [name, value] of Object.entries(exchange.setCookies)) {
        if (value) cookies.set(`${origin}|${name}`, { name, value, url: origin });
      }
    }
    seed.cookies = [...cookies.values()];
    seed.headers = [...headers.entries()].map(([origin, values]) => ({ origin, headers: values }));
  }

  const pageOrigin = originOf(startUrl);
  const token = latestToken(context, from);
  if (token) seed.token = token;
  // No key named yet: put the token where single-page apps usually look for it.
  if (config?.fromEarlierSteps !== false && !(config?.storage?.length) && token && pageOrigin) {
    context.markSecret(token);
    seed.guessed = GUESSED_KEYS.map((key) => `localStorage.${key}`);
    for (const key of GUESSED_KEYS) seed.storage.push({ origin: pageOrigin, area: "localStorage", key, value: token });
  }
  for (const item of config?.storage ?? []) {
    let value: string | undefined;
    if (item.source) {
      const resolved = resolveSource(item.source as ResponseSource, context.registry);
      value = resolved.ok ? resolved.entry.text : undefined;
    } else if (item.value) {
      value = fillTemplate(item.value, context);
    } else {
      value = latestToken(context, from);
    }
    if (value === undefined || !pageOrigin) {
      seed.missing.push(`${item.area}.${item.key}`);
      continue;
    }
    context.markSecret(value);
    if (item.jsonTemplate) {
      // {"token": "{{value}}"} → the app's own JSON shape.
      value = item.jsonTemplate.replace(/\{\{\s*value\s*\}\}/g, value.replace(/["\\]/g, "\\$&"));
    }
    seed.storage.push({ origin: pageOrigin, area: item.area, key: item.key, value });
  }
  for (const cookie of seed.cookies) context.markSecret(cookie.value);
  for (const item of seed.headers) for (const value of Object.values(item.headers)) context.markSecret(value);
  return seed;
}

const applied = new WeakMap<BrowserContext, { headers: Map<string, Record<string, string>>; routed: Set<string> }>();

/**
 * Put the seed into a browser context. Safe to call again (a later UI step
 * adds what the steps in between obtained): headers update in place, storage
 * is written once per tab before the page's own scripts run.
 */
export async function applySeed(browserContext: BrowserContext, seed: SessionSeed) {
  if (seed.cookies.length) await browserContext.addCookies(seed.cookies).catch(() => undefined);
  const state = applied.get(browserContext) ?? { headers: new Map<string, Record<string, string>>(), routed: new Set<string>() };
  applied.set(browserContext, state);
  for (const { origin, headers } of seed.headers) {
    state.headers.set(origin, { ...(state.headers.get(origin) ?? {}), ...headers });
    if (state.routed.has(origin)) continue;
    state.routed.add(origin);
    await browserContext.route(
      (url) => url.origin === origin,
      async (route) => {
        const request = route.request();
        const current = request.headers();
        const extra: Record<string, string> = state.headers.get(origin) ?? {};
        const merged = { ...current };
        // The page's own credential wins; ours fills in only what is missing.
        for (const [name, value] of Object.entries(extra)) if (!(name.toLowerCase() in current)) merged[name] = value;
        await route.continue({ headers: merged }).catch(() => undefined);
      },
    );
  }
  if (seed.storage.length) {
    await browserContext.addInitScript((items: SessionSeed["storage"]) => {
      for (const item of items) {
        if (location.origin !== item.origin) continue;
        const flag = `__qa_seed:${item.area}:${item.key}`;
        try {
          // Once per tab: the app may replace the value later (refresh, logout).
          if (sessionStorage.getItem(flag)) continue;
          (item.area === "localStorage" ? localStorage : sessionStorage).setItem(item.key, item.value);
          sessionStorage.setItem(flag, "1");
        } catch {
          // storage blocked on this page
        }
      }
    }, seed.storage);
  }
}

/** For the step result: what the browser started with (names only). */
export function describeSeed(seed: SessionSeed) {
  return {
    cookies: seed.cookies.map((cookie) => `${cookie.name} (${new URL(cookie.url).host})`),
    headers: seed.headers.flatMap((item) => Object.keys(item.headers).map((name) => `${name} → ${new URL(item.origin).host}`)),
    storage: seed.storage.filter((item) => !seed.guessed?.includes(`${item.area}.${item.key}`)).map((item) => `${item.area}.${item.key}`),
    ...(seed.guessed?.length ? { guessed: seed.guessed } : {}),
    ...(seed.missing.length ? { missing: seed.missing } : {}),
  };
}

/**
 * Where the app itself keeps the token: a storage entry (other than the
 * guessed ones) holding the earlier steps' token, as the whole value or a
 * field of a JSON value. Saved on the step so the next run uses exactly that.
 */
export function learnTokenPlace(
  storage: { localStorage?: Record<string, unknown>; sessionStorage?: Record<string, unknown> },
  token: string | undefined,
  seeded: string[] | undefined,
): StorageSeed | null {
  if (!token) return null;
  for (const area of ["localStorage", "sessionStorage"] as const) {
    for (const [key, value] of Object.entries(storage[area] ?? {})) {
      if (seeded?.includes(`${area}.${key}`)) continue;
      if (value === token) return { area, key };
      if (value && typeof value === "object") {
        const path = findPath(value, token, []);
        if (path) return { area, key, jsonTemplate: JSON.stringify(placeholderAt(value, path)) };
      }
    }
  }
  return null;
}

function findPath(value: unknown, token: string, path: string[]): string[] | null {
  if (value === token) return path;
  if (value && typeof value === "object" && path.length < 6) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findPath(child, token, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

/** The JSON with the token replaced by {{value}}; other fields kept as they were. */
function placeholderAt(value: unknown, path: string[]): unknown {
  if (path.length === 0) return "{{value}}";
  const [head, ...rest] = path;
  const copy = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  (copy as Record<string, unknown>)[head!] = placeholderAt((value as Record<string, unknown>)[head!], rest);
  return copy;
}
