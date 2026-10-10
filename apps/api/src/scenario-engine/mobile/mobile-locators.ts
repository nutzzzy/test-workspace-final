import { allNodes, type MobileNode, type MobilePlatform } from "./mobile-hierarchy";

/**
 * Ways to find a mobile element again, the Appium way, ranked like the web
 * recorder ranks its locators: meaning and stability first (accessibility id,
 * resource id), visible text next, structure (XPath, class, position) last —
 * and a locator that matches several elements on the screen falls behind every
 * one that matches only this element.
 */

export const MOBILE_STRATEGIES = [
  "accessibility id",
  "id",
  "-android uiautomator",
  "-ios predicate string",
  "-ios class chain",
  "xpath",
  "class name",
] as const;
export type MobileStrategy = (typeof MOBILE_STRATEGIES)[number];

/** Why a locator got its place; the UI explains each code. */
export const LOCATOR_REASONS = [
  "accessibilityId",
  "resourceId",
  "resourceIdAndText",
  "visibleText",
  "typeAndText",
  "placeholder",
  "classChain",
  "attributeXpath",
  "containedText",
  "classOnly",
  "positional",
  "unique",
  "notUnique",
  "generated",
  "changesWithText",
  "derivedFromLabel",
  "longText",
  "xpathSlow",
] as const;
export type LocatorReason = (typeof LOCATOR_REASONS)[number];

export type MobileLocator = {
  using: MobileStrategy;
  value: string;
  /** 0–1: how likely it finds the same element on a later build of the app. */
  score?: number;
  /** It matched exactly this element on the screen it was made from. */
  unique?: boolean;
  /** Elements it matched on that screen. */
  matches?: number;
  reasons?: LocatorReason[];
};

/** What a locator selects, so it can be checked against the screen without the device. */
type Matcher = { tag?: string; attrs?: Record<string, string>; hasDescendant?: Record<string, string>; nth?: number };
type Draft = { using: MobileStrategy; value: string; base: number; kind: LocatorReason; matcher: Matcher; textual?: boolean };

const BASE: Partial<Record<LocatorReason, number>> = {
  accessibilityId: 0.95,
  resourceId: 0.9,
  resourceIdAndText: 0.86,
  visibleText: 0.75,
  typeAndText: 0.73,
  placeholder: 0.7,
  classChain: 0.7,
  attributeXpath: 0.6,
  containedText: 0.55,
  classOnly: 0.3,
  positional: 0.15,
};

const MAX_LOCATORS = 8;
const LONG_TEXT = 40;

