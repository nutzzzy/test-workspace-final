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
import { seedFromContext } from "./browser-session";

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
      // Sign-in by API (what a cURL step does): a token in the body and a session cookie.
      if (url.pathname === "/api/session-login") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=sess-777; Path=/; HttpOnly" });
        return res.end(JSON.stringify({ data: { accessToken: "tok-api-555555555" } }));
      }
      if (url.pathname === "/api/profile") {
        return req.headers.authorization === "Bearer tok-api-555555555" ? json(200, { name: "QA" }) : json(401, { message: "invalid token" });
      }
      // A server-rendered page behind the session cookie.
      if (url.pathname === "/account") {
        return html(/sid=sess-777/.test(req.headers.cookie ?? "") ? "<h1>Hello QA</h1>" : "<h1>Please sign in</h1>");
      }
      // A single-page app that keeps its token in localStorage.
      if (url.pathname === "/spa") {
        return html(`<p id="p">loading</p><script>
          const token = localStorage.getItem("auth_token");
          fetch("/api/profile", { headers: token ? { Authorization: "Bearer " + token } : {} })
            .then((r) => r.json()).then((d) => (document.getElementById("p").textContent = d.name ? "Profile: " + d.name : "Signed out"));
        </script>`);
      }
      // A page whose API calls carry no credential of their own (the browser adds it).
      if (url.pathname === "/spa2") {
        return html(`<p id="p">loading</p><script>
          fetch("/api/profile").then((r) => r.json()).then((d) => (document.getElementById("p").textContent = d.name ? "Profile: " + d.name : "Signed out"));
        </script>`);
      }
      // An app that reads the token from a common key and then keeps it in its own JSON entry.
      if (url.pathname === "/spa3") {
        return html(`<p id="p">loading</p><script>
          const token = localStorage.getItem("token");
          if (token) localStorage.setItem("app.session", JSON.stringify({ user: { name: "QA" }, auth: { jwt: token } }));
          const session = JSON.parse(localStorage.getItem("app.session") || "{}");
          fetch("/api/profile", { headers: session.auth ? { Authorization: "Bearer " + session.auth.jwt } : {} })
            .then((r) => r.json()).then((d) => (document.getElementById("p").textContent = d.name ? "Profile: " + d.name : "Signed out"));
        </script>`);
      }
      // Two users: each login gives its own token and session cookie.
      if (url.pathname === "/api/login-as") {
        const user = url.searchParams.get("u") ?? "0";
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `uid=user-${user}; Path=/` });
        return res.end(JSON.stringify({ accessToken: `tok-user-${user}-000000` }));
      }
      if (url.pathname === "/whoami") {
        const cookie = /uid=(user-\d)/.exec(req.headers.cookie ?? "")?.[1] ?? "nobody";
        return html(`<p id="c">cookie:${cookie}</p><p id="t"></p><script>
          document.getElementById("t").textContent = "token:" + (localStorage.getItem("token") || "none");
        </script>`);
      }
      // One-time code that submits by itself on its last digit (a client-side route change).
      if (url.pathname === "/otp") {
        return html(`<label>Digit 1 <input name="d1"></label><label>Digit 2 <input name="d2"></label><script>
          document.querySelector('[name=d2]').addEventListener("input", () => {
            history.pushState({}, "", "/home");
            document.body.innerHTML = "<h1>Signed in home</h1>";
          });
        </script>`);
      }
      // A click that leads, a moment later, to a cart with a new code every time.
      if (url.pathname === "/shop") {
        return html(`<p>Pizza place (4,712+)</p><button onclick="setTimeout(() => location.href = '/basket/' + Math.random().toString(36).slice(2, 5) + '7' + Math.floor(Math.random() * 90 + 10) + '/?code=x' + Date.now(), 1200)">Pizza place (4,712+)</button>`);
      }
      if (/^\/basket\/[a-z0-9]+\/$/.test(url.pathname)) {
        return html(`<h1>Basket ${url.pathname.split("/")[2]}</h1>`);
      }
      // Payment options: a row selects on click, except its wide "details" button in the middle.
      if (url.pathname === "/pay") {
        const preselected = url.searchParams.get("pre") === "1";
        return html(`<div id="opts">
          <div data-testid="wallet" data-is-selected="${preselected}" style="display:flex;width:600px;height:60px;border:1px solid">
            <span style="width:40px">W</span><button id="details" style="width:520px" onclick="event.stopPropagation()">Wallet details 1,000</button>
          </div>
          <div data-testid="bank" data-is-selected="${!preselected}" style="height:60px">Bank</div></div>
          <button id="pay">Pay</button><p id="r"></p><script>
          for (const row of document.querySelectorAll("[data-testid]")) row.addEventListener("click", () => {
            for (const other of document.querySelectorAll("[data-testid]")) other.dataset.isSelected = String(other === row);
          });
          document.getElementById("pay").onclick = () => (document.getElementById("r").textContent =
            "Paid with " + document.querySelector('[data-is-selected="true"]').dataset.testid);
        </script>`);
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

describeUi("UI steps open signed in with what earlier (cURL) steps obtained", () => {
  const apiLogin: OrchestrationStep = {
    id: "login",
    name: "POST /api/session-login",
    type: "HTTP_REQUEST",
    enabled: true,
    orderIndex: 0,
    config: { method: "POST", url: "", body: { user: "qa" } },
  };
  const profile: OrchestrationStep = {
    id: "profile",
    name: "GET /api/profile",
    type: "HTTP_REQUEST",
    enabled: true,
    orderIndex: 1,
    config: {
      method: "GET",
      url: "",
      headers: { Authorization: "Bearer old" },
      bindings: [
        {
          target: { location: "header", field: "Authorization", key: "Authorization" },
          source: { stepId: "login", stepName: "login", orderIndex: 0, path: "response.body.data.accessToken" },
          origin: "manual",
        },
      ],
    },
  };
  const check = (id: string, orderIndex: number, path: string, text: string, extra: Record<string, unknown> = {}): OrchestrationStep => ({
    id,
    name: `UI ${path}`,
    type: "UI_FLOW",
    enabled: true,
    orderIndex,
    config: sealUiConfig({ startUrl: `${base}${path}`, actions: [{ id: "a", kind: "assertText", value: text }], actionTimeoutMs: 5000, newSession: true, ...extra }, null, encrypt),
  });
  const withBase = () => [
    { ...apiLogin, config: { ...apiLogin.config, url: `${base}/api/session-login` } },
    { ...profile, config: { ...profile.config, url: `${base}/api/profile` } },
  ];

  it("a server page behind the session cookie the API login received", async () => {
    const { results } = await run([...withBase(), check("ui", 2, "/account", "Hello QA")]);
    expect(results.map((item) => item.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
    expect((results[2]!.output as { signedIn: { cookies: string[] } }).signedIn.cookies[0]).toMatch(/^sid \(127\.0\.0\.1:\d+\)$/);
  });

  it("a single-page app that reads the token from localStorage (the latest token, under the app's key)", async () => {
    const { results } = await run([
      ...withBase(),
      check("ui", 2, "/spa", "Profile: QA", { session: { fromEarlierSteps: false, storage: [{ area: "localStorage", key: "auth_token" }] } }),
    ]);
    expect(results[2]).toMatchObject({ status: "PASSED" });
    expect((results[2]!.output as { signedIn: { storage: string[] } }).signedIn.storage).toEqual(["localStorage.auth_token"]);
  });

  it("with no key named, the token goes where apps usually look (here auth_token)", async () => {
    const { results } = await run([...withBase(), check("ui", 2, "/spa", "Profile: QA")]);
    expect(results[2]).toMatchObject({ status: "PASSED" });
    expect((results[2]!.output as { signedIn: { guessed: string[] } }).signedIn.guessed).toContain("localStorage.auth_token");
  });

  it("learns where the app keeps the token, so it is not guessed next time", async () => {
    const learned: Array<{ stepId: string; learned: unknown }> = [];
    const results: OrchestrationStepResult[] = [];
    let storage: unknown;
    await orchestrateSteps([...withBase(), check("ui", 2, "/spa3", "Profile: QA")], registry(), new ExecutionContext(), {
      stopOnFailure: true,
      onStepComplete: (result) => void results.push(result),
      onLearnUi: async (stepId, items, place) => {
        learned.push({ stepId, learned: items });
        storage = place;
      },
    });
    expect(results[2]).toMatchObject({ status: "PASSED" });
    expect(storage).toEqual({ area: "localStorage", key: "app.session", jsonTemplate: '{"user":{"name":"QA"},"auth":{"jwt":"{{value}}"}}' });
    // Next run with the learned entry: exactly the app's own key, nothing guessed.
    const next = check("ui", 2, "/spa3", "Profile: QA", { session: { storage: [storage] } });
    const again = await run([...withBase(), next]);
    expect(again.results[2]).toMatchObject({ status: "PASSED" });
    const signedIn = (again.results[2]!.output as { signedIn: { storage: string[]; guessed?: string[] } }).signedIn;
    expect(signedIn.storage).toEqual(["localStorage.app.session"]);
    expect(signedIn.guessed).toBeUndefined();
  });

  it("the page's API calls get the Authorization header the earlier request sent", async () => {
    const { results } = await run([...withBase(), check("ui", 2, "/spa2", "Profile: QA")]);
    expect(results[2]).toMatchObject({ status: "PASSED" });
    expect((results[2]!.output as { signedIn: { headers: string[] } }).signedIn.headers[0]).toMatch(/^Authorization → 127\.0\.0\.1:\d+$/);
  });

  it("without the earlier steps' session the same page is signed out", async () => {
    const { results } = await run([check("ui", 0, "/account", "Hello QA", { actionTimeoutMs: 1500 })]);
    expect(results[0]!.status).toBe("FAILED");
  });

  it("the recording browser opens signed in too", async () => {
    const context = new ExecutionContext();
    await orchestrateSteps(withBase(), registry(), context, { stopOnFailure: true, keepResources: true });
    const recorder = new UiRecorderService();
    const started = await recorder.start(
      { scenarioId: "s", startUrl: `${base}/account` },
      { headless: true, seed: seedFromContext(context, `${base}/account`, undefined) },
    );
    await started.page.waitForLoadState("domcontentloaded");
    expect(await started.page.textContent("h1")).toBe("Hello QA");
    await recorder.discard(started.id);
    await context.dispose();
  });
});

describeUi("choosing which earlier steps sign the UI step in", () => {
  const loginAs = (user: number, orderIndex: number): OrchestrationStep => ({
    id: `login-${user}`,
    name: `login as ${user}`,
    type: "HTTP_REQUEST",
    enabled: true,
    orderIndex,
    config: { method: "POST", url: `${base}/api/login-as?u=${user}`, body: {} },
  });
  const whoami = (session?: Record<string, unknown>): OrchestrationStep => ({
    id: "ui",
    name: "who am I",
    type: "UI_FLOW",
    enabled: true,
    orderIndex: 2,
    config: sealUiConfig(
      { startUrl: `${base}/whoami`, actions: [{ id: "a", kind: "waitForText", value: "token:" }], actionTimeoutMs: 5000, newSession: true, ...(session ? { session } : {}) },
      null,
      encrypt,
    ),
  });
  const shown = (result: OrchestrationStepResult) => (result.output as { body: { localStorage: Record<string, string> } }).body;

  it("by default the latest step's user (all earlier steps, newest wins)", async () => {
    const { results } = await run([loginAs(1, 0), loginAs(2, 1), whoami()]);
    expect(results[2]).toMatchObject({ status: "PASSED" });
    expect(shown(results[2]!).localStorage.token).toBe("tok-user-2-000000");
    expect((results[2]!.output as { signedIn: { cookies: string[] } }).signedIn.cookies).toEqual([expect.stringMatching(/^uid /)]);
  });

  it("only the chosen step's cookies and token", async () => {
    const { results, context } = await run([loginAs(1, 0), loginAs(2, 1), whoami({ fromSteps: ["login-1"] })]);
    expect(results[2]).toMatchObject({ status: "PASSED" });
    // The page saw user 1: its cookie and its token, not user 2's.
    const page = context.registry.entries().filter((entry) => entry.stepId === "ui");
    expect(page.find((entry) => entry.path === "response.cookies.uid")?.text).toBe("user-1");
    expect(page.find((entry) => entry.path === "response.body.localStorage.token")?.text).toBe("tok-user-1-000000");
  });

  it("the other one when that one is chosen", async () => {
    const { context } = await run([loginAs(1, 0), loginAs(2, 1), whoami({ fromSteps: ["login-2"] })]);
    const page = context.registry.entries().filter((entry) => entry.stepId === "ui");
    expect(page.find((entry) => entry.path === "response.cookies.uid")?.text).toBe("user-2");
    expect(page.find((entry) => entry.path === "response.body.localStorage.token")?.text).toBe("tok-user-2-000000");
  });
});

describeUi("replaying what changes between runs", () => {
  const ui = (startUrl: string, actions: UiAction[]): OrchestrationStep => ({
    id: "ui",
    name: "ui",
    type: "UI_FLOW",
    enabled: true,
    orderIndex: 0,
    config: sealUiConfig({ startUrl, actions, actionTimeoutMs: 6000 }, null, encrypt),
  });
  const field = (name: string) => ({ candidates: [{ kind: "css" as const, value: `input[name="${name}"]` }], fingerprint: { tag: "input" } });

  it("types the last digit before the page change it causes, even when recorded after it", async () => {
    const { results } = await run([
      ui(`${base}/otp`, [
        { id: "1", kind: "fill", value: "1", target: field("d1") },
        { id: "nav", kind: "navigate", url: `${base}/home` },
        { id: "2", kind: "fill", value: "2", target: field("d2") },
        { id: "check", kind: "assertText", value: "Signed in home" },
      ]),
    ]);
    expect(results[0]).toMatchObject({ status: "PASSED" });
  });

  it("follows the app to a page whose code changes every run instead of opening the old one", async () => {
    const { results } = await run([
      ui(`${base}/shop`, [
        {
          id: "buy",
          kind: "click",
          target: { candidates: [{ kind: "role", value: "button", name: "Pizza place (4,600+)" }], fingerprint: { tag: "button" } },
        },
        { id: "nav", kind: "navigate", url: `${base}/basket/ab73x9/?code=x1700000000000` },
        { id: "check", kind: "assertText", value: "Basket" },
      ]),
    ]);
    expect(results[0]).toMatchObject({ status: "PASSED" });
    const output = results[0]!.output as { url: string; actions: UiActionResult[] };
    // A fresh cart (not the recorded one), and the button found although its count changed.
    expect(output.url).not.toContain("ab73x9");
    expect(output.actions[0]!.how).toContain("numbers may differ");
  });
});

describeUi("choosing an option", () => {
  const steps = (query: string): OrchestrationStep[] => [
    {
      id: "ui",
      name: "pay",
      type: "UI_FLOW",
      enabled: true,
      orderIndex: 0,
      config: sealUiConfig(
        {
          startUrl: `${base}/pay${query}`,
          actionTimeoutMs: 4000,
          actions: [
            { id: "w", kind: "click", target: { candidates: [{ kind: "testid", value: '[data-testid="wallet"]' }], fingerprint: { tag: "div" } } },
            { id: "p", kind: "click", target: { candidates: [{ kind: "css", value: "#pay" }], fingerprint: { tag: "button" } } },
            { id: "c", kind: "assertText", value: "Paid with wallet" },
          ],
        },
        null,
        encrypt,
      ),
    },
  ];

  it("makes sure the option is selected, even when the click lands on its inner button", async () => {
    const { results } = await run(steps(""));
    expect(results[0]).toMatchObject({ status: "PASSED" });
  });

  it("does not click an option that is already selected (which could change it)", async () => {
    const { results } = await run(steps("?pre=1"));
    expect(results[0]).toMatchObject({ status: "PASSED" });
    expect((results[0]!.output as { actions: UiActionResult[] }).actions[0]!.how).toContain("already selected");
  });
});
