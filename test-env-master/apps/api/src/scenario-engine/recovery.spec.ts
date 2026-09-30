import { AssertionExecutor } from "./executors/assertion.executor";
import { HttpRequestExecutor } from "./executors/http-request.executor";
import * as recovery from "./flow/recovery";
import {
  isRetrySafe,
  planRecoveryCandidates,
  recoverySettings,
  requestFingerprint,
} from "./flow/recovery";
import { orchestrateSteps } from "./orchestrate";
import { StepExecutorRegistry } from "./step-executor.registry";
import { ExecutionContext, type OrchestrationStep, type OrchestrationStepResult } from "./types";

const BASE = "https://93.184.216.34";

function registry() {
  const reg = new StepExecutorRegistry();
  reg.register(new HttpRequestExecutor());
  reg.register(new AssertionExecutor());
  return reg;
}

type Route = (url: URL, body: unknown, method: string) => { status: number; body: unknown } | null;

function mockFetch(route: Route) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.toString(), method, body });
    const hit = route(url, body, method) ?? { status: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

let order = 0;
const http = (name: string, config: Record<string, unknown>): OrchestrationStep => ({
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

/** Step 1 returns userId 125 and bikerId 9821; Step 2 a registration id. */
function flowRoutes(activate: (bikerId: string | null) => { status: number; body: unknown }): Route {
  return (url) => {
    if (url.pathname === "/profile") return { status: 200, body: { data: { userId: 125, bikerId: 9821 } } };
    if (url.pathname === "/registrations") return { status: 200, body: { registrationId: 771 } };
    if (url.pathname === "/activate") return activate(url.searchParams.get("bikerId"));
    return null;
  };
}

async function run(steps: OrchestrationStep[]) {
  const results: OrchestrationStepResult[] = [];
  const outcome = await orchestrateSteps(steps, registry(), new ExecutionContext(), {
    stopOnFailure: true,
    onStepComplete: (result) => {
      results.push(result);
    },
  });
  return { outcome, results };
}

describe("bounded scenario recovery", () => {
  beforeEach(() => {
    order = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  const active = (bikerId: string | null) =>
    bikerId === "9821" ? { status: 200, body: { status: "ACTIVE" } } : { status: 500, body: { message: "biker not found" } };

  it("substitutes the justified value from an earlier step and records it", async () => {
    const calls = mockFetch(flowRoutes(active));
    const { outcome, results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("register", { method: "GET", url: `${BASE}/registrations` }),
      http("activate", { method: "GET", url: `${BASE}/activate`, query: { bikerId: "125" } }),
      assertion({ kind: "equals", path: "body.status", expected: "ACTIVE" }),
    ]);

    expect(outcome.status).toBe("PASSED");
    const step3 = results[2]!;
    expect(step3.status).toBe("PASSED");
    expect(step3.recovery?.outcome).toBe("RECOVERED");
    expect(step3.recovery?.originalStatus).toBe(500);
    expect(step3.recovery?.attempts).toHaveLength(1);
    const candidate = step3.recovery!.attempts[0]!.candidate;
    expect(candidate).toMatchObject({
      location: "query",
      fieldName: "bikerId",
      original: "125",
      replacement: "9821",
      confidence: "HIGH",
      source: { stepName: "profile", path: "response.body.data.bikerId" },
      originalSource: { stepName: "profile", path: "response.body.data.userId" },
    });
    expect(calls.filter((call) => call.url.includes("/activate"))).toHaveLength(2);
  });

  it("does not retry when no justified candidate exists", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/profile" ? { status: 200, body: { data: { name: "Ali" } } } : { status: 500, body: {} },
    );
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "GET", url: `${BASE}/activate`, query: { bikerId: "125" } }),
    ]);
    expect(results[1]!.recovery?.outcome).toBe("NO_CANDIDATE");
    expect(calls.filter((call) => call.url.includes("/activate"))).toHaveLength(1);
  });

  it("does not count HTTP 200 as recovered when an assertion still fails", async () => {
    mockFetch(flowRoutes(() => ({ status: 200, body: { status: "PENDING" } })));
    const { outcome, results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "GET", url: `${BASE}/activate`, query: { bikerId: "125" } }),
      assertion({ kind: "equals", path: "body.status", expected: "ACTIVE" }),
    ]);
    const step = results[1]!;
    expect(step.recovery?.outcome).toBe("FAILED");
    expect(step.recovery?.attempts[0]).toMatchObject({ status: 200, expectationMet: false });
    expect(outcome.status).toBe("FAILED");
  });

  it("never retries a POST automatically; it suggests the correction", async () => {
    const calls = mockFetch((url, body) => {
      if (url.pathname === "/profile") return { status: 200, body: { data: { userId: 125, bikerId: 9821 } } };
      const sent = (body as { bikerId?: number } | undefined)?.bikerId;
      return sent === 9821 ? { status: 200, body: { ok: 1 } } : { status: 500, body: {} };
    });
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "POST", url: `${BASE}/activate`, body: { bikerId: 125 } }),
    ]);
    const trace = results[1]!.recovery!;
    expect(trace.outcome).toBe("SUGGESTED");
    expect(trace.blockedReason).toBe("UNSAFE_METHOD");
    expect(trace.suggestions[0]).toMatchObject({ field: "bikerId", original: "125", replacement: "9821" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("retries a POST marked idempotent and keeps the JSON type of the value", async () => {
    const calls = mockFetch((url, body) => {
      if (url.pathname === "/profile") return { status: 200, body: { data: { userId: 125, bikerId: 9821 } } };
      return (body as { bikerId?: unknown }).bikerId === 9821 ? { status: 200, body: {} } : { status: 500, body: {} };
    });
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "POST", url: `${BASE}/activate`, body: { bikerId: 125 }, recovery: { idempotent: true } }),
    ]);
    expect(results[1]!.recovery?.outcome).toBe("RECOVERED");
    expect(calls.at(-1)?.body).toEqual({ bikerId: 9821 });
  });

  it("never retries DELETE, even when marked idempotent", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/profile"
        ? { status: 200, body: { data: { bikerId: 9821 } } }
        : { status: 500, body: {} },
    );
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("remove", { method: "DELETE", url: `${BASE}/remove`, query: { bikerId: "125" }, recovery: { idempotent: true } }),
    ]);
    expect(results[1]!.recovery?.outcome).toBe("SUGGESTED");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("stops at the attempt budget", async () => {
    const calls = mockFetch((url) =>
      url.pathname === "/profile"
        ? { status: 200, body: { a1: "A-1", b1: "B-1", c1: "C-1", d1: "D-1" } }
        : { status: 500, body: {} },
    );
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("find", {
        method: "GET",
        url: `${BASE}/find`,
        query: { a1: "x-a", b1: "x-b", c1: "x-c", d1: "x-d" },
        recovery: { maxAttempts: 3 },
      }),
    ]);
    const trace = results[1]!.recovery!;
    expect(trace.outcome).toBe("FAILED");
    expect(trace.attempts).toHaveLength(3);
    expect(trace.blockedReason).toBe("BUDGET");
    expect(trace.suggestions).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("/find"))).toHaveLength(4);
  });

  it("never sends the same effective request twice", async () => {
    const calls = mockFetch(flowRoutes(() => ({ status: 500, body: {} })));
    const duplicate = {
      location: "query" as const,
      field: "bikerId",
      fieldName: "bikerId",
      original: "125",
      replacement: "9821",
      source: { stepName: "profile", orderIndex: 0, path: "response.body.data.bikerId" },
      originalSource: null,
      confidence: "HIGH" as const,
      reason: "SAME_KEY" as const,
    };
    jest.spyOn(recovery, "planRecoveryCandidates").mockReturnValue([duplicate, { ...duplicate }]);
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "GET", url: `${BASE}/activate`, query: { bikerId: "125" } }),
    ]);
    expect(results[1]!.recovery?.attempts).toHaveLength(1);
    expect(results[1]!.recovery?.blockedReason).toBe("DUPLICATE_REQUEST");
    expect(calls.filter((call) => call.url.includes("/activate"))).toHaveLength(2);
  });

  it("leaves a negative test alone when its assertions pass", async () => {
    const calls = mockFetch(flowRoutes(() => ({ status: 404, body: { message: "biker not found" } })));
    const { results, outcome } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "GET", url: `${BASE}/activate`, query: { bikerId: "125" } }),
      assertion({ kind: "status_code", expected: "404" }),
    ]);
    expect(results[1]!.recovery).toBeUndefined();
    expect(outcome.status).toBe("PASSED");
    expect(calls.filter((call) => call.url.includes("/activate"))).toHaveLength(1);
  });

  it("fails a step whose expectedStatus is not met", async () => {
    mockFetch(() => ({ status: 201, body: {} }));
    const { results } = await run([
      http("create", { method: "GET", url: `${BASE}/x`, expectedStatus: 200, recovery: { enabled: false } }),
    ]);
    expect(results[0]!.status).toBe("FAILED");
    expect(results[0]!.error).toBe("Expected HTTP 200, got 201");
    expect(results[0]!.recovery?.outcome).toBe("DISABLED");
  });

  it("records consumed variables for the flow view", async () => {
    mockFetch((url) =>
      url.pathname === "/profile"
        ? { status: 200, body: { data: { bikerId: "B-9821" } } }
        : { status: 200, body: {} },
    );
    const { results } = await run([
      http("profile", { method: "GET", url: `${BASE}/profile` }),
      http("activate", { method: "GET", url: `${BASE}/bikers/{{bikerId}}/activate` }),
    ]);
    expect(results[0]!.extractedVars?.bikerId).toBe("B-9821");
    expect(results[1]!.consumedVars).toEqual([{ variable: "bikerId", location: "url" }]);
  });
});