/** Ranked locators for one element of the screen (best first). */
export function locatorsFor(root: MobileNode, node: MobileNode, platform: MobilePlatform): MobileLocator[] {
  const nodes = allNodes(root);
  const drafts = platform === "android" ? androidDrafts(node, nodes) : iosDrafts(node, nodes);
  const seen = new Set<string>();
  const out: MobileLocator[] = [];
  for (const draft of drafts) {
    const key = `${draft.using}\u0000${draft.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const matched = matchAll(nodes, draft.matcher);
    // A locator that does not even find the element it was made from is wrong, not weak.
    if (!matched.includes(node)) continue;
    out.push(score(draft, matched.length));
  }
  return rankMobileLocators(out).slice(0, MAX_LOCATORS);
}

/** Unique locators first, then by score; the order a replay tries them in. */
export function rankMobileLocators(locators: MobileLocator[]): MobileLocator[] {
  return [...locators].sort((a, b) => Number(b.unique !== false) - Number(a.unique !== false) || (b.score ?? 0) - (a.score ?? 0));
}

function score(draft: Draft, matches: number): MobileLocator {
  const reasons: LocatorReason[] = [draft.kind];
  let value = draft.base;
  if (draft.textual) reasons.push("changesWithText");
  if (/(?:^|[^a-z])(?:[0-9a-f]{8,}|\d{4,})(?:$|[^a-z])|^[a-z]{0,3}\d+$/i.test(shortValue(draft))) {
    value *= 0.6;
    reasons.push("generated");
  }
  if (draft.textual && textOf(draft).length > LONG_TEXT) {
    value *= 0.9;
    reasons.push("longText");
  }
  if (draft.using === "xpath") {
    value *= 0.95;
    reasons.push("xpathSlow");
  }
  if (matches === 1) reasons.push("unique");
  else {
    value *= 0.4;
    reasons.push("notUnique");
  }
  return { using: draft.using, value: draft.value, score: Math.round(value * 100) / 100, unique: matches === 1, matches, reasons };
}

function shortValue(draft: Draft) {
  if (draft.kind === "resourceId") return draft.value.replace(/^.*:id\//, "");
  if (draft.kind === "accessibilityId") return draft.value;
  return "";
}

function textOf(draft: Draft) {
  return Object.values(draft.matcher.attrs ?? draft.matcher.hasDescendant ?? {}).join(" ");
}

function androidDrafts(node: MobileNode, nodes: MobileNode[]): Draft[] {
  const a = node.attrs;
  const cls = a.class || node.tag;
  const desc = a["content-desc"]?.trim() ? a["content-desc"] : "";
  const rid = a["resource-id"]?.trim() ? a["resource-id"] : "";
  const text = a.password !== "true" && a.text?.trim() ? a.text : "";
  const hint = a.hint?.trim() && a.hint !== text ? a.hint : "";
  const out: Draft[] = [];
  if (desc) out.push({ using: "accessibility id", value: desc, base: BASE.accessibilityId!, kind: "accessibilityId", matcher: { attrs: { "content-desc": desc } } });
  if (rid) out.push({ using: "id", value: rid, base: BASE.resourceId!, kind: "resourceId", matcher: { attrs: { "resource-id": rid } } });
  if (rid && text) {
    out.push({
      using: "-android uiautomator",
      value: `new UiSelector().resourceId(${javaString(rid)}).text(${javaString(text)})`,
      base: BASE.resourceIdAndText!,
      kind: "resourceIdAndText",
      matcher: { attrs: { "resource-id": rid, text } },
      textual: true,
    });
  }
  if (text) {
    out.push({ using: "-android uiautomator", value: `new UiSelector().text(${javaString(text)})`, base: BASE.visibleText!, kind: "visibleText", matcher: { attrs: { text } }, textual: true });
    out.push({
      using: "-android uiautomator",
      value: `new UiSelector().className(${javaString(cls)}).text(${javaString(text)})`,
      base: BASE.typeAndText!,
      kind: "typeAndText",
      matcher: { tag: node.tag, attrs: { text } },
      textual: true,
    });
    const quoted = xpathString(text);
    if (quoted) out.push({ using: "xpath", value: `//${node.tag}[@text=${quoted}]`, base: BASE.attributeXpath!, kind: "attributeXpath", matcher: { tag: node.tag, attrs: { text } }, textual: true });
  }
  if (hint) {
    const quoted = xpathString(hint);
    if (quoted) out.push({ using: "xpath", value: `//${node.tag}[@hint=${quoted}]`, base: BASE.placeholder!, kind: "placeholder", matcher: { tag: node.tag, attrs: { hint } }, textual: true });
  }
  if (!text && !desc) {
    // A clickable row or card with its title in a child: the row that contains that text.
    const inner = innerAttr(node, "text");
    const quoted = inner ? xpathString(inner) : null;
    if (inner && quoted && a.clickable === "true") {
      out.push({
        using: "xpath",
        value: `//${node.tag}[@clickable="true"][.//*[@text=${quoted}]]`,
        base: BASE.containedText!,
        kind: "containedText",
        matcher: { tag: node.tag, attrs: { clickable: "true" }, hasDescendant: { text: inner } },
        textual: true,
      });
    }
  }
  out.push({ using: "class name", value: cls, base: BASE.classOnly!, kind: "classOnly", matcher: { tag: node.tag } });
  out.push(positional(node, nodes));
  return out;
}

