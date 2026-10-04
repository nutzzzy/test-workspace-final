import { AssertionExecutor } from "../executors/assertion.executor";
import { ExtractVariableExecutor } from "../executors/extract-variable.executor";
import { HttpRequestExecutor } from "../executors/http-request.executor";
import { orchestrateSteps, type OrchestrationOptions, type PendingInput } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext, type OrchestrationStep, type OrchestrationStepResult } from "../types";
import { analyzeDependencies } from "./dependency-analyzer";
import { bindingFromSuggestion } from "./mapping-review";
import type { StepBinding } from "./bindings";
import type { ManualResolution } from "./manual-recovery";
import * as recovery from "./recovery";
import { planRecoveryCandidates, requestFingerprint } from "./recovery";
import { listInputTargets, setInput } from "./request-inputs";
import { importantValues, ValueRegistry, viewEntry } from "./value-registry";

const BASE = "https://93.184.216.34";

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown; raw: string | undefined };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function mockFetch(route: (call: Call) => Reply | null) {
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
    const hit = route(call) ?? { status: 404, body: { message: "not found" } };
    const headers = new Headers({ "content-type": "application/json", ...(hit.headers ?? {}) });
    return new Response(hit.status === 204 ? null : JSON.stringify(hit.body ?? {}), { status: hit.status, headers });
  });
  return calls;
}

function registry() {
  const reg = new StepExecutorRegistry();
  reg.register(new HttpRequestExecutor());
  reg.register(new AssertionExecutor());
  reg.register(new ExtractVariableExecutor());
  return reg;
}

let order = 0;
const http = (name: string, config: Record<string, unknown>, id = `step-${name}`): OrchestrationStep => ({
  id,
  name,
  type: "HTTP_REQUEST",
  enabled: true,
  orderIndex: order++,
  config,
});
const assertion = (config: Record<string, unknown>): OrchestrationStep => ({
  name: "check",
  type: "ASSERTION",
  enabled: true,
  orderIndex: order++,
  config,
});

async function run(steps: OrchestrationStep[], options: Partial<OrchestrationOptions> = {}) {
  const results: OrchestrationStepResult[] = [];
  const outcome = await orchestrateSteps(steps, registry(), new ExecutionContext(), {
    stopOnFailure: true,
    ...options,
    onStepComplete: (result) => {
      results.push(result);
    },
  });
  return { outcome, results };
}

const calledPath = (calls: Call[], path: string) => calls.filter((call) => call.url.pathname === path);

beforeEach(() => {
  order = 0;
});
afterEach(() => jest.restoreAllMocks());

describe("Runtime Value Registry", () => {
  it("records body, header, Location and cookie values with their source and semantic key", () => {
    const reg = new ValueRegistry();
    const added = reg.addResponse(
      { stepId: "s1", stepName: "Create order", orderIndex: 0 },
      {
        status: 201,
        headers: { location: "/api/orders/9812", "x-request-id": "req-77", server: "nginx" },
        body: { data: { biker: { id: 991 }, user: { id: 42, token: "tok-secret-1" }, status: "ASSIGNED" } },
        cookies: { sid: "cookie-secret" },
      },
    );
    const biker = added.find((entry) => entry.path === "response.body.data.biker.id")!;
    expect(biker).toMatchObject({ key: "id", semanticKey: "bikerId", context: "biker", value: 991, type: "number", stepName: "Create order" });
    expect(added.find((entry) => entry.path === "response.headers.location#id")).toMatchObject({
      semanticKey: "orderId",
      value: 9812,
    });
    expect(added.some((entry) => entry.path === "response.headers.x-request-id")).toBe(true);
    expect(added.some((entry) => entry.path === "response.headers.server")).toBe(false);
    const token = added.find((entry) => entry.key === "token")!;
    const cookie = added.find((entry) => entry.kind === "cookie")!;
    expect(viewEntry(token).display).not.toContain("tok-secret-1");
    expect(viewEntry(cookie)).toMatchObject({ secret: true, category: "token" });
    expect(importantValues(added).map((item) => item.semanticKey)).toEqual(expect.arrayContaining(["bikerId", "status"]));
  });

  it("replaces the values of a step that runs again", () => {
    const reg = new ValueRegistry();
    reg.addResponse({ stepName: "a", orderIndex: 0 }, { status: 200, headers: {}, body: { id: 1 } });
    reg.addResponse({ stepName: "a", orderIndex: 0 }, { status: 200, headers: {}, body: { id: 2 } });
    expect(reg.entries().map((entry) => entry.value)).toEqual([2]);
  });
});

