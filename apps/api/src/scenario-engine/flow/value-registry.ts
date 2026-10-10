import { isSecretKey } from "../../common/mask.util";

/**
 * Scenario Runtime Value Registry.
 *
 * Every successful HTTP step contributes the scalar values of its response
 * (JSON body, selected headers, the Location header and cookies) together with
 * where they came from. Later requests, recovery and manual recovery read
 * values only from here, so all of them agree on what an earlier step
 * produced. Nothing in this file calls a model.
 */

export type RegistryValueType = "number" | "string" | "boolean";
export type RegistrySourceKind = "body" | "header" | "location" | "cookie";
export type RegistryCategory = "id" | "token" | "number" | "string" | "boolean" | "header";

export type RegistryEntry = {
  /** Stable reference: `${orderIndex}:${path}`. */
  ref: string;
  stepId?: string;
  stepName: string;
  orderIndex: number;
  /** Insertion order across the run. */
  sequence: number;
  /** response.body.data.biker.id · response.headers.x-request-id · response.cookies.sid */
  path: string;
  /** Original key (id). */
  key: string;
  /** Key with its entity context (bikerId for biker.id). */
  semanticKey: string;
  /** Nearest meaningful parent (biker), "" at the top level. */
  context: string;
  value: string | number | boolean;
  text: string;
  type: RegistryValueType;
  kind: RegistrySourceKind;
  secret: boolean;
  /** An EXTRACT_VARIABLE step (or a saved mapping) names this value explicitly. */
  explicit: boolean;
  /** Variable names this value was extracted into explicitly. */
  variables: string[];
  at: number;
};

export type RegistryResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  cookies?: Record<string, string>;
};

export type RegistryStep = { stepId?: string; stepName: string; orderIndex: number };

/** Wrapper keys that carry no entity meaning (data.user.id → context "user"). */
const WRAPPERS = /^(data|result|results|payload|content|response|body|attributes|item|items|records|value|values|entity|object)$/i;
/** Headers that are worth reusing; everything else is transport noise. */
const USEFUL_HEADER =
  /^(location|content-location|etag|x-[a-z0-9-]*(id|token|session|key|ref|reference)|[a-z-]*request-id|[a-z-]*correlation-id|[a-z-]*trace-id|[a-z-]*session[a-z-]*)$/i;
const ID_KEY = /^(id|uuid|guid|code|key|ref|reference|number|no)$/i;
const MAX_LEAVES = 300;
const MAX_DEPTH = 10;
const MAX_ARRAY_ITEMS = 20;

export const normKey = (key: string) => key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

export function singular(word: string) {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
  if (/(ss|us)$/i.test(word)) return word;
  if (/(xes|ches|shes)$/i.test(word)) return word.replace(/es$/i, "");
  return word.replace(/s$/i, "");
}

function camel(context: string, key: string) {
  const head = context.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
  const tail = key.charAt(0).toUpperCase() + key.slice(1);
  return `${head.charAt(0).toLowerCase()}${head.slice(1)}${tail}`;
}

/** bikerId for (biker, id); orderUuid for (orders, uuid); status stays status. */
export function semanticKeyOf(key: string, context: string) {
  if (!context || !ID_KEY.test(key)) return key;
  return camel(singular(context), key.toLowerCase() === "uuid" ? "Uuid" : key.charAt(0).toUpperCase() + key.slice(1));
}

function typeOf(value: unknown): RegistryValueType | null {
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && value.trim() && value.length <= 2000) return "string";
  return null;
}

function contextOf(segments: string[]) {
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    if (/^\d+$/.test(segment) || WRAPPERS.test(segment)) continue;
    return singular(segment);
  }
  return "";
}

export function isTokenKey(key: string) {
  return /token|jwt|bearer|session|apikey|secret/i.test(normKey(key));
}

export class ValueRegistry {
  private items: RegistryEntry[] = [];
  private sequence = 0;

