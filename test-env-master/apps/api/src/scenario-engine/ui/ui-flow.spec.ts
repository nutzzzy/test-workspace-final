import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { encryptSecret, decryptSecret } from "../../common/crypto.util";
import { AssertionExecutor } from "../executors/assertion.executor";
import { HttpRequestExecutor } from "../executors/http-request.executor";
import { UiFlowExecutor, type UiActionResult } from "../executors/ui-flow.executor";
import { orchestrateSteps } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext, type OrchestrationStep, type OrchestrationStepResult } from "../types";
import { browserPath } from "./ui-browser";
import { UiRecorderService } from "./ui-recorder.service";
import { publicUiConfig, sealUiConfig, SECRET_PLACEHOLDER, type UiAction } from "./ui-types";

/**
 * Real browser, real pages: a small app with a login form, a dashboard and an
 * API. Recorded by driving the recording browser like a user would, then
 * replayed headless. Skipped where no Chrome/Chromium is installed.
 */
const hasBrowser = Boolean(browserPath());
const describeUi = hasBrowser ? describe : describe.skip;
jest.setTimeout(90_000);

const KEY = "test-key";
const encrypt = (plain: string) => encryptSecret(plain, KEY);

/** The app. `variant` 2 renames things the way a redesign would. */
let variant = 1;
const loginPage = () => `<!doctype html><html><body>
  <h1>Sign in</h1>
  <form id="f">
    <label for="email">Email</label><input id="email" name="email" ${variant === 1 ? 'data-testid="email"' : ""}>
    <label>Password <input type="password" name="password" id="pw-${variant === 1 ? "1" : "x9"}"></label>
    <label><input type="checkbox" name="remember"> Remember me</label>
    <select name="role"><option value="">Choose</option><option value="qa">QA engineer</option><option value="dev">Developer</option></select>
    <button type="submit" ${variant === 1 ? 'data-testid="login"' : 'class="btn primary"'}>${variant === 1 ? "Sign in" : "Sign in now"}</button>
    <div id="msg" role="alert"></div>
  </form>
  <script>
    document.getElementById("f").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password"), role: form.get("role"), remember: form.get("remember") === "on" }) });
      const data = await res.json();
      if (!res.ok) { document.getElementById("msg").textContent = data.message; return; }
      localStorage.setItem("auth", JSON.stringify({ token: data.token, user: { id: data.userId } }));
      location.href = "/dashboard";
    });
  </script></body></html>`;
const dashboard = `<!doctype html><html><body><h1>Dashboard</h1><p id="hello"></p>
  <script>const auth = JSON.parse(localStorage.getItem("auth") || "{}");
  document.getElementById("hello").textContent = auth.token ? "Welcome back" : "Not signed in";</script></body></html>`;

let server: Server;
let base: string;
const apiCalls: Array<{ path: string; auth?: string }> = [];

