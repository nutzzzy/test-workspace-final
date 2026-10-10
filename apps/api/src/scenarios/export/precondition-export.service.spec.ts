import { HttpException } from "@nestjs/common";
import type { AIService } from "../../ai/ai.service";
import type { PrismaService } from "../../prisma/prisma.service";
import { EXPORT_ERRORS, PreconditionExportService } from "./precondition-export.service";

const scenario = {
  id: "sc1",
  name: "Login flow",
  description: "",
  stopOnFailure: true,
  environment: null,
  steps: [
    {
      id: "s1",
      name: "Sign in",
      type: "UI_FLOW",
      orderIndex: 0,
      enabled: true,
      config: {
        startUrl: "https://app.test/login",
        actions: [
          { id: "a1", kind: "fill", value: "sara@example.com", target: { candidates: [{ kind: "label", value: "Email" }], fingerprint: { tag: "input" } } },
          { id: "a2", kind: "click", target: { candidates: [{ kind: "testid", value: '[data-testid="login-submit"]' }], fingerprint: { tag: "button" } } },
          { id: "a3", kind: "assertText", value: "Welcome back" },
        ],
      },
    },
  ],
};

const connections = [
  { id: "claude", name: "Claude", model: "claude-sonnet", usable: true, blockedReason: null },
  { id: "openai", name: "OpenAI", model: "gpt", usable: true, blockedReason: null },
  { id: "gemini", name: "Gemini", model: "gemini-pro", usable: false, blockedReason: "external_not_allowed" },
];

const CODE = {
  playwright: `import { test, expect } from '@playwright/test';\ntest('Login flow', async ({ page }) => {\n  await page.goto('https://app.test/login');\n  await page.getByLabel('Email').fill('sara@example.com');\n  await page.getByTestId('login-submit').click();\n  await expect(page.getByText('Welcome back')).toBeVisible();\n});\n`,
  selenium: `from selenium import webdriver\nfrom selenium.webdriver.common.by import By\n\n\ndef test_login_flow():\n    driver = webdriver.Chrome()\n    driver.get("https://app.test/login")\n    driver.find_element(By.CSS_SELECTOR, "input[aria-label='Email']").send_keys("sara@example.com")\n    driver.find_element(By.CSS_SELECTOR, "[data-testid='login-submit']").click()\n    assert "Welcome back" in driver.page_source\n    driver.quit()\n`,
  cypress: `describe('Login flow', () => {\n  it('signs in', () => {\n    cy.visit('https://app.test/login');\n    cy.get('input[aria-label="Email"]').type('sara@example.com');\n    cy.get('[data-testid="login-submit"]').click();\n    cy.contains('Welcome back').should('be.visible');\n  });\n});\n`,
};

function setup(options: { providerTimeoutMs?: number; call?: jest.Mock } = {}) {
  const prisma = {
    scenario: { findUnique: jest.fn().mockResolvedValue(scenario) },
    databaseConnector: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const call =
    options.call ??
    jest.fn().mockImplementation(async (_group: string, _call: unknown, opts: { only?: string }) => ({
      data: { code: CODE.playwright, warnings: [] },
      origin: { connectionId: opts.only ?? "claude", name: opts.only === "openai" ? "OpenAI" : "Claude", model: "m" },
    }));
  const ai = {
    listConnections: jest.fn().mockResolvedValue(connections),
    chainFor: jest.fn().mockResolvedValue([{ id: "claude" }, { id: "openai" }]),
    getRunBudget: jest.fn().mockResolvedValue({ runBudgetMs: 300_000, providerTimeoutMs: options.providerTimeoutMs ?? 180_000 }),
    call,
  };
  const service = new PreconditionExportService(prisma as unknown as PrismaService, ai as unknown as AIService);
  return { service, prisma, ai, call };
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), message: error.message };
    throw error;
  }
  throw new Error("expected the export to fail");
}