  /** Record a response; a re-executed step replaces its earlier values. */
  addResponse(step: RegistryStep, response: RegistryResponse): RegistryEntry[] {
    this.items = this.items.filter((item) => item.orderIndex !== step.orderIndex);
    const added: RegistryEntry[] = [];
    const push = (entry: Omit<RegistryEntry, "ref" | "sequence" | "at" | "explicit" | "variables" | "stepId" | "stepName" | "orderIndex">) => {
      if (added.length >= MAX_LEAVES) return;
      added.push({
        ...entry,
        ref: `${step.orderIndex}:${entry.path}`,
        stepId: step.stepId,
        stepName: step.stepName,
        orderIndex: step.orderIndex,
        sequence: this.sequence++,
        explicit: false,
        variables: [],
        at: Date.now(),
      });
    };

    const visit = (value: unknown, segments: string[], depth: number) => {
      if (depth > MAX_DEPTH || added.length >= MAX_LEAVES) return;
      if (Array.isArray(value)) {
        value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => visit(item, [...segments, String(index)], depth + 1));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          visit(child, [...segments, key], depth + 1);
        }
        return;
      }
      const type = typeOf(value);
      if (!type || segments.length === 0) return;
      const key = segments[segments.length - 1] ?? "";
      if (/^\d+$/.test(key)) return;
      const context = contextOf(segments);
      push({
        path: `response.body.${segments.join(".")}`,
        key,
        semanticKey: semanticKeyOf(key, context),
        context,
        value: value as string | number | boolean,
        text: String(value).trim(),
        type,
        kind: "body",
        secret: isSecretKey(key),
      });
    };
    visit(response.body, [], 0);

    for (const [rawName, headerValue] of Object.entries(response.headers ?? {})) {
      const name = rawName.toLowerCase();
      if (!USEFUL_HEADER.test(name) || name === "set-cookie" || typeof headerValue !== "string" || !headerValue.trim()) {
        continue;
      }
      push({
        path: `response.headers.${name}`,
        key: name,
        semanticKey: name.replace(/^x-/, "").replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
        context: "",
        value: headerValue,
        text: headerValue.trim(),
        type: "string",
        kind: "header",
        secret: isSecretKey(name),
      });
      if (name === "location" || name === "content-location") {
        // Location: /api/orders/9812 → orderId = 9812
        const parts = headerValue.split("?")[0]!.split("/").filter(Boolean);
        const last = parts[parts.length - 1];
        const collection = parts[parts.length - 2];
        if (last && collection && /\d/.test(last) && /^[A-Za-z0-9_-]+$/.test(last)) {
          const numeric = /^\d{1,15}$/.test(last);
          push({
            path: `response.headers.${name}#id`,
            key: "id",
            semanticKey: semanticKeyOf("id", singular(collection)),
            context: singular(collection),
            value: numeric ? Number(last) : last,
            text: last,
            type: numeric ? "number" : "string",
            kind: "location",
            secret: false,
          });
        }
      }
    }

    for (const [name, cookieValue] of Object.entries(response.cookies ?? {})) {
      if (!cookieValue) continue;
      push({
        path: `response.cookies.${name}`,
        key: name,
        semanticKey: name,
        context: "",
        value: cookieValue,
        text: cookieValue,
        type: "string",
        kind: "cookie",
        // A cookie is a credential until proven otherwise.
        secret: true,
      });
    }

    this.items.push(...added);
    return added;
  }

  /** An EXTRACT_VARIABLE step read `path` of step `orderIndex` into `variable`. */
  markExplicit(orderIndex: number, path: string, variable: string) {
    const wanted = normalizePath(path);
    const hit = this.items.find((item) => item.orderIndex === orderIndex && normalizePath(item.path) === wanted);
    if (!hit) return null;
    hit.explicit = true;
    if (!hit.variables.includes(variable)) hit.variables.push(variable);
    return hit;
  }

  entries(): readonly RegistryEntry[] {
    return this.items;
  }

  byRef(ref: string) {
    return this.items.find((item) => item.ref === ref);
  }

  /** Resolve a saved source: prefer the step id, fall back to its position. */
  resolve(source: { stepId?: string; orderIndex?: number; path: string }) {
    const wanted = normalizePath(source.path);
    const matches = this.items.filter((item) => normalizePath(item.path) === wanted);
    return (
      (source.stepId ? matches.find((item) => item.stepId === source.stepId) : undefined) ??
      (source.orderIndex !== undefined ? matches.find((item) => item.orderIndex === source.orderIndex) : undefined)
    );
  }

  size() {
    return this.items.length;
  }
}

