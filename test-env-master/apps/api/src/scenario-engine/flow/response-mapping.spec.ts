import { parseJsonPath, readJsonPath, validateMappings, formatJsonPath } from "@qa-workbench/shared";
import { AssertionExecutor } from "../executors/assertion.executor";
import { DelayExecutor } from "../executors/delay.executor";
import { ExtractVariableExecutor } from "../executors/extract-variable.executor";
import { HttpRequestExecutor } from "../executors/http-request.executor";
import { SetVariableExecutor } from "../executors/set-variable.executor";
import { orchestrateSteps } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext, type OrchestrationStep } from "../types";
import { validateFlow } from "./flow-validator";
import { parseCurl } from "./parse-curl";
import { interpolateJsonText, variableCatalog } from "./response-mapping";

// A literal public IP: the SSRF check passes without DNS.
const BASE = "https://93.184.216.34";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown; raw: string | undefined };
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

function mockFetch(route: (call: Call) => Reply | null | Promise<Reply | null>) {
  const calls: Call[] = [];
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    try {
      body = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const call: Call = {
      url: new URL(String(input)),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
      raw,
    };
    calls.push(call);
    const hit = (await route(call)) ?? { status: 404, body: { message: "not found" } };
    const headers = new Headers({ "content-type": "application/json", ...(hit.headers ?? {}) });
    const text = hit.raw !== undefined ? hit.raw : hit.status === 204 ? null : JSON.stringify(hit.body ?? {});
    return new Response(text, { status: hit.status, headers });
  });
  return calls;
}

function registry() {
  const reg = new StepExecutorRegistry();
  reg.register(new HttpRequestExecutor());
  reg.register(new AssertionExecutor());
  reg.register(new ExtractVariableExecutor());
  reg.register(new SetVariableExecutor());
  reg.register(new DelayExecutor());
  return reg;
}

let order = 0;
const http = (name: string, config: Record<string, unknown>): OrchestrationStep => ({
  id: `step-${name}`,
  name,
  type: "HTTP_REQUEST",
  enabled: true,
  orderIndex: order++,
  config,
});

const LOGIN_RESPONSE = {
  data: {
    user: { id: 123, name: "Ali", roles: ["qa", "admin"] },
    tokens: { access: TOKEN },
    items: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
  },
};

const loginStep = (extract: unknown[]) =>
  http("Login", { method: "POST", url: `${BASE}/login`, body: { user: "qa" }, extract });

const run = (steps: OrchestrationStep[], context = new ExecutionContext(), stopOnFailure = true) =>
  orchestrateSteps(steps, registry(), context, { stopOnFailure });

beforeEach(() => {
  order = 0;
});
afterEach(() => jest.restoreAllMocks());

describe("JSONPath subset", () => {
  it("parses dot, index, negative index and bracket notation", () => {
    const parsed = parseJsonPath("$.data['odd key'].items[-1].id");
    expect(parsed).toEqual({ ok: true, segments: ["data", "odd key", "items", -1, "id"] });
    expect(parseJsonPath("data.user.id")).toEqual({ ok: true, segments: ["data", "user", "id"] });
    expect(parseJsonPath("$[0].id")).toEqual({ ok: true, segments: [0, "id"] });
  });

  it("rejects wildcards, recursive descent and script/filter expressions", () => {
    for (const path of ["$..id", "$.items[*].id", "$.items[?(@.id==1)]", "$.a.constructor()", ""]) {
      expect(parseJsonPath(path).ok).toBe(false);
    }
  });

  it("reads nested values and reports missing ones (own properties only)", () => {
    const seg = (path: string) => (parseJsonPath(path) as { segments: Array<string | number> }).segments;
    expect(readJsonPath(LOGIN_RESPONSE, seg("$.data.user.id"))).toEqual({ found: true, value: 123 });
    expect(readJsonPath(LOGIN_RESPONSE, seg("$.data.items[-1].id"))).toEqual({ found: true, value: "a3" });
    expect(readJsonPath(LOGIN_RESPONSE, seg("$.data.items[9].id")).found).toBe(false);
    expect(readJsonPath({}, seg("$.constructor")).found).toBe(false);
    expect(formatJsonPath(["data", "odd key", 0])).toBe("$.data['odd key'][0]");
  });

  it("validates names, duplicates, paths and header names", () => {
    const problems = validateMappings([
      { variable: "ok", path: "$.a" },
      { variable: "ok", path: "$.b" },
      { variable: "1bad", path: "$.c" },
      { variable: "p", path: "$..x" },
      { variable: "h", from: "header", path: "bad header" },
      { variable: "s", from: "status", path: "" },
    ]);
    expect(problems.map((p) => p.code)).toEqual(["duplicate_name", "invalid_name", "invalid_path", "invalid_header"]);
  });
});

