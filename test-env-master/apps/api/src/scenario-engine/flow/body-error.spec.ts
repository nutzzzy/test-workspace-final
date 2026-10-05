import { AssertionExecutor } from "../executors/assertion.executor";
import { ExtractVariableExecutor } from "../executors/extract-variable.executor";
import { HttpRequestExecutor } from "../executors/http-request.executor";
import { orchestrateSteps } from "../orchestrate";
import { StepExecutorRegistry } from "../step-executor.registry";
import { ExecutionContext, type OrchestrationStep, type OrchestrationStepResult } from "../types";
import { describeResponseError, detectBodyError } from "./body-error";
import type { DependencySuggestion } from "./dependency-analyzer";
import { chooseAutoMappings, suggestDependencies } from "./mapping-review";
import { analyzeResponse } from "./response-analyzer";

const BASE = "https://93.184.216.34";

describe("errors reported in the response body", () => {
  it.each([
    [{ success: false, message: "Order not found" }, "success = false", "Order not found"],
    [{ ok: false, error: "Invalid token" }, "ok = false", "Invalid token"],
    [{ status: "error", message: "Biker is busy" }, 'status = "error"', "Biker is busy"],
    [{ errors: [{ message: "orderId must be a number", field: "orderId" }] }, "errors", "orderId must be a number"],
    [{ error: { code: "E42", message: "Trip already closed" } }, "error", "Trip already closed"],
    [{ errorCode: "TRIP_CLOSED", message: "Trip already closed" }, "errorCode = TRIP_CLOSED", "Trip already closed"],
    [{ errors: { reasonId: ["is required"] } }, "errors", "reasonId: is required"],
  ])("detects %j", (body, signal, message) => {
    expect(detectBodyError(body)).toMatchObject({ signal, message });
  });

  it.each([
    [{ success: true, data: { id: 5 } }],
    [{ data: { order: { id: 5, status: "FAILED" } } }],
    [{ errors: [], data: { id: 5 } }],
    [{ error: null, items: [] }],
    [{ code: 0, message: "OK", data: {} }],
    [[{ id: 1 }]],
    ["plain text"],
  ])("does not mistake %j for an error", (body) => {
    expect(detectBodyError(body)).toBeNull();
  });

  it("ties the error to the request field it names, and to that field's mapping", () => {
    const request = { method: "GET", url: `${BASE}/orders/551`, query: { bikerId: "42" }, headers: {} };
    const bindings = [
      {
        target: { location: "query" as const, field: "bikerId", key: "bikerId" },
        source: { stepId: "s1", stepName: "Get biker", orderIndex: 0, path: "response.body.data.id" },
        origin: "accepted" as const,
      },
    ];
    const error = describeResponseError({ success: false, message: "Biker 42 not found", field: "bikerId" }, 200, request, bindings);
    expect(error).toMatchObject({
      field: { location: "query", field: "bikerId" },
      fieldEvidence: "named",
      mapping: { stepName: "Get biker", orderIndex: 0, path: "response.body.data.id", fixedValue: false },
    });
  });

  it("finds the field a message mentions, and the credential for a token error", () => {
    const request = { method: "POST", url: `${BASE}/trips`, headers: { Authorization: "Bearer abc12345" }, body: { orderItemId: 7, id: 3 } };
    expect(describeResponseError({ success: false, message: "order item id is invalid" }, 200, request, [])?.field).toMatchObject({ location: "body", key: "orderItemId" });
    expect(describeResponseError({ message: "Token expired" }, 401, request, [])).toMatchObject({ field: { location: "header", field: "Authorization" }, fieldEvidence: "auth" });
  });

  it("the response analysis shows a body error of a 200", () => {
    expect(analyzeResponse({ status: 200, body: { success: false, message: "Order not found" } }).errorInformation).toEqual({ message: "Order not found", code: null });
  });
});

