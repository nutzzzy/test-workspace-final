import { ExecutionContext, type UiLiveProgress } from "../types";
import { fakeAppium } from "../mobile/fake-appium";
import { MobileFlowExecutor, type MobileActionResult } from "./mobile-flow.executor";

const target = (...candidates: Array<{ using: string; value: string; unique?: boolean }>) => ({ candidates, fingerprint: { tag: "android.widget.Button", name: "Sign in" } });

const flow = {
  platform: "android",
  serverUrl: "http://127.0.0.1:4723",
  capabilities: { "appium:appPackage": "com.shop.app" },
  actions: [
    { id: "a1", kind: "type", value: "{{email}}", target: target({ using: "id", value: "com.shop.app:id/email" }) },
    { id: "a2", kind: "type", secret: true, valueEnc: "enc:hunter22", target: target({ using: "id", value: "com.shop.app:id/password" }) },
    { id: "a3", kind: "tap", target: target({ using: "accessibility id", value: "login-button" }, { using: "id", value: "com.shop.app:id/login" }) },
    { id: "a4", kind: "assertText", value: "Welcome", target: target({ using: "id", value: "com.shop.app:id/title" }) },
  ],
};

const instant = () => Promise.resolve();
const decrypt = (payload: string) => payload.replace(/^enc:/, "");

function deviceWith(elements: Record<string, string[]>, texts: Record<string, string> = { title: "Welcome, Sara" }) {
  return fakeAppium({ elements, texts });
}

const ALL = {
  "id|com.shop.app:id/email": ["email"],
  "id|com.shop.app:id/password": ["pw"],
  "accessibility id|login-button": ["login"],
  "id|com.shop.app:id/title": ["title"],
};

describe("MobileFlowExecutor", () => {
  it("replays the actions in order on the device and reports its progress", async () => {
    const fake = deviceWith(ALL);
    const executor = new MobileFlowExecutor(decrypt, fake.open, instant);
    const context = new ExecutionContext({ email: "sara@example.com" });
    const progress: UiLiveProgress[] = [];
    context.reportUi = (item) => progress.push(item);

    const result = await executor.execute(flow, context);

    expect(result.status).toBe("PASSED");
    const output = result.output as { kind: string; actions: MobileActionResult[]; screenshot?: string };
    expect(output.kind).toBe("mobile");
    expect(output.actions.map((action) => [action.label, action.status, action.how])).toEqual([
      ['Type "{{email}}" into «Sign in»', "PASSED", "id: com.shop.app:id/email"],
      ['Type "••••••" into «Sign in»', "PASSED", "id: com.shop.app:id/password"],
      ["Tap «Sign in»", "PASSED", "accessibility id: login-button"],
      ['Check «Sign in» shows "Welcome"', "PASSED", "id: com.shop.app:id/title"],
    ]);
    expect(output.screenshot).toBe("data:image/png;base64,iVBORw0KGgo=");
    const typed = fake.calls.filter((call) => call.path.endsWith("/value")).map((call) => (call.body as { text: string }).text);
    expect(typed).toEqual(["sara@example.com", "hunter22"]);
    // The decrypted secret is masked wherever the run is stored.
    expect(context.redact({ note: "typed hunter22" })).toEqual({ note: "typed ***" });
    expect(progress[0]).toMatchObject({ phase: "connecting", current: 0, total: 4 });
    expect(progress.some((item) => item.phase === "actions" && item.actions[2]!.status === "running")).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: "finishing", current: 4 });
    await context.dispose();
    expect(fake.calls.at(-1)).toEqual({ method: "DELETE", path: "/session/s1" });
  });

  it("finds an element another way when the remembered locator fails, and remembers that way", async () => {
    const fake = deviceWith({ ...ALL, "accessibility id|login-button": [], "id|com.shop.app:id/login": ["login"] });
    const result = await new MobileFlowExecutor(decrypt, fake.open, instant).execute(flow, new ExecutionContext({ email: "x" }));
    expect(result.status).toBe("PASSED");
    const tap = (result.output as { actions: MobileActionResult[] }).actions[2]!;
    expect(tap).toMatchObject({ healed: true, how: "id: com.shop.app:id/login" });
    expect(result.uiLearned).toEqual([{ actionId: "a3", candidateIndex: 1 }]);
  });

  it("fails on a missing element with its code, skips what follows, and never acts on an ambiguous match", async () => {
    const fake = deviceWith({ ...ALL, "accessibility id|login-button": ["one", "two"] });
    const result = await new MobileFlowExecutor(decrypt, fake.open, instant).execute({ ...flow, actionTimeoutMs: 1000 }, new ExecutionContext({ email: "x" }));
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/^Tap «Sign in»: Ambiguous element: «Sign in» — accessibility id "login-button" matches 2 elements$/);
    const actions = (result.output as { actions: MobileActionResult[] }).actions;
    expect(actions.map((action) => action.status)).toEqual(["PASSED", "PASSED", "FAILED", "SKIPPED"]);
    expect(actions[2]!.code).toBe("AMBIGUOUS_LOCATOR");
    expect(fake.calls.some((call) => /\/element\/(?:one|two)\/click$/.test(call.path))).toBe(false);
  });

  it("goes on after an optional action fails", async () => {
    const fake = deviceWith({ ...ALL, "accessibility id|login-button": [] });
    const optional = { ...flow, actionTimeoutMs: 1000, actions: flow.actions.map((action) => (action.id === "a3" ? { ...action, target: target({ using: "accessibility id", value: "login-button" }), optional: true } : action)) };
    const result = await new MobileFlowExecutor(decrypt, fake.open, instant).execute(optional, new ExecutionContext({ email: "x" }));
    expect(result.status).toBe("PASSED");
    expect((result.output as { actions: MobileActionResult[] }).actions[2]).toMatchObject({ status: "FAILED", optional: true, code: "ELEMENT_NOT_FOUND" });
  });

  it("waits for a text check to come true", async () => {
    const fake = deviceWith(ALL, { title: "Loading…" });
    let reads = 0;
    const sleep = async () => {
      reads += 1;
      if (reads === 3) fake.texts.title = "Welcome back";
    };
    const result = await new MobileFlowExecutor(decrypt, fake.open, sleep).execute(flow, new ExecutionContext({ email: "x" }));
    expect(result.status).toBe("PASSED");
    expect(reads).toBe(3);
  });

  it("reports a session that cannot start, without running anything", async () => {
    const fake = fakeAppium({ sessionError: { status: 500, message: "An unknown server-side error occurred: app not installed" } });
    const result = await new MobileFlowExecutor(decrypt, fake.open, instant).execute(flow, new ExecutionContext({ email: "x" }));
    expect(result).toEqual({
      status: "FAILED",
      error: "Appium could not start the session: An unknown server-side error occurred: app not installed",
      output: { kind: "mobile", platform: "android", actions: [] },
    });
  });

  it("shares one Appium session between mobile steps of a run unless a step asks for a new one", async () => {
    const fake = deviceWith(ALL);
    const executor = new MobileFlowExecutor(decrypt, fake.open, instant);
    const context = new ExecutionContext({ email: "x" });
    const only = (id: string) => ({ ...flow, actions: flow.actions.filter((action) => action.id === id) });
    await executor.execute(only("a3"), context);
    await executor.execute(only("a4"), context);
    expect(fake.sessions).toBe(1);
    await executor.execute({ ...only("a3"), newSession: true }, context);
    expect(fake.sessions).toBe(2);
    expect(fake.calls.filter((call) => call.method === "DELETE" && call.path === "/session/s1")).toHaveLength(1);
    await context.dispose();
    expect(fake.calls.at(-1)).toEqual({ method: "DELETE", path: "/session/s2" });
  });

  it("rejects an invalid step before connecting", async () => {
    const fake = deviceWith(ALL);
    const executor = new MobileFlowExecutor(decrypt, fake.open, instant);
    expect(await executor.execute({ ...flow, serverUrl: "" }, new ExecutionContext())).toEqual({ status: "FAILED", error: "Invalid mobile step: the Appium server URL is required" });
    const untargeted = { ...flow, actions: [{ id: "x", kind: "tap" }] };
    expect((await executor.execute(untargeted, new ExecutionContext())).error).toBe('Invalid mobile step: action "tap" has no element');
    expect(fake.calls).toEqual([]);
  });
});

