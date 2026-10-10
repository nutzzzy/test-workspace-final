/**
 * Precondition export: turn a saved precondition into automation code for a
 * test framework, written by one of the workspace's AI connections.
 *
 * Everything that differs per framework lives in its registry entry
 * (`EXPORT_FRAMEWORKS`): languages, file names, generation rules and the
 * checks that tell its code apart from another framework's. Adding a
 * framework is adding an entry; the export dialog, the API and the
 * validation read the registry.
 */

// ── normalized precondition context (what the AI receives) ──────────────

/**
 * One way to find an element, as the AI receives it: exactly one kind —
 * `{ testid }` (attribute data-testid unless `attr` names another),
 * `{ role, name }`, `{ label }`, `{ placeholder }`, `{ text }`, `{ css }` or `{ xpath }`.
 */
export type ExportLocator = {
  testid?: string;
  attr?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
  xpath?: string;
};

export type ExportUiAction = {
  /** navigate | click | fill | select | check | uncheck | press | hover | upload | waitForElement | waitForText | assertText | assertUrl */
  do: string;
  /** What the user did, in words (recorded label). */
  label?: string;
  url?: string;
  /** Typed text, option, key or expected text; `{{name}}` is a variable. */
  value?: string;
  /** The typed value is secret: read it from this environment variable. */
  secretEnv?: string;
  option?: string;
  /** Ways to find the element, most reliable first. */
  locators?: ExportLocator[];
  /** The element is inside a repeated structure (table, list): find the row by what it contains, then the element in it. */
  row?: { container?: string; rowSelector: string; match: string[]; target: ExportLocator[] };
  /** Named region around the element (dialog, form). */
  within?: string;
  frameUrl?: string;
  tab?: number;
  optional?: boolean;
  files?: string[];
};

/** One way to find a mobile element: an Appium locator strategy and its value, used verbatim. */
export type ExportMobileLocator = { using: string; value: string };

export type ExportMobileAction = {
  /** tap | type | clear | longPress | swipe | back | assertText | assertVisible | waitForElement */
  do: string;
  label?: string;
  /** Typed text or expected text; `{{name}}` is a variable. */
  value?: string;
  /** The typed value is secret: read it from this environment variable. */
  secretEnv?: string;
  /** Ways to find the element, most reliable first. */
  locators?: ExportMobileLocator[];
  /** Swipe direction (up moves the content up). */
  direction?: string;
  optional?: boolean;
};

export type ExportStep =
  | { type: "ui"; name: string; startUrl: string; newSession?: boolean; actions: ExportUiAction[] }
  | {
      type: "mobile";
      name: string;
      platform: "android" | "ios";
      /** Appium server URL (credentials removed). */
      server: string;
      /** Appium capabilities as recorded (secret values masked). */
      capabilities: Record<string, unknown>;
      newSession?: boolean;
      actions: ExportMobileAction[];
    }
  | {
      type: "http";
      name: string;
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      expectStatus?: number[];
      /** variable → response path it is read from (for later steps). */
      extract?: Record<string, string>;
      /** request input (header.x, query.y, path "<recorded segment>") → the earlier step's response value or literal it takes. */
      uses?: Record<string, string>;
    }
  | { type: "assert"; name: string; check: string; path?: string; expected?: unknown }
  | { type: "db"; name: string; operation: string; query: string; database?: string; expect?: string }
  | { type: "delay"; name: string; ms: number }
  | { type: "setVar"; name: string; variable: string; value: unknown }
  | { type: "extractVar"; name: string; variable: string; path: string }
  | { type: "condition"; name: string; left: string; op: string; right: string };

export type ExportContext = {
  preconditionId: string;
  name: string;
  description?: string;
  /** The first URL the precondition opens or calls. */
  url?: string;
  /** Steps in execution order; UI steps carry their actions, assertions and locators in order. */
  steps: ExportStep[];
  /** `{{variables}}` the steps use that no step produces (environment / configuration values). */
  variables: string[];
  metadata: {
    environment?: string;
    stopOnFailure: boolean;
    disabledStepsLeftOut?: number;
    /** Steps the chosen framework cannot drive (a browser framework and a mobile step, or the reverse), left out of the code. */
    leftOut?: Array<{ step: string; reason: string }>;
  };
  /** Set when one step is exported on its own: which step, and what the caller must provide. */
  scope?: ExportScope;
};

/** A single-step export: the step's place in the precondition and the values it needs from earlier steps or configuration. */
export type ExportScope = {
  kind: "step";
  step: string;
  /** The precondition the step belongs to. */
  precondition: string;
  /** 1-based position of the step in the precondition. */
  position: number;
  total: number;
  /** `{{variables}}` the step reads: parameters of the exported function. */
  inputs: string[];
  /** An earlier step of the same kind leaves the browser or app session this step continues in. */
  continuesSession?: boolean;
};

/** What a UI step drives: a browser page or a mobile app (through Appium). */
export type ExportSurface = "web" | "mobile";

// ── registry ─────────────────────────────────────────────────────────────

export type ExportLanguageId = "typescript" | "javascript" | "python" | "java" | "robot";

export const EXPORT_LANGUAGE_LABELS: Record<ExportLanguageId, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  robot: "Robot Framework",
};

