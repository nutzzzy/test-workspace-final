import { AssertionExecutor } from "../executors/assertion.executor";
import { HttpRequestExecutor } from "../executors/http-request.executor";
import { orchestrateSteps, type OrchestrationOptions } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext, type OrchestrationStep, type OrchestrationStepResult } from "../types";
import { applyBindings, resolveSource, verifyBindings, type StepBinding } from "./bindings";
import type { FlowHttpStep } from "./dependency-analyzer";
import { bindingFromSuggestion, reviewMappings, suggestDependencies, type ReviewStep } from "./mapping-review";
import { parseCurl, splitCurlCommands } from "./parse-curl";
import { inferRequestDependencies, templateRequest } from "./request-dependencies";
import { ValueRegistry } from "./value-registry";

/**
 * The redesigned scenario builder end to end: paste several cURLs, review
 * detected dependencies, save them as hidden mappings, run, and keep runs
 * isolated. Every API here is a local mock; nothing leaves the process.
 */

const BASE = "https://93.184.216.34";

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(route: (call: Call) => { status: number; body?: unknown } | null) {
  const calls: Call[] = [];
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    try {
      body = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const call = { url: new URL(String(input)), method: String(init?.method ?? "GET"), headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const hit = route(call) ?? { status: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

function registry() {
  const reg = new StepExecutorRegistry();
  reg.register(new HttpRequestExecutor());
  reg.register(new AssertionExecutor());
  return reg;
}

async function run(steps: OrchestrationStep[], options: Partial<OrchestrationOptions> = {}, context = new ExecutionContext()) {
  const results: OrchestrationStepResult[] = [];
  const outcome = await orchestrateSteps(steps, registry(), context, {
    stopOnFailure: false,
    ...options,
    onStepComplete: (result) => {
      results.push(result);
    },
  });
  return { outcome, results };
}

const auth = (header: string) => (call: Call) => {
  const key = Object.keys(call.headers).find((name) => name.toLowerCase() === "authorization");
  return key ? call.headers[key] === header : false;
};

/** The four requests of the brief, copied from a browser with stale literal values. */
const FOUR_CURLS = `
curl -X POST "${BASE}/auth/login" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"test","password":"test"}'

curl -X GET "${BASE}/users/123" \\
  -H "Authorization: Bearer stale-token-from-browser"

curl "${BASE}/users/123/account" -H "Authorization: Bearer stale-token-from-browser"

curl -X POST "${BASE}/accounts/555/deposits" \\
  -H "Authorization: Bearer stale-token-from-browser" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":10}'
`;

function importSteps(text: string): FlowHttpStep[] {
  return splitCurlCommands(text).map((command, index) => {
    const parsed = parseCurl(command);
    if (!parsed.ok) throw new Error(parsed.code);
    return { id: `s${index + 1}`, name: `Request ${index + 1}`, orderIndex: index, type: "HTTP_REQUEST", config: { ...parsed.config } };
  });
}

const toOrchestration = (steps: FlowHttpStep[]): OrchestrationStep[] =>
  steps.map((step) => ({ id: step.id, name: step.name, type: "HTTP_REQUEST", enabled: true, orderIndex: step.orderIndex, config: step.config }));

afterEach(() => jest.restoreAllMocks());

describe("cURL import", () => {
  it("imports four commands separated by blank lines, keeping methods, headers, query and bodies", () => {
    const steps = importSteps(FOUR_CURLS);
    expect(steps.map((step) => `${String(step.config.method)} ${String(step.config.url)}`)).toEqual([
      `POST ${BASE}/auth/login`,
      `GET ${BASE}/users/123`,
      `GET ${BASE}/users/123/account`,
      `POST ${BASE}/accounts/555/deposits`,
    ]);
    expect(steps[0]!.config.body).toEqual({ username: "test", password: "test" });
    expect(steps[3]!.config.body).toEqual({ amount: 10 });
  });

  it("reports duplicate headers, ignored and unsupported options instead of dropping them silently", () => {
    const result = parseCurl(
      `curl -k -L --proxy http://p:1 --frobnicate 'https://a.test/x?q=1' https://b.test -H 'X-A: 1' -H 'x-a: 2' --compressed`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.headers).toEqual({ "x-a": "2" });
    expect(result.config.query).toEqual({ q: "1" });
    expect(result.warnings.map((item) => `${item.code}:${item.detail}`)).toEqual(
      expect.arrayContaining([
        "ignored_option:-k",
        "ignored_option:-L",
        "ignored_option:--proxy",
        "unsupported_option:--frobnicate",
        "duplicate_header:x-a",
        "extra_url:https://b.test",
      ]),
    );
    // Output-only flags are not worth a warning.
    expect(result.warnings.some((item) => item.detail === "--compressed")).toBe(false);
  });

  it("warns when data cannot be sent with the method, and rejects malformed commands with a code", () => {
    const get = parseCurl(`curl -X GET https://a.test -d 'x=1'`);
    expect(get.ok && get.warnings).toEqual([{ code: "body_dropped", detail: "GET" }]);
    expect(parseCurl(`curl 'https://a.test`)).toEqual({ ok: false, code: "unclosed_quote" });
    expect(parseCurl(`curl -H 'A: b'`)).toEqual({ ok: false, code: "missing_url" });
    expect(parseCurl(`curl -d @secrets.json https://a.test`)).toEqual({ ok: false, code: "file_body" });
  });
});

describe("dependency detection without response samples", () => {
  it("links the bearer token to the login call and proposes the user id, never as HIGH", () => {
    const suggestions = inferRequestDependencies(importSteps(FOUR_CURLS));
    const tokens = suggestions.filter((item) => item.reason === "auth_token");
    expect(tokens.map((item) => item.consumerStepId)).toEqual(["s2", "s3", "s4"]);
    expect(tokens.every((item) => item.producerStepId === "s1" && item.confidence === "MEDIUM" && item.evidence === "request")).toBe(true);
    expect(tokens[0]).toMatchObject({ target: { location: "header", field: "Authorization" }, expect: { kind: "token" } });

    const userId = suggestions.find((item) => item.consumerStepId === "s2" && item.target.location === "path");
    expect(userId).toMatchObject({ producerStepId: "s1", reason: "auth_user", confidence: "LOW", expect: { key: "userId" } });
    expect(suggestions.every((item) => item.confidence !== "HIGH")).toBe(true);
  });

  it("prefers the call that returns the entity, and never proposes a step that sends the same value itself", () => {
    const suggestions = inferRequestDependencies(importSteps(FOUR_CURLS));
    const account = suggestions.filter((item) => item.consumerStepId === "s4" && item.target.location === "path");
    expect(account).toEqual([
      expect.objectContaining({ producerStepId: "s3", reason: "returns_entity", confidence: "MEDIUM", expect: { kind: "value", key: "accountId", alt: ["id"] } }),
    ]);
    // Request 3 sends /users/123 itself, so it consumes 123 rather than producing it.
    const user3 = suggestions.filter((item) => item.consumerStepId === "s3" && item.target.location === "path");
    expect(user3.every((item) => item.producerStepId !== "s2")).toBe(true);
  });

  it("does not invent a token source when no earlier call looks like a login", () => {
    const steps = importSteps(`curl ${BASE}/items -H 'Authorization: Bearer abcdefgh12'\ncurl ${BASE}/items/9 -H 'Authorization: Bearer abcdefgh12'`);
    expect(inferRequestDependencies(steps).filter((item) => item.reason === "auth_token")).toEqual([]);
  });

  it("shows several equal candidates as LOW instead of silently choosing one", () => {
    const steps = importSteps(
      [`curl -X POST ${BASE}/orders -d '{"a":1}'`, `curl -X POST ${BASE}/v2/orders -d '{"b":2}'`, `curl ${BASE}/orders/77`].join("\n"),
    );
    const order = inferRequestDependencies(steps).filter((item) => item.consumerStepId === "s3");
    expect(order).toHaveLength(2);
    expect(order.every((item) => item.confidence === "LOW")).toBe(true);
  });

  it("uses response evidence over request inference, and hides fields that already have a saved mapping", () => {
    const steps = importSteps(FOUR_CURLS);
    const samples = [{ stepId: "s1", status: 200, body: { data: { accessToken: "stale-token-from-browser", userId: 123 } } }];
    const suggestions = suggestDependencies(steps, samples);
    const header = suggestions.filter((item) => item.consumerStepId === "s2" && item.target.location === "header");
    expect(header).toEqual([expect.objectContaining({ evidence: "response", confidence: "HIGH", sourcePath: "$.data.accessToken" })]);

    steps[1]!.config.bindings = [bindingFromSuggestion(header[0]!, steps[0]!)];
    const after = suggestDependencies(steps, samples);
    expect(after.some((item) => item.consumerStepId === "s2" && item.target.location === "header")).toBe(false);
  });

  it("offers a field that automatic recovery fixed as the strongest suggestion for that field", () => {
    const steps = importSteps(FOUR_CURLS);
    const recovered = [
      { consumerStepId: "s2", producerStepId: "s1", target: { location: "path" as const, field: "2", key: "userId" }, path: "response.body.data.userId" },
    ];
    const forPath = suggestDependencies(steps, [], {}, recovered).filter((item) => item.consumerStepId === "s2" && item.target.location === "path");
    expect(forPath).toEqual([expect.objectContaining({ reason: "recovered", confidence: "HIGH", evidence: "response", sourcePath: "response.body.data.userId" })]);
    expect(bindingFromSuggestion(forPath[0]!, steps[0]!).source).toMatchObject({ stepId: "s1", path: "response.body.data.userId" });
    // A source that would run after its destination is never proposed.
    expect(suggestDependencies(steps, [], {}, [{ ...recovered[0]!, consumerStepId: "s1", producerStepId: "s2" }]).some((item) => item.reason === "recovered")).toBe(false);
  });

  it("places path segments the way they are sent when the URL starts with {{base_url}}", () => {
    const request = templateRequest({ url: "{{base_url}}/users/123", method: "get" }, { base_url: `${BASE}/api/v1` });
    expect(request).toMatchObject({ method: "GET", url: `${BASE}/api/v1/users/123` });
  });
});

describe("saved mappings at run time", () => {
  const registryWith = (body: unknown, step = { stepId: "s1", stepName: "Login", orderIndex: 0 }) => {
    const reg = new ValueRegistry();
    reg.addResponse(step, { status: 200, headers: {}, body });
    return reg;
  };

  it("resolves an inferred token by key, and refuses to guess between several", () => {
    const one = registryWith({ data: { access_token: "T-1", refresh_token: "R-1", user: { id: 5 } } });
    const found = resolveSource({ stepId: "s1", path: "", expect: { kind: "token", key: "accessToken" } }, one);
    expect(found.ok && found.entry.path).toBe("response.body.data.access_token");

    const two = registryWith({ a: { token: "T-1" }, b: { token: "T-2" } });
    expect(resolveSource({ stepId: "s1", path: "", expect: { kind: "token", key: "accessToken" } }, two)).toEqual({ ok: false, reason: "ambiguous" });
    expect(resolveSource({ stepId: "s9", path: "response.body.a.token" }, two)).toEqual({ ok: false, reason: "source_not_run" });
  });

  it("maps into a URL path, query, header, JSON body and form field, and skips disabled mappings", () => {
    const reg = registryWith({ data: { token: "T-9", userId: 42, flag: true } });
    const source = (path: string) => ({ stepId: "s1", stepName: "Login", orderIndex: 0, path });
    const bindings: StepBinding[] = [
      { target: { location: "path", field: "2" }, source: source("response.body.data.userId") },
      { target: { location: "query", field: "owner" }, source: source("response.body.data.userId") },
      { target: { location: "header", field: "Authorization" }, source: source("response.body.data.token") },
      { target: { location: "body", field: "user.id" }, source: source("response.body.data.userId") },
      { target: { location: "body", field: "user.active" }, source: source("response.body.data.flag") },
      { target: { location: "query", field: "skip" }, source: source("response.body.data.token"), enabled: false },
    ];
    const json = applyBindings(
      { method: "PUT", url: `${BASE}/users/1`, headers: { Authorization: "Bearer old" }, body: { user: { id: "x", active: "no" } } },
      bindings,
      reg,
    );
    expect(json.missing).toEqual([]);
    expect(json.request).toEqual({
      method: "PUT",
      url: `${BASE}/users/42`,
      headers: { Authorization: "Bearer T-9" },
      query: { owner: "42" },
      body: { user: { id: 42, active: true } },
    });

    const form = applyBindings(
      { method: "POST", url: `${BASE}/f`, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "uid=1&note=a" },
      [{ target: { location: "form", field: "uid" }, source: source("response.body.data.userId") }],
      reg,
    );
    expect(form.request.body).toBe("uid=42&note=a");
  });

  it("blocks a step whose mapped value is missing instead of sending stale data", async () => {
    const calls = mockFetch((call) => (call.url.pathname === "/login" ? { status: 500, body: {} } : { status: 200, body: {} }));
    const binding: StepBinding = {
      target: { location: "header", field: "Authorization" },
      source: { stepId: "login", stepName: "Login", orderIndex: 0, path: "response.body.token" },
    };
    const { results, outcome } = await run([
      { id: "login", name: "Login", type: "HTTP_REQUEST", enabled: true, orderIndex: 0, config: { method: "POST", url: `${BASE}/login`, body: { a: 1 } } },
      { id: "me", name: "Me", type: "HTTP_REQUEST", enabled: true, orderIndex: 1, config: { method: "GET", url: `${BASE}/me`, headers: { Authorization: "Bearer stale" }, bindings: [binding] } },
    ]);
    expect(results[1]).toMatchObject({ status: "FAILED", blocked: [{ target: "header.Authorization", reason: "source_not_run" }] });
    expect(results[1]!.error).toMatch(/^Blocked: Step 1 \(Login\) has no successful response in this run/);
    expect(calls.some((call) => call.url.pathname === "/me")).toBe(false);
    expect(outcome.status).toBe("FAILED");
  });

  it("pins an inferred source to the path a successful run matched", () => {
    const binding: StepBinding = {
      target: { location: "header", field: "Authorization" },
      source: { stepId: "s1", path: "", expect: { kind: "token", key: "accessToken" } },
      origin: "accepted",
      evidence: "request",
    };
    const pinned = verifyBindings([binding], [{ target: { location: "header", field: "authorization" }, path: "response.body.data.token" }], "2026-10-04T00:00:00.000Z");
    expect(pinned?.[0]).toMatchObject({ source: { path: "response.body.data.token", expect: { kind: "token" } }, verifiedAt: "2026-10-04T00:00:00.000Z" });
    expect(verifyBindings(pinned!, [])).toBeNull();
  });
});

describe("paste → accept → run", () => {
  function server() {
    let logins = 0;
    return mockFetch((call) => {
      const path = call.url.pathname;
      if (path === "/auth/login") {
        logins += 1;
        return { status: 200, body: { data: { accessToken: `fresh-${logins}`, userId: 123 + logins } } };
      }
      const token = `Bearer fresh-${logins}`;
      if (!auth(token)(call)) return { status: 401, body: { message: "unauthorized" } };
      if (path === `/users/${123 + logins}`) return { status: 200, body: { user: { id: 123 + logins } } };
      if (path === `/users/${123 + logins}/account`) return { status: 200, body: { account: { id: 700 + logins } } };
      if (path === `/accounts/${700 + logins}/deposits`) return { status: 201, body: { ok: true } };
      return null;
    });
  }

  function acceptedFlow() {
    const steps = importSteps(FOUR_CURLS);
    const suggestions = inferRequestDependencies(steps);
    const accept = suggestions.filter((item) => item.confidence === "MEDIUM" || (item.reason === "auth_user" && item.target.location === "path"));
    for (const item of accept) {
      const consumer = steps.find((step) => step.id === item.consumerStepId)!;
      const producer = steps.find((step) => step.id === item.producerStepId)!;
      consumer.config.bindings = [...((consumer.config.bindings as StepBinding[]) ?? []), bindingFromSuggestion(item, producer)];
    }
    // Request 3's user id comes from Request 2's response.
    steps[2]!.config.bindings = [
      ...((steps[2]!.config.bindings as StepBinding[]) ?? []),
      { target: { location: "path", field: "2" }, source: { stepId: "s2", stepName: "Request 2", orderIndex: 1, path: "response.body.user.id" }, origin: "manual" },
    ];
    return steps;
  }

  it("runs four imported requests with values from earlier responses, and saves the verified paths", async () => {
    const calls = server();
    const steps = acceptedFlow();
    const saved = new Map<string, StepBinding[]>();
    const { results, outcome } = await run(toOrchestration(steps), {
      onSaveBindings: async (stepId, bindings) => {
        saved.set(stepId, bindings);
      },
    });
    expect(results.map((item) => item.status)).toEqual(["PASSED", "PASSED", "PASSED", "PASSED"]);
    expect(outcome.status).toBe("PASSED");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /auth/login",
      "GET /users/124",
      "GET /users/124/account",
      "POST /accounts/701/deposits",
    ]);
    expect(saved.get("s2")?.find((item) => item.target.location === "header")).toMatchObject({
      source: { path: "response.body.data.accessToken" },
      verifiedAt: expect.any(String),
    });
    // The consumed sources are reported; the token itself never is.
    expect(JSON.stringify(results)).not.toContain("fresh-1");
  });

  it("isolates runs: a rerun uses its own login, never the previous run's values", async () => {
    const calls = server();
    const steps = toOrchestration(acceptedFlow());
    await run(steps);
    const second = await run(steps);
    expect(second.results.map((item) => item.status)).toEqual(["PASSED", "PASSED", "PASSED", "PASSED"]);
    expect(calls.slice(4).map((call) => call.url.pathname)).toEqual(["/auth/login", "/users/125", "/users/125/account", "/accounts/702/deposits"]);
  });

  it("existing scenarios without mappings still run unchanged", async () => {
    mockFetch((call) => (call.url.pathname === "/health" ? { status: 200, body: { ok: true } } : null));
    const { results } = await run([{ name: "Health", type: "HTTP_REQUEST", enabled: true, orderIndex: 0, config: { method: "GET", url: `${BASE}/health` } }]);
    expect(results[0]!.status).toBe("PASSED");
  });
});

describe("mapping review", () => {
  const step = (id: string, orderIndex: number, config: Record<string, unknown> = {}, enabled = true): ReviewStep => ({
    id,
    name: id,
    orderIndex,
    type: "HTTP_REQUEST",
    enabled,
    config: { method: "GET", url: `${BASE}/users/1`, ...config },
  });
  const bind = (sourceId: string, extra: Partial<StepBinding> = {}, path = "response.body.data.id"): StepBinding => ({
    target: { location: "path", field: "2" },
    source: { stepId: sourceId, path },
    ...extra,
  });

  it("flags every way a saved mapping can break, without changing it", () => {
    const steps = [
      step("a", 0),
      step("b", 1, { bindings: [bind("a", { verifiedAt: "x" }), bind("gone"), bind("c"), bind("a", { enabled: false })] }),
      step("c", 2),
      step("d", 3, { url: `${BASE}/health`, bindings: [bind("a")] }),
      step("e", 4, { bindings: [bind("a", {}, "response.body.data.missing")] }),
      step("f", 5, { bindings: [bind("off")] }),
      step("off", 0.5 as number, {}, false),
      step("g", 6, { bindings: [bind("a", { evidence: "request" })] }),
    ];
    const statuses = reviewMappings(steps, [{ stepId: "a", body: { data: { id: 5 } } }]).map((item) => `${item.stepId}:${item.status}`);
    expect(statuses).toEqual([
      "b:ok",
      "b:source_missing",
      "b:source_after_target",
      "b:disabled",
      "d:target_missing",
      "e:path_missing",
      "f:source_disabled",
      "g:unverified",
    ]);
  });

  it("reports a mapping whose source was reordered after its destination", () => {
    const steps = [step("b", 0, { bindings: [bind("a", { verifiedAt: "x" })] }), step("a", 1)];
    expect(reviewMappings(steps, [])[0]).toMatchObject({ status: "source_after_target", sourceStep: 2 });
  });
});

describe("bounded retries", () => {
  it("never sends more than 10 recovery attempts, even with more candidates", async () => {
    const items = Array.from({ length: 14 }, (_, index) => ({ itemId: 100 + index }));
    const calls = mockFetch((call) => (call.url.pathname === "/items" ? { status: 200, body: { data: items } } : { status: 404, body: {} }));
    const { results } = await run([
      { name: "List", type: "HTTP_REQUEST", enabled: true, orderIndex: 0, config: { method: "GET", url: `${BASE}/items` } },
      { name: "Get", type: "HTTP_REQUEST", enabled: true, orderIndex: 1, config: { method: "GET", url: `${BASE}/item`, query: { itemId: "9999" } } },
    ]);
    const trace = results[1]!.recovery!;
    expect(trace.attempts).toHaveLength(10);
    expect(trace.stoppedBecause).toBe("MAX_ATTEMPTS");
    expect(calls.filter((call) => call.url.pathname === "/item")).toHaveLength(11);
    // Every attempt sent a different request.
    expect(new Set(calls.filter((call) => call.url.pathname === "/item").map((call) => call.url.search)).size).toBe(11);
  });
});