describe("PreconditionExportService.options", () => {
  it("lists frameworks with file names and the workspace's AI connections, the automation default first", async () => {
    const { service } = setup();
    const options = await service.options("sc1");
    // Appium is listed but cannot export a browser precondition.
    expect(options.frameworks.map((item) => [item.id, item.available])).toEqual([["playwright", true], ["selenium", true], ["cypress", true], ["appium", false]]);
    expect(options.step).toBeNull();
    expect(options.frameworks[0]!.languages[0]).toEqual({ id: "typescript", label: "TypeScript", filename: "login-flow.spec.ts" });
    expect(options.frameworks[3]!.unavailableReason).toBe("noMobileSteps");
    expect(options.providers.map((item) => item.id)).toEqual(["claude", "openai", "gemini"]);
    expect(options.providers[2]).toEqual({ id: "gemini", name: "Gemini", model: "gemini-pro", usable: false, blockedReason: "external_not_allowed" });
    expect(options.defaultProviderId).toBe("claude");
  });
});

describe("PreconditionExportService.generate", () => {
  it.each([
    ["playwright", "typescript", "openai", CODE.playwright, "login-flow.spec.ts"],
    ["selenium", "python", "claude", CODE.selenium, "login_flow_test.py"],
    ["cypress", "typescript", "openai", CODE.cypress, "login-flow.cy.ts"],
  ])("%s + %s through %s: one request to the chosen connection, normalized result", async (framework, language, providerId, code, filename) => {
    const call = jest.fn().mockResolvedValue({ data: { code, warnings: ["Uses a helper"] }, origin: { connectionId: providerId, name: providerId, model: "m" } });
    const { service } = setup({ call });
    const result = await service.generate("sc1", { framework, language, providerId });
    expect(call).toHaveBeenCalledTimes(1);
    const [group, request, opts] = call.mock.calls[0];
    expect(group).toBe("automation");
    expect(opts).toMatchObject({ only: providerId, attemptsPerConnection: 2 });
    expect(request.prompt).toContain('"preconditionId":"sc1"');
    expect(request.prompt).toContain("sara@example.com");
    expect(request.system).toMatch(new RegExp(framework, "i"));
    expect(result).toEqual({ framework, language, code, filename, warnings: ["Uses a helper"], provider: { id: providerId, name: providerId, model: "m" } });
  });

  it("uses the workspace default (the automation routing, with fallback) when no provider is chosen", async () => {
    const { service, call } = setup();
    const result = await service.generate("sc1", { framework: "playwright", language: "typescript" });
    expect(call.mock.calls[0][2].only).toBeUndefined();
    expect(result.provider.id).toBe("claude");
  });

  it("never writes to the precondition", async () => {
    const { service, prisma } = setup();
    await service.generate("sc1", { framework: "playwright", language: "typescript" });
    expect(Object.keys(prisma.scenario)).toEqual(["findUnique"]);
  });

  it("rejects an unsupported framework or language before calling the AI", async () => {
    const { service, call } = setup();
    expect(await failure(service.generate("sc1", { framework: "robot", language: "python" }))).toEqual({ status: 400, message: EXPORT_ERRORS.unsupportedFramework });
    expect(await failure(service.generate("sc1", { framework: "cypress", language: "java" }))).toEqual({ status: 400, message: EXPORT_ERRORS.unsupportedLanguage });
    expect(call).not.toHaveBeenCalled();
  });

  it("reports a precondition without enabled steps", async () => {
    const { service, prisma } = setup();
    prisma.scenario.findUnique.mockResolvedValue({ ...scenario, steps: [{ ...scenario.steps[0], enabled: false }] });
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript" }))).toEqual({ status: 400, message: EXPORT_ERRORS.nothingToExport });
  });

  it("reports an unknown precondition", async () => {
    const { service, prisma } = setup();
    prisma.scenario.findUnique.mockResolvedValue(null);
    await expect(service.generate("nope", { framework: "playwright", language: "typescript" })).rejects.toThrow("Scenario not found");
  });

  it("reports a chosen provider that cannot be used, without calling it", async () => {
    const { service, call } = setup();
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript", providerId: "gemini" }))).toEqual({
      status: 424,
      message: EXPORT_ERRORS.providerUnavailable,
    });
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript", providerId: "deleted" }))).toMatchObject({
      message: EXPORT_ERRORS.providerUnavailable,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("reports a workspace without usable providers", async () => {
    const { service, ai } = setup();
    ai.listConnections.mockResolvedValue([connections[2]]);
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript" }))).toEqual({ status: 424, message: EXPORT_ERRORS.noProvider });
  });

  it.each([
    ["AI automation failed on every connection — Claude: fetch failed: connect ECONNREFUSED 127.0.0.1:11434", EXPORT_ERRORS.providerUnavailable],
    ["AI automation failed on every connection — Claude: AI service error 503: overloaded", EXPORT_ERRORS.providerUnavailable],
    ["AI automation failed on every connection — Pollinations: AI service error 402: {}", EXPORT_ERRORS.providerUnavailable],
    ["AI automation failed on every connection — Claude: The model did not answer in time", EXPORT_ERRORS.timeout],
    ["AI automation failed on every connection — Claude: AI response is empty", EXPORT_ERRORS.empty],
    ["AI automation failed on every connection — Claude: AI response is not valid JSON", EXPORT_ERRORS.invalid],
    ["AI automation failed on every connection — Claude: AI schema validation failed: code: expected string", EXPORT_ERRORS.invalid],
    [
      'AI automation failed on every connection — Pollinations: AI schema validation failed: [\n  {\n    "expected": "string",\n    "code": "invalid_type",\n    "path": [\n      "code"\n    ],\n    "message": "Invalid input: expect | Local Ollama: fetch failed: connect ECONNREFUSED',
      EXPORT_ERRORS.cutOff,
    ],
    ["AI automation failed on every connection — Claude: AI service error 400: bad request", "Code generation failed: Claude: AI service error 400: bad request"],
    ["AI automation failed on every connection — Claude: AI response is empty | Local Ollama: fetch failed", EXPORT_ERRORS.empty],
  ])("maps a provider failure (%s)", async (raw, message) => {
    const { service } = setup({ call: jest.fn().mockRejectedValue(new Error(raw)) });
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript", providerId: "claude" }))).toEqual({ status: 424, message });
  });

  it("stops waiting at the provider time limit", async () => {
    const call = jest.fn().mockImplementation(
      (_group: string, _call: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("AI analysis was cancelled")))),
    );
    const { service } = setup({ providerTimeoutMs: 20, call });
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript", providerId: "claude" }))).toEqual({
      status: 424,
      message: EXPORT_ERRORS.timeout,
    });
  });

  it("reports an empty code answer", async () => {
    const { service } = setup({ call: jest.fn().mockResolvedValue({ data: { code: "  " }, origin: { connectionId: "claude", name: "Claude", model: "m" } }) });
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript" }))).toEqual({ status: 424, message: EXPORT_ERRORS.empty });
  });

  it("rejects code for the wrong framework or language instead of showing it", async () => {
    const { service } = setup({ call: jest.fn().mockResolvedValue({ data: { code: CODE.selenium }, origin: { connectionId: "claude", name: "Claude", model: "m" } }) });
    const result = await failure(service.generate("sc1", { framework: "playwright", language: "typescript" }));
    expect(result.status).toBe(422);
    expect(result.message).toMatch(/^The generated code was rejected: /);
    const cypress = setup({ call: jest.fn().mockResolvedValue({ data: { code: CODE.playwright }, origin: { connectionId: "claude", name: "Claude", model: "m" } }) });
    expect((await failure(cypress.service.generate("sc1", { framework: "cypress", language: "typescript" }))).message).toMatch(/Playwright APIs/);
  });
});