function iosDrafts(node: MobileNode, nodes: MobileNode[]): Draft[] {
  const a = node.attrs;
  const type = a.type || node.tag;
  const name = a.name?.trim() ? a.name : "";
  const label = a.label?.trim() ? a.label : "";
  const placeholder = a.placeholderValue?.trim() ? a.placeholderValue : "";
  const out: Draft[] = [];
  if (name) {
    // Without an accessibility identifier, XCUITest reports the label as the name: it changes with the text.
    const derived = name === label;
    out.push({
      using: "accessibility id",
      value: name,
      base: BASE.accessibilityId! * (derived ? 0.8 : 1),
      kind: "accessibilityId",
      matcher: { attrs: { name } },
      textual: derived,
    });
  }
  if (label) {
    out.push({ using: "-ios predicate string", value: `label == ${predicateString(label)}`, base: BASE.visibleText!, kind: "visibleText", matcher: { attrs: { label } }, textual: true });
    out.push({
      using: "-ios predicate string",
      value: `type == ${predicateString(type)} AND label == ${predicateString(label)}`,
      base: BASE.typeAndText!,
      kind: "typeAndText",
      matcher: { tag: node.tag, attrs: { label } },
      textual: true,
    });
    if (!label.includes("`")) {
      out.push({ using: "-ios class chain", value: `**/${type}[\`label == ${predicateString(label)}\`]`, base: BASE.classChain!, kind: "classChain", matcher: { tag: node.tag, attrs: { label } }, textual: true });
    }
  }
  if (placeholder) {
    out.push({
      using: "-ios predicate string",
      value: `type == ${predicateString(type)} AND placeholderValue == ${predicateString(placeholder)}`,
      base: BASE.placeholder!,
      kind: "placeholder",
      matcher: { tag: node.tag, attrs: { placeholderValue: placeholder } },
      textual: true,
    });
  }
  const attr = name ? "name" : label ? "label" : "";
  const quoted = attr ? xpathString(a[attr]!) : null;
  if (attr && quoted) {
    out.push({ using: "xpath", value: `//${node.tag}[@${attr}=${quoted}]`, base: BASE.attributeXpath!, kind: "attributeXpath", matcher: { tag: node.tag, attrs: { [attr]: a[attr]! } }, textual: attr === "label" || name === label });
  }
  if (!name && !label) {
    const inner = innerAttr(node, "label");
    const innerQuoted = inner ? xpathString(inner) : null;
    if (inner && innerQuoted) {
      out.push({
        using: "xpath",
        value: `//${node.tag}[.//*[@label=${innerQuoted}]]`,
        base: BASE.containedText!,
        kind: "containedText",
        matcher: { tag: node.tag, hasDescendant: { label: inner } },
        textual: true,
      });
    }
  }
  out.push({ using: "class name", value: type, base: BASE.classOnly!, kind: "classOnly", matcher: { tag: node.tag } });
  out.push(positional(node, nodes));
  return out;
}

/** `(//tag)[n]`: always one element, and the first to break when the screen changes. */
function positional(node: MobileNode, nodes: MobileNode[]): Draft {
  const nth = nodes.filter((item) => item.tag === node.tag).indexOf(node) + 1;
  return { using: "xpath", value: `(//${node.tag})[${nth}]`, base: BASE.positional!, kind: "positional", matcher: { tag: node.tag, nth } };
}

function innerAttr(node: MobileNode, attr: string): string {
  for (const child of node.children) {
    const value = child.attrs[attr]?.trim();
    if (value) return child.attrs[attr]!;
    const deeper = innerAttr(child, attr);
    if (deeper) return deeper;
  }
  return "";
}

function matchAll(nodes: MobileNode[], matcher: Matcher): MobileNode[] {
  const hits = nodes.filter((node) => matches(node, matcher));
  if (matcher.nth === undefined) return hits;
  const hit = hits[matcher.nth - 1];
  return hit ? [hit] : [];
}

function matches(node: MobileNode, matcher: Matcher): boolean {
  if (matcher.tag && node.tag !== matcher.tag) return false;
  for (const [key, value] of Object.entries(matcher.attrs ?? {})) if (node.attrs[key] !== value) return false;
  if (matcher.hasDescendant && !hasDescendant(node, matcher.hasDescendant)) return false;
  return true;
}

function hasDescendant(node: MobileNode, attrs: Record<string, string>): boolean {
  return node.children.some((child) => Object.entries(attrs).every(([key, value]) => child.attrs[key] === value) || hasDescendant(child, attrs));
}

function javaString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function predicateString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An XPath string literal, or null when the text has both kinds of quotes. */
function xpathString(value: string): string | null {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return null;
}