export type ExportLanguage = {
  id: ExportLanguageId;
  /** File name of the generated test, from the precondition's name. */
  filename: (name: ExportName) => string;
  /** Language-specific generation rules for this framework. */
  instructions: string;
  /** At least one must match: the code uses this framework in this language. */
  signature: RegExp[];
  /**
   * Replace the framework's own rules, action calls and browser-only flag:
   * the language drives the framework through another API (Robot Framework
   * keywords instead of Playwright or Selenium calls).
   */
  frameworkInstructions?: string;
  actionCalls?: RegExp;
  browserOnly?: boolean;
  /** APIs that must not appear in this language, on top of the framework's. */
  foreign?: Array<{ pattern: RegExp; api: string }>;
};

export type ExportFramework = {
  id: string;
  label: string;
  /** Supported languages; the first is the default. */
  languages: ExportLanguage[];
  /** Framework-specific generation rules (kept short: they are sent with every export). */
  instructions: string;
  /** APIs of other frameworks that must not appear in this framework's code. */
  foreign: Array<{ pattern: RegExp; api: string }>;
  /** Calls that perform one recorded browser action (open, click, type, …); counted against the precondition's actions. */
  actionCalls: RegExp;
  /**
   * The framework only drives a browser (HTTP steps use the language's own
   * client), so code for a precondition without UI steps need not use it.
   */
  browserOnly?: boolean;
  /** The UI steps it can drive (default: browser pages). Steps of another kind are left out of its code. */
  drives?: ExportSurface[];
};

/** The precondition's name in the shapes file and class names need. */
export type ExportName = { kebab: string; snake: string; pascal: string };

