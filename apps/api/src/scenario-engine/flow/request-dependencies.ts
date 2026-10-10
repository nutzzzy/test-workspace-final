import { isSecretKey } from "../../common/mask.util";
import type { DependencySuggestion, FlowHttpStep } from "./dependency-analyzer";
import { listInputTargets, type HttpRequestSpec, type RequestInputTarget } from "./request-inputs";
import { normKey, singular } from "./value-registry";

/**
 * Dependencies inferred from the requests alone — before any of them ran.
 * The evidence is the shape of the requests (a login call, a create call, a
 * literal id or token in a later request), so a suggestion here is never
 * HIGH and never applied without the user accepting it. Its source is
 * described by what to look for (`expect`), resolved against the real
 * response at run time and pinned once a run verifies it.
 */

const TEMPLATE_ORIGIN = "http://template.invalid";

/**
 * The step's request as written, in the shape request-inputs reads. A leading
 * {{base_url}} is replaced by the environment's value when it is a URL (so
 * path segment positions match what is sent), otherwise by a stand-in origin.
 */
export function templateRequest(config: Record<string, unknown>, env: Record<string, string> = {}): HttpRequestSpec {
  const raw = typeof config.url === "string" ? config.url.replace(/%7B%7B([A-Za-z0-9_.-]+)%7D%7D/gi, "{{$1}}") : "";
  const leading = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/.exec(raw);
  let url = raw;
  if (leading) {
    const value = env[leading[1]!];
    const base = value && /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : TEMPLATE_ORIGIN;
    url = `${base}${raw.slice(leading[0].length)}`;
  }
  const strings = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
        .filter(([, item]) => typeof item === "string" || typeof item === "number")
        .map(([key, item]) => [key, String(item)]),
    );
  return {
    method: typeof config.method === "string" ? config.method.toUpperCase() : "GET",
    url,
    headers: strings(config.headers),
    query: strings(config.query),
    body: config.body,
  };
}

const AUTH_PATH = /(^|\/)(login|log-in|signin|sign-in|auth|authenticate|authorize|token|oauth2?|sessions?)(\/|$)/i;
const AUTH_BODY = /^(password|passwd|pwd|otp|clientsecret|granttype|refreshtoken|pin)$/;
/** Header names that carry a credential issued by an earlier call. */
const TOKEN_HEADER = /^(authorization|xaccesstoken|xauthtoken|xsessiontoken|xtoken|token|accesstoken)$/;
const USER_ENTITIES = new Set(["user", "account", "customer", "member", "profile", "client"]);

