import { parseJsonPath, readJsonPath } from "@qa-workbench/shared";
import { isDynamicSegment } from "../ui/replay-smarts";
import { resolveSource, type ResponseSource } from "./bindings";
import type { ValueRegistry } from "./value-registry";

/**
 * Which item of a list a mapping reads. A position ("the first order") is
 * only right while nobody else adds to the list; a condition ("the order whose
 * code is the one the UI step ended on") is right every run:
 *   response.body.orders[ code ∈ Step 1 → response.body.path ].id
 */
export type PickCondition = {
  /** Field of the item, e.g. "code" or "vendor.code". */
  field: string;
  /** equals: the same value; in: the item's value appears inside the other (a code inside a URL). */
  op: "equals" | "in";
  /** A fixed value or {{variable}}, or a value of an earlier step. */
  value: { text: string } | { source: ResponseSource };
};

export type ListPick = {
  /** The list, e.g. "response.body.orders". */
  list: string;
  /** What to read from the chosen item, e.g. "id". */
  item: string;
  /** Without conditions: first (default) or last. With conditions: which of several matches. */
  position?: "first" | "last";
  where?: PickCondition[];
};

export type PickResult =
  | { ok: true; value: unknown; index: number; path: string }
  | { ok: false; reason: "list_missing" | "no_match" | "condition_unresolved"; detail: string };

/** response.body.orders.0.id → { list: response.body.orders, index: 0, item: id }; null when no list index in it. */
export function splitListPath(path: string): { list: string; index: number; item: string } | null {
  const parts = path.split(".");
  // The last numeric segment: the item of the innermost list.
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    if (/^\d+$/.test(parts[at]!)) {
      return { list: parts.slice(0, at).join("."), index: Number(parts[at]), item: parts.slice(at + 1).join(".") };
    }
  }
  return null;
}

function read(value: unknown, path: string): unknown {
  if (!path) return value;
  const parsed = parseJsonPath(`$.${path}`);
  if (!parsed.ok) return undefined;
  const found = readJsonPath(value, parsed.segments);
  return found.found ? found.value : undefined;
}

/** response.body.orders → the list inside a response body. */
function listOf(body: unknown, list: string): unknown[] | null {
  const inner = list.replace(/^response\.body\.?/, "");
  const value = read(body, inner);
  return Array.isArray(value) ? value : null;
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** One condition against one item. A tiny value (1, "a") never counts as found inside another. */
function holds(item: unknown, condition: PickCondition, wanted: string) {
  const own = text(read(item, condition.field));
  if (!own) return false;
  if (condition.op === "equals") return own === wanted;
  return own.length >= 3 && wanted.includes(own);
}

/**
 * The chosen item's value from the source step's full response (`body`).
 * Conditions take their values from the registry (earlier steps) or text.
 */
export function resolvePick(
  pick: ListPick,
  body: unknown,
  registry: ValueRegistry,
  fill: (template: string) => string | undefined,
): PickResult {
  const items = listOf(body, pick.list);
  if (!items) return { ok: false, reason: "list_missing", detail: `${pick.list} is not a list in the response` };
  const wanted: string[] = [];
  for (const condition of pick.where ?? []) {
    if ("text" in condition.value) {
      const value = fill(condition.value.text);
      if (value === undefined) return { ok: false, reason: "condition_unresolved", detail: `no value for ${condition.value.text}` };
      wanted.push(value);
    } else {
      const found = resolveSource(condition.value.source, registry);
      if (!found.ok) {
        return { ok: false, reason: "condition_unresolved", detail: `${condition.value.source.stepName ?? "an earlier step"} did not provide ${condition.value.source.path}` };
      }
      wanted.push(found.entry.text);
    }
  }
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (pick.where ?? []).every((condition, at) => holds(item, condition, wanted[at]!)));
  const chosen = pick.position === "last" ? matches[matches.length - 1] : matches[0];
  if (!chosen) {
    const what = (pick.where ?? []).map((condition, at) => `${condition.field} ${condition.op === "in" ? "in" : "="} ${wanted[at]}`).join(" and ");
    return { ok: false, reason: "no_match", detail: `no item of ${pick.list} has ${what || "anything"} (${items.length} items)` };
  }
  const value = read(chosen.item, pick.item);
  if (value === undefined || value === null || typeof value === "object") {
    return { ok: false, reason: "no_match", detail: `item ${chosen.index} of ${pick.list} has no ${pick.item}` };
  }
  return { ok: true, value, index: chosen.index, path: `${pick.list}.${chosen.index}.${pick.item}` };
}

export type AnchorSuggestion = {
  condition: PickCondition;
  /** e.g. code "p47l5j" appears in Step 1 → response.body.path "/order/follow/p47l5j/". */
  preview: { itemValue: string; otherValue: string; otherStep: string; otherPath: string };
};

/**
 * Ways to recognise the chosen item by data of other steps instead of its
 * position: fields of the item (codes, ids — not names or prices) whose value
 * another earlier step produced too, as the same value or inside a URL.
 */
export function suggestAnchors(
  item: unknown,
  others: Array<{ stepId?: string; stepName: string; orderIndex: number; path: string; text: string }>,
): AnchorSuggestion[] {
  const out: AnchorSuggestion[] = [];
  const fields: Array<{ field: string; value: string }> = [];
  const visit = (value: unknown, path: string[], depth: number) => {
    if (depth > 3 || fields.length > 80) return;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key], depth + 1);
      return;
    }
    if (typeof value === "string" || typeof value === "number") {
      const own = String(value);
      // Identifying values: codes and ids, not counts, prices or words.
      if (own.length >= 4 && own.length <= 64 && (isDynamicSegment(own) || /^[A-Za-z0-9_-]+$/.test(own) && /\d/.test(own))) fields.push({ field: path.join("."), value: own });
    }
  };
  visit(item, [], 0);
  for (const { field, value } of fields) {
    for (const other of others) {
      const op = other.text === value ? "equals" : other.text.length > value.length && new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(other.text) ? "in" : null;
      if (!op) continue;
      out.push({
        condition: { field, op, value: { source: { stepId: other.stepId, stepName: other.stepName, orderIndex: other.orderIndex, path: other.path } } },
        preview: { itemValue: value, otherValue: other.text.slice(0, 160), otherStep: other.stepName, otherPath: other.path },
      });
    }
  }
  // Exact matches first, then values found inside URLs; one suggestion per field and source.
  const seen = new Set<string>();
  return out
    .sort((a, b) => Number(a.condition.op === "in") - Number(b.condition.op === "in"))
    .filter((item) => {
      const key = `${item.condition.field}|${JSON.stringify(item.condition.value)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}