describe("recovery planning", () => {
  const history = (body: unknown, name = "s1", orderIndex = 0) => ({
    orderIndex,
    name,
    response: { status: 200, headers: {}, body },
  });

  it("treats two different earlier values for the same key as ambiguous (MEDIUM)", () => {
    const candidates = planRecoveryCandidates(
      { method: "GET", url: `${BASE}/x`, query: { bikerId: "11" } },
      [history({ bikerId: "22" }), history({ bikerId: "33" }, "s2", 1)],
    );
    expect(candidates.map((item) => item.confidence)).toEqual(["MEDIUM", "MEDIUM"]);
    expect(candidates[0]!.reason).toBe("SAME_KEY_AMBIGUOUS");
  });

  it("does not touch a value that already agrees with an earlier response", () => {
    expect(
      planRecoveryCandidates({ method: "GET", url: `${BASE}/x`, query: { bikerId: "22" } }, [
        history({ bikerId: "22", userId: "5" }),
      ]),
    ).toEqual([]);
  });

  it("maps entity ids by structure and URL segments at MEDIUM confidence", () => {
    const candidates = planRecoveryCandidates(
      { method: "GET", url: `${BASE}/bikers/125/activate`, body: { bikerId: 125 } },
      [history({ biker: { id: 9821 } })],
    );
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: "body", confidence: "MEDIUM", reason: "ENTITY_ID" }),
        expect.objectContaining({ location: "url", confidence: "MEDIUM", replacement: "9821" }),
      ]),
    );
    expect(candidates.some((item) => item.confidence === "HIGH")).toBe(false);
  });

  it("fingerprints the effective request independent of key order and header case", () => {
    const a = requestFingerprint({ method: "get", url: "u", headers: { A: "1", b: "2" }, body: { x: 1, y: 2 } });
    const b = requestFingerprint({ method: "GET", url: "u", headers: { B: "2", a: "1" }, body: { y: 2, x: 1 } });
    expect(a).toBe(b);
    expect(requestFingerprint({ method: "GET", url: "u", body: { x: 2 } })).not.toBe(a);
  });

  it("applies safe defaults", () => {
    expect(recoverySettings({})).toEqual({ enabled: true, maxAttempts: 3, allowMedium: false, idempotent: false });
    expect(recoverySettings({ recovery: { maxAttempts: 99 } }).maxAttempts).toBe(5);
    expect(isRetrySafe("GET", false)).toBe(true);
    expect(isRetrySafe("POST", false)).toBe(false);
    expect(isRetrySafe("PUT", true)).toBe(true);
    expect(isRetrySafe("DELETE", true)).toBe(false);
  });
});
