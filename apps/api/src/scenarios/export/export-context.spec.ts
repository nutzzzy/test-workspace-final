import { buildExportContext, isFragile, rankLocators, type ExportSource } from "./export-context";

const loginStep = {
  id: "s1",
  name: "Sign in",
  type: "UI_FLOW",
  orderIndex: 0,
  enabled: true,
  config: {
    startUrl: "https://app.test/login",
    actions: [
      {
        id: "a1",
        kind: "fill",
        value: "sara@example.com",
        label: 'Type "sara@example.com" into «Email»',
        url: "https://app.test/login",
        target: {
          candidates: [
            { kind: "css", value: "div:nth-child(2) > input", confidence: 0.3 },
            { kind: "label", value: "Email", confidence: 0.9 },
            { kind: "testid", value: '[data-testid="email"]', confidence: 0.95 },
          ],
          fingerprint: { tag: "input", type: "email", classes: ["css-1x2y3z"] },
        },
      },
      {
        id: "a2",
        kind: "fill",
        secret: true,
        valueEnc: "v1:encrypted-password",
        target: { candidates: [{ kind: "label", value: "Password" }], fingerprint: { tag: "input", type: "password" } },
      },
      {
        id: "a3",
        kind: "click",
        target: {
          candidates: [
            { kind: "role", value: "button", name: "Edit" },
            { kind: "id", value: "#ember1234" },
          ],
          fingerprint: { tag: "button" },
          scope: {
            kind: "row",
            container: { role: "table", name: "Users" },
            rowSelector: "tr",
            identity: [{ strategy: "cell", column: "Name", value: "Sara" }],
            target: [{ kind: "role", value: "button", name: "Edit" }],
          },
        },
      },
      { id: "a4", kind: "assertText", value: "Saved" },
    ],
  },
};

const source: ExportSource = {
  id: "sc1",
  name: "Edit user",
  description: "",
  stopOnFailure: true,
  environment: { name: "QA" },
  steps: [
    {
      id: "s2",
      name: "Get user",
      type: "HTTP_REQUEST",
      orderIndex: 1,
      enabled: true,
      config: {
        method: "get",
        url: "{{base_url}}/api/users/{{userId}}",
        headers: { Authorization: "Bearer abc.def.ghi", Accept: "application/json" },
        expectedStatus: 200,
        extract: [{ variable: "email", path: "$.data.email" }],
        originalCurl: "curl … secret",
        recovery: { attempts: 3 },
      },
    },
    loginStep,
    { id: "s3", name: "Disabled", type: "DELAY", orderIndex: 2, enabled: false, config: { ms: 500 } },
    { id: "s4", name: "Status", type: "ASSERTION", orderIndex: 3, enabled: true, config: { kind: "status_code", expected: 200 } },
  ],
};