describe("response extraction", () => {
  it("extracts simple, nested, indexed and multiple values from one response", async () => {
    mockFetch(() => ({ status: 200, body: LOGIN_RESPONSE, headers: { "x-request-id": "req-77" } }));
    const context = new ExecutionContext();
    const result = await run(
      [
        loginStep([
          { variable: "userId", path: "$.data.user.id" },
          { variable: "userName", path: "$.data.user.name" },
          { variable: "accessToken", path: "$.data.tokens.access" },
          { variable: "firstItem", path: "$.data.items[0].id" },
          { variable: "lastItem", path: "$.data.items[-1].id" },
          { variable: "roles", path: "$.data.user.roles" },
          { variable: "requestId", from: "header", path: "X-Request-Id" },
          { variable: "loginStatus", from: "status", path: "" },
        ]),
      ],
      context,
    );
    expect(result.status).toBe("PASSED");
    expect(context.get("userId")).toBe("123");
    expect(context.typedValue("userId")).toBe(123);
    expect(context.get("userName")).toBe("Ali");
    expect(context.get("accessToken")).toBe(TOKEN);
    expect(context.get("firstItem")).toBe("a1");
    expect(context.get("lastItem")).toBe("a3");
    expect(context.typedValue("roles")).toEqual(["qa", "admin"]);
    expect(context.get("requestId")).toBe("req-77");
    expect(context.get("loginStatus")).toBe("200");
    const outcomes = result.stepResults[0]!.extractions!;
    expect(outcomes.every((item) => item.status === "EXTRACTED")).toBe(true);
    expect(context.sourceOf("userId")).toMatchObject({ stepName: "Login", path: "response.body.data.user.id" });
  });

  it("fails the step on a missing path and stores none of its variables", async () => {
    mockFetch(() => ({ status: 200, body: LOGIN_RESPONSE }));
    const context = new ExecutionContext();
    const result = await run(
      [
        loginStep([
          { variable: "userId", path: "$.data.user.id" },
          { variable: "orderId", path: "$.data.order.id" },
        ]),
      ],
      context,
    );
    expect(result.status).toBe("FAILED");
    expect(result.stepResults[0]!.error).toBe(
      "Extraction failed for {{orderId}} (body $.data.order.id): not found in the response",
    );
    expect(context.get("userId")).toBeUndefined();
    expect(result.stepResults[0]!.extractions!.map((item) => item.status)).toEqual(["EXTRACTED", "MISSING"]);
  });

  it("treats null as a failure unless the mapping is optional", async () => {
    mockFetch(() => ({ status: 200, body: { data: { coupon: null, id: 5 } } }));
    const required = await run([http("A", { url: `${BASE}/a`, extract: [{ variable: "coupon", path: "$.data.coupon" }] })]);
    expect(required.stepResults[0]!.error).toBe("Extraction failed for {{coupon}} (body $.data.coupon): the value is null");

    const context = new ExecutionContext();
    const optional = await run(
      [
        http("B", {
          url: `${BASE}/a`,
          extract: [
            { variable: "coupon", path: "$.data.coupon", optional: true },
            { variable: "id", path: "$.data.id" },
          ],
        }),
      ],
      context,
    );
    expect(optional.status).toBe("PASSED");
    expect(context.get("coupon")).toBeUndefined();
    expect(context.get("id")).toBe("5");
    expect(optional.stepResults[0]!.extractions![0]).toMatchObject({ status: "SKIPPED", reason: "the value is null" });
  });

  it("explains empty and non-JSON responses", async () => {
    mockFetch((call) =>
      call.url.pathname === "/empty" ? { status: 200, raw: "" } : { status: 200, raw: "<html>ok</html>", headers: { "content-type": "text/html" } },
    );
    const empty = await run([http("E", { url: `${BASE}/empty`, extract: [{ variable: "x", path: "$.id" }] })]);
    expect(empty.stepResults[0]!.error).toBe("Extraction failed for {{x}} (body $.id): the response body is empty");
    const html = await run([http("H", { url: `${BASE}/html`, extract: [{ variable: "x", path: "$.id" }] })]);
    expect(html.stepResults[0]!.error).toBe("Extraction failed for {{x}} (body $.id): the response body is not JSON");
  });

  it("does not extract from a response that failed its expectation", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? { status: 500, body: { data: { tokens: { access: TOKEN } }, token: "leaked-token" } } : { status: 200, body: {} },
    );
    const context = new ExecutionContext();
    const result = await run(
      [
        loginStep([{ variable: "accessToken", path: "$.data.tokens.access" }]),
        http("Profile", { url: `${BASE}/me`, headers: { Authorization: "Bearer {{accessToken}}" }, continueOnFailure: true }),
      ],
      context,
      false,
    );
    // Without an interactive user the failed request ends as NEEDS_INPUT (existing recovery rule).
    expect(result.stepResults.map((step) => step.status)).toEqual(["NEEDS_INPUT", "FAILED"]);
    expect(context.get("accessToken")).toBeUndefined();
    // The auto-learned token of the failed response was rolled back too.
    expect(context.get("token")).toBeUndefined();
    expect(result.stepResults[1]!.error).toBe(
      "Variable {{accessToken}} was not produced: step 1 (Login) did not provide it",
    );
    // The dependent request was never sent.
    expect(calls.filter((call) => call.url.pathname === "/me")).toHaveLength(0);
  });
});