function pathSegments(request: HttpRequestSpec) {
  try {
    return new URL(request.url).pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

/** Literal segments only (no ids, no {{placeholders}}). */
function literalSegments(request: HttpRequestSpec) {
  return pathSegments(request).filter((part) => !/\d/.test(part) && !part.includes("{{"));
}

export function isAuthRequest(request: HttpRequestSpec) {
  if (AUTH_PATH.test(new URL(request.url, TEMPLATE_ORIGIN).pathname)) return true;
  return listInputTargets(request).some(
    (target) => (target.location === "body" || target.location === "form") && AUTH_BODY.test(normKey(target.key)),
  );
}

/** userId → user, account_id → account, orderUuid → order; null for keys that do not name an entity. */
export function entityOf(key: string) {
  const match = /^(.*?)[_-]?(id|uuid|guid|code|number|no)$/i.exec(key);
  const entity = match?.[1] ? singular(match[1]).toLowerCase() : "";
  return entity.length >= 2 ? entity : null;
}

function looksLikeId(value: string) {
  return /^\d{1,19}$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || (/\d/.test(value) && /^[A-Za-z0-9_-]{4,64}$/.test(value));
}

function tokenOf(target: RequestInputTarget) {
  if (target.location !== "header" || !TOKEN_HEADER.test(normKey(target.field))) return null;
  const value = target.currentValue.trim();
  // Basic credentials are typed in by the user, not issued by an earlier call.
  if (/^basic\s/i.test(value) || value.includes("{{") || value.length < 8) return null;
  return value;
}

type Producer = { step: FlowHttpStep; request: HttpRequestSpec; auth: boolean; literals: string[]; values: Set<string> };

function suggestion(
  producer: FlowHttpStep,
  consumer: FlowHttpStep,
  target: RequestInputTarget,
  fields: Pick<DependencySuggestion, "confidence" | "reason" | "expect" | "variable">,
): DependencySuggestion {
  const location = target.location === "url" ? "path" : target.location;
  return {
    id: `${producer.id}|${consumer.id}|expect:${fields.expect!.kind}:${fields.expect!.key}|${location}|${target.field}`,
    producerStepId: producer.id,
    producerName: producer.name,
    consumerStepId: consumer.id,
    consumerName: consumer.name,
    sourcePath: "",
    variable: fields.variable,
    location,
    locationDetail: target.location === "path" ? target.key : target.field,
    confidence: fields.confidence,
    score: fields.confidence === "MEDIUM" ? 0.6 : 0.4,
    masked: target.secret || fields.expect?.kind === "token",
    target: { location: target.location, field: target.field, key: target.key },
    evidence: "request",
    reason: fields.reason,
    expect: fields.expect,
  };
}

/**
 * Propose where literal tokens and ids of later requests probably come from:
 * - a bearer/token header ← the nearest earlier login-like call (MEDIUM);
 * - an entity id (path segment, query, header, body or form field named
 *   userId / account_id / …) ← the nearest earlier call that creates that
 *   entity (POST /users, MEDIUM), returns it (GET …/account, MEDIUM when it is
 *   the last segment, else LOW), or — for user-like ids — a login (LOW).
 * A step that sends the same literal itself consumes it rather than produces
 * it, so it is never the proposed source. Ties are all returned, never resolved
 * by guessing.
 */
export function inferRequestDependencies(steps: FlowHttpStep[], env: Record<string, string> = {}): DependencySuggestion[] {
  const http = [...steps]
    .filter((step) => (step.type ?? "HTTP_REQUEST") === "HTTP_REQUEST")
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const producers: Producer[] = [];
  const out: DependencySuggestion[] = [];

  for (const step of http) {
    const request = templateRequest(step.config, env);
    const targets = (() => {
      try {
        return listInputTargets(request);
      } catch {
        return [];
      }
    })();

    for (const target of targets) {
      if (target.currentValue.includes("{{")) continue;

      const token = tokenOf(target);
      if (token) {
        // The token was issued by the nearest earlier auth call that did not itself send it.
        const source = [...producers].reverse().find((item) => item.auth && !item.values.has(token));
        if (source) {
          out.push(
            suggestion(source.step, step, target, {
              confidence: "MEDIUM",
              reason: "auth_token",
              expect: { kind: "token", key: "accessToken" },
              variable: "accessToken",
            }),
          );
        }
        continue;
      }

      if (target.secret || !looksLikeId(target.currentValue)) continue;
      const entity = entityOf(target.key);
      if (!entity) continue;
      const key = `${entity}Id`;
      const eligible = producers.filter((item) => !item.values.has(target.currentValue));

      const ranked: Array<{ producer: Producer; confidence: "MEDIUM" | "LOW"; reason: DependencySuggestion["reason"] }> = [];
      for (const producer of [...eligible].reverse()) {
        const literals = producer.literals.map((part) => singular(part).toLowerCase().replace(/[^a-z0-9]/g, ""));
        const last = literals[literals.length - 1];
        const named = normKey(entity);
        if (producer.request.method === "POST" && last === named) {
          ranked.push({ producer, confidence: "MEDIUM", reason: "creates_entity" });
        } else if (producer.request.method === "GET" && last === named) {
          ranked.push({ producer, confidence: "MEDIUM", reason: "returns_entity" });
        } else if (producer.request.method === "GET" && literals.includes(named)) {
          ranked.push({ producer, confidence: "LOW", reason: "returns_entity" });
        } else if (producer.auth && USER_ENTITIES.has(entity)) {
          ranked.push({ producer, confidence: "LOW", reason: "auth_user" });
        }
      }
      const strongest = ranked.filter((item) => item.confidence === "MEDIUM");
      // One clear MEDIUM source wins; otherwise every candidate is shown as LOW for the user to choose.
      const chosen = strongest.length === 1 ? strongest : ranked.map((item) => ({ ...item, confidence: "LOW" as const }));
      for (const item of chosen.slice(0, 3)) {
        out.push(
          suggestion(item.producer.step, step, target, {
            confidence: item.confidence,
            reason: item.reason,
            // A create/fetch response may name the id plainly ({ "id": 5 }); a login response must name it.
            expect: item.reason === "auth_user" ? { kind: "value", key } : { kind: "value", key, alt: ["id"] },
            variable: key,
          }),
        );
      }
    }

    producers.push({
      step,
      request,
      auth: (() => {
        try {
          return isAuthRequest(request);
        } catch {
          return false;
        }
      })(),
      literals: literalSegments(request),
      values: new Set(targets.map((target) => tokenOf(target) ?? target.currentValue)),
    });
  }
  return out;
}

/** Masked view of a step's inputs, for choosing which field a mapping fills. */
export function inputFields(config: Record<string, unknown>, env: Record<string, string> = {}) {
  try {
    return listInputTargets(templateRequest(config, env)).map((target) => ({
      location: target.location,
      field: target.field,
      key: target.key,
      type: target.type,
      secret: target.secret || isSecretKey(target.key),
      display: target.secret || isSecretKey(target.key) ? "••••••" : target.currentValue.slice(0, 120),
    }));
  } catch {
    return [];
  }
}