describe("buildExportContext", () => {
  const context = buildExportContext(source);

  it("keeps the enabled steps in execution order and notes the ones left out", () => {
    expect(context.steps.map((step) => step.name)).toEqual(["Sign in", "Get user", "Status"]);
    expect(context.metadata).toEqual({ environment: "QA", stopOnFailure: true, disabledStepsLeftOut: 1 });
    expect(context.url).toBe("https://app.test/login");
    expect(context.preconditionId).toBe("sc1");
  });

  it("keeps actions, values, assertions and stable locators, best first", () => {
    const ui = context.steps[0]!;
    if (ui.type !== "ui") throw new Error("expected a UI step");
    expect(ui.actions.map((action) => action.do)).toEqual(["fill", "fill", "click", "assertText"]);
    expect(ui.actions[0]!.value).toBe("sara@example.com");
    expect(ui.actions[0]!.locators).toEqual([{ testid: "email" }, { label: "Email" }]);
    expect(ui.actions[3]).toEqual({ do: "assertText", value: "Saved" });
  });

  it("keeps a written label and drops one that only repeats the generated description", () => {
    const ui = context.steps[0]!;
    if (ui.type !== "ui") throw new Error("expected a UI step");
    expect(ui.actions[0]!.label).toBeUndefined();
    const custom = buildExportContext({ ...source, steps: [{ ...loginStep, config: { ...loginStep.config, actions: [{ ...loginStep.config.actions[0], label: "Log in as the QA admin" }] } }] });
    const step = custom.steps[0]!;
    if (step.type !== "ui") throw new Error("expected a UI step");
    expect(step.actions[0]!.label).toBe("Log in as the QA admin");
  });

  it("describes table rows by their content, not their position", () => {
    const ui = context.steps[0]!;
    if (ui.type !== "ui") throw new Error("expected a UI step");
    expect(ui.actions[2]!.row).toEqual({ container: 'table "Users"', rowSelector: "tr", match: ["Name = Sara"], target: [{ role: "button", name: "Edit" }] });
  });

  it("never sends secrets: typed secrets become environment variables, credential headers are masked", () => {
    const text = JSON.stringify(context);
    expect(text).not.toContain("encrypted-password");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("originalCurl");
    const ui = context.steps[0]!;
    if (ui.type !== "ui") throw new Error("expected a UI step");
    expect(ui.actions[1]).toMatchObject({ do: "fill", secretEnv: "PASSWORD" });
    // Field names make better variable names than non-Latin labels.
    const otp = buildExportContext({
      ...source,
      steps: [
        {
          ...loginStep,
          config: {
            startUrl: "https://app.test",
            actions: [1, 2].map((n) => ({ id: `o${n}`, kind: "fill", secret: true, valueEnc: "x", target: { candidates: [{ kind: "label", value: "رقم کد" }], fingerprint: { tag: "input", type: "text", name: `otp-digit-${n}` } } }))
              .concat([{ id: "p", kind: "fill", secret: true, valueEnc: "x", target: { candidates: [{ kind: "placeholder", value: "رمز عبور" }], fingerprint: { tag: "input", type: "password", name: "" } } }]),
          },
        },
      ],
    });
    const otpStep = otp.steps[0]!;
    if (otpStep.type !== "ui") throw new Error("expected a UI step");
    expect(otpStep.actions.map((action) => action.secretEnv)).toEqual(["OTP_DIGIT_1", "OTP_DIGIT_2", "PASSWORD"]);
    expect(ui.actions[1]!.value).toBeUndefined();
    const http = context.steps[1]!;
    if (http.type !== "http") throw new Error("expected an HTTP step");
    expect(http).toMatchObject({ method: "GET", url: "{{base_url}}/api/users/{{userId}}", expectStatus: [200], extract: { email: "$.data.email" } });
    expect(http.headers!.Authorization).toBe("Bearer ***");
    expect(http.headers!.Accept).toBe("application/json");
  });

  it("keeps a header's scheme and template, and names mapped path segments by their recorded value", () => {
    const mapped = buildExportContext({
      ...source,
      steps: [
        {
          id: "c",
          name: "Cancel",
          type: "HTTP_REQUEST",
          orderIndex: 0,
          enabled: true,
          config: {
            method: "POST",
            url: "https://api.test/bpms/28647645/cancel",
            headers: { authorization: "Bearer eyJhbGciOi.abc.def", "x-api-key": "{{apiKey}}", Cookie: "sid=abc" },
            bindings: [
              { target: { location: "path", field: "2", key: "bpmId" }, source: { stepId: "s2", path: "response.body.result.id" } },
              { target: { location: "header", field: "authorization" }, source: { stepId: "s2", path: "response.body.result.accessToken" } },
            ],
          },
        },
        { ...source.steps[0]!, orderIndex: -1 },
      ],
    });
    const http = mapped.steps[1]!;
    if (http.type !== "http") throw new Error("expected an HTTP step");
    expect(http.headers).toEqual({ authorization: "Bearer ***", "x-api-key": "{{apiKey}}", Cookie: "***" });
    expect(http.uses).toEqual({
      'path "28647645"': 'step "Get user" response.body.result.id',
      "header.authorization": 'step "Get user" response.body.result.accessToken',
    });
  });

  it("lists the configuration variables no step produces", () => {
    expect(context.variables).toEqual(["base_url", "userId"]);
  });

  it("leaves out recorder internals (fingerprints, page URLs, learned state)", () => {
    const text = JSON.stringify(context);
    expect(text).not.toContain("fingerprint");
    expect(text).not.toContain("css-1x2y3z");
    expect(text).not.toContain("confidence");
  });
});

describe("locators", () => {
  it("drops positional CSS, generated ids and absolute XPath", () => {
    expect(isFragile({ kind: "css", value: "ul > li:nth-child(3) > a" })).toBe(true);
    expect(isFragile({ kind: "css", value: ".css-1q2w3e4 > span" })).toBe(true);
    expect(isFragile({ kind: "id", value: "#ember1234" })).toBe(true);
    expect(isFragile({ kind: "id", value: "#email" })).toBe(false);
    expect(isFragile({ kind: "xpath", value: "/html/body/div[2]/form/input" })).toBe(true);
    expect(isFragile({ kind: "css", value: "form.login button[type=submit]" })).toBe(false);
  });

  it("ranks test id, role, label, placeholder first and keeps at most three", () => {
    expect(
      rankLocators([
        { kind: "text", value: "Save" },
        { kind: "css", value: "button.primary" },
        { kind: "role", value: "button", name: "Save" },
        { kind: "placeholder", value: "Search" },
        { kind: "testid", value: '[data-cy="save"]' },
      ]),
    ).toEqual([{ testid: "save", attr: "data-cy" }, { role: "button", name: "Save" }, { placeholder: "Search" }]);
  });

  it("keeps a fragile locator only when nothing else was recorded", () => {
    const context = buildExportContext({
      ...source,
      steps: [
        {
          ...loginStep,
          config: {
            startUrl: "https://app.test",
            actions: [{ id: "x", kind: "click", target: { candidates: [{ kind: "css", value: "div > div > div > span" }], fingerprint: { tag: "span" } } }],
          },
        },
      ],
    });
    const ui = context.steps[0]!;
    if (ui.type !== "ui") throw new Error("expected a UI step");
    expect(ui.actions[0]!.locators).toEqual([{ css: "div > div > div > span" }]);
  });
});