describe("dependencies in every input location", () => {
  const producer = () =>
    http("create", { method: "POST", url: `${BASE}/orders`, body: {} });
  const routes = (extra: (call: Call) => Reply | null) => (call: Call) =>
    call.url.pathname === "/orders" && call.method === "POST"
      ? { status: 201, body: { data: { orderId: 9812, bikerId: 125, accessToken: "AT-XYZ-1" } } }
      : extra(call);

  it("URL path: a previous response id fills /orders/{{orderId}}/bikers/{{bikerId}}", async () => {
    const calls = mockFetch(routes((call) => (call.url.pathname === "/orders/9812/bikers/125" ? { status: 200, body: {} } : null)));
    const { results } = await run([producer(), http("get", { method: "GET", url: `${BASE}/orders/{{orderId}}/bikers/{{bikerId}}` })]);
    expect(results[1]!.status).toBe("PASSED");
    expect(calls[1]!.url.pathname).toBe("/orders/9812/bikers/125");
    expect(results[1]!.consumedVars?.map((item) => item.source?.stepName)).toEqual(["create", "create"]);
  });

  it("path parameter: a saved mapping fills a literal segment from an earlier step", async () => {
    const bindings: StepBinding[] = [
      { target: { location: "path", field: "2" }, source: { stepId: "step-create", path: "response.body.data.orderId" } },
    ];
    const calls = mockFetch(routes((call) => (call.url.pathname === "/orders/9812" ? { status: 200, body: {} } : null)));
    const { results } = await run([producer(), http("get", { method: "GET", url: `${BASE}/orders/1`, bindings })]);
    expect(results[1]!.status).toBe("PASSED");
    expect(calls[1]!.url.pathname).toBe("/orders/9812");
  });

  it("query parameter: previous bikerId → ?bikerId=", async () => {
    const calls = mockFetch(routes((call) => (call.url.searchParams.get("bikerId") === "125" ? { status: 200, body: [] } : null)));
    const { results } = await run([producer(), http("trips", { method: "GET", url: `${BASE}/trips`, query: { bikerId: "{{bikerId}}" } })]);
    expect(results[1]!.status).toBe("PASSED");
    expect(calls[1]!.url.search).toBe("?bikerId=125");
  });

  it("header: previous accessToken → Authorization, and the token is masked in the stored input", async () => {
    const calls = mockFetch(routes((call) => (call.headers.Authorization === "Bearer AT-XYZ-1" ? { status: 200, body: {} } : { status: 401 })));
    const { results } = await run([
      producer(),
      http("me", { method: "GET", url: `${BASE}/me`, headers: { Authorization: "Bearer {{accessToken}}" } }),
    ]);
    expect(results[1]!.status).toBe("PASSED");
    expect(calls[1]!.headers.Authorization).toBe("Bearer AT-XYZ-1");
    expect(results[1]!.consumedVars?.[0]).toMatchObject({ variable: "accessToken", location: "headers.Authorization" });
  });

  it("JSON body: previous orderId → nested field, keeping it a number", async () => {
    const calls = mockFetch(routes((call) => (call.url.pathname === "/assign" ? { status: 200, body: {} } : null)));
    await run([
      producer(),
      http("assign", { method: "POST", url: `${BASE}/assign`, body: { order: { id: "{{orderId}}" }, note: "order {{orderId}}" } }),
    ]);
    expect(calls[1]!.body).toEqual({ order: { id: 9812 }, note: "order 9812" });
  });

  it("form-urlencoded: previous id → form field, URL-encoded", async () => {
    const calls = mockFetch(routes((call) => (call.url.pathname === "/form" ? { status: 200, body: {} } : null)));
    const { results } = await run([
      producer(),
      http("form", {
        method: "POST",
        url: `${BASE}/form`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "orderId={{orderId}}&note=a%20b&token={{accessToken}}",
      }),
    ]);
    expect(results[1]!.status).toBe("PASSED");
    expect(calls[1]!.raw).toBe("orderId=9812&note=a%20b&token=AT-XYZ-1");
    expect(results[1]!.consumedVars?.map((item) => item.location)).toEqual(expect.arrayContaining(["form.orderId", "form.token"]));
  });

  it("design time: a literal id in an imported URL is proposed as a mapping, never a {{variable}}", () => {
    const steps = [
      { id: "a", name: "Create trip", orderIndex: 0, type: "HTTP_REQUEST", config: { method: "POST", url: `${BASE}/trips` } },
      { id: "b", name: "Get trip", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "GET", url: `${BASE}/trip/8912?userId=4411` } },
    ];
    const body = { data: { trip: { id: 8912 }, userId: 4411 } };
    const suggestions = analyzeDependencies(steps, [{ stepId: "a", status: 201, body }]);
    const path = suggestions.find((item) => item.location === "path")!;
    expect(path).toMatchObject({ sourcePath: "$.data.trip.id", variable: "tripId", locationDetail: "tripId" });
    const query = suggestions.find((item) => item.location === "query")!;
    expect(query).toMatchObject({ locationDetail: "userId", variable: "userId" });
    expect(bindingFromSuggestion(path, steps[0]!)).toMatchObject({
      target: { location: "path", field: "2" },
      source: { stepId: "a", path: "response.body.data.trip.id" },
    });
    expect(bindingFromSuggestion(query, steps[0]!).target).toMatchObject({ location: "query", field: "userId" });
    expect(steps[1]!.config.url).toBe(`${BASE}/trip/8912?userId=4411`);
  });

  it("lists and sets inputs uniformly across locations", () => {
    const request = {
      method: "POST",
      url: `${BASE}/orders/551/items?bikerId=20`,
      headers: { Authorization: "Bearer T1", Cookie: "sid=abc; cart=5", "x-user-id": "42" },
      body: { order: { id: 551 } },
    };
    const targets = listInputTargets(request);
    expect(targets.map((target) => `${target.location}:${target.field}`)).toEqual([
      "path:2",
      "query:bikerId",
      "header:Authorization",
      "cookie:sid",
      "cookie:cart",
      "header:x-user-id",
      "body:order.id",
    ]);
    let next = setInput(request, { location: "path", field: "2" }, "782");
    next = setInput(next, { location: "query", field: "bikerId" }, "901");
    next = setInput(next, { location: "header", field: "authorization" }, "T2");
    next = setInput(next, { location: "cookie", field: "cart" }, "6");
    next = setInput(next, { location: "body", field: "order.id" }, "782");
    expect(next.url).toBe(`${BASE}/orders/782/items?bikerId=901`);
    expect(next.headers).toMatchObject({ Authorization: "Bearer T2", Cookie: "sid=abc; cart=6" });
    expect(next.body).toEqual({ order: { id: 782 } });
  });
});