const PLAYWRIGHT_IMPORT = /@playwright\/test|require\(\s*['"](?:@playwright\/test|playwright)['"]\s*\)|from\s+['"]playwright['"]/;
const CYPRESS_COMMAND = /\bcy\.(?:visit|get|contains|request|url|location|intercept|wait|session|origin|window)\(/;
const SELENIUM_API = /\bdriver\.find_?[eE]lements?\(|selenium-webdriver|org\.openqa\.selenium|from\s+selenium\b|import\s+selenium\b/;

/** Robot Framework file layout, shared by every framework it drives. */
const ROBOT_RULES = [
  "Robot Framework (.robot), not Python: *** Settings ***, *** Variables *** if needed, *** Test Cases *** with one test case named after the precondition, *** Keywords *** only for helpers.",
  "Separate keywords and arguments with four spaces. Comments start with #.",
  "Environment values: %{NAME}. Values later steps use: ${name} variables set with VAR or Set Test Variable.",
  "HTTP steps: RequestsLibrary (Library    RequestsLibrary, only when the precondition has HTTP steps): ${response}=    POST    <url>    json=${body}    expected_status=<status>; read values from ${response.json()}.",
].join("\n");

/** Lines that call one of these Robot keywords (optionally assigning its result). */
function robotKeywords(names: string[]): RegExp {
  const list = names.map((name) => name.replace(/ /g, "[ _]")).join("|");
  return new RegExp(`^[ \\t]+(?:\\$\\{[^}]+\\}\\s*=?[ \\t]+)?(?:(?:Browser|SeleniumLibrary)\\.)?(?:${list})(?=[ \\t]{2,}|\\t|[ \\t]*$)`, "gim");
}

export const PLAYWRIGHT: ExportFramework = {
  id: "playwright",
  label: "Playwright",
  drives: ["web"],
  actionCalls: /\.(?:goto|click|dblclick|fill|check|uncheck|setChecked|selectOption|select_option|press|hover|setInputFiles|set_input_files)\(/g,
  instructions: [
    "Use Playwright Test. Locators: getByTestId, getByRole(role, { name }), getByLabel, getByPlaceholder, getByText; page.locator(css) only when no other locator is given.",
    "Use web-first assertions (expect(locator).toBeVisible / toHaveText / toContainText, expect(page).toHaveURL).",
    "Rows: locate the rows, filter({ hasText }) by the match values, then the target inside the row. Frames: frameLocator. Other tabs: context.waitForEvent('page').",
    "HTTP steps: the request fixture (APIRequestContext); read later values from the parsed JSON.",
  ].join("\n"),
  languages: [
    {
      id: "typescript",
      filename: (name) => `${name.kebab}.spec.ts`,
      instructions: "TypeScript: import { test, expect } from '@playwright/test'. One test() per precondition. Environment values: process.env.",
      signature: [PLAYWRIGHT_IMPORT],
    },
    {
      id: "javascript",
      filename: (name) => `${name.kebab}.spec.js`,
      instructions: "JavaScript (no type annotations): const { test, expect } = require('@playwright/test'). One test() per precondition. Environment values: process.env.",
      signature: [PLAYWRIGHT_IMPORT],
    },
    {
      id: "python",
      filename: (name) => `${name.snake}_test.py`,
      instructions:
        "Python with pytest-playwright: from playwright.sync_api import Page, expect; one def test_…(page: Page) function. Snake-case methods (get_by_role, to_have_url). HTTP steps: page.request. Environment values: os.environ.",
      signature: [/\bplaywright\b/],
    },
    {
      id: "robot",
      filename: (name) => `${name.snake}.robot`,
      instructions: ROBOT_RULES,
      frameworkInstructions: [
        "Use the Browser library (robotframework-browser, Playwright-based): Library    Browser. Not SeleniumLibrary.",
        "Open each UI step with New Browser, New Context and New Page    <startUrl>; later navigation with Go To. Actions: Click, Fill Text, Fill Secret, Type Text, Select Options By, Check Checkbox, Uncheck Checkbox, Keyboard Key, Hover, Upload File By Selector.",
        "Selectors: data-testid=x for test ids (css=[attr=\"x\"] for another attribute), Get Element By Role / Get Element By Label / Get Element By Placeholder / Get Element By Text for role + name, label, placeholder and text, css=… and xpath=… only when given.",
        "Secret values: Fill Secret    <selector>    %NAME. Assertions with the built-in assertion operators: Get Text    <selector>    contains    <text>, Get Url    contains    <path>, Wait For Elements State    <selector>    visible.",
        "Rows: css=<rowSelector>:has-text(\"<match>\") >> <target>. Frames: <frame selector> >>> <selector>. Other tabs: Switch Page    NEW.",
      ].join("\n"),
      actionCalls: robotKeywords([
        "New Page", "Go To", "Click", "Fill Text", "Fill Secret", "Type Text", "Type Secret", "Select Options By", "Check Checkbox",
        "Uncheck Checkbox", "Keyboard Key", "Press Keys", "Hover", "Upload File By Selector",
      ]),
      browserOnly: true,
      signature: [/^\s*Library(?:\s{2,}|\t)Browser\b/m],
      foreign: [{ pattern: /^\s*Library(?:\s{2,}|\t)SeleniumLibrary\b/m, api: "SeleniumLibrary" }],
    },
  ],
  foreign: [
    { pattern: SELENIUM_API, api: "Selenium" },
    { pattern: /\bBy\.(?:id|css|cssSelector|xpath|name|className|linkText)\(|\bWebDriverWait\b/, api: "Selenium" },
    { pattern: CYPRESS_COMMAND, api: "Cypress" },
  ],
};

export const SELENIUM: ExportFramework = {
  id: "selenium",
  label: "Selenium",
  drives: ["web"],
  browserOnly: true,
  actionCalls: /\b(?:driver|browser)\.get\(|\.(?:click|send_keys|sendKeys|select_by_visible_text|selectByVisibleText|select_by_value|selectByValue|move_to_element|moveToElement)\(/g,
  instructions: [
    "Use Selenium 4 WebDriver with explicit waits (WebDriverWait + expected conditions); no sleeps except for delay steps.",
    "Locators: CSS for test ids and attributes (e.g. [data-testid=\"x\"], input[placeholder=\"…\"], [aria-label=\"…\"]), relative XPath with normalize-space() only for visible text or role + name. Never absolute XPath.",
    "Rows: find the row whose text contains the match values, then the target inside it. Frames: switch_to.frame / switchTo().frame and back. Quit the driver at the end.",
    "HTTP steps: the language's standard HTTP client (see language rules), not the browser. Start a WebDriver only when the precondition has UI steps.",
  ].join("\n"),
  languages: [
    {
      id: "java",
      filename: (name) => `${name.pascal}Test.java`,
      instructions: `Java with JUnit 5 and Selenium 4 (org.openqa.selenium). One public class named by the file name (e.g. class XTest for XTest.java) with one @Test method; set up and quit the driver in @BeforeEach/@AfterEach. HTTP steps: java.net.http.HttpClient. Environment values: System.getenv.`,
      signature: [/org\.openqa\.selenium/],
    },
    {
      id: "python",
      filename: (name) => `${name.snake}_test.py`,
      instructions:
        "Python with pytest and selenium (from selenium import webdriver; By; WebDriverWait; expected_conditions as EC). A driver fixture that quits at the end; one def test_… function. HTTP steps: requests. Environment values: os.environ.",
      signature: [/from\s+selenium\b|import\s+selenium\b/],
    },
    {
      id: "javascript",
      filename: (name) => `${name.kebab}.test.js`,
      instructions:
        "JavaScript (no type annotations) with mocha (describe/it) and selenium-webdriver (const { Builder, By, until } = require('selenium-webdriver')). HTTP steps: fetch. Environment values: process.env.",
      signature: [/selenium-webdriver/],
    },
    {
      id: "typescript",
      filename: (name) => `${name.kebab}.test.ts`,
      instructions:
        "TypeScript with mocha (describe/it) and selenium-webdriver (import { Builder, By, until, WebDriver } from 'selenium-webdriver'). HTTP steps: fetch. Environment values: process.env.",
      signature: [/selenium-webdriver/],
    },
    {
      id: "robot",
      filename: (name) => `${name.snake}.robot`,
      instructions: ROBOT_RULES,
      frameworkInstructions: [
        "Use SeleniumLibrary: Library    SeleniumLibrary. Not the Browser library.",
        "Open the first UI step with Open Browser    <startUrl>    chrome (only when the precondition has UI steps); Close Browser in [Teardown]. Later navigation with Go To.",
        "Actions: Click Element, Input Text, Input Password    <locator>    %{NAME} for secrets, Select From List By Label / By Value, Select Checkbox, Unselect Checkbox, Press Keys, Mouse Over, Choose File.",
        "Locators: css:[data-testid=\"x\"] for test ids and attributes (css:input[placeholder=\"…\"], css:[aria-label=\"…\"]), xpath: with normalize-space() only for visible text or role + name. Never absolute XPath.",
        "Wait explicitly (Wait Until Element Is Visible, Wait Until Page Contains); Sleep only for delay steps. Assertions: Element Should Contain, Page Should Contain, Location Should Contain.",
        "Rows: an xpath for the row containing the match values, then the target inside it. Frames: Select Frame / Unselect Frame. Other tabs: Switch Window    NEW.",
      ].join("\n"),
      actionCalls: robotKeywords([
        "Open Browser", "Go To", "Click Element", "Click Button", "Click Link", "Input Text", "Input Password", "Select From List By Label",
        "Select From List By Value", "Select From List By Index", "Select Checkbox", "Unselect Checkbox", "Select Radio Button", "Press Keys",
        "Mouse Over", "Choose File",
      ]),
      browserOnly: true,
      signature: [/^\s*Library(?:\s{2,}|\t)SeleniumLibrary\b/m],
      foreign: [{ pattern: /^\s*Library(?:\s{2,}|\t)Browser\b/m, api: "the Browser library (Playwright)" }],
    },
  ],
  foreign: [
    { pattern: /\bpage\.(?:goto|getByRole|getByTestId|getByLabel|get_by_role|get_by_test_id)\(/, api: "Playwright" },
    { pattern: /@playwright\/test|playwright\.sync_api/, api: "Playwright" },
    { pattern: CYPRESS_COMMAND, api: "Cypress" },
  ],
};

export const CYPRESS: ExportFramework = {
  id: "cypress",
  label: "Cypress",
  drives: ["web"],
  actionCalls: /\bcy\.visit\(|\.(?:click|dblclick|type|check|uncheck|select|trigger|selectFile)\(/g,
  instructions: [
    "Use Cypress with built-in commands only (no plugins): cy.visit, cy.get, cy.contains, cy.request, cy.url, cy.location, .within, .should. describe, it and cy are globals: do not import them.",
    "Locators: cy.get('[data-testid=\"x\"]') for test ids, attribute selectors for label/placeholder/name, cy.contains(selector, text) for role + name or visible text.",
    "Assertions: .should('be.visible' | 'contain' | 'have.value'), cy.url().should('include', …). Rows: cy.contains(rowSelector, matchText).within(…). HTTP steps: cy.request, chaining .then for values later steps use.",
    "Cypress cannot drive a second browser tab; open such a link in the same tab and add a warning.",
  ].join("\n"),
  languages: [
    {
      id: "typescript",
      filename: (name) => `${name.kebab}.cy.ts`,
      instructions: "TypeScript: describe/it in one spec file. Environment values: Cypress.env('NAME').",
      signature: [CYPRESS_COMMAND],
    },
    {
      id: "javascript",
      filename: (name) => `${name.kebab}.cy.js`,
      instructions: "JavaScript (no type annotations): describe/it in one spec file. Environment values: Cypress.env('NAME').",
      signature: [CYPRESS_COMMAND],
    },
  ],
  foreign: [
    { pattern: /\bpage\.goto\(|@playwright\/test|\bpage\.getBy\w+\(/, api: "Playwright" },
    { pattern: SELENIUM_API, api: "Selenium" },
    { pattern: /\bBy\.(?:id|css|cssSelector|xpath|name|className)\(/, api: "Selenium" },
  ],
};

const APPIUM_CALL = /\.(?:click|sendKeys|send_keys|setValue|addValue)\(|\bdriver\.(?:navigate\(\)\.)?back\(|['"]mobile:\s*(?:longClickGesture|swipeGesture|touchAndHold|swipe)['"]/g;

export const APPIUM: ExportFramework = {
  id: "appium",
  label: "Appium",
  drives: ["mobile"],
  browserOnly: true,
  actionCalls: APPIUM_CALL,
  instructions: [
    "Use Appium 2 (W3C protocol). Each mobile step gives the server and the capabilities: start a session with exactly those capabilities (secret values from environment variables), reuse the previous mobile step's session when the server and capabilities are the same and newSession is not set, and quit every session at the end.",
    "Mobile locators are {\"using\": strategy, \"value\": …}; use the strategy and value verbatim: accessibility id, id (resource id), -android uiautomator, -ios predicate string, -ios class chain, xpath, class name. The first is the preferred one; use the others only through one small helper that tries them in order when the first finds nothing.",
    "Wait explicitly for each element (until it is displayed) before acting. tap: click. type: clear, then send the keys. clear: clear. longPress: mobile: longClickGesture on Android, mobile: touchAndHold on iOS. swipe: mobile: swipeGesture on Android, mobile: swipe on iOS, in the given direction. back: the driver's back. assertText: the element's text contains the value. assertVisible and waitForElement: the element is displayed.",
    "HTTP steps: the language's standard HTTP client, not the driver. No browser APIs (no page, cy, or driver.get of a URL).",
  ].join("\n"),
  languages: [
    {
      id: "java",
      filename: (name) => `${name.pascal}Test.java`,
      instructions:
        "Java with JUnit 5 and the Appium java-client 9 (io.appium.java_client: AndroidDriver / IOSDriver, AppiumBy, UiAutomator2Options / XCUITestOptions or DesiredCapabilities with the given capabilities). One public class named by the file name with one @Test method; create the driver in @BeforeEach and quit it in @AfterEach. Waits: WebDriverWait. HTTP steps: java.net.http.HttpClient. Environment values: System.getenv.",
      signature: [/io\.appium\.java_client/],
    },
    {
      id: "python",
      filename: (name) => `${name.snake}_test.py`,
      instructions:
        "Python with pytest and Appium-Python-Client 3+ (from appium import webdriver; from appium.options.common import AppiumOptions or the platform options class; from appium.webdriver.common.appiumby import AppiumBy; WebDriverWait). A driver fixture that quits at the end; one def test_… function. HTTP steps: requests. Environment values: os.environ.",
      signature: [/from\s+appium\b|import\s+appium\b/],
    },
    {
      id: "javascript",
      filename: (name) => `${name.kebab}.test.js`,
      instructions:
        "JavaScript (no type annotations) with mocha (describe/it) and WebdriverIO in standalone mode: const { remote } = require('webdriverio'); remote({ hostname, port, path, capabilities }). Selectors: '~<accessibility id>', 'id=<resource id>' via driver.$(`id=…`) or driver.findElement('id', …), 'android=<uiautomator>', '-ios predicate string:<predicate>', '-ios class chain:<chain>', xpath as is. Waits: waitForDisplayed. HTTP steps: fetch. Environment values: process.env. deleteSession in after().",
      signature: [/\bwebdriverio\b/],
    },
    {
      id: "typescript",
      filename: (name) => `${name.kebab}.test.ts`,
      instructions:
        "TypeScript with mocha (describe/it) and WebdriverIO in standalone mode: import { remote } from 'webdriverio'; remote({ hostname, port, path, capabilities }). Selectors: '~<accessibility id>', 'android=<uiautomator>', '-ios predicate string:<predicate>', '-ios class chain:<chain>', xpath as is; resource ids with driver.findElement('id', …). Waits: waitForDisplayed. HTTP steps: fetch. Environment values: process.env. deleteSession in after().",
      signature: [/\bwebdriverio\b/],
    },
    {
      id: "robot",
      filename: (name) => `${name.snake}.robot`,
      instructions: ROBOT_RULES,
      frameworkInstructions: [
        "Use AppiumLibrary: Library    AppiumLibrary. Not SeleniumLibrary or the Browser library.",
        "Open Application    <server>    platformName=<Android|iOS>    then every capability as name=value (appium: prefix kept); Close Application in [Teardown].",
        "Locators: accessibility_id=…, id=…, android=<uiautomator>, predicate=<ios predicate>, chain=<ios class chain>, xpath=…, class=… — the given value verbatim.",
        "Actions: Wait Until Element Is Visible before each, then Click Element, Input Text (Input Password    <locator>    %{NAME} for secrets), Clear Text, Long Press, Swipe By Percent (directions as percentages), Go Back. Checks: Element Should Contain Text, Element Should Be Visible.",
      ].join("\n"),
      actionCalls: robotKeywords(["Click Element", "Click Text", "Tap", "Input Text", "Input Password", "Input Value", "Long Press", "Swipe", "Swipe By Percent", "Go Back"]),
      browserOnly: true,
      signature: [/^\s*Library(?:\s{2,}|\t)AppiumLibrary\b/m],
      foreign: [
        { pattern: /^\s*Library(?:\s{2,}|\t)SeleniumLibrary\b/m, api: "SeleniumLibrary" },
        { pattern: /^\s*Library(?:\s{2,}|\t)Browser\b/m, api: "the Browser library (Playwright)" },
      ],
    },
  ],
  foreign: [
    { pattern: /@playwright\/test|playwright\.sync_api|\bpage\.(?:goto|getByRole|getByTestId|get_by_role)\(/, api: "Playwright" },
    { pattern: CYPRESS_COMMAND, api: "Cypress" },
    { pattern: /selenium-webdriver/, api: "selenium-webdriver (browser)" },
  ],
};

/** Every export target, in the order the export dialog lists them. Register new frameworks here. */
export const EXPORT_FRAMEWORKS: readonly ExportFramework[] = [PLAYWRIGHT, SELENIUM, CYPRESS, APPIUM];

export function findExportFramework(id: string): ExportFramework | undefined {
  return EXPORT_FRAMEWORKS.find((item) => item.id === id);
}

export function findExportLanguage(framework: ExportFramework, id: string): ExportLanguage | undefined {
  return framework.languages.find((item) => item.id === id);
}

/** The registry without functions and patterns, as the export dialog lists it. */
export type ExportFrameworkOption = {
  id: string;
  label: string;
  languages: Array<{ id: ExportLanguageId; label: string; filename: string }>;
  /** False when the framework cannot drive any UI step of the precondition (absent: it can). */
  available?: boolean;
  /** Why it is not available: "mobileOnly" (its UI steps are mobile) or "noMobileSteps". */
  unavailableReason?: ExportUnavailableReason;
};

export type ExportUnavailableReason = "mobileOnly" | "noMobileSteps";

/** The kinds of UI steps a precondition (or one step) has. */
export function exportSurfaces(steps: Array<{ type: string }>): Set<ExportSurface> {
  const out = new Set<ExportSurface>();
  for (const step of steps) {
    if (step.type === "ui") out.add("web");
    if (step.type === "mobile") out.add("mobile");
  }
  return out;
}

/**
 * Whether the framework can export these steps: it drives at least one of
 * their UI kinds — or, without UI steps, it is not a mobile-only framework
 * (HTTP and database steps are plain code in any browser framework).
 */
export function frameworkAvailability(framework: ExportFramework, surfaces: Set<ExportSurface>): { available: boolean; reason?: ExportUnavailableReason } {
  const drives = framework.drives ?? ["web"];
  if (surfaces.size === 0) return drives.includes("web") ? { available: true } : { available: false, reason: "noMobileSteps" };
  if (drives.some((surface) => surfaces.has(surface))) return { available: true };
  return { available: false, reason: surfaces.has("mobile") ? "mobileOnly" : "noMobileSteps" };
}

/**
 * The context as one framework exports it: UI steps it cannot drive are left
 * out (and listed in metadata.leftOut), the rest is unchanged.
 */
export function contextForFramework(context: ExportContext, framework: ExportFramework): ExportContext {
  const leftOut: Array<{ step: string; reason: string }> = [];
  const steps = context.steps.filter((step) => {
    const surface = step.type === "ui" ? "web" : step.type === "mobile" ? "mobile" : null;
    if (!surface || (framework.drives ?? ["web"]).includes(surface)) return true;
    leftOut.push({ step: step.name, reason: surface === "mobile" ? `${framework.label} cannot drive a mobile app` : `${framework.label} cannot drive a browser` });
    return false;
  });
  if (!leftOut.length) return context;
  return { ...context, steps, metadata: { ...context.metadata, leftOut } };
}

/** `surfaces`: the UI kinds of what is exported; when given, every framework says whether it can export them. */
export function exportFrameworkOptions(preconditionName: string, surfaces?: Set<ExportSurface>): ExportFrameworkOption[] {
  const name = exportName(preconditionName);
  return EXPORT_FRAMEWORKS.map((framework) => {
    const availability = surfaces ? frameworkAvailability(framework, surfaces) : null;
    return {
      id: framework.id,
      label: framework.label,
      languages: framework.languages.map((language) => ({
        id: language.id,
        label: EXPORT_LANGUAGE_LABELS[language.id],
        filename: language.filename(name),
      })),
      ...(availability ? { available: availability.available } : {}),
      ...(availability?.reason ? { unavailableReason: availability.reason } : {}),
    };
  });
}

/** File and class names from the precondition's name; "precondition" when it has no Latin letters or digits. */
export function exportName(preconditionName: string): ExportName {
  const words = preconditionName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 8);
  const list = words.length ? words : ["precondition"];
  // Identifiers (Java classes, Python modules) cannot start with a digit.
  if (/^\d/.test(list[0]!)) list.unshift("precondition");
  return {
    kebab: list.join("-"),
    snake: list.join("_"),
    pascal: list.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(""),
  };
}

// ── normalized result ────────────────────────────────────────────────────

/** What every export returns, whichever AI service wrote the code. */
export type ExportResult = {
  framework: string;
  language: ExportLanguageId;
  code: string;
  filename: string;
  warnings: string[];
  /** The AI connection that wrote the code. */
  provider: { id: string; name: string; model: string };
};

// ── prompt ───────────────────────────────────────────────────────────────

const COMMON_RULES = [
  "Convert the precondition below into one runnable automated test. Translate it; do not redesign it.",
  "Keep every step and action in the given order, with its URLs, typed values, options, keys and expected texts exactly as given. Do not add, drop, merge or reorder steps.",
  "Turn every assert*/waitFor* action, assert step and expected status into an assertion.",
  "Use only the given locators, in the given order of preference (the first is the most reliable). Do not invent selectors; never use nth-child/nth-of-type, generated class names or ids, absolute XPath or coordinates unless that is the only locator given.",
  'Locators: {"testid":"x"} is the test id x (attribute data-testid unless "attr" names another), {"role":"button","name":"Sign in"} a role with its accessible name, {"label"|"placeholder"|"text":"…"} that text, {"css":"…"} a CSS selector, {"xpath":"…"} an XPath.',
  "Write compact code: one short comment per step (not per action), no other comments, no unused imports or helpers.",
  "{{name}} values come from earlier steps (extract) or from configuration: read configuration and every secretEnv value from environment variables with that name. Header values \"***\" are masked secrets: read them from an environment variable named after the header. Never write a secret into the code.",
  "Optional actions must not fail the test.",
  'Answer with JSON: {"code": "<the complete file>", "warnings": ["<anything that could not be converted exactly>"]}. The code is plain source, without Markdown fences.',
].join("\n");

const DATABASE_RULE = "Database steps: call a small helper with the SQL kept verbatim, declared at the end of the file with a TODO for the connection.";

/** A single step exported on its own: a reusable piece, not a whole test. These rules override the test-structure rules. */
const STEP_RULES = [
  "Export only the one step named in scope: write one reusable function named after the step (Robot Framework: one keyword in *** Keywords ***, no *** Test Cases ***; Java: a public class named by the file name holding one public static method) that performs exactly this step.",
  "The caller provides the framework's page / driver / request object (do not create, open, close or quit browsers, apps or sessions; Cypress uses the global cy), every value in scope.inputs and every value the step `uses` from an earlier step, as parameters. Start the file with one comment that lists what the caller must provide.",
  "No test case, fixture, setup or teardown. Keep the framework's usual import line (even when only a type or expect is used) and nothing unused.",
].join("\n");

/** System and user messages for one export: common rules, the framework's and language's rules, the precondition. */
export function buildExportPrompt(context: ExportContext, framework: ExportFramework, language: ExportLanguage): { system: string; prompt: string } {
  const name = exportName(context.name);
  const system = [
    `You are a code generator that converts recorded test preconditions into ${framework.label} tests in ${EXPORT_LANGUAGE_LABELS[language.id]}.`,
    // Rules for step kinds the precondition does not have only cost tokens.
    context.steps.some((step) => step.type === "db") ? `${COMMON_RULES}\n${DATABASE_RULE}` : COMMON_RULES,
    language.frameworkInstructions ?? framework.instructions,
    language.instructions,
    ...(context.scope ? [STEP_RULES] : []),
  ].join("\n\n");
  const prompt = [
    `Framework: ${framework.label}. Language: ${EXPORT_LANGUAGE_LABELS[language.id]}. File: ${language.filename(name)}.`,
    "Precondition (JSON):",
    JSON.stringify(context),
  ].join("\n");
  return { system, prompt };
}

// ── validation ───────────────────────────────────────────────────────────

/**
 * Strings the code must contain to represent the precondition: URL paths,
 * typed values, expected texts and test ids. Variables and secrets are left
 * out (they become environment reads).
 */
export function exportAnchors(context: ExportContext): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (text.length < 2 || text.length > 200 || /\{\{|\*\*\*/.test(text)) return;
    out.add(text);
  };
  /** The URL's path, up to the first segment a mapping replaces at run time (`bound`). */
  const addUrl = (value: string | undefined, bound: string[] = []) => {
    if (!value) return;
    const plain = value.replace(/\{\{[^}]+\}\}/g, "");
    let path: string;
    try {
      const url = new URL(plain);
      path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.host;
    } catch {
      path = plain.split("?")[0] ?? "";
    }
    const segments = path.split("/");
    const cut = segments.findIndex((segment) => bound.includes(segment));
    add(cut >= 0 ? segments.slice(0, cut).join("/") + "/" : path);
  };
  for (const step of context.steps) {
    if (step.type === "ui") {
      addUrl(step.startUrl);
      for (const action of step.actions) {
        if (action.do === "navigate") addUrl(action.url ?? action.value);
        else if (["fill", "assertText", "waitForText", "assertUrl", "select"].includes(action.do) && !action.secretEnv) add(action.option ?? action.value);
        add(action.locators?.find((locator) => locator.testid)?.testid);
      }
    } else if (step.type === "mobile") {
      for (const action of step.actions) {
        if ((action.do === "type" || action.do === "assertText") && !action.secretEnv) add(action.value);
        add(action.locators?.find((locator) => locator.using === "accessibility id" || locator.using === "id")?.value);
      }
    } else if (step.type === "http") {
      const bound = Object.keys(step.uses ?? {}).map((key) => /^path "(.*)"$/.exec(key)?.[1]).filter((item): item is string => Boolean(item));
      addUrl(step.url, bound);
    } else if (step.type === "db") {
      add(step.query.slice(0, 200));
    }
  }
  return [...out];
}

const BROWSER_ACTIONS = new Set(["navigate", "click", "fill", "select", "check", "uncheck", "press", "hover", "upload"]);
/** Mobile actions counted against the code (clearing is left out: typing usually clears first). */
const MOBILE_ACTIONS = new Set(["tap", "type", "longPress", "swipe", "back"]);

/** UI actions the precondition performs: each UI step's start URL and its interactive actions, and each mobile step's interactive actions. */
export function exportBrowserActions(context: ExportContext): number {
  return context.steps.reduce((count, step) => {
    if (step.type === "ui") return count + 1 + step.actions.filter((action) => BROWSER_ACTIONS.has(action.do)).length;
    if (step.type === "mobile") return count + step.actions.filter((action) => MOBILE_ACTIONS.has(action.do)).length;
    return count;
  }, 0);
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, kind: "private key" },
  { pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, kind: "API key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, kind: "AWS key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, kind: "GitHub token" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, kind: "Slack token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, kind: "JWT" },
  { pattern: /Bearer\s+(?!\$|\{|['"`]\s*\+)[A-Za-z0-9\-._~+/]{20,}=*/g, kind: "bearer token" },
];

export type ExportValidation = {
  ok: boolean;
  /** The code with Markdown fences removed and any secret redacted. */
  code: string;
  /** Why the code cannot be shown (wrong framework or language, empty, unrelated). */
  errors: string[];
  warnings: string[];
};

/**
 * Check generated code before it is shown: not empty, written for the chosen
 * framework and language, free of other frameworks' APIs and of secrets, and
 * recognisably the same precondition (its URLs, values and texts appear).
 */
export function validateExportCode(input: {
  code: string;
  framework: ExportFramework;
  language: ExportLanguage;
  anchors?: string[];
  /** Secret values known to the caller; they must not appear in the code. */
  secrets?: string[];
  /** The precondition has browser steps (default true); without them a browser-only framework need not appear. */
  hasUiSteps?: boolean;
  /** Recorded browser actions (opening each UI step's start URL included); the code should perform as many. */
  browserActions?: number;
  /** "step": one step exported as a reusable function (no test case required). */
  mode?: "full" | "step";
}): ExportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let code = stripFences(input.code ?? "");
  if (!code.trim()) return { ok: false, code: "", errors: ["The generated code is empty"], warnings };

  const { framework, language } = input;
  const comments = stripComments(code, language.id);
  if (!language.signature.some((pattern) => pattern.test(comments))) {
    if ((language.browserOnly ?? framework.browserOnly) && input.hasUiSteps === false) {
      warnings.push(`This precondition has no browser steps, so the code does not need ${framework.label}; its requests use the language's HTTP client.`);
    } else {
      errors.push(`The code does not use ${framework.label} for ${EXPORT_LANGUAGE_LABELS[language.id]}`);
    }
  }
  if (/^\s*import\s*\{[^}]*\b(?:describe|it)\b[^}]*\}\s*from\s*['"]cypress['"]/m.test(comments)) {
    errors.push("The code imports describe/it from cypress; they are globals");
  }
  for (const item of [...framework.foreign, ...(language.foreign ?? [])]) {
    if (item.pattern.test(comments)) errors.push(`The code uses ${item.api} APIs instead of ${framework.label}`);
  }
  // A single step is a keyword file: it has no test case section.
  const languageChecks = LANGUAGE_CHECKS[language.id].filter((check) => !(input.mode === "step" && check.why === NO_TEST_CASES));
  const foreignLanguage = languageChecks.find((check) => check.pattern.test(comments));
  if (foreignLanguage) errors.push(`The code is not ${EXPORT_LANGUAGE_LABELS[language.id]}: ${foreignLanguage.why}`);

  const known = (input.secrets ?? []).filter((value) => value.length >= 4);
  for (const value of known) {
    if (code.includes(value)) {
      code = code.split(value).join("<redacted>");
      warnings.push("A secret value was removed from the code; read it from an environment variable.");
    }
  }
  for (const { pattern, kind } of SECRET_PATTERNS) {
    if (pattern.test(code)) {
      code = code.replace(pattern, "<redacted>");
      warnings.push(`A ${kind} was removed from the code; read it from an environment variable.`);
    }
    pattern.lastIndex = 0;
  }

  if (input.browserActions) {
    // A warning, not an error: a framework may legitimately merge or split an action (type + Enter).
    const performed = comments.match(language.actionCalls ?? framework.actionCalls)?.length ?? 0;
    const expected = input.browserActions;
    if (performed !== expected) {
      warnings.push(`The code performs ${performed} browser actions; the precondition records ${expected}. Check for added, repeated or missing steps.`);
    }
  }

  const anchors = input.anchors ?? [];
  if (anchors.length > 0) {
    const missing = anchors.filter((anchor) => !code.includes(anchor) && !code.includes(JSON.stringify(anchor).slice(1, -1)));
    if (missing.length / anchors.length > 0.5) {
      errors.push(`The code does not represent this precondition (missing: ${missing.slice(0, 3).join(", ")})`);
    } else if (missing.length) {
      warnings.push(`Not found in the code, check them: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
    }
  }
  return { ok: errors.length === 0, code, errors, warnings: [...new Set(warnings)] };
}

const NO_TEST_CASES = "no *** Test Cases *** section";

/** Code that cannot be the chosen language. */
const LANGUAGE_CHECKS: Record<ExportLanguageId, Array<{ pattern: RegExp; why: string }>> = {
  typescript: [
    { pattern: /^\s*def\s+\w+\s*\(.*\)\s*(?:->\s*[\w\[\], ]+)?:\s*$/m, why: "Python function" },
    { pattern: /^\s*(?:public\s+)?class\s+\w+[^{\n]*\{[\s\S]*\bpublic\s+void\b/m, why: "Java class" },
    { pattern: /^\s*from\s+[\w.]+\s+import\s+/m, why: "Python import" },
  ],
  javascript: [
    { pattern: /^\s*def\s+\w+\s*\(.*\)\s*(?:->\s*[\w\[\], ]+)?:\s*$/m, why: "Python function" },
    { pattern: /\bpublic\s+void\b/, why: "Java method" },
    { pattern: /^\s*from\s+[\w.]+\s+import\s+/m, why: "Python import" },
    { pattern: /^\s*import\s+type\b|^\s*(?:export\s+)?interface\s+\w+|\b(?:const|let|var)\s+\w+\s*:\s*[A-Z]\w*(?:<[^>]*>)?\s*=|\)\s*:\s*(?:Promise<|void\b|string\b|number\b|boolean\b)/m, why: "TypeScript types" },
  ],
  python: [
    { pattern: /^\s*(?:const|let|var)\s+[\w{[]/m, why: "JavaScript declaration" },
    { pattern: /^\s*import\s+[{*]|=>\s*[{(]|\bfunction\s*\w*\s*\(/m, why: "JavaScript syntax" },
    { pattern: /\bpublic\s+(?:class|void|static)\b/, why: "Java syntax" },
  ],
  java: [
    { pattern: /^\s*(?:const|let|var)\s+\w+\s*=\s*(?:require|await|async|\()/m, why: "JavaScript declaration" },
    { pattern: /=>\s*[{(]|^\s*import\s+[{*]/m, why: "JavaScript syntax" },
    { pattern: /^\s*def\s+\w+\s*\(.*\)\s*:\s*$/m, why: "Python function" },
    { pattern: /^\s*from\s+[\w.]+\s+import\s+/m, why: "Python import" },
  ],
  robot: [
    { pattern: /^(?![\s\S]*\*\*\*\s*Test Cases?\s*\*\*\*)/i, why: NO_TEST_CASES },
    { pattern: /^\s*(?:def|class)\s+\w+.*:\s*$|^\s*(?:from\s+[\w.]+\s+)?import\s+\w/m, why: "Python code" },
    { pattern: /^\s*(?:const|let|var)\s+\w|=>\s*[{(]/m, why: "JavaScript syntax" },
    { pattern: /\bpublic\s+(?:class|void|static)\b/, why: "Java syntax" },
  ],
};

function stripFences(code: string): string {
  const fenced = /^\s*```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(code);
  return (fenced ? fenced[1]! : code).replace(/^\r?\n+/, "").replace(/\s+$/, "") + "\n";
}

/** The code without comments, so a comment that mentions another framework is not mistaken for using it. */
function stripComments(code: string, language: ExportLanguageId): string {
  if (language === "python" || language === "robot") return code.replace(/^\s*#.*$/gm, "");
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