beforeAll(async () => {
  if (!hasBrowser) return;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      apiCalls.push({ path: url.pathname, auth: req.headers.authorization });
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(body);
      };
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/login") return html(loginPage());
      if (url.pathname === "/dashboard") return html(dashboard);
      if (url.pathname === "/api/login") {
        const body = JSON.parse(raw || "{}");
        if (body.password !== "s3cret!" || body.role !== "qa" || body.remember !== true) return json(401, { message: "Wrong email or password" });
        return json(200, { token: "tok-ui-123456789", userId: 4242 });
      }
      if (url.pathname === "/api/orders") {
        return req.headers.authorization === "Bearer tok-ui-123456789" ? json(200, { orders: [] }) : json(401, { message: "invalid token" });
      }
      json(404, { message: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Record the login like a user: type, tick, choose, click. */
async function recordLogin() {
  const recorder = new UiRecorderService();
  const started = await recorder.start({ scenarioId: "s", startUrl: `${base}/login` }, { headless: true });
  const page = started.page;
  await page.click("#email");
  await page.keyboard.type("qa@example.test", { delay: 5 });
  await page.click('input[type="password"]');
  await page.keyboard.type("s3cret!", { delay: 5 });
  await page.click('input[name="remember"]');
  await page.selectOption('select[name="role"]', "qa");
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/);
  await page.waitForTimeout(300);
  await recorder.stop(started.id);
  return recorder.take(started.id);
}

function registry() {
  const reg = new StepExecutorRegistry();
  reg.register(new HttpRequestExecutor());
  reg.register(new AssertionExecutor());
  reg.register(new UiFlowExecutor((payload) => decryptSecret(payload, KEY)));
  return reg;
}

async function run(steps: OrchestrationStep[], learned: Array<{ stepId: string; learned: unknown }> = []) {
  const results: OrchestrationStepResult[] = [];
  const context = new ExecutionContext();
  const outcome = await orchestrateSteps(steps, registry(), context, {
    stopOnFailure: true,
    onStepComplete: (result) => void results.push(result),
    onLearnUi: async (stepId, items) => void learned.push({ stepId, learned: items }),
  });
  return { outcome, results, context };
}

const uiStep = (config: Record<string, unknown>, orderIndex = 0): OrchestrationStep => ({
  id: `ui-${orderIndex}`,
  name: "Sign in",
  type: "UI_FLOW",
  enabled: true,
  orderIndex,
  config,
});

describeUi("UI steps: record in a browser, replay in the background", () => {
  let recorded: Awaited<ReturnType<typeof recordLogin>>;
  beforeAll(async () => {
    variant = 1;
    recorded = await recordLogin();
  });

  it("records typing, the checkbox, the select and the click as clean actions", () => {
    const kinds = recorded.actions.map((action) => action.kind);
    expect(kinds).toEqual(["fill", "fill", "check", "select", "click"]);
    const [email, password, , role, submit] = recorded.actions as UiAction[];
    expect(email).toMatchObject({ value: "qa@example.test" });
    expect(email!.target!.candidates[0]).toMatchObject({ kind: "testid", value: '[data-testid="email"]' });
    expect(password).toMatchObject({ secret: true, value: "s3cret!" });
    expect(password!.label).not.toContain("s3cret!");
    expect(role).toMatchObject({ value: "qa", optionLabel: "QA engineer" });
    expect(submit!.target!.candidates.some((candidate) => candidate.kind === "role" && candidate.name === "Sign in")).toBe(true);
    // The page change caused by the click is not a separate "open URL".
    expect(kinds).not.toContain("navigate");
  });

  it("keeps the typed password encrypted, and never shows it", () => {
    const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions: recorded.actions }, null, encrypt);
    const password = (sealed.actions as UiAction[])[1]!;
    expect(password.value).toBeUndefined();
    expect(decryptSecret(password.valueEnc!, KEY)).toBe("s3cret!");
    expect(((publicUiConfig(sealed).actions as UiAction[])[1] as UiAction & { valueEnc?: string }).valueEnc).toBeUndefined();
    expect((publicUiConfig(sealed).actions as UiAction[])[1]!.value).toBe(SECRET_PLACEHOLDER);
    // Saving the step again without retyping keeps the stored secret.
    const resaved = sealUiConfig(publicUiConfig(sealed), sealed, encrypt);
    expect((resaved.actions as UiAction[])[1]!.valueEnc).toBe(password.valueEnc);
  });

  it("replays the flow headless and leaves the token for later steps", async () => {
    const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions: recorded.actions }, null, encrypt);
    const ordersCall: OrchestrationStep = {
      id: "orders",
      name: "List orders",
      type: "HTTP_REQUEST",
      enabled: true,
      orderIndex: 1,
      config: {
        method: "GET",
        url: `${base}/api/orders`,
        headers: { Authorization: "Bearer old-token-000" },
        bindings: [
          {
            target: { location: "header", field: "Authorization", key: "Authorization" },
            source: { stepId: "ui-0", stepName: "Sign in", orderIndex: 0, path: "response.body.localStorage.auth.token" },
            origin: "manual",
          },
        ],
      },
    };
    apiCalls.length = 0;
    const { results } = await run([uiStep(sealed), ordersCall]);
    expect(results[0]).toMatchObject({ status: "PASSED" });
    const output = results[0]!.output as { url: string; actions: UiActionResult[]; screenshot?: string; body: { localStorage: { auth: { token: string } } } };
    expect(output.url).toBe(`${base}/dashboard`);
    expect(output.actions.every((action) => action.status === "PASSED")).toBe(true);
    expect(output.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(apiCalls.find((call) => call.path === "/api/login")).toBeDefined();
    // The UI step's localStorage fed the API call.
    expect(results[1]).toMatchObject({ status: "PASSED" });
    expect(apiCalls.find((call) => call.path === "/api/orders")?.auth).toBe("Bearer tok-ui-123456789");
  });

  it("finds elements again after a redesign and remembers how", async () => {
    variant = 2; // test ids gone, password field id changed, button text changed
    try {
      const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions: recorded.actions }, null, encrypt);
      const learned: Array<{ stepId: string; learned: unknown }> = [];
      const { results } = await run([uiStep({ ...sealed, actionTimeoutMs: 6000 })], learned);
      expect(results[0]).toMatchObject({ status: "PASSED" });
      const actions = (results[0]!.output as { actions: UiActionResult[] }).actions;
      expect(actions[0]).toMatchObject({ healed: true }); // email: by id instead of test id
      expect(actions[4]).toMatchObject({ healed: true }); // button: by similarity or another locator
      expect(learned[0]?.stepId).toBe("ui-0");
    } finally {
      variant = 1;
    }
  });

  it("fails with the page's own error message when the form is rejected", async () => {
    const actions = (recorded.actions as UiAction[]).map((action) => (action.secret ? { ...action, value: "wrong" } : action));
    const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions }, null, encrypt);
    const { results } = await run([uiStep(sealed)]);
    expect(results[0]).toMatchObject({ status: "FAILED", error: "The page shows an error: Wrong email or password" });
  });

  it("stops at an element that is gone, and reports which action and why", async () => {
    const actions = [...(recorded.actions as UiAction[])];
    actions.splice(1, 0, {
      id: "ghost",
      kind: "click",
      target: { candidates: [{ kind: "css", value: "#does-not-exist" }], fingerprint: { tag: "button", text: "Nothing like this" } },
      label: "Click «Ghost»",
    });
    const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions, actionTimeoutMs: 1500 }, null, encrypt);
    const { results } = await run([uiStep(sealed)]);
    expect(results[0]!.status).toBe("FAILED");
    expect(results[0]!.error).toMatch(/^Click «Ghost»: Element not found/);
    const statuses = (results[0]!.output as { actions: UiActionResult[] }).actions.map((action) => action.status);
    expect(statuses).toEqual(["PASSED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED"]);
  });

  it("an optional action may fail without failing the step", async () => {
    const actions: UiAction[] = [
      { id: "maybe", kind: "click", optional: true, target: { candidates: [{ kind: "css", value: "#cookie-banner-ok" }], fingerprint: { tag: "button" } } },
      ...(recorded.actions as UiAction[]),
    ];
    const sealed = sealUiConfig({ startUrl: recorded.startUrl, actions, actionTimeoutMs: 1500 }, null, encrypt);
    const { results } = await run([uiStep(sealed)]);
    expect(results[0]!.status).toBe("PASSED");
  });
});
