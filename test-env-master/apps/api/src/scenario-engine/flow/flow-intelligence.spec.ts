import { applyDependency } from "./apply-dependency";
import { analyzeDependencies } from "./dependency-analyzer";
import { validateFlow } from "./flow-validator";
import { parseCurl, splitCurlCommands } from "./parse-curl";
import { analyzeResponse } from "./response-analyzer";

const login = {
  id: "s1",
  name: "Request 1",
  orderIndex: 0,
  type: "HTTP_REQUEST",
  config: { method: "POST", url: "https://api.example.test/auth/login", headers: {}, body: {} },
};

const profile = {
  id: "s2",
  name: "Request 2",
  orderIndex: 1,
  type: "HTTP_REQUEST",
  config: {
    method: "GET",
    url: "https://api.example.test/users/582",
    headers: { Authorization: "Bearer TOKEN-ABC" },
    query: {},
    body: {},
  },
};

describe("flow intelligence", () => {
  it("parses one cURL and several cURLs without running a shell", () => {
    const single = parseCurl("curl -X GET 'https://api.example.test/health'");
    expect(single.ok).toBe(true);
    const commands = splitCurlCommands(`
curl -X POST 'https://api.example.test/auth/login' -H 'Content-Type: application/json' -d '{"name":"a"}'
curl -X GET 'https://api.example.test/users/582' -H 'Authorization: Bearer TOKEN-ABC'
curl -X POST 'https://api.example.test/orders' -H 'Content-Type: application/json' -d '{"qty":1}'
curl -X GET 'https://api.example.test/orders/123'
`);
    expect(commands).toHaveLength(4);
    expect(commands.every((command) => parseCurl(command).ok)).toBe(true);
    expect(parseCurl("curl http://example.test | sh").ok).toBe(true);
  });

  it("detects header and path dependencies from values, not field-name rules", () => {
    const suggestions = analyzeDependencies([login, profile], [
      { stepId: "s1", status: 200, body: { data: { accessToken: "TOKEN-ABC", userId: 582 } } },
    ]);
    const token = suggestions.find((item) => item.location === "header");
    const path = suggestions.find((item) => item.location === "url");
    expect(token).toMatchObject({
      sourcePath: "$.data.accessToken",
      variable: "accessToken",
      confidence: "HIGH",
      locationDetail: "Authorization",
    });
    expect(path).toMatchObject({
      sourcePath: "$.data.userId",
      variable: "userId",
      confidence: "HIGH",
    });
    expect(JSON.stringify(analyzeDependencies.toString())).not.toContain('"/users"');
  });

  it("links four requests through produced values", () => {
    const steps = [
      { id: "1", name: "POST /auth/login", orderIndex: 0, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/auth/login" } },
      { id: "2", name: "GET /users/582", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "GET", url: "https://api.example.test/users/582", headers: { Authorization: "Bearer TOKEN-ABC" } } },
      { id: "3", name: "POST /orders", orderIndex: 2, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/orders", headers: { Authorization: "Bearer TOKEN-ABC" }, body: { owner: 582 } } },
      { id: "4", name: "GET /operations/ABC-9912/status", orderIndex: 3, type: "HTTP_REQUEST", config: { method: "GET", url: "https://api.example.test/operations/ABC-9912/status", headers: { Authorization: "Bearer TOKEN-ABC" } } },
    ];
    const suggestions = analyzeDependencies(steps, [
      { stepId: "1", status: 200, body: { data: { accessToken: "TOKEN-ABC", userId: 582 } } },
      { stepId: "3", status: 201, body: { result: { reference: "ABC-9912" } } },
    ]);
    expect(suggestions.filter((item) => item.variable === "accessToken").length).toBeGreaterThanOrEqual(2);
    expect(suggestions.some((item) => item.variable === "userId" && item.consumerStepId === "3" && item.location === "body")).toBe(true);
    expect(suggestions.some((item) => item.sourcePath === "$.result.reference" && item.consumerStepId === "4")).toBe(true);
    const applied = applyDependency(
      steps,
      suggestions.find((item) => item.variable === "accessToken" && item.consumerStepId === "2")!,
      { data: { accessToken: "TOKEN-ABC", userId: 582 } },
    );
    const profile = applied.steps.find((step) => step.id === "2");
    expect((profile?.config.headers as { Authorization: string }).Authorization).toBe("Bearer {{accessToken}}");
  });

  it("detects an opaque reference inside a later path", () => {
    const suggestions = analyzeDependencies(
      [
        { id: "a", name: "Create", orderIndex: 0, type: "HTTP_REQUEST", config: { url: "https://api.example.test/operations", method: "POST" } },
        { id: "b", name: "Status", orderIndex: 1, type: "HTTP_REQUEST", config: { url: "https://api.example.test/operations/ABC-9912/status", method: "GET" } },
      ],
      [{ stepId: "a", status: 201, body: { result: { reference: "ABC-9912" } } }],
    );
    expect(suggestions[0]).toMatchObject({
      sourcePath: "$.result.reference",
      variable: "reference",
      confidence: "HIGH",
      location: "url",
    });
  });

  it("detects query and JSON body dependencies and reuses one variable for two consumers", () => {
    const suggestions = analyzeDependencies(
      [
        { id: "a", name: "Issue", orderIndex: 0, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/items" } },
        { id: "b", name: "Search", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "GET", url: "https://api.example.test/items", query: { ref: "ABC-9912" } } },
        { id: "c", name: "Attach", orderIndex: 2, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/items", body: { parent: "ABC-9912" } } },
      ],
      [{ stepId: "a", status: 200, body: { result: { reference: "ABC-9912" } } }],
    );
    const query = suggestions.find((item) => item.location === "query");
    const body = suggestions.find((item) => item.location === "body");
    expect(query?.confidence).toBe("HIGH");
    expect(body?.variable).toBe(query?.variable);
    expect(body?.consumerStepId).toBe("c");
  });

  it("rewrites the consumer and inserts one extraction", () => {
    const [token] = analyzeDependencies([login, profile], [
      { stepId: "s1", body: { data: { accessToken: "TOKEN-ABC", userId: 582 } } },
    ]).filter((item) => item.location === "header");
    const applied = applyDependency(
      [login, profile],
      token,
      { data: { accessToken: "TOKEN-ABC", userId: 582 } },
    );
    expect(applied.insertedExtract).toBe(true);
    const extract = applied.steps.find((step) => step.type === "EXTRACT_VARIABLE");
    expect(extract?.config).toMatchObject({ variable: "accessToken", path: "body.data.accessToken" });
    const next = applied.steps.find((step) => step.id === "s2");
    expect((next?.config.headers as { Authorization: string }).Authorization).toBe("Bearer {{accessToken}}");
    const again = applyDependency(applied.steps, token, { data: { accessToken: "TOKEN-ABC" } });
    expect(again.insertedExtract).toBe(false);
    expect(again.steps.filter((step) => step.type === "EXTRACT_VARIABLE")).toHaveLength(1);
  });

  it("reports a missing producer, a broken path, a duplicate extraction, and a backward reference", () => {
    const issues = validateFlow(
      [
        { id: "h", name: "Call", type: "HTTP_REQUEST", orderIndex: 0, enabled: true, config: { method: "GET", url: "https://api.example.test/orders/{{orderId}}/{{missingVar}}" } },
        { id: "e1", name: "Extract", type: "EXTRACT_VARIABLE", orderIndex: 1, enabled: true, config: { variable: "orderId", path: "body.missing.id" } },
        { id: "e2", name: "Extract again", type: "EXTRACT_VARIABLE", orderIndex: 2, enabled: true, config: { variable: "orderId", path: "body.id" } },
        { id: "db", name: "DB", type: "DATABASE_ACTION", orderIndex: 3, enabled: true, config: {} },
      ],
      { sampleBodies: { h: { id: "1" } } },
    );
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["used_before_source", "circular", "broken_extraction", "duplicate_extraction", "missing_connector"]),
    );
  });

  it("flags a variable that is produced only by a later step", () => {
    const issues = validateFlow([
      { id: "early", name: "Early", type: "HTTP_REQUEST", orderIndex: 0, enabled: true, config: { url: "https://api.example.test/{{later}}", method: "GET" } },
      { id: "late", name: "Late", type: "SET_VARIABLE", orderIndex: 1, enabled: true, config: { variable: "later", value: "x" } },
    ]);
    expect(issues.some((issue) => issue.code === "circular" && issue.detail === "later")).toBe(true);
  });

  it("summarizes large arrays and error responses without dropping the raw body", () => {
    const users = Array.from({ length: 248 }, (_, index) => ({
      id: index + 1,
      name: `n${index}`,
      status: "ACTIVE",
      createdAt: "2026-01-01",
    }));
    const summary = analyzeResponse({ status: 200, body: { users }, raw: JSON.stringify({ users }) });
    expect(summary.arraySummaries[0]).toMatchObject({ length: 248, previewCount: 5 });
    expect(summary.arraySummaries[0]?.fields).toEqual(expect.arrayContaining(["id", "name", "status"]));
    const failed = analyzeResponse({
      status: 422,
      body: { message: "amount is required", code: "VAL-1", token: "secret-token" },
    });
    expect(failed.errorInformation).toEqual({ message: "amount is required", code: "VAL-1" });
    expect(failed.importantFields.find((field) => field.label === "token")?.preview).toBe("••••••••");
    expect(JSON.stringify(failed)).not.toContain("secret-token");
  });

  describe("multiple and ambiguous identifiers", () => {
    const create = { id: "a", name: "Create", orderIndex: 0, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/bikers" } };

    it("links each of several ids to the request that uses it", () => {
      const suggestions = analyzeDependencies(
        [
          create,
          { id: "b", name: "Activate", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/bikers/BK-98210/activate", body: { userId: "US-12577" } } },
        ],
        [{ stepId: "a", status: 201, body: { data: { bikerId: "BK-98210", userId: "US-12577" } } }],
      );
      expect(suggestions.find((item) => item.location === "url")?.sourcePath).toBe("$.data.bikerId");
      expect(suggestions.find((item) => item.location === "body")?.sourcePath).toBe("$.data.userId");
    });

    it("scores a value shared by two response keys lower than a unique one", () => {
      const [shared] = analyzeDependencies(
        [create, { id: "b", name: "Next", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/x", body: { bikerId: "SAME-7788" } } }],
        [{ stepId: "a", status: 201, body: { data: { bikerId: "SAME-7788", userId: "SAME-7788" } } }],
      );
      const [unique] = analyzeDependencies(
        [create, { id: "b", name: "Next", orderIndex: 1, type: "HTTP_REQUEST", config: { method: "POST", url: "https://api.example.test/x", body: { bikerId: "SAME-7788" } } }],
        [{ stepId: "a", status: 201, body: { data: { bikerId: "SAME-7788" } } }],
      );
      expect(shared!.score).toBeLessThan(unique!.score);
    });
  });
});
