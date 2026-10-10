import { ExecutionContext } from "./types";
import { bindRequest, captureResponse } from "./auto-bind";
import { HttpRequestExecutor } from "./executors/http-request.executor";

describe("API dependency auto-bind", () => {
  it("learns ids and tokens from a response and fills the next request", () => {
    const context = new ExecutionContext({ base_url: "https://api.test" });
    const learned = captureResponse(
      {
        token: "tok-1",
        user: { id: "user-9" },
        data: { orderId: "ORD-3" },
      },
      context,
    );

    expect(learned.token).toBe("tok-1");
    expect(context.get("userId")).toBe("user-9");
    expect(context.get("base_url")).toBe("https://api.test");

    const bound = bindRequest(
      {
        method: "POST",
        url: "{{base_url}}/users/{{userId}}/orders/{orderId}",
        headers: {},
        body: { userId: "", note: "keep-me" },
      },
      context,
    );

    expect(bound.url).toBe(
      "https://api.test/users/user-9/orders/ORD-3",
    );
    expect(bound.headers).toEqual({ Authorization: "Bearer tok-1" });
    expect(bound.body).toEqual({ userId: "user-9", note: "keep-me" });
  });

  it("does not replace an environment value or a value the user already set", () => {
    const context = new ExecutionContext({ token: "env-token" });
    captureResponse({ token: "from-api", userId: "u2" }, context);
    expect(context.get("token")).toBe("env-token");

    const bound = bindRequest(
      {
        url: "https://api.test/users/{{user_id}}",
        headers: { Authorization: "Bearer custom" },
        body: { userId: "explicit" },
      },
      context,
    );
    expect(bound.url).toBe("https://api.test/users/u2");
    expect(bound.headers).toEqual({ Authorization: "Bearer custom" });
    expect(bound.body).toEqual({ userId: "explicit" });
  });

  it("chains two HTTP steps without extract configuration", async () => {
    const executor = new HttpRequestExecutor();
    const context = new ExecutionContext();
    const fetchMock = jest.spyOn(global, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "abc", user_id: "42" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const login = await executor.execute(
      { method: "POST", url: "https://example.com/login", body: { phone: "1" } },
      context,
    );
    expect(login.status).toBe("PASSED");
    expect(context.get("token")).toBe("abc");

    await executor.execute(
      {
        method: "GET",
        url: "https://example.com/users/{{userId}}",
        headers: {},
      },
      context,
    );

    const second = fetchMock.mock.calls[1];
    expect(String(second?.[0])).toBe("https://example.com/users/42");
    const init = second?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer abc");
    fetchMock.mockRestore();
  });
});
