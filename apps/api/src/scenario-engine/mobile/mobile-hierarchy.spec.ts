import { allNodes, boundsOf, detectElements, detectPlatform, findNode, parsePageSource, screenSize } from "./mobile-hierarchy";
import { locatorsFor } from "./mobile-locators";
import { ANDROID_LOGIN, IOS_LOGIN } from "./mobile-fixtures";

describe("parsePageSource", () => {
  it("reads UiAutomator2 XML: tags, attributes, entities, tree paths", () => {
    const root = parsePageSource(ANDROID_LOGIN);
    expect(detectPlatform(root)).toBe("android");
    const title = allNodes(root).find((node) => node.attrs["resource-id"] === "com.shop.app:id/title")!;
    expect(title.tag).toBe("android.widget.TextView");
    expect(title.attrs.text).toBe("Welcome & sign in");
    expect(title.path).toBe("0.0.0");
    expect(findNode(root, "0.0.0")).toBe(title);
    expect(boundsOf(title)).toEqual({ x: 40, y: 100, width: 1000, height: 80 });
    expect(screenSize(root)).toEqual({ width: 1080, height: 2220 });
  });

  it("reads XCUITest XML with x / y / width / height", () => {
    const root = parsePageSource(IOS_LOGIN);
    expect(detectPlatform(root)).toBe("ios");
    const button = allNodes(root).find((node) => node.attrs.name === "Sign in")!;
    expect(boundsOf(button)).toEqual({ x: 20, y: 290, width: 350, height: 50 });
    expect(screenSize(root)).toEqual({ width: 390, height: 844 });
  });

  it("rejects what is not a screen description", () => {
    expect(() => parsePageSource("")).toThrow("empty screen description");
    expect(() => parsePageSource("<hierarchy><a></b></hierarchy>")).toThrow("not valid XML");
    expect(() => parsePageSource("<hierarchy>")).toThrow("not valid XML");
    expect(() => parsePageSource("just text")).toThrow("not valid XML");
  });
});

describe("detectElements", () => {
  it("finds Android buttons, fields, clickable rows and labelled text; skips zero-sized ones", () => {
    const root = parsePageSource(ANDROID_LOGIN);
    const elements = detectElements(root, "android");
    expect(elements.map((element) => [element.name, element.interactive])).toEqual([
      ["Welcome & sign in", false],
      ["email", true],
      ["password", true],
      ["login-button", true],
      ["Help", true],
      ["Help", true],
      ["Forgot password?", true],
      ["Forgot password?", false],
    ]);
    const password = elements.find((element) => element.attributes["resource-id"] === "com.shop.app:id/password")!;
    expect(password).toMatchObject({ editable: true, password: true });
    expect(elements.find((element) => element.attributes["resource-id"] === "com.shop.app:id/email")).toMatchObject({ editable: true, password: false });
  });

  it("finds iOS controls and text; skips hidden elements, layout containers and keyboard keys", () => {
    const elements = detectElements(parsePageSource(IOS_LOGIN), "ios");
    expect(elements.map((element) => [element.name, element.tag.replace("XCUIElementType", ""), element.interactive])).toEqual([
      ["Welcome", "StaticText", false],
      ["email-field", "TextField", true],
      ["password-field", "SecureTextField", true],
      ["Sign in", "Button", true],
      ["Orders", "Cell", true],
      ["Orders", "StaticText", false],
    ]);
    expect(elements[2]).toMatchObject({ editable: true, password: true });
  });
});