// ── Appium and single-step export ───────────────────────────────────────

const mobileStep = {
  id: "m1",
  name: "Open cart on Android",
  type: "MOBILE_FLOW",
  orderIndex: 1,
  enabled: true,
  config: {
    platform: "android",
    serverUrl: "http://user:key@127.0.0.1:4723",
    capabilities: { "appium:appPackage": "com.shop.app", "appium:accessKey": "s3cr3t-key" },
    actions: [
      {
        id: "t1",
        kind: "tap",
        target: {
          candidates: [
            { using: "xpath", value: "(//android.widget.Button)[3]", score: 0.14, unique: true },
            { using: "accessibility id", value: "Cart", score: 0.95, unique: true },
          ],
          fingerprint: { tag: "android.widget.Button", name: "Cart" },
        },
      },
      { id: "t2", kind: "assertText", value: "Your cart", target: { candidates: [{ using: "id", value: "com.shop.app:id/title", score: 0.9, unique: true }], fingerprint: { tag: "android.widget.TextView" } } },
    ],
  },
};

const APPIUM_PY = `import os
from appium import webdriver
from appium.options.common import AppiumOptions
from appium.webdriver.common.appiumby import AppiumBy


def test_open_cart(driver):
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Cart").click()
    assert "Your cart" in driver.find_element(AppiumBy.ID, "com.shop.app:id/title").text
`;