describe("success definition", () => {
  it.each([200, 201, 202, 204, 206])("HTTP %i passes when no status is configured", async (status) => {
    mockFetch(() => ({ status, body: {} }));
    const { results } = await run([http("x", { method: "GET", url: `${BASE}/x` })]);
    expect(results[0]!.status).toBe("PASSED");
    expect(results[0]!.assertions).toEqual([{ label: "status 2xx", passed: true }]);
  });

  it("HTTP 500 without an expectation does not pass", async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    const { results } = await run([http("x", { method: "GET", url: `${BASE}/health` })]);
    expect(results[0]!.status).toBe("FAILED");
  });

  it("an explicit expectedStatus 201 is not satisfied by 200", async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    const { results } = await run([http("x", { method: "POST", url: `${BASE}/x`, expectedStatus: 201, recovery: { enabled: false } })]);
    expect(results[0]!.status).toBe("FAILED");
    expect(results[0]!.error).toBe("Expected HTTP 201, got 200");
  });

  it("2xx is not enough when an attached assertion fails", async () => {
    mockFetch(() => ({ status: 200, body: { status: "PENDING" } }));
    const { results } = await run([
      http("x", { method: "GET", url: `${BASE}/x` }),
      assertion({ kind: "equals", path: "body.status", expected: "ACTIVE" }),
    ]);
    // No input could be changed, so this is a plain failure rather than NEEDS_INPUT.
    expect(results[0]!.status).toBe("FAILED");
    expect(results[0]!.assertions?.find((check) => !check.passed)?.label).toBe("equals body.status");
  });
});