describe("mobile steps in a run", () => {
  it("report live progress, persist learned locators, and close the session with the run", async () => {
    const { orchestrateSteps } = await import("../orchestrate");
    const { StepExecutorRegistry } = await import("../step-executor.registry");
    const { DelayExecutor } = await import("./delay.executor");
    const fake = deviceWith({ ...ALL, "accessibility id|login-button": [], "id|com.shop.app:id/login": ["login"] });
    const registry = new StepExecutorRegistry();
    registry.register(new MobileFlowExecutor(decrypt, fake.open, instant));
    registry.register(new DelayExecutor());
    const live: unknown[] = [];
    const learned: Array<{ stepId: string; learned: unknown }> = [];
    const outcome = await orchestrateSteps(
      [
        { id: "m1", name: "Sign in", type: "MOBILE_FLOW", enabled: true, orderIndex: 0, config: flow },
        { id: "d1", name: "Wait", type: "DELAY", enabled: true, orderIndex: 1, config: { ms: 1 } },
      ],
      registry,
      new ExecutionContext({ email: "x" }),
      {
        stopOnFailure: true,
        onProgress: (progress) => void live.push(progress),
        onLearnUi: async (stepId, items) => void learned.push({ stepId, learned: items }),
      },
    );
    expect(outcome.status).toBe("PASSED");
    expect(outcome.stepResults[0]).not.toHaveProperty("uiLearned");
    expect(learned).toEqual([{ stepId: "m1", learned: [{ actionId: "a3", candidateIndex: 1 }] }]);
    expect(live).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "m1", ui: expect.objectContaining({ phase: "actions" }) })]));
    expect(fake.calls.at(-1)).toEqual({ method: "DELETE", path: "/session/s1" });
  });
});