const PLAYWRIGHT_STEP = `import { Page, expect } from '@playwright/test';\n// The caller provides: page (signed out, any page).\nexport async function signIn(page: Page) {\n  await page.goto('https://app.test/login');\n  await page.getByLabel('Email').fill('sara@example.com');\n  await page.getByTestId('login-submit').click();\n  await expect(page.getByText('Welcome back')).toBeVisible();\n}\n`;

describe("PreconditionExportService with mobile steps", () => {
  const mobileOnly = { ...scenario, name: "Cart", steps: [{ ...mobileStep, orderIndex: 0 }] };

  it("offers only Appium for a mobile precondition", async () => {
    const { service, prisma } = setup();
    prisma.scenario.findUnique.mockResolvedValue(mobileOnly);
    const options = await service.options("sc1");
    expect(options.frameworks.filter((item) => item.available).map((item) => item.id)).toEqual(["appium"]);
    expect(options.frameworks.find((item) => item.id === "playwright")!.unavailableReason).toBe("mobileOnly");
  });

  it("exports Appium code: locators ranked, credentials and secret capabilities kept out of the prompt", async () => {
    const call = jest.fn().mockResolvedValue({ data: { code: APPIUM_PY, warnings: [] }, origin: { connectionId: "claude", name: "Claude", model: "m" } });
    const { service, prisma } = setup({ call });
    prisma.scenario.findUnique.mockResolvedValue(mobileOnly);
    const result = await service.generate("sc1", { framework: "appium", language: "python" });
    const { system, prompt } = call.mock.calls[0][1];
    expect(system).toMatch(/Appium tests in Python/);
    expect(prompt).toContain('"type":"mobile"');
    expect(prompt).toContain('"server":"http://127.0.0.1:4723"');
    expect(prompt).not.toContain("user:key");
    expect(prompt).not.toContain("s3cr3t-key");
    // The stable accessibility id comes before the positional XPath, though the XPath was recorded first.
    expect(prompt.indexOf('"value":"Cart"')).toBeLessThan(prompt.indexOf("(//android.widget.Button)[3]"));
    expect(result).toMatchObject({ framework: "appium", language: "python", filename: "cart_test.py", warnings: [] });
  });

  it("refuses a browser framework for a mobile-only precondition, before calling the AI", async () => {
    const { service, prisma, call } = setup();
    prisma.scenario.findUnique.mockResolvedValue(mobileOnly);
    expect(await failure(service.generate("sc1", { framework: "playwright", language: "typescript" }))).toEqual({ status: 400, message: EXPORT_ERRORS.frameworkCannotExport });
    expect(call).not.toHaveBeenCalled();
  });

  it("leaves the mobile step out of browser code for a mixed precondition, and says so", async () => {
    const { service, prisma, call } = setup();
    prisma.scenario.findUnique.mockResolvedValue({ ...scenario, steps: [...scenario.steps, mobileStep] });
    const result = await service.generate("sc1", { framework: "playwright", language: "typescript" });
    expect(call.mock.calls[0][1].prompt).not.toContain('"type":"mobile"');
    expect(result.warnings).toContain('Step "Open cart on Android" was left out: Playwright cannot drive a mobile app.');
  });
});

