import { bindRequest, captureResponse } from "./auto-bind";
import { HttpRequestExecutor } from "./executors/http-request.executor";
import { ExecutionContext } from "./types";

describe("HTTP step safety", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not send a captured token to a different host", () => {
    const context = new ExecutionContext();
    captureResponse({ token: "tok-1" }, context, "https://api.example.test");
    const same = bindRequest({ url: "https://api.example.test/me", headers: {} }, context);
    const other = bindRequest({ url: "https://thirdparty.example/hook", headers: {} }, context);
    expect(same.headers).toEqual({ Authorization: "Bearer tok-1" });
    expect(other.headers).toEqual({});
  });

  it("uses the environment base URL as the trusted origin for an environment token", () => {
    const context = new ExecutionContext({ token: "env-tok", base_url: "https://api.example.test" });
    expect(bindRequest({ url: "https://api.example.test/x", headers: {} }, context).headers).toEqual({
      Authorization: "Bearer env-tok",
    });
    expect(bindRequest({ url: "https://evil.example/x", headers: {} }, context).headers).toEqual({});
  });

  it("reports a timeout as FAILED, not CANCELLED", async () => {
    jest.spyOn(global, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const result = await new HttpRequestExecutor().execute(
      { method: "GET", url: "https://93.184.216.34/slow", timeoutMs: 1000 },
      new ExecutionContext(),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("Request timed out after 1000 ms");
  });

  it("reports a user cancellation as CANCELLED", async () => {
    const context = new ExecutionContext();
    jest.spyOn(global, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
          setTimeout(() => context.cancel(), 10);
        }),
    );
    const result = await new HttpRequestExecutor().execute(
      { method: "GET", url: "https://93.184.216.34/slow", timeoutMs: 5000 },
      context,
    );
    expect(result.status).toBe("CANCELLED");
  });

  it("sends object bodies as JSON and redacts secret values from stored input", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const context = new ExecutionContext({ API_KEY: "s3cr3t-value" }, { secretKeys: ["API_KEY"] });
    const result = await new HttpRequestExecutor().execute(
      { method: "POST", url: "https://93.184.216.34/x", headers: { "X-Custom": "{{API_KEY}}" }, body: { a: 1 } },
      context,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.stringify(result.resolvedInput)).not.toContain("s3cr3t-value");
  });

  it("blocks metadata addresses, including IPv4-mapped IPv6", async () => {
    for (const url of ["http://169.254.169.254/", "http://[::ffff:169.254.169.254]/", "http://2852039166/"]) {
      const result = await new HttpRequestExecutor().execute({ method: "GET", url }, new ExecutionContext());
      expect(result.status).toBe("FAILED");
      expect(result.error).toMatch(/SSRF protection blocked host|Invalid URL/);
    }
  });
});