/** response.body.a.b · body.a.b · $.a.b · a.b → response.body.a.b */
export function normalizePath(path: string) {
  const trimmed = path.trim();
  if (/^response\.(body|headers|cookies)\b/.test(trimmed)) return trimmed.replace(/\[(\d+)\]/g, ".$1");
  if (/^(headers|cookies)\./.test(trimmed)) return `response.${trimmed}`;
  const body = trimmed
    .replace(/^\$\.?/, "")
    .replace(/^response\./, "")
    .replace(/^body\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1");
  return body ? `response.body.${body}` : "response.body";
}

export function categoryOf(entry: Pick<RegistryEntry, "key" | "semanticKey" | "type" | "kind" | "secret" | "text">): RegistryCategory {
  if (entry.secret || isTokenKey(entry.key)) return "token";
  if (entry.kind === "header" || entry.kind === "cookie") return "header";
  if (/(id|uuid|guid)$/i.test(entry.semanticKey) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(entry.text)) return "id";
  if (entry.type === "number") return "number";
  if (entry.type === "boolean") return "boolean";
  return "string";
}

const MASK = "••••••";

/** What may leave the engine (UI, storage, a model): secrets never carry a value. */
export type RegistryView = {
  ref: string;
  stepId?: string;
  stepName: string;
  orderIndex: number;
  path: string;
  key: string;
  semanticKey: string;
  context: string;
  type: RegistryValueType;
  kind: RegistrySourceKind;
  category: RegistryCategory;
  display: string;
  secret: boolean;
  explicit: boolean;
  important: boolean;
};

const IMPORTANT = /(id|uuid|status|state|code|reference|number|token|type)$/i;

export function viewEntry(entry: RegistryEntry, secrets: ReadonlySet<string> = new Set()): RegistryView {
  const secret = entry.secret || secrets.has(entry.text);
  const text = entry.text.length > 120 ? `${entry.text.slice(0, 117)}...` : entry.text;
  const depth = entry.path.split(".").length - 2;
  return {
    ref: entry.ref,
    stepId: entry.stepId,
    stepName: entry.stepName,
    orderIndex: entry.orderIndex,
    path: entry.path,
    key: entry.key,
    semanticKey: entry.semanticKey,
    context: entry.context,
    type: entry.type,
    kind: entry.kind,
    category: categoryOf({ ...entry, secret }),
    display: secret ? MASK : text,
    secret,
    explicit: entry.explicit,
    important: entry.explicit || IMPORTANT.test(entry.semanticKey) || (depth <= 2 && entry.kind === "body"),
  };
}

/** Deterministic "Important Data": explicit, ids, states, then shallow fields. */
export function importantValues(entries: readonly RegistryEntry[], limit = 8, secrets?: ReadonlySet<string>) {
  const rank = (entry: RegistryEntry) => {
    if (entry.explicit) return 0;
    const category = categoryOf(entry);
    if (category === "id") return 1;
    if (/(status|state|code)$/i.test(entry.key)) return 2;
    if (category === "token") return 3;
    return 4 + entry.path.split(".").length;
  };
  return [...entries]
    .map((entry) => viewEntry(entry, secrets))
    .filter((view) => view.important && view.kind !== "cookie")
    .sort((a, b) => {
      const left = entries.find((item) => item.ref === a.ref)!;
      const right = entries.find((item) => item.ref === b.ref)!;
      return rank(left) - rank(right) || left.sequence - right.sequence;
    })
    .filter((view, index, list) => list.findIndex((other) => other.semanticKey === view.semanticKey && other.display === view.display) === index)
    .slice(0, limit);
}