describe("PreconditionExportService single-step export", () => {
  it("lists frameworks for that step, named after it", async () => {
    const { service, prisma } = setup();
    prisma.scenario.findUnique.mockResolvedValue({ ...scenario, steps: [...scenario.steps, mobileStep] });
    const web = await service.options("sc1", "s1");
    expect(web.step).toEqual({ id: "s1", name: "Sign in", type: "UI_FLOW" });
    expect(web.frameworks.find((item) => item.id === "appium")!.available).toBe(false);
    expect(web.frameworks[0]!.languages[0]!.filename).toBe("sign-in.spec.ts");
    const mobile = await service.options("sc1", "m1");
    expect(mobile.frameworks.filter((item) => item.available).map((item) => item.id)).toEqual(["appium"]);
    await expect(service.options("sc1", "missing")).rejects.toThrow(EXPORT_ERRORS.stepNotFound);
  });

  it("exports one web step as a reusable function, with the step rules and its scope", async () => {
    const call = jest.fn().mockResolvedValue({ data: { code: PLAYWRIGHT_STEP, warnings: [] }, origin: { connectionId: "claude", name: "Claude", model: "m" } });
    const { service, prisma } = setup({ call });
    prisma.scenario.findUnique.mockResolvedValue({ ...scenario, steps: [...scenario.steps, mobileStep] });
    const result = await service.generate("sc1", { framework: "playwright", language: "typescript", stepId: "s1" });
    const { system, prompt } = call.mock.calls[0][1];
    expect(system).toMatch(/Export only the one step named in scope/);
    expect(prompt).toContain('"scope":{"kind":"step","step":"Sign in","precondition":"Login flow","position":1,"total":2');
    expect(prompt).not.toContain("Open cart on Android");
    expect(result).toMatchObject({ filename: "sign-in.spec.ts", warnings: [] });
  });

  it("exports one mobile step with Appium and reports an unknown step", async () => {
    const call = jest.fn().mockResolvedValue({ data: { code: APPIUM_PY, warnings: [] }, origin: { connectionId: "claude", name: "Claude", model: "m" } });
    const { service, prisma } = setup({ call });
    prisma.scenario.findUnique.mockResolvedValue({ ...scenario, steps: [...scenario.steps, mobileStep] });
    const result = await service.generate("sc1", { framework: "appium", language: "python", stepId: "m1" });
    expect(call.mock.calls[0][1].prompt).toContain('"scope":{"kind":"step","step":"Open cart on Android"');
    expect(result.filename).toBe("open_cart_on_android_test.py");
    expect(await failure(service.generate("sc1", { framework: "appium", language: "python", stepId: "nope" }))).toEqual({ status: 404, message: EXPORT_ERRORS.stepNotFound });
  });

  it("a whole-precondition export is unchanged by step export (no scope, no step rules)", async () => {
    const { service, call } = setup();
    await service.generate("sc1", { framework: "playwright", language: "typescript" });
    const { system, prompt } = call.mock.calls[0][1];
    expect(system).not.toMatch(/Export only the one step/);
    expect(prompt).not.toContain('"scope"');
  });
});