describe("variable injection", () => {
  it("passes values through URL, query, headers, JSON body and form body", async () => {
    const calls = mockFetch((call) => {
      if (call.url.pathname === "/login") return { status: 200, body: LOGIN_RESPONSE };
      return { status: 200, body: { ok: true } };
    });
    const result = await run([
      loginStep([
        { variable: "userId", path: "$.data.user.id" },
        { variable: "userName", path: "$.data.user.name" },
        { variable: "accessToken", path: "$.data.tokens.access" },
        { variable: "roles", path: "$.data.user.roles" },
      ]),
      http("Update", {
        method: "PUT",
        url: `${BASE}/users/{{userId}}`,
        query: { owner: "{{userName}}" },
        headers: { Authorization: "Bearer {{accessToken}}", "X-User": "{{userId}}" },
        body: { userId: "{{userId}}", name: "{{userName}}", label: "user-{{userId}}", roles: "{{roles}}" },
      }),
      http("Form", {
        method: "POST",
        url: `${BASE}/form`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "user={{userName}}&id={{userId}}",
      }),
    ]);
    expect(result.status).toBe("PASSED");
    const update = calls[1]!;
    expect(update.url.pathname).toBe("/users/123");
    expect(update.url.searchParams.get("owner")).toBe("Ali");
    expect(update.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(update.headers["X-User"]).toBe("123");
    expect(update.body).toEqual({ userId: 123, name: "Ali", label: "user-123", roles: ["qa", "admin"] });
    expect(calls[2]!.raw).toBe("user=Ali&id=123");
  });

  it("keeps raw JSON text bodies valid when values contain quotes", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? { status: 200, body: { data: { name: 'He said "hi"\n', id: 7 } } } : { status: 200, body: {} },
    );
    const result = await run([
      http("Login", {
        url: `${BASE}/login`,
        extract: [
          { variable: "userName", path: "$.data.name" },
          { variable: "userId", path: "$.data.id" },
        ],
      }),
      http("Post", {
        method: "POST",
        url: `${BASE}/notes`,
        headers: { "Content-Type": "application/json" },
        body: '{"id": {{userId}}, "quoted": "{{userId}}", "text": "note by {{userName}}", "who": "{{userName}}"}',
      }),
    ]);
    expect(result.status).toBe("PASSED");
    expect(JSON.parse(calls[1]!.raw!)).toEqual({ id: 7, quoted: 7, text: 'note by He said "hi"\n', who: 'He said "hi"\n' });
  });

  it("encodes response values inside the URL and never re-expands them", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? { status: 200, body: { data: { slug: "../admin?x=1", note: "{{db_password}}" } } } : { status: 200, body: {} },
    );
    const context = new ExecutionContext({ db_password: "hunter2-secret" });
    const result = await run(
      [
        http("Login", {
          url: `${BASE}/login`,
          extract: [
            { variable: "slug", path: "$.data.slug" },
            { variable: "note", path: "$.data.note" },
          ],
        }),
        http("Get", { method: "POST", url: `${BASE}/pages/{{slug}}`, body: { note: "{{note}}" } }),
      ],
      context,
    );
    expect(result.status).toBe("PASSED");
    expect(calls[1]!.url.pathname).toBe("/pages/..%2Fadmin%3Fx%3D1");
    expect(calls[1]!.url.search).toBe("");
    expect(calls[1]!.body).toEqual({ note: "{{db_password}}" });
  });

  it("refuses a value with a line break in a header", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? { status: 200, body: { v: "a\r\nX-Injected: 1" } } : { status: 200, body: {} },
    );
    const result = await run([
      http("Login", { url: `${BASE}/login`, extract: [{ variable: "v", path: "$.v" }] }),
      http("Use", { url: `${BASE}/use`, headers: { "X-Value": "{{v}}" } }),
    ]);
    expect(result.stepResults[1]!.error).toBe("Variable {{v}} contains a line break and cannot be used in a header");
    expect(calls).toHaveLength(1);
  });

  it("transfers variables across four sequential requests", async () => {
    const calls = mockFetch((call) => {
      switch (call.url.pathname) {
        case "/login":
          return { status: 200, body: { token: "tok-1234", user: { id: 11 } } };
        case "/users/11":
          return call.headers.Authorization === "Bearer tok-1234" ? { status: 200, body: { account: { id: "acc-9" } } } : { status: 401 };
        case "/accounts/acc-9":
          return { status: 200, body: { orders: [{ id: 501 }, { id: 502 }] } };
        case "/orders/502":
          return { status: 200, body: { state: "PAID" } };
        default:
          return null;
      }
    });
    const result = await run([
      http("Login", { url: `${BASE}/login`, extract: [{ variable: "accessToken", path: "$.token" }, { variable: "userId", path: "$.user.id" }] }),
      http("User", { url: `${BASE}/users/{{userId}}`, headers: { Authorization: "Bearer {{accessToken}}" }, extract: [{ variable: "accountId", path: "$.account.id" }] }),
      http("Account", { url: `${BASE}/accounts/{{accountId}}`, extract: [{ variable: "orderId", path: "$.orders[-1].id" }] }),
      http("Order", { url: `${BASE}/orders/{{orderId}}`, extract: [{ variable: "orderState", path: "$.state" }] }),
    ]);
    expect(result.status).toBe("PASSED");
    expect(calls.map((call) => call.url.pathname)).toEqual(["/login", "/users/11", "/accounts/acc-9", "/orders/502"]);
  });

  it("works for steps created from cURL, with placeholders kept through parsing", async () => {
    const parsed = parseCurl(
      `curl '${BASE}/users/{{userId}}?view={{userName}}' -X POST -H 'Authorization: Bearer {{accessToken}}' -H 'Content-Type: application/json' -d '{"id": {{userId}}, "name": "{{userName}}"}'`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.url).toBe(`${BASE}/users/{{userId}}`);
    expect(parsed.config.query).toEqual({ view: "{{userName}}" });

    const base = parseCurl(`curl '{{base_url}}/v1/items/{{id}}'`);
    expect(base.ok && base.config.url).toBe("{{base_url}}/v1/items/{{id}}");

    const calls = mockFetch((call) => (call.url.pathname === "/login" ? { status: 200, body: LOGIN_RESPONSE } : { status: 200, body: {} }));
    const result = await run([
      loginStep([
        { variable: "userId", path: "$.data.user.id" },
        { variable: "userName", path: "$.data.user.name" },
        { variable: "accessToken", path: "$.data.tokens.access" },
      ]),
      http("From cURL", { ...parsed.config, originalCurl: "curl ..." }),
    ]);
    expect(result.status).toBe("PASSED");
    expect(calls[1]!.url.pathname).toBe("/users/123");
    expect(calls[1]!.url.searchParams.get("view")).toBe("Ali");
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]!.body).toEqual({ id: 123, name: "Ali" });
  });

  it("still resolves {{x}} stored percent-encoded by older cURL imports", async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    const result = await run([http("Old", { url: `${BASE}/users/%7B%7BuserId%7D%7D` })], new ExecutionContext({ userId: "42" }));
    expect(result.status).toBe("PASSED");
    expect(calls[0]!.url.pathname).toBe("/users/42");
  });
});

