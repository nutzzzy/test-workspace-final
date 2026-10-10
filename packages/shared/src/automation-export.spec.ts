import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPIUM,
  CYPRESS,
  EXPORT_FRAMEWORKS,
  PLAYWRIGHT,
  SELENIUM,
  buildExportPrompt,
  contextForFramework,
  exportAnchors,
  exportBrowserActions,
  exportFrameworkOptions,
  exportName,
  exportSurfaces,
  findExportFramework,
  frameworkAvailability,
  findExportLanguage,
  validateExportCode,
  type ExportContext,
  type ExportFramework,
} from "./automation-export";

const context: ExportContext = {
  preconditionId: "sc1",
  name: "Login flow",
  url: "https://app.test/login",
  steps: [
    {
      type: "ui",
      name: "Sign in",
      startUrl: "https://app.test/login",
      actions: [
        { do: "fill", value: "sara@example.com", locators: [{ label: "Email" }] },
        { do: "fill", secretEnv: "PASSWORD", locators: [{ label: "Password" }] },
        { do: "click", locators: [{ testid: "login-submit" }, { role: "button", name: "Sign in" }] },
        { do: "assertText", value: "Welcome back" },
        { do: "assertUrl", value: "/dashboard" },
      ],
    },
  ],
  variables: [],
  metadata: { stopOnFailure: true },
};

const lang = (framework: ExportFramework, id: string) => findExportLanguage(framework, id)!;

const PLAYWRIGHT_TS = `import { test, expect } from '@playwright/test';

test('Login flow', async ({ page }) => {
  // Sign in
  await page.goto('https://app.test/login');
  await page.getByLabel('Email').fill('sara@example.com');
  await page.getByLabel('Password').fill(process.env.PASSWORD ?? '');
  await page.getByTestId('login-submit').click();
  await expect(page.getByText('Welcome back')).toBeVisible();
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;

const SELENIUM_PY = `import os
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


def test_login_flow():
    driver = webdriver.Chrome()
    try:
        driver.get("https://app.test/login")
        wait = WebDriverWait(driver, 10)
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input[aria-label='Email']"))).send_keys("sara@example.com")
        driver.find_element(By.CSS_SELECTOR, "input[aria-label='Password']").send_keys(os.environ["PASSWORD"])
        driver.find_element(By.CSS_SELECTOR, "[data-testid='login-submit']").click()
        wait.until(EC.text_to_be_present_in_element((By.TAG_NAME, "body"), "Welcome back"))
        assert "/dashboard" in driver.current_url
    finally:
        driver.quit()
`;

const CYPRESS_TS = `describe('Login flow', () => {
  it('signs in', () => {
    cy.visit('https://app.test/login');
    cy.get('input[aria-label="Email"]').type('sara@example.com');
    cy.get('input[aria-label="Password"]').type(Cypress.env('PASSWORD'), { log: false });
    cy.get('[data-testid="login-submit"]').click();
    cy.contains('Welcome back').should('be.visible');
    cy.url().should('include', '/dashboard');
  });
});
`;

const PLAYWRIGHT_ROBOT = `*** Settings ***
Library    Browser

*** Test Cases ***
Login flow
    # Sign in
    New Browser    chromium
    New Context
    New Page    https://app.test/login
    \${email}=    Get Element By Label    Email
    Fill Text    \${email}    sara@example.com
    \${password}=    Get Element By Label    Password
    Fill Secret    \${password}    %PASSWORD
    Click    data-testid=login-submit
    Get Text    body    contains    Welcome back
    Get Url    contains    /dashboard
`;

const SELENIUM_ROBOT = `*** Settings ***
Library    SeleniumLibrary
Test Teardown    Close Browser

*** Test Cases ***
Login flow
    # Sign in
    Open Browser    https://app.test/login    chrome
    Input Text    css:input[aria-label="Email"]    sara@example.com
    Input Password    css:input[aria-label="Password"]    %{PASSWORD}
    Click Element    css:[data-testid="login-submit"]
    Wait Until Page Contains    Welcome back
    Location Should Contain    /dashboard