describe("a step whose response reports an error", () => {
  const registry = () => {
    const reg = new StepExecutorRegistry();
    reg.register(new HttpRequestExecutor());
    reg.register(new AssertionExecutor());
    reg.register(new ExtractVariableExecutor());
    return reg;
  };
  let order = 0;
  const http = (name: string, config: Record<string, unknown>): OrchestrationStep => ({ id: `step-${name}`, name, type: "HTTP_REQUEST", enabled: true, orderIndex: order++, config });
  const assertion = (config: Record<string, unknown>): OrchestrationStep => ({ name: "check", type: "ASSERTION", enabled: true, orderIndex: order++, config });
  const serve = (route: (url: URL) => { status: number; body: unknown } | null) => {
    const calls: URL[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const hit = route(url) ?? { status: 404, body: { message: "not found" } };
      return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
    });
    return calls;
  };
  const run = async (steps: OrchestrationStep[]) => {
    const results: OrchestrationStepResult[] = [];
    await orchestrateSteps(steps, registry(), new ExecutionContext(), { stopOnFailure: true, onStepComplete: (result) => void results.push(result) });
    return results;
  };
  beforeEach(() => {
    order = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  it("fails a 200 that says success: false, and stops the scenario", async () => {
    const calls = serve((url) => (url.pathname === "/pay" ? { status: 200, body: { success: false, message: "Card declined" } } : { status: 200, body: {} }));
    const results = await run([http("pay", { method: "POST", url: `${BASE}/pay`, body: { amount: 5 } }), http("next", { method: "GET", url: `${BASE}/next` })]);
    expect(results[0]!.status).not.toBe("PASSED");
    expect(results[0]!.error).toContain("Card declined");
    expect(results[0]!.assertions?.find((check) => !check.passed)?.label).toBe("no error in the response body");
    expect(results[0]!.responseError).toMatchObject({ message: "Card declined", signal: "success = false" });
    expect(calls.some((url) => url.pathname === "/next")).toBe(false);
  });

  it("recovers by correcting the field the error names first", async () => {
    // Two earlier values could fix the request; the error names bikerId, so its correction goes first.
    const calls = serve((url) => {
      if (url.pathname === "/a") return { status: 200, body: { bikerId: 901, tripId: 77 } };
      if (url.pathname === "/trips") {
        const ok = url.searchParams.get("bikerId") === "901";
        return { status: 200, body: ok ? { success: true } : { success: false, message: "Biker not found", field: "bikerId" } };
      }
      return null;
    });
    const results = await run([http("a", { method: "GET", url: `${BASE}/a` }), http("trips", { method: "GET", url: `${BASE}/trips`, query: { tripId: "12", bikerId: "42" } })]);
    expect(results[1]!.status).toBe("RECOVERED");
    expect(results[1]!.recovery?.attempts[0]?.candidate.changes.some((change) => change.field === "bikerId")).toBe(true);
    expect(results[1]!.recovery?.likelyField).toMatchObject({ field: "bikerId" });
    expect(results[1]!.responseError).toMatchObject({ field: { field: "bikerId" }, fieldEvidence: "named" });
    expect(calls.filter((url) => url.pathname === "/trips")).toHaveLength(2);
  });

  it("leaves a negative test alone: an assertion on the error members decides", async () => {
    serve(() => ({ status: 200, body: { success: false, message: "Out of stock" } }));
    const results = await run([
      http("buy", { method: "POST", url: `${BASE}/buy`, body: {} }),
      assertion({ kind: "equals", path: "body.success", expected: false }),
    ]);
    expect(results[0]!.status).toBe("PASSED");
  });

  it("can be switched off per step", async () => {
    serve(() => ({ status: 200, body: { success: false } }));
    const results = await run([http("x", { method: "GET", url: `${BASE}/x`, checkResponseBody: false })]);
    expect(results[0]!.status).toBe("PASSED");
  });
});

describe("detect mappings automatically", () => {
  const suggestion = (over: Partial<DependencySuggestion>): DependencySuggestion => ({
    id: Math.random().toString(),
    producerStepId: "p1",
    producerName: "p1",
    consumerStepId: "c",
    consumerName: "c",
    sourcePath: "$.id",
    variable: "orderId",
    location: "query",
    locationDetail: "orderId",
    confidence: "HIGH",
    score: 0.9,
    masked: false,
    target: { location: "query", field: "orderId", key: "orderId" },
    evidence: "response",
    reason: "same_value",
    ...over,
  });

  it("takes the strongest source of each field, leaves ties and weak ones as suggestions", () => {
    const plan = chooseAutoMappings([
      suggestion({ id: "a" }),
      suggestion({ id: "b", confidence: "MEDIUM", score: 0.6, producerStepId: "p2" }),
      suggestion({ id: "t1", target: { location: "query", field: "bikerId", key: "bikerId" }, sourcePath: "$.a" }),
      suggestion({ id: "t2", target: { location: "query", field: "bikerId", key: "bikerId" }, sourcePath: "$.b" }),
      suggestion({ id: "w", confidence: "LOW", score: 0.4, target: { location: "body", field: "userId", key: "userId" } }),
    ]);
    expect(plan.chosen.map((item) => item.id)).toEqual(["a"]);
    expect(plan.ambiguous.map((group) => group.map((item) => item.id))).toEqual([["t1", "t2"]]);
    expect(plan.weak.map((item) => item.id)).toEqual(["w"]);
  });

  it("after the mappings were deleted, finds them again from the previous responses", () => {
    const steps = [
      { id: "login", name: "login", orderIndex: 0, type: "HTTP_REQUEST", config: { method: "POST", url: `${BASE}/login`, body: { user: "u" } } },
      { id: "order", name: "create order", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "POST", url: `${BASE}/orders`, headers: { Authorization: "Bearer tok-1234567890" }, body: { item: 3 } } },
      { id: "get", name: "get order", orderIndex: 2, type: "HTTP_REQUEST", config: { method: "GET", url: `${BASE}/orders/98123`, headers: { Authorization: "Bearer tok-1234567890" } } },
    ];
    const samples = [
      { stepId: "login", status: 200, body: { data: { accessToken: "tok-1234567890" } } },
      { stepId: "order", status: 201, body: { data: { order: { id: 98123 } } } },
    ];
    const plan = chooseAutoMappings(suggestDependencies(steps, samples));
    const saved = plan.chosen.map((item) => `${item.consumerStepId}:${item.target.location}:${item.target.key} ← ${item.producerStepId} ${item.sourcePath}`);
    expect(saved).toEqual(
      expect.arrayContaining([
        "order:header:Authorization ← login $.data.accessToken",
        "get:header:Authorization ← login $.data.accessToken",
        "get:path:orderId ← order $.data.order.id",
      ]),
    );
  });
});