describe("automatic recovery", () => {
  it("first request fails, candidate 1 fails, candidate 2 succeeds, then stops", async () => {
    // Two earlier steps return different bikerIds; only the older one is right.
    const calls = mockFetch((call) => {
      if (call.url.pathname === "/a") return { status: 200, body: { bikerId: 991 } };
      if (call.url.pathname === "/b") return { status: 200, body: { bikerId: 555 } };
      if (call.url.pathname === "/trips") {
        return call.url.searchParams.get("bikerId") === "991" ? { status: 200, body: {} } : { status: 500, body: { message: "Biker not found" } };
      }
      return null;
    });
    const { results } = await run([
      http("a", { method: "GET", url: `${BASE}/a` }),
      http("b", { method: "GET", url: `${BASE}/b` }),
      http("trips", { method: "GET", url: `${BASE}/trips`, query: { bikerId: "42" } }),
    ]);
    const step = results[2]!;
    expect(step.status).toBe("RECOVERED");
    expect(step.recovery?.attempts.map((attempt) => [attempt.candidate.replacement, attempt.status])).toEqual([
      ["555", 500],
      ["991", 200],
    ]);
    expect(step.recovery?.stoppedBecause).toBe("SUCCESS");
    expect(step.recovery?.original).toMatchObject({ status: 500, message: "Biker not found" });
    expect(calledPath(calls, "/trips")).toHaveLength(3);
  });

  it("corrects a URL path and a query parameter together", async () => {
    const calls = mockFetch((call) => {
      if (call.url.pathname === "/bikers") return { status: 200, body: { data: { biker: { id: 901 } } } };
      if (call.url.pathname === "/orders" && call.method === "POST") return { status: 201, body: { data: { order: { id: 782 } } } };
      if (call.url.pathname === "/orders/782" && call.url.searchParams.get("bikerId") === "901") return { status: 200, body: {} };
      return { status: 500, body: {} };
    });
    const { results } = await run([
      http("biker", { method: "GET", url: `${BASE}/bikers` }),
      http("order", { method: "POST", url: `${BASE}/orders`, body: {} }),
      http("get", { method: "GET", url: `${BASE}/orders/551`, query: { bikerId: "20" } }),
    ]);
    const trace = results[2]!.recovery!;
    expect(results[2]!.status).toBe("RECOVERED");
    const winner = trace.attempts.at(-1)!.candidate;
    expect(winner.reason).toBe("COMBINED");
    expect(winner.changes.map((change) => `${change.location}.${change.fieldName}=${change.replacement}`)).toEqual([
      "query.bikerId=901",
      "path.orderId=782",
    ]);
    expect(trace.attempts.length).toBeLessThanOrEqual(3);
    expect(calls.at(-1)!.url.toString()).toBe(`${BASE}/orders/782?bikerId=901`);
  });

  it("recovers a wrong bearer token from the value an earlier step returned", async () => {
    mockFetch((call) => {
      if (call.url.pathname === "/login") return { status: 200, body: { accessToken: "GOOD-TOKEN" } };
      return call.headers.Authorization === "Bearer GOOD-TOKEN" ? { status: 200, body: {} } : { status: 401, body: {} };
    });
    const { results } = await run([
      http("login", { method: "POST", url: `${BASE}/login`, body: {} }),
      http("me", { method: "GET", url: `${BASE}/me`, headers: { Authorization: "Bearer STALE-TOKEN" } }),
    ]);
    expect(results[1]!.status).toBe("RECOVERED");
    expect(results[1]!.recovery?.attempts[0]!.candidate).toMatchObject({ location: "header", field: "Authorization" });
  });

  it("stops after 10 unique failed attempts and asks for input", async () => {
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index}Id`, `V-${index}`]));
    const query = Object.fromEntries(Object.keys(fields).map((key) => [key, `wrong-${key}`]));
    const calls = mockFetch((call) => (call.url.pathname === "/src" ? { status: 200, body: fields } : { status: 500, body: {} }));
    const { results, outcome } = await run([
      http("src", { method: "GET", url: `${BASE}/src` }),
      http("find", { method: "GET", url: `${BASE}/find`, query }),
    ]);
    const trace = results[1]!.recovery!;
    expect(trace.attempts).toHaveLength(10);
    expect(trace.stoppedBecause).toBe("MAX_ATTEMPTS");
    expect(results[1]!.status).toBe("NEEDS_INPUT");
    expect(outcome.status).toBe("NEEDS_INPUT");
    expect(calledPath(calls, "/find")).toHaveLength(11);
    expect(results[1]!.manual?.recommended.length).toBeGreaterThan(0);
  });

  it("never exceeds 10 attempts even when configured higher", () => {
    expect(recovery.recoverySettings({ recovery: { maxAttempts: 50 } }).maxAttempts).toBe(10);
  });

  it("never sends the same effective request twice, including the original", async () => {
    const calls = mockFetch((call) => (call.url.pathname === "/p" ? { status: 200, body: { bikerId: 7 } } : { status: 500, body: {} }));
    const same = {
      location: "query" as const,
      field: "bikerId",
      fieldName: "bikerId",
      original: "3",
      replacement: "3",
      source: { stepName: "p", orderIndex: 0, path: "response.body.bikerId" },
      originalSource: null,
    };
    const differ = { ...same, replacement: "7" };
    const candidate = (change: typeof same) => ({ ...change, changes: [change], confidence: "HIGH" as const, reason: "SAME_KEY" as const });
    jest.spyOn(recovery, "planRecoveryCandidates").mockReturnValue([candidate(same), candidate(differ), candidate({ ...differ })]);
    const { results } = await run([
      http("p", { method: "GET", url: `${BASE}/p` }),
      http("x", { method: "GET", url: `${BASE}/x?bikerId=3` }),
    ]);
    expect(results[1]!.recovery?.attempts).toHaveLength(1);
    expect(results[1]!.recovery?.skippedDuplicates).toBe(2);
    expect(calledPath(calls, "/x")).toHaveLength(2);
  });

  it("fingerprints query parameters the same whether they are in the URL or the query map", () => {
    expect(requestFingerprint({ method: "GET", url: `${BASE}/x?b=2&a=1` })).toBe(
      requestFingerprint({ method: "GET", url: `${BASE}/x`, query: { a: "1", b: "2" } }),
    );
    expect(requestFingerprint({ method: "POST", url: `${BASE}/x`, body: "a=1&b=2", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).toBe(
      requestFingerprint({ method: "POST", url: `${BASE}/x`, body: "b=2&a=1", headers: { "content-type": "application/x-www-form-urlencoded" } }),
    );
  });

  it("recovers a form field", async () => {
    const calls = mockFetch((call) => {
      if (call.url.pathname === "/p") return { status: 200, body: { data: { order: { id: 9812 } } } };
      return call.raw?.includes("orderId=9812") ? { status: 200, body: {} } : { status: 422, body: {} };
    });
    const { results } = await run([
      http("p", { method: "GET", url: `${BASE}/p` }),
      http("f", { method: "POST", url: `${BASE}/f`, body: "orderId=1234", headers: { "Content-Type": "application/x-www-form-urlencoded" }, recovery: { idempotent: true, allowDataChanges: true } }),
    ]);
    expect(results[1]!.status).toBe("RECOVERED");
    expect(calls.at(-1)!.raw).toBe("orderId=9812");
  });
});

describe("mutating request safety", () => {
  const source = (call: Call) => (call.url.pathname === "/p" ? { status: 200, body: { bikerId: 9821 } } : { status: 500, body: {} });

  it.each(["POST", "PATCH", "PUT"])("%s is not retried automatically without idempotency", async (method) => {
    const calls = mockFetch(source);
    const { results } = await run([
      http("p", { method: "GET", url: `${BASE}/p` }),
      http("m", { method, url: `${BASE}/m`, body: { bikerId: 125 } }),
    ]);
    expect(calledPath(calls, "/m")).toHaveLength(1);
    expect(results[1]!.status).toBe("NEEDS_INPUT");
    expect(results[1]!.recovery).toMatchObject({ blockedReason: "UNSAFE_METHOD", stoppedBecause: "UNSAFE_ONLY" });
  });

  it("DELETE is never retried with alternative ids, even when marked idempotent", async () => {
    const calls = mockFetch(source);
    await run([
      http("p", { method: "GET", url: `${BASE}/p` }),
      http("d", { method: "DELETE", url: `${BASE}/d`, query: { bikerId: "125" }, recovery: { idempotent: true } }),
    ]);
    expect(calledPath(calls, "/d")).toHaveLength(1);
  });

  it("a POST carrying an Idempotency-Key may be retried", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/p"
        ? { status: 200, body: { bikerId: 9821 } }
        : (call.body as { bikerId?: number }).bikerId === 9821
          ? { status: 201, body: {} }
          : { status: 500, body: {} },
    );
    const { results } = await run([
      http("p", { method: "GET", url: `${BASE}/p` }),
      http("m", {
        method: "POST",
        url: `${BASE}/m`,
        headers: { "Idempotency-Key": "k-1" },
        body: { bikerId: 125 },
        // Changing business data in the body always needs explicit consent.
        recovery: { allowDataChanges: true },
      }),
    ]);
    expect(results[1]!.status).toBe("RECOVERED");
    expect(calledPath(calls, "/m")).toHaveLength(2);
  });
});

describe("manual recovery", () => {
  const routes = (call: Call): Reply | null => {
    if (call.url.pathname === "/login") return { status: 200, body: { accessToken: "AT-1", userId: 42 } };
    if (call.url.pathname === "/bikers") return { status: 201, body: { data: { registration: { number: 5501 }, courier: 991 } } };
    if (call.url.pathname === "/trips") return call.url.searchParams.get("bikerId") === "991" ? { status: 200, body: {} } : { status: 500, body: {} };
    return null;
  };
  const flow = (extra: Record<string, unknown> = {}) => [
    http("login", { method: "POST", url: `${BASE}/login`, body: {} }),
    http("bikers", { method: "POST", url: `${BASE}/bikers`, body: {} }),
    http("trips", { method: "GET", url: `${BASE}/trips`, query: { bikerId: "42" }, ...extra }),
  ];

  it("pauses with grouped values, then runs the request with the value the user picked", async () => {
    const calls = mockFetch(routes);
    let pending: PendingInput | undefined;
    const { results, outcome } = await run(flow(), {
      awaitInput: async (input) => {
        pending = input;
        const value = input.result.manual!.values.find((item) => item.path === "response.body.data.courier")!;
        return { changes: [{ target: { location: "query", field: "bikerId" }, source: { ref: value.ref } }] };
      },
    });
    expect(pending?.result.status).toBe("NEEDS_INPUT");
    const manual = pending!.result.manual!;
    expect(manual.targets.find((target) => target.location === "query")).toMatchObject({ field: "bikerId", display: "42" });
    expect(new Set(manual.values.map((item) => item.stepName))).toEqual(new Set(["login", "bikers"]));
    // Secrets never leave as text.
    expect(JSON.stringify(manual)).not.toContain("AT-1");
    expect(results[2]!.status).toBe("RECOVERED");
    expect(results[2]!.recovery?.manual).toBe(true);
    expect(results[2]!.recovery?.attempts.at(-1)).toMatchObject({ manual: true, status: 200, expectationMet: true });
    expect(calls.at(-1)!.url.searchParams.get("bikerId")).toBe("991");
    expect(outcome.status).toBe("PASSED");
  });

  it("accepts a custom value and records it as a manual override", async () => {
    mockFetch(routes);
    const { results } = await run(flow(), {
      awaitInput: async () => ({ changes: [{ target: { location: "query", field: "bikerId" }, source: { value: "991" } }] }),
    });
    expect(results[2]!.status).toBe("RECOVERED");
    expect(results[2]!.recovery?.attempts.at(-1)?.candidate).toMatchObject({ reason: "MANUAL", replacement: "991", source: { path: "custom value" } });
  });

  it("stays NEEDS_INPUT (not FAILED) when the user does not resolve it", async () => {
    mockFetch(routes);
    const { results } = await run(flow(), { awaitInput: async () => null });
    expect(results[2]!.status).toBe("NEEDS_INPUT");
  });

  it("saves the mapping and reuses it automatically on the next run", async () => {
    mockFetch(routes);
    let saved: StepBinding[] = [];
    const resolution = (input: PendingInput): ManualResolution => {
      const value = input.result.manual!.values.find((item) => item.path === "response.body.data.courier")!;
      return { changes: [{ target: { location: "query", field: "bikerId" }, source: { ref: value.ref } }], save: true };
    };
    await run(flow(), {
      awaitInput: async (input) => resolution(input),
      onSaveBindings: async (_stepId, bindings) => {
        saved = bindings;
      },
    });
    expect(saved).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ location: "query", field: "bikerId" }),
        source: expect.objectContaining({ stepId: "step-bikers", path: "response.body.data.courier" }),
        origin: "manual",
      }),
    ]);

    order = 0;
    const calls = mockFetch(routes);
    const awaitInput = jest.fn();
    const { results } = await run(flow({ bindings: saved }), { awaitInput });
    expect(results[2]!.status).toBe("PASSED");
    expect(results[2]!.recovery).toBeUndefined();
    expect(awaitInput).not.toHaveBeenCalled();
    expect(calledPath(calls, "/trips")).toHaveLength(1);
    expect(results[2]!.consumedVars).toEqual(
      expect.arrayContaining([expect.objectContaining({ location: "query.bikerId", source: expect.objectContaining({ stepName: "bikers" }) })]),
    );
  });
});

describe("semantic ranking stays optional and compact", () => {
  it("is never asked when deterministic evidence exists", async () => {
    mockFetch((call) =>
      call.url.pathname === "/p" ? { status: 200, body: { bikerId: 9821 } } : call.url.searchParams.get("bikerId") === "9821" ? { status: 200, body: {} } : { status: 500, body: {} },
    );
    const ranker = jest.fn();
    await run(
      [http("p", { method: "GET", url: `${BASE}/p` }), http("x", { method: "GET", url: `${BASE}/x`, query: { bikerId: "1" }, recovery: { aiAssist: true } })],
      { ranker },
    );
    expect(ranker).not.toHaveBeenCalled();
  });

  it("receives only candidate metadata — no values, no secrets — and promotes its choice", async () => {
    const calls = mockFetch((call) =>
      call.url.pathname === "/p"
        ? { status: 200, body: { tripId: 8912, accessToken: "SECRET-XYZ" } }
        : call.url.searchParams.get("currentTripId") === "8912"
          ? { status: 200, body: {} }
          : { status: 404, body: { message: "Trip not found" } },
    );
    const ranker = jest.fn(async () => ["0"]);
    const { results } = await run(
      [
        http("p", { method: "GET", url: `${BASE}/p` }),
        http("x", { method: "GET", url: `${BASE}/x`, query: { currentTripId: "77" }, recovery: { aiAssist: true } }),
      ],
      { ranker },
    );
    expect(ranker).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify((ranker.mock.calls as unknown[][])[0]![0]);
    expect(payload).not.toContain("8912");
    expect(payload).not.toContain("SECRET-XYZ");
    expect(payload).toContain("Trip not found");
    expect(results[1]!.status).toBe("RECOVERED");
    expect(results[1]!.recovery?.attempts[0]!.candidate.reason).toBe("AI_SUGGESTION");
    expect(calledPath(calls, "/x")).toHaveLength(2);
  });

  it("without the ranker, a LOW candidate is only suggested", () => {
    const candidates = planRecoveryCandidates({ method: "GET", url: `${BASE}/x`, query: { currentTripId: "77" } }, [
      { orderIndex: 0, name: "p", response: { status: 200, headers: {}, body: { tripId: 8912 } } },
    ]);
    expect(candidates).toEqual([expect.objectContaining({ confidence: "LOW", reason: "SIMILAR_KEY", replacement: "8912" })]);
  });
});