`;

const anchors = exportAnchors(context);

describe("export registry", () => {
  it("lists Playwright, Selenium, Cypress and Appium with only implemented languages", () => {
    assert.deepEqual(EXPORT_FRAMEWORKS.map((item) => item.id), ["playwright", "selenium", "cypress", "appium"]);
    assert.deepEqual(APPIUM.languages.map((item) => item.id), ["java", "python", "javascript", "typescript", "robot"]);
    assert.deepEqual(PLAYWRIGHT.languages.map((item) => item.id), ["typescript", "javascript", "python", "robot"]);
    assert.deepEqual(SELENIUM.languages.map((item) => item.id), ["java", "python", "javascript", "typescript", "robot"]);
    assert.deepEqual(CYPRESS.languages.map((item) => item.id), ["typescript", "javascript"]);
  });

  it("finds frameworks and languages by id and rejects unknown ones", () => {
    assert.equal(findExportFramework("cypress"), CYPRESS);
    assert.equal(findExportFramework("robot"), undefined);
    assert.equal(findExportLanguage(CYPRESS, "python"), undefined);
  });

  it("names files after the precondition, per framework and language", () => {
    const options = exportFrameworkOptions("Login flow");
    const file = (framework: string, language: string) =>
      options.find((item) => item.id === framework)!.languages.find((item) => item.id === language)!.filename;
    assert.equal(file("playwright", "typescript"), "login-flow.spec.ts");
    assert.equal(file("playwright", "python"), "login_flow_test.py");
    assert.equal(file("selenium", "java"), "LoginFlowTest.java");
    assert.equal(file("selenium", "python"), "login_flow_test.py");
    assert.equal(file("cypress", "typescript"), "login-flow.cy.ts");
    assert.equal(file("playwright", "robot"), "login_flow.robot");
    assert.equal(file("selenium", "robot"), "login_flow.robot");
  });

  it("falls back to 'precondition' for names without Latin letters", () => {
    assert.deepEqual(exportName("ورود کاربر"), { kebab: "precondition", snake: "precondition", pascal: "Precondition" });
    assert.equal(exportName("2FA login").pascal, "Precondition2faLogin");
  });

  it("a newly registered framework is listed without changing the export flow", () => {
    const robot: ExportFramework = {
      id: "robot",
      label: "Robot Framework",
      instructions: "Use SeleniumLibrary.",
      languages: [{ id: "python", filename: (name) => `${name.snake}.robot`, instructions: "", signature: [/\*\*\* Test Cases \*\*\*/] }],
      foreign: [],
      actionCalls: /^\s{4}(?:Go To|Click|Input Text)\b/gm,
    };
    const code = "*** Settings ***\nLibrary    SeleniumLibrary\n\n*** Test Cases ***\nLogin flow\n    Go To    https://app.test/login\n";
    assert.equal(validateExportCode({ code, framework: robot, language: robot.languages[0]! }).ok, true);
  });
});

describe("export prompt", () => {
  it("is one compact request with the framework's and language's rules and the precondition", () => {
    const { system, prompt } = buildExportPrompt(context, SELENIUM, lang(SELENIUM, "python"));
    assert.match(system, /Selenium tests in Python/);
    assert.match(system, /pytest and selenium/);
    assert.doesNotMatch(system, /Playwright Test|Cypress with/);
    assert.match(prompt, /File: login_flow_test\.py/);
    assert.ok(prompt.includes(JSON.stringify(context)));
    assert.ok(!prompt.includes("\n  "), "the context is sent without indentation");
  });

  it("sends Robot Framework rules with the framework's library instead of its own API rules", () => {
    const browser = buildExportPrompt(context, PLAYWRIGHT, lang(PLAYWRIGHT, "robot")).system;
    assert.match(browser, /Playwright tests in Robot Framework/);
    assert.match(browser, /Library {4}Browser/);
    assert.match(browser, /\*\*\* Test Cases \*\*\*/);
    assert.doesNotMatch(browser, /Playwright Test|getByTestId/);
    const selenium = buildExportPrompt(context, SELENIUM, lang(SELENIUM, "robot")).system;
    assert.match(selenium, /Library {4}SeleniumLibrary/);
    assert.doesNotMatch(selenium, /WebDriverWait|Library {4}Browser\b/);
  });

  it("adds the database rule only for preconditions with database steps", () => {
    assert.doesNotMatch(buildExportPrompt(context, PLAYWRIGHT, lang(PLAYWRIGHT, "typescript")).system, /Database steps/);
    const withDb: ExportContext = { ...context, steps: [...context.steps, { type: "db", name: "Clean", operation: "DELETE", query: "DELETE FROM carts" }] };
    assert.match(buildExportPrompt(withDb, PLAYWRIGHT, lang(PLAYWRIGHT, "typescript")).system, /Database steps/);
  });
});

describe("validateExportCode", () => {
  it("accepts Playwright TypeScript, Selenium Python and Cypress TypeScript of the same precondition", () => {
    for (const [framework, language, code] of [
      [PLAYWRIGHT, "typescript", PLAYWRIGHT_TS],
      [SELENIUM, "python", SELENIUM_PY],
      [CYPRESS, "typescript", CYPRESS_TS],
      [PLAYWRIGHT, "robot", PLAYWRIGHT_ROBOT],
      [SELENIUM, "robot", SELENIUM_ROBOT],
    ] as const) {
      const result = validateExportCode({ code, framework, language: lang(framework, language), anchors });
      assert.deepEqual(result.errors, [], `${framework.id}/${language}`);
      assert.equal(result.ok, true);
    }
  });

  it("rejects empty code", () => {
    const result = validateExportCode({ code: "  \n", framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript") });
    assert.equal(result.ok, false);
    assert.match(result.errors[0]!, /empty/);
  });

  it("rejects code written for another framework", () => {
    const asPlaywright = validateExportCode({ code: SELENIUM_PY, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "python") });
    assert.equal(asPlaywright.ok, false);
    assert.ok(asPlaywright.errors.some((item) => /Selenium APIs/.test(item)));
    const asCypress = validateExportCode({ code: PLAYWRIGHT_TS, framework: CYPRESS, language: lang(CYPRESS, "typescript") });
    assert.equal(asCypress.ok, false);
    assert.ok(asCypress.errors.some((item) => /Playwright APIs/.test(item)));
  });

  it("rejects Playwright code that calls driver.findElement", () => {
    const mixed = PLAYWRIGHT_TS.replace("await page.getByTestId('login-submit').click();", "await driver.findElement(By.css('#x')).click();");
    const result = validateExportCode({ code: mixed, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript") });
    assert.equal(result.ok, false);
  });

  it("rejects Cypress code that calls page.goto", () => {
    const mixed = CYPRESS_TS.replace("cy.visit('https://app.test/login');", "page.goto('https://app.test/login');");
    const result = validateExportCode({ code: mixed, framework: CYPRESS, language: lang(CYPRESS, "typescript") });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => /Playwright/.test(item)));
  });

  it("does not mistake a comment about another framework for its use", () => {
    const commented = `// Converted from a Selenium-style recording: driver.findElement is not used\n${PLAYWRIGHT_TS}`;
    assert.equal(validateExportCode({ code: commented, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript") }).ok, true);
  });

  it("rejects code in another language", () => {
    const python = validateExportCode({ code: SELENIUM_PY, framework: SELENIUM, language: lang(SELENIUM, "java") });
    assert.equal(python.ok, false);
    const typed = validateExportCode({ code: PLAYWRIGHT_TS, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "javascript") });
    assert.equal(typed.ok, true, "plain Playwright TS without types is also valid JS syntax");
    const withTypes = PLAYWRIGHT_TS.replace("async ({ page }) =>", "async ({ page }): Promise<void> =>");
    assert.equal(validateExportCode({ code: withTypes, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "javascript") }).ok, false);
    const tsAsPython = validateExportCode({ code: PLAYWRIGHT_TS, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "python") });
    assert.equal(tsAsPython.ok, false);
  });

  it("accepts Selenium code without a browser for a precondition without browser steps, with a warning", () => {
    const apiOnly = `import os\nimport requests\n\n\ndef test_api():\n    response = requests.post("https://api.test/login", json={"password": os.environ["PASSWORD"]})\n    assert response.ok\n`;
    const withoutUi = validateExportCode({ code: apiOnly, framework: SELENIUM, language: lang(SELENIUM, "python"), hasUiSteps: false });
    assert.equal(withoutUi.ok, true);
    assert.ok(withoutUi.warnings.some((item) => /no browser steps/.test(item)));
    assert.equal(validateExportCode({ code: apiOnly, framework: SELENIUM, language: lang(SELENIUM, "python"), hasUiSteps: true }).ok, false);
    // Playwright and Cypress make HTTP calls with their own APIs, so they must always appear.
    assert.equal(validateExportCode({ code: apiOnly, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "python"), hasUiSteps: false }).ok, false);
  });

  it("rejects Robot Framework code for the other library, and Python passed off as Robot", () => {
    const browserAsSelenium = validateExportCode({ code: PLAYWRIGHT_ROBOT, framework: SELENIUM, language: lang(SELENIUM, "robot") });
    assert.equal(browserAsSelenium.ok, false);
    const both = PLAYWRIGHT_ROBOT.replace("Library    Browser", "Library    Browser\nLibrary    SeleniumLibrary");
    assert.ok(validateExportCode({ code: both, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "robot") }).errors.some((item) => /SeleniumLibrary/.test(item)));
    const python = validateExportCode({ code: SELENIUM_PY, framework: SELENIUM, language: lang(SELENIUM, "robot") });
    assert.equal(python.ok, false);
    const noTests = SELENIUM_ROBOT.replace("*** Test Cases ***", "*** Keywords ***");
    assert.ok(validateExportCode({ code: noTests, framework: SELENIUM, language: lang(SELENIUM, "robot") }).errors.some((item) => /Test Cases/.test(item)));
  });

  it("accepts Robot Framework code without a browser library for a precondition without browser steps", () => {
    const apiOnly = "*** Settings ***\nLibrary    RequestsLibrary\n\n*** Test Cases ***\nApi\n    POST    https://api.test/login    expected_status=200\n";
    for (const framework of [PLAYWRIGHT, SELENIUM]) {
      assert.equal(validateExportCode({ code: apiOnly, framework, language: lang(framework, "robot"), hasUiSteps: false }).ok, true);
      assert.equal(validateExportCode({ code: apiOnly, framework, language: lang(framework, "robot"), hasUiSteps: true }).ok, false);
    }
  });

  it("rejects importing Cypress globals", () => {
    const imported = `import { describe, it } from 'cypress';\n${CYPRESS_TS}`;
    const result = validateExportCode({ code: imported, framework: CYPRESS, language: lang(CYPRESS, "typescript") });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => /globals/.test(item)));
  });

  it("warns when the code performs a different number of browser actions than recorded", () => {
    // start URL + fill + fill + click (the assertions are not actions)
    assert.equal(exportBrowserActions(context), 4);
    for (const [framework, language, code] of [
      [PLAYWRIGHT, "typescript", PLAYWRIGHT_TS],
      [SELENIUM, "python", SELENIUM_PY],
      [CYPRESS, "typescript", CYPRESS_TS],
      [PLAYWRIGHT, "robot", PLAYWRIGHT_ROBOT],
      [SELENIUM, "robot", SELENIUM_ROBOT],
    ] as const) {
      const exact = validateExportCode({ code, framework, language: lang(framework, language), browserActions: 4 });
      assert.deepEqual(exact.warnings, [], `${framework.id} counts its own actions`);
    }
    const repeated = PLAYWRIGHT_TS.replace(
      "await page.getByTestId('login-submit').click();",
      "await page.getByTestId('login-submit').click();\n  await page.getByTestId('login-submit').click();",
    );
    const result = validateExportCode({ code: repeated, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript"), browserActions: 4 });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((item) => /performs 5 browser actions; the precondition records 4/.test(item)));
  });

  it("removes Markdown fences around the code", () => {
    const result = validateExportCode({ code: "```ts\n" + PLAYWRIGHT_TS + "```", framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript") });
    assert.equal(result.ok, true);
    assert.ok(result.code.startsWith("import { test"));
  });

  it("redacts secrets and warns", () => {
    const leaked = PLAYWRIGHT_TS.replace("process.env.PASSWORD ?? ''", "'hunter2-secret'").replace(
      "await page.goto",
      "await page.setExtraHTTPHeaders({ Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl' });\n  await page.goto",
    );
    const result = validateExportCode({ code: leaked, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript"), secrets: ["hunter2-secret"] });
    assert.equal(result.ok, true);
    assert.ok(!result.code.includes("hunter2-secret"));
    assert.ok(!result.code.includes("eyJhbGciOiJIUzI1NiJ9"));
    assert.ok(result.warnings.length >= 2);
  });

  it("rejects code that does not represent the precondition, and warns about a missing detail", () => {
    const unrelated = `import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.goto('https://other.test/'); });\n`;
    const result = validateExportCode({ code: unrelated, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript"), anchors });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => /does not represent/.test(item)));

    const partial = PLAYWRIGHT_TS.replace("await expect(page.getByText('Welcome back')).toBeVisible();\n", "");
    const warned = validateExportCode({ code: partial, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript"), anchors });
    assert.equal(warned.ok, true);
    assert.ok(warned.warnings.some((item) => item.includes("Welcome back")));
  });

  it("anchors are URL paths, typed values, expected texts and test ids — not secrets or variables", () => {
    assert.deepEqual(anchors.sort(), ["/dashboard", "/login", "Welcome back", "login-submit", "sara@example.com"].sort());
    const withVariable: ExportContext = {
      ...context,
      steps: [{ type: "http", name: "Get user", method: "GET", url: "{{base_url}}/api/users/{{userId}}" }],
    };
    assert.deepEqual(exportAnchors(withVariable), ["/api/users/"]);
    const withMappedId: ExportContext = {
      ...context,
      steps: [{ type: "http", name: "Cancel", method: "POST", url: "https://api.test/bpms/28647645/cancel", uses: { 'path "28647645"': 'step "Add" response.body.result.id' } }],
    };
    assert.deepEqual(exportAnchors(withMappedId), ["/bpms/"]);
  });
});

// ── Appium, framework availability and single-step export ───────────────

const mobileContext: ExportContext = {
  preconditionId: "sc2",
  name: "App login",
  steps: [
    {
      type: "mobile",
      name: "Sign in on Android",
      platform: "android",
      server: "http://127.0.0.1:4723",
      capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2", "appium:appPackage": "com.shop.app" },
      actions: [
        { do: "type", value: "sara@example.com", locators: [{ using: "id", value: "com.shop.app:id/email" }] },
        { do: "type", secretEnv: "PASSWORD", locators: [{ using: "id", value: "com.shop.app:id/password" }] },
        { do: "tap", locators: [{ using: "accessibility id", value: "Sign in" }, { using: "xpath", value: '//android.widget.Button[@text="Sign in"]' }] },
        { do: "assertText", value: "Welcome", locators: [{ using: "id", value: "com.shop.app:id/title" }] },
      ],
    },
  ],
  variables: [],
  metadata: { stopOnFailure: true },
};

const APPIUM_JAVA = `import io.appium.java_client.AppiumBy;
import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import org.junit.jupiter.api.*;
import java.net.URL;

public class AppLoginTest {
  private AndroidDriver driver;

  @BeforeEach
  void setUp() throws Exception {
    UiAutomator2Options options = new UiAutomator2Options().setAppPackage("com.shop.app");
    driver = new AndroidDriver(new URL("http://127.0.0.1:4723"), options);
  }

  @Test
  void appLogin() {
    // Sign in on Android
    driver.findElement(AppiumBy.id("com.shop.app:id/email")).sendKeys("sara@example.com");
    driver.findElement(AppiumBy.id("com.shop.app:id/password")).sendKeys(System.getenv("PASSWORD"));
    driver.findElement(AppiumBy.accessibilityId("Sign in")).click();
    Assertions.assertTrue(driver.findElement(AppiumBy.id("com.shop.app:id/title")).getText().contains("Welcome"));
  }

  @AfterEach
  void tearDown() {
    driver.quit();
  }
}
`;

const APPIUM_ROBOT_KEYWORD = `*** Settings ***
Library    AppiumLibrary

*** Keywords ***
Sign In On Android
    # The caller opens the application (Open Application) and provides %{PASSWORD}.
    Input Text    id=com.shop.app:id/email    sara@example.com
    Input Password    id=com.shop.app:id/password    %{PASSWORD}
    Click Element    accessibility_id=Sign in
    Element Should Contain Text    id=com.shop.app:id/title    Welcome
`;

describe("framework availability", () => {
  const web = exportSurfaces(context.steps);
  const mobile = exportSurfaces(mobileContext.steps);
  const none = exportSurfaces([{ type: "http" }]);
  const mixed = exportSurfaces([...context.steps, ...mobileContext.steps]);

  it("offers browser frameworks for web and HTTP-only preconditions, Appium only for mobile ones", () => {
    assert.deepEqual(frameworkAvailability(PLAYWRIGHT, web), { available: true });
    assert.deepEqual(frameworkAvailability(APPIUM, web), { available: false, reason: "noMobileSteps" });
    assert.deepEqual(frameworkAvailability(SELENIUM, none), { available: true });
    assert.deepEqual(frameworkAvailability(APPIUM, none), { available: false, reason: "noMobileSteps" });
    assert.deepEqual(frameworkAvailability(APPIUM, mobile), { available: true });
    assert.deepEqual(frameworkAvailability(CYPRESS, mobile), { available: false, reason: "mobileOnly" });
    assert.equal(frameworkAvailability(PLAYWRIGHT, mixed).available, true);
    assert.equal(frameworkAvailability(APPIUM, mixed).available, true);
  });

  it("lists availability only when asked, so existing callers see the same options", () => {
    const plain = exportFrameworkOptions("Login flow").find((item) => item.id === "playwright")!;
    assert.deepEqual(Object.keys(plain).sort(), ["id", "label", "languages"]);
    const mobileOptions = exportFrameworkOptions("App login", mobile);
    assert.deepEqual(
      mobileOptions.map((item) => [item.id, item.available, item.unavailableReason]),
      [["playwright", false, "mobileOnly"], ["selenium", false, "mobileOnly"], ["cypress", false, "mobileOnly"], ["appium", true, undefined]],
    );
    assert.equal(mobileOptions.find((item) => item.id === "appium")!.languages.find((item) => item.id === "java")!.filename, "AppLoginTest.java");
  });

  it("leaves out the UI steps a framework cannot drive, and says so", () => {
    const both: ExportContext = { ...context, steps: [...context.steps, ...mobileContext.steps] };
    const forPlaywright = contextForFramework(both, PLAYWRIGHT);
    assert.deepEqual(forPlaywright.steps.map((step) => step.type), ["ui"]);
    assert.deepEqual(forPlaywright.metadata.leftOut, [{ step: "Sign in on Android", reason: "Playwright cannot drive a mobile app" }]);
    const forAppium = contextForFramework(both, APPIUM);
    assert.deepEqual(forAppium.steps.map((step) => step.type), ["mobile"]);
    assert.equal(contextForFramework(context, PLAYWRIGHT), context, "nothing left out: the same context");
  });
});

describe("Appium export", () => {
  it("sends Appium rules, not browser rules", () => {
    const { system, prompt } = buildExportPrompt(mobileContext, APPIUM, lang(APPIUM, "java"));
    assert.match(system, /Appium tests in Java/);
    assert.match(system, /io\.appium\.java_client/);
    assert.match(system, /accessibility id, id \(resource id\), -android uiautomator/);
    assert.doesNotMatch(system, /Playwright Test|getByTestId|cy\.visit/);
    assert.match(prompt, /File: AppLoginTest\.java/);
    const robot = buildExportPrompt(mobileContext, APPIUM, lang(APPIUM, "robot")).system;
    assert.match(robot, /Library {4}AppiumLibrary/);
    assert.doesNotMatch(robot, /SeleniumLibrary\.|Library {4}Browser\b(?! library)/);
  });

  it("accepts Appium Java code of the precondition and counts its mobile actions", () => {
    const result = validateExportCode({
      code: APPIUM_JAVA,
      framework: APPIUM,
      language: lang(APPIUM, "java"),
      anchors: exportAnchors(mobileContext),
      browserActions: exportBrowserActions(mobileContext),
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(exportBrowserActions(mobileContext), 3);
    assert.ok(!result.warnings.some((warning) => /browser actions/.test(warning)), result.warnings.join("; "));
  });

  it("anchors mobile steps by typed and expected values and stable ids, not secrets", () => {
    const found = exportAnchors(mobileContext);
    assert.ok(found.includes("sara@example.com"));
    assert.ok(found.includes("Welcome"));
    assert.ok(found.includes("com.shop.app:id/email"));
    assert.ok(found.includes("Sign in"));
    assert.ok(!found.some((anchor) => anchor.includes("PASSWORD")));
  });

  it("rejects browser code for Appium and Appium code for a browser framework", () => {
    const playwrightForAppium = validateExportCode({ code: PLAYWRIGHT_TS, framework: APPIUM, language: lang(APPIUM, "typescript") });
    assert.equal(playwrightForAppium.ok, false);
    assert.ok(playwrightForAppium.errors.some((error) => /does not use Appium/.test(error)));
    assert.ok(playwrightForAppium.errors.some((error) => /uses Playwright APIs/.test(error)));
    assert.equal(validateExportCode({ code: APPIUM_JAVA, framework: PLAYWRIGHT, language: lang(PLAYWRIGHT, "typescript") }).ok, false);
  });
});

describe("single-step export", () => {
  const stepContext: ExportContext = {
    ...mobileContext,
    scope: { kind: "step", step: "Sign in on Android", precondition: "App login", position: 2, total: 3, inputs: ["PASSWORD"], continuesSession: true },
  };

  it("adds the step rules only when one step is exported", () => {
    const full = buildExportPrompt(context, PLAYWRIGHT, lang(PLAYWRIGHT, "typescript")).system;
    assert.doesNotMatch(full, /Export only the one step/);
    const step = buildExportPrompt(stepContext, APPIUM, lang(APPIUM, "robot"));
    assert.match(step.system, /Export only the one step named in scope/);
    assert.match(step.system, /do not create, open, close or quit/);
    assert.ok(step.prompt.includes('"scope":{"kind":"step"'));
  });

  it("accepts a Robot keyword file for one step, but not as a whole precondition", () => {
    const language = lang(APPIUM, "robot");
    assert.equal(validateExportCode({ code: APPIUM_ROBOT_KEYWORD, framework: APPIUM, language, mode: "step" }).ok, true);
    const full = validateExportCode({ code: APPIUM_ROBOT_KEYWORD, framework: APPIUM, language });
    assert.equal(full.ok, false);
    assert.ok(full.errors.some((error) => /Test Cases/.test(error)));
  });
});