describe("unresolved variables", () => {
  it("explains a variable used before the step that produces it, without sending", async () => {
    const calls = mockFetch(() => ({ status: 200, body: { token: "abcd-1234" } }));
    const result = await run([
      http("Profile", { url: `${BASE}/me`, headers: { "X-Session": "{{sessionKey}}" } }),
      http("Login", { url: `${BASE}/login`, extract: [{ variable: "sessionKey", path: "$.token" }] }),
    ]);
    expect(result.stepResults[0]!.error).toBe("Variable {{sessionKey}} is used before step 2 (Login) produces it");
    expect(calls).toHaveLength(0);
  });

  it("keeps the plain message for a variable nobody defines", async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    const result = await run([http("A", { url: `${BASE}/a/{{nothing}}` })]);
    expect(result.stepResults[0]!.error).toBe("Unresolved variable: {{nothing}}");
  });

  it("reports a mapping whose path is invalid at run time", async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    const result = await run([http("A", { url: `${BASE}/a`, extract: [{ variable: "x", path: "$..id" }] })]);
    expect(result.stepResults[0]!.status).toBe("FAILED");
    expect(result.stepResults[0]!.error).toMatch(/^Invalid response mapping \{\{x\}\}: invalid_path/);
  });
});

describe("isolation, rerun, masking and compatibility", () => {
  it("gives every run its own variables, also when runs overlap", async () => {
    let issued = 0;
    const calls = mockFetch(async (call) => {
      if (call.url.pathname === "/login") {
        issued += 1;
        const token = `token-run-${(call.body as { run: number }).run}`;
        await new Promise((resolve) => setTimeout(resolve, issued === 1 ? 30 : 0));
        return { status: 200, body: { token } };
      }
      return { status: 200, body: { auth: call.headers.Authorization } };
    });
    const scenario = (runNo: number) => [
      { ...loginStep([{ variable: "accessToken", path: "$.token" }]), config: { method: "POST", url: `${BASE}/login`, body: { run: runNo }, extract: [{ variable: "accessToken", path: "$.token" }] } },
      http(`Me ${runNo}`, { url: `${BASE}/me?run=${runNo}`, headers: { Authorization: "Bearer {{accessToken}}" } }),
    ];
    const [first, second] = await Promise.all([run(scenario(1)), run(scenario(2))]);
    expect(first.status).toBe("PASSED");
    expect(second.status).toBe("PASSED");
    const me = (runNo: number) => calls.find((call) => call.url.pathname === "/me" && call.url.searchParams.get("run") === String(runNo))!;
    expect(me(1).headers.Authorization).toBe("Bearer token-run-1");
    expect(me(2).headers.Authorization).toBe("Bearer token-run-2");
  });

  it("starts a rerun from a fresh context: earlier values are not reused", async () => {
    let loginOk = true;
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? (loginOk ? { status: 200, body: { sid: "sid-first" } } : { status: 503, body: {} }) : { status: 200, body: {} },
    );
    const steps = () => {
      order = 0;
      return [
        http("Login", { url: `${BASE}/login`, extract: [{ variable: "sid", path: "$.sid" }] }),
        http("Use", { url: `${BASE}/use`, headers: { "X-Sid": "{{sid}}" }, continueOnFailure: true }),
      ];
    };
    const firstRun = await run(steps(), new ExecutionContext(), false);
    expect(firstRun.status).toBe("PASSED");
    loginOk = false;
    // The runner builds a new ExecutionContext per run (ScenarioRunner.prepareRun).
    const rerun = await run(steps(), new ExecutionContext(), false);
    expect(rerun.stepResults[1]!.error).toBe("Variable {{sid}} was not produced: step 1 (Login) did not provide it");
    expect(calls.filter((call) => call.url.pathname === "/use")).toHaveLength(1);
  });

  it("masks mapped secrets in outputs, sent requests, extracted values and variables", async () => {
    mockFetch((call) => (call.url.pathname === "/login" ? { status: 200, body: { data: { tokens: { access: TOKEN }, ref: "opaque-ref-9876" } } } : { status: 200, body: {} }));
    const context = new ExecutionContext();
    const result = await run(
      [
        http("Login", {
          url: `${BASE}/login`,
          extract: [
            { variable: "accessToken", path: "$.data.tokens.access" },
            { variable: "ref", path: "$.data.ref", secret: true },
          ],
        }),
        http("Use", { url: `${BASE}/use`, headers: { Authorization: "Bearer {{accessToken}}", "X-Ref": "{{ref}}" } }),
      ],
      context,
    );
    expect(result.status).toBe("PASSED");
    const everything = JSON.stringify([result.stepResults, context.redact(context.entries())]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("opaque-ref-9876");
    expect(result.stepResults[0]!.extractions!.find((item) => item.variable === "ref")).toMatchObject({ secret: true });
  });

  it("runs a scenario without mappings exactly as before (auto-binding included)", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/login" ? { status: 200, body: { token: "auto-token-1", orderId: 77 } } : { status: 200, body: {} },
    );
    const result = await run([
      http("Login", { url: `${BASE}/login` }),
      http("Order", { url: `${BASE}/orders/{{orderId}}` }),
    ]);
    expect(result.status).toBe("PASSED");
    expect(result.stepResults[0]!.extractions).toBeUndefined();
    expect(calls[1]!.url.pathname).toBe("/orders/77");
    expect(calls[1]!.headers.Authorization).toBe("Bearer auto-token-1");
  });

  it("stops on cancellation without extracting", async () => {
    const context = new ExecutionContext();
    mockFetch(async () => {
      context.cancel();
      return { status: 200, body: { token: "x-1234" } };
    });
    const result = await run([http("Login", { url: `${BASE}/login`, extract: [{ variable: "accessToken", path: "$.token" }] })], context);
    expect(result.status).toBe("CANCELLED");
    expect(context.get("accessToken")).toBeUndefined();
  });

  it("keeps delays, assertions and SET_VARIABLE working alongside mappings", async () => {
    mockFetch((call) => (call.url.pathname === "/login" ? { status: 200, body: { id: 3 } } : { status: 200, body: { echo: true } }));
    const result = await run([
      http("Login", { url: `${BASE}/login`, extract: [{ variable: "userId", path: "$.id" }] }),
      { id: "assert", name: "Status", type: "ASSERTION", enabled: true, orderIndex: order++, config: { kind: "status_code", expected: 200 } },
      { id: "set", name: "Set", type: "SET_VARIABLE", enabled: true, orderIndex: order++, config: { variable: "label", value: "user-{{userId}}" } },
      { id: "delay", name: "Wait", type: "DELAY", enabled: true, orderIndex: order++, config: { ms: 1 } },
      http("Use", { url: `${BASE}/labels/{{label}}` }),
    ]);
    expect(result.stepResults.map((step) => step.status)).toEqual(["PASSED", "PASSED", "PASSED", "PASSED", "PASSED"]);
  });
});