describe("locatorsFor (ranking)", () => {
  const androidRoot = parsePageSource(ANDROID_LOGIN);
  const iosRoot = parsePageSource(IOS_LOGIN);
  const androidNode = (rid: string) => allNodes(androidRoot).find((node) => node.attrs["resource-id"] === rid)!;

  it("prefers the accessibility id, then the resource id, over text and structure", () => {
    const locators = locatorsFor(androidRoot, androidNode("com.shop.app:id/login"), "android");
    expect(locators.slice(0, 3).map((item) => item.using)).toEqual(["accessibility id", "id", "-android uiautomator"]);
    expect(locators[0]).toMatchObject({ value: "login-button", unique: true, matches: 1 });
    expect(locators[0]!.reasons).toEqual(expect.arrayContaining(["accessibilityId", "unique"]));
    // Structure last: the position (unique, fragile), then the class (matches every button).
    expect(locators.slice(-2)).toMatchObject([
      { using: "xpath", value: "(//android.widget.Button)[1]", unique: true, reasons: expect.arrayContaining(["positional"]) },
      { using: "class name", value: "android.widget.Button", unique: false, matches: 4 },
    ]);
    for (let index = 1; index < locators.length; index += 1) expect(locators[index - 1]!.score!).toBeGreaterThanOrEqual(locators[index]!.score!);
  });

  it("never puts a locator that matches several elements before one that matches only this element", () => {
    const help = allNodes(androidRoot).filter((node) => node.attrs.text === "Help")[1]!;
    const locators = locatorsFor(androidRoot, help, "android");
    const firstAmbiguous = locators.findIndex((item) => item.unique === false);
    const lastUnique = locators.map((item) => item.unique).lastIndexOf(true);
    expect(lastUnique).toBeLessThan(firstAmbiguous);
    expect(locators[0]).toMatchObject({ using: "xpath", value: "(//android.widget.Button)[3]", unique: true });
    const text = locators.find((item) => item.value === 'new UiSelector().text("Help")')!;
    expect(text).toMatchObject({ unique: false, matches: 2, reasons: expect.arrayContaining(["notUnique", "changesWithText"]) });
  });

  it("flags generated ids and reads a row by the text inside it", () => {
    const row = androidNode("com.shop.app:id/row_9f3a2b1c4d");
    const locators = locatorsFor(androidRoot, row, "android");
    expect(locators.find((item) => item.using === "id")!.reasons).toContain("generated");
    expect(locators.find((item) => item.reasons?.includes("containedText"))).toMatchObject({
      value: '//android.view.ViewGroup[@clickable="true"][.//*[@text="Forgot password?"]]',
      unique: true,
    });
  });

  it("does not use a password field's text, and uses the hint of an empty field", () => {
    const password = locatorsFor(androidRoot, androidNode("com.shop.app:id/password"), "android");
    expect(password.some((item) => item.value.includes("••••"))).toBe(false);
    const email = locatorsFor(androidRoot, androidNode("com.shop.app:id/email"), "android");
    expect(email.find((item) => item.reasons?.includes("placeholder"))?.value).toBe('//android.widget.EditText[@hint="Email"]');
  });

  it("uses iOS accessibility ids, predicates and class chains, and marks a name copied from the label", () => {
    const nodes = allNodes(iosRoot);
    const email = locatorsFor(iosRoot, nodes.find((node) => node.attrs.name === "email-field")!, "ios");
    expect(email[0]).toMatchObject({ using: "accessibility id", value: "email-field", unique: true });
    expect(email.some((item) => item.value === 'type == "XCUIElementTypeTextField" AND placeholderValue == "Email"')).toBe(true);
    const signIn = locatorsFor(iosRoot, nodes.find((node) => node.attrs.name === "Sign in" && node.tag === "XCUIElementTypeButton")!, "ios");
    expect(signIn[0]!.reasons).toEqual(expect.arrayContaining(["accessibilityId", "changesWithText"]));
    expect(signIn.map((item) => item.using)).toEqual(expect.arrayContaining(["-ios predicate string", "-ios class chain", "xpath"]));
    expect(signIn.find((item) => item.using === "-ios class chain")!.value).toBe('**/XCUIElementTypeButton[`label == "Sign in"`]');
    const cell = locatorsFor(iosRoot, nodes.find((node) => node.tag === "XCUIElementTypeCell")!, "ios");
    expect(cell.find((item) => item.reasons?.includes("containedText"))?.value).toBe('//XCUIElementTypeCell[.//*[@label="Orders"]]');
  });

  it("escapes quotes in generated locators", () => {
    const xml = `<hierarchy><android.widget.Button class="android.widget.Button" text='Say "hi"' bounds="[0,0][10,10]" clickable="true"/></hierarchy>`;
    const root = parsePageSource(xml);
    const locators = locatorsFor(root, allNodes(root)[1]!, "android");
    expect(locators.find((item) => item.reasons?.includes("visibleText"))!.value).toBe('new UiSelector().text("Say \\"hi\\"")');
    expect(locators.find((item) => item.reasons?.includes("attributeXpath"))!.value).toBe(`//android.widget.Button[@text='Say "hi"']`);
  });
});
