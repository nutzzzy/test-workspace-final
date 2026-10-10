/**
 * The screen of a mobile app as Appium describes it (page source XML), and
 * the elements on it a test can act on or check. Android (UiAutomator2) and
 * iOS (XCUITest) describe elements differently; both become `MobileNode`s
 * with their raw attributes, and `detectElements` reads them per platform.
 */

export type MobilePlatform = "android" | "ios";

export type MobileNode = {
  tag: string;
  attrs: Record<string, string>;
  children: MobileNode[];
  parent: MobileNode | null;
  /** Position in the tree: child indexes from the root, joined with dots ("0.2.1"). */
  path: string;
  /** Document order (XPath `//` order). */
  order: number;
};

export type Bounds = { x: number; y: number; width: number; height: number };

export type DetectedElement = {
  /** The node's tree path: stable for one capture of the screen only. */
  id: string;
  tag: string;
  /** What the element is called: its text, accessibility id or a text inside it. */
  name: string;
  /** Taps and typing go to it (button, field, switch, cell); otherwise it is text to check. */
  interactive: boolean;
  /** Typing goes into it. */
  editable: boolean;
  /** A password field: its value is never read back. */
  password: boolean;
  bounds: Bounds | null;
  /** The attributes locators are made from, platform names kept (resource-id, content-desc, name, label, …). */
  attributes: Record<string, string>;
};

const MAX_NODES = 20_000;
const MAX_SOURCE_CHARS = 8_000_000;

/** Parse Appium's page source. Throws when it is not XML Appium could have written. */
export function parsePageSource(xml: string): MobileNode {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("The app returned an empty screen description");
  if (xml.length > MAX_SOURCE_CHARS) throw new Error("The screen description is too large to read");
  const root: MobileNode = { tag: "#document", attrs: {}, children: [], parent: null, path: "", order: -1 };
  const stack: MobileNode[] = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<(\/?)([A-Za-z_][\w.:$-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let order = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (!tag) continue;
    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== tag || stack.length === 0) throw new Error("The screen description is not valid XML");
      continue;
    }
    const parent = stack[stack.length - 1]!;
    const node: MobileNode = {
      tag,
      attrs: readAttributes(rawAttrs ?? ""),
      children: [],
      parent,
      path: parent === root ? String(parent.children.length) : `${parent.path}.${parent.children.length}`,
      order: order++,
    };
    if (order > MAX_NODES) throw new Error("The screen has too many elements to read");
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length === 0) throw new Error("The screen description is not valid XML");
  return root;
}

function readAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return out;
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Every element node, in document order (the document node itself left out). */
export function allNodes(root: MobileNode): MobileNode[] {
  const out: MobileNode[] = [];
  const visit = (node: MobileNode) => {
    for (const child of node.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

export function findNode(root: MobileNode, path: string): MobileNode | null {
  if (!path) return null;
  let node: MobileNode | undefined = root;
  for (const part of path.split(".")) {
    node = node?.children[Number(part)];
    if (!node) return null;
  }
  return node ?? null;
}

/** The platform a page source was written for. */
export function detectPlatform(root: MobileNode): MobilePlatform | null {
  const first = root.children[0];
  if (!first) return null;
  if (first.tag === "hierarchy" || allNodes(root).slice(0, 5).some((node) => node.tag.startsWith("android."))) return "android";
  if (first.tag === "AppiumAUT" || first.tag.startsWith("XCUIElementType")) return "ios";
  return null;
}

/** Android "[x1,y1][x2,y2]" or iOS x / y / width / height, in the screen's coordinates. */
export function boundsOf(node: MobileNode): Bounds | null {
  const android = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.attrs.bounds ?? "");
  if (android) {
    const [x1, y1, x2, y2] = android.slice(1).map(Number) as [number, number, number, number];
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  }
  const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => Number(node.attrs[key]));
  if ([x, y, width, height].every((value) => Number.isFinite(value)) && node.attrs.width !== undefined) {
    return { x: x!, y: y!, width: width!, height: height! };
  }
  return null;
}

const ANDROID_INTERACTIVE_CLASS = /(?:EditText|Button|ImageButton|CheckBox|Switch|RadioButton|Spinner|ToggleButton|SeekBar|CheckedTextView|AutoCompleteTextView)$/;
const ANDROID_EDITABLE_CLASS = /(?:EditText|AutoCompleteTextView)$/;
const IOS_INTERACTIVE_TYPES = new Set([
  "XCUIElementTypeButton",
  "XCUIElementTypeTextField",
  "XCUIElementTypeSecureTextField",
  "XCUIElementTypeSearchField",
  "XCUIElementTypeTextView",
  "XCUIElementTypeSwitch",
  "XCUIElementTypeSlider",
  "XCUIElementTypeStepper",
  "XCUIElementTypeCell",
  "XCUIElementTypeLink",
  "XCUIElementTypeSegmentedControl",
  "XCUIElementTypePickerWheel",
  "XCUIElementTypeTab",
  "XCUIElementTypeMenuItem",
  "XCUIElementTypeCheckBox",
  "XCUIElementTypeRadioButton",
]);
const IOS_EDITABLE_TYPES = new Set(["XCUIElementTypeTextField", "XCUIElementTypeSecureTextField", "XCUIElementTypeSearchField", "XCUIElementTypeTextView"]);
const IOS_TEXT_TYPES = new Set(["XCUIElementTypeStaticText", "XCUIElementTypeImage", "XCUIElementTypeOther"]);
/** Keyboard keys are typed through, never tapped as steps. */
const IOS_SKIPPED_PARENTS = new Set(["XCUIElementTypeKeyboard"]);

const MAX_ELEMENTS = 400;

/**
 * The elements a step can use on this screen: what can be tapped or typed
 * into, and labelled text that can be checked. Hidden and zero-sized elements
 * are left out; so are iOS keyboard keys.
 */
export function detectElements(root: MobileNode, platform: MobilePlatform): DetectedElement[] {
  const out: DetectedElement[] = [];
  for (const node of allNodes(root)) {
    if (out.length >= MAX_ELEMENTS) break;
    const element = platform === "android" ? androidElement(node) : iosElement(node);
    if (element) out.push(element);
  }
  return out;
}

function androidElement(node: MobileNode): DetectedElement | null {
  const a = node.attrs;
  if (!a.class && !node.tag.includes(".")) return null;
  if (a.displayed === "false") return null;
  const bounds = boundsOf(node);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const className = a.class || node.tag;
  const editable = ANDROID_EDITABLE_CLASS.test(className);
  const interactive =
    a.clickable === "true" || a["long-clickable"] === "true" || a.checkable === "true" || editable || ANDROID_INTERACTIVE_CLASS.test(className);
  const text = (a.text ?? "").trim();
  const desc = (a["content-desc"] ?? "").trim();
  if (!interactive && !text && !desc) return null;
  const password = a.password === "true";
  const name = desc || (password ? "" : text) || innerText(node, "android") || shortId(a["resource-id"]) || className.split(".").pop()!;
  return {
    id: node.path,
    tag: node.tag,
    name,
    interactive,
    editable,
    password,
    bounds,
    attributes: pick(a, ["resource-id", "content-desc", "text", "class", "package", "checkable", "checked", "clickable", "enabled", "focused", "selected", "password", "hint"]),
  };
}

function iosElement(node: MobileNode): DetectedElement | null {
  const a = node.attrs;
  const type = a.type || node.tag;
  if (!type.startsWith("XCUIElementType") || type === "XCUIElementTypeApplication" || type === "XCUIElementTypeWindow") return null;
  if (a.visible === "false") return null;
  for (let parent = node.parent; parent; parent = parent.parent) if (IOS_SKIPPED_PARENTS.has(parent.attrs.type || parent.tag)) return null;
  const bounds = boundsOf(node);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const interactive = IOS_INTERACTIVE_TYPES.has(type);
  const label = (a.label ?? "").trim();
  const nameAttr = (a.name ?? "").trim();
  // "Other" elements are mostly layout; only an accessible one with a name says something.
  if (!interactive && (!IOS_TEXT_TYPES.has(type) || (!label && !nameAttr) || (type === "XCUIElementTypeOther" && a.accessible !== "true"))) return null;
  const password = type === "XCUIElementTypeSecureTextField";
  return {
    id: node.path,
    tag: node.tag,
    name: label || nameAttr || (password ? "" : (a.value ?? "").trim()) || innerText(node, "ios") || type.replace("XCUIElementType", ""),
    interactive,
    editable: IOS_EDITABLE_TYPES.has(type),
    password,
    bounds,
    attributes: pick(a, ["type", "name", "label", "value", "enabled", "visible", "accessible", "placeholderValue"]),
  };
}

/** The first text inside an element (a clickable row's title). */
export function innerText(node: MobileNode, platform: MobilePlatform): string {
  for (const child of node.children) {
    const text = platform === "android" ? (child.attrs.text || child.attrs["content-desc"] || "").trim() : (child.attrs.label || child.attrs.name || "").trim();
    if (text) return text;
    const deeper = innerText(child, platform);
    if (deeper) return deeper;
  }
  return "";
}

function shortId(resourceId: string | undefined) {
  return resourceId ? resourceId.replace(/^.*:id\//, "") : "";
}

function pick(attrs: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) if (attrs[key] !== undefined && attrs[key] !== "") out[key] = attrs[key]!.slice(0, 500);
  return out;
}

/** The screen's size in element coordinates: the root element's bounds. */
export function screenSize(root: MobileNode): { width: number; height: number } | null {
  const first = root.children[0];
  if (!first) return null;
  if (first.attrs.width && first.attrs.height && !first.attrs.x) {
    const width = Number(first.attrs.width);
    const height = Number(first.attrs.height);
    if (width > 0 && height > 0) return { width, height };
  }
  for (const node of allNodes(root).slice(0, 3)) {
    const bounds = boundsOf(node);
    if (bounds && bounds.width > 0 && bounds.height > 0) return { width: bounds.x + bounds.width, height: bounds.y + bounds.height };
  }
  return null;
}