describe("buildExportContext with mobile steps", () => {
  const mobile = {
    id: "m1",
    name: "Pay in app",
    type: "MOBILE_FLOW",
    orderIndex: 5,
    enabled: true,
    config: {
      platform: "ios",
      serverUrl: "https://alice:hub-key@hub.example.com/wd/hub",
      capabilities: { "appium:bundleId": "com.shop", "bstack:options": { userName: "alice", accessKey: "k-123456" } },
      actions: [
        {
          id: "p1",
          kind: "type",
          secret: true,
          valueEnc: "v1:enc",
          target: { candidates: [{ using: "accessibility id", value: "pin", score: 0.95, unique: true }], fingerprint: { tag: "XCUIElementTypeSecureTextField", accessibilityId: "pin" } },
        },
        {
          id: "p2",
          kind: "tap",
          target: {
            candidates: [
              { using: "-ios predicate string", value: 'label == "Pay"', score: 0.3, unique: false, matches: 2 },
              { using: "accessibility id", value: "pay-button", score: 0.95, unique: true },
              { using: "xpath", value: "(//XCUIElementTypeButton)[4]", score: 0.14, unique: true },
            ],
            fingerprint: { tag: "XCUIElementTypeButton", name: "Pay" },
            learned: 2,
          },
        },
        { id: "p3", kind: "swipe", direction: "down" },
      ],
    },
  };
  const withMobile: ExportSource = { ...source, steps: [...source.steps, mobile] };

  it("exports the device, the capabilities without credentials, and the actions in order", () => {
    const step = buildExportContext(withMobile).steps.find((item) => item.type === "mobile");
    if (step?.type !== "mobile") throw new Error("expected a mobile step");
    expect(step.platform).toBe("ios");
    expect(step.server).toBe("https://hub.example.com/wd/hub");
    expect(step.capabilities).toEqual({ "appium:bundleId": "com.shop", "bstack:options": { userName: "alice", accessKey: "***" } });
    expect(step.actions.map((action) => action.do)).toEqual(["type", "tap", "swipe"]);
    expect(step.actions[0]).toEqual({ do: "type", secretEnv: "PIN", locators: [{ using: "accessibility id", value: "pin" }] });
    expect(step.actions[2]).toEqual({ do: "swipe", direction: "down" });
  });

  it("puts the locator that worked last first, then unique ones by rank, and drops one that matched several elements", () => {
    const step = buildExportContext(withMobile).steps.find((item) => item.type === "mobile");
    if (step?.type !== "mobile") throw new Error("expected a mobile step");
    expect(step.actions[1]!.locators).toEqual([
      { using: "xpath", value: "(//XCUIElementTypeButton)[4]" },
      { using: "accessibility id", value: "pay-button" },
    ]);
  });
});

describe("buildExportContext for one step", () => {
  it("exports only that step, named after it, with its place, inputs and session", () => {
    const later = { ...loginStep, id: "s9", name: "Sign in again", orderIndex: 9 };
    const context = buildExportContext({ ...source, steps: [...source.steps, later] }, new Map(), { stepId: "s9" });
    expect(context.name).toBe("Sign in again");
    expect(context.steps.map((step) => step.name)).toEqual(["Sign in again"]);
    expect(context.scope).toEqual({ kind: "step", step: "Sign in again", precondition: "Edit user", position: 5, total: 5, inputs: ["PASSWORD"], continuesSession: true });
    expect(context.metadata).toEqual({ environment: "QA", stopOnFailure: true });
  });

  it("lists the variables an HTTP step needs and exports a disabled step when it is chosen", () => {
    const http = buildExportContext(source, new Map(), { stepId: "s2" });
    expect(http.scope).toMatchObject({ step: "Get user", position: 2, inputs: ["base_url", "userId"] });
    expect(http.scope?.continuesSession).toBeUndefined();
    const disabled = buildExportContext(source, new Map(), { stepId: "s3" });
    expect(disabled.steps).toEqual([{ type: "delay", name: "Disabled", ms: 500 }]);
  });

  it("does not change the whole-precondition context", () => {
    expect(buildExportContext(source).scope).toBeUndefined();
    expect(() => buildExportContext(source, new Map(), { stepId: "nope" })).toThrow("Step not found");
  });
});