describe("design-time catalog and validation", () => {
  const steps = [
    { id: "1", name: "Login", type: "HTTP_REQUEST", orderIndex: 0, enabled: true, config: { url: `${BASE}/login`, extract: [{ variable: "accessToken", path: "$.token" }] } },
    { id: "2", name: "Me", type: "HTTP_REQUEST", orderIndex: 1, enabled: true, config: { url: `${BASE}/me/{{userId}}`, headers: { Authorization: "Bearer {{accessToken}}" }, extract: [{ variable: "userId", path: "$.id" }] } },
  ];

  it("lists producers with their step and marks secrets", () => {
    expect(variableCatalog(steps)).toEqual([
      expect.objectContaining({ name: "accessToken", stepId: "1", orderIndex: 0, kind: "mapping", secret: true }),
      expect.objectContaining({ name: "userId", stepId: "2", orderIndex: 1, kind: "mapping", path: "$.id" }),
    ]);
  });

  it("flags a step that uses its own (later) output, and env name conflicts", () => {
    const issues = validateFlow(steps, { environmentKeys: ["accessToken"] });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "2", code: "used_before_source", detail: "userId" }),
        expect.objectContaining({ stepId: "1", code: "variable_conflict", detail: "accessToken" }),
      ]),
    );
    expect(issues.some((issue) => issue.detail === "accessToken" && issue.code === "used_before_source")).toBe(false);
  });

  it("interpolates JSON text with typed values and reports missing names", () => {
    const values: Record<string, unknown> = { n: 5, s: 'a"b', o: { k: [1] } };
    const out = interpolateJsonText('{"n": {{n}}, "s": "{{s}}", "t": "x{{s}}", "o": {{o}}, "m": "{{missing}}"}', (name) =>
      name in values ? { value: values[name] } : undefined,
    );
    expect(out.missing).toEqual(["missing"]);
    expect(JSON.parse(out.text)).toEqual({ n: 5, s: 'a"b', t: 'xa"b', o: { k: [1] }, m: "" });
  });
});
