import { NotFoundException } from "@nestjs/common";
import { UiRecorderService } from "../ui/ui-recorder.service";
import { fakeAppium, type FakeAppium } from "./fake-appium";
import { ANDROID_LOGIN, IOS_LOGIN } from "./mobile-fixtures";
import { MobileRecorderService } from "./mobile-recorder.service";

const DEVICE = { platform: "android", serverUrl: "http://127.0.0.1:4723", capabilities: { "appium:appPackage": "com.shop.app" } };

function setup(fake: FakeAppium = fakeAppium({ source: ANDROID_LOGIN })) {
  const recorder = new MobileRecorderService();
  recorder.open = fake.open;
  recorder.sleep = () => Promise.resolve();
  return { recorder, fake };
}

/** Wait for the background operation (connect, action, capture) to end. */
async function settled(recorder: MobileRecorderService, id: string) {
  for (let i = 0; i < 200; i += 1) {
    const view = recorder.status(id);
    if (view.state !== "connecting" && view.state !== "working") return view;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the recording did not settle");
}

describe("MobileRecorderService", () => {
  afterEach(() => jest.useRealTimers());

  it("connects, reads the screen and shows every stage it went through", async () => {
    const { recorder, fake } = setup();
    const started = recorder.start({ scenarioId: "sc1", ...DEVICE });
    expect(started.state).toBe("connecting");
    expect(started.stages.map((stage) => stage.id)).toEqual(["connect", "capture", "hierarchy", "detect", "rank"]);
    const view = await settled(recorder, started.id);
    expect(view.state).toBe("ready");
    expect(view.stages.every((stage) => stage.status === "done")).toBe(true);
    expect(view.stages.find((stage) => stage.id === "detect")!.detail).toBe("8");
    expect(view.screenVersion).toBe(1);
    const screen = recorder.screen(started.id);
    expect(screen.screenshot).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(screen.width).toBe(1080);
    expect(screen.elements.find((element) => element.name === "login-button")!.locators[0]).toMatchObject({ using: "accessibility id", value: "login-button", unique: true });
    expect(fake.sessions).toBe(1);
    await recorder.discard(started.id);
  });

  it("fails visibly when Appium cannot be reached, without pretending to record", async () => {
    const { recorder } = setup(fakeAppium({ unreachable: true }));
    const started = recorder.start({ scenarioId: "sc1", ...DEVICE });
    const view = await settled(recorder, started.id);
    expect(view.state).toBe("failed");
    expect(view.error).toMatch(/^Could not reach the Appium server/);
    expect(view.stages[0]).toEqual({ id: "connect", status: "failed" });
    expect(view.stages.slice(1).every((stage) => stage.status === "pending")).toBe(true);
    expect(() => recorder.screen(started.id)).toThrow("The screen has not been read yet");
    expect(() => recorder.act(started.id, { kind: "tap", elementId: "0.0.3" })).toThrow("The recording is not connected to a device");
  });

  it("validates the start request", () => {
    const { recorder } = setup();
    expect(() => recorder.start({ scenarioId: "sc1", ...DEVICE, platform: "windows" })).toThrow("Choose the platform");
    expect(() => recorder.start({ scenarioId: "sc1", ...DEVICE, serverUrl: "device" })).toThrow("Enter the Appium server URL");
    expect(() => recorder.start({ scenarioId: "sc1", ...DEVICE, capabilities: [] })).toThrow("Capabilities must be a JSON object");
  });

  it("records actions in the order they were done, after doing them on the device", async () => {
    const fake = fakeAppium({
      source: ANDROID_LOGIN,
      elements: { "id|com.shop.app:id/email": ["email"], "id|com.shop.app:id/password": ["pw"], "accessibility id|login-button": ["login"] },
    });
    const { recorder } = setup(fake);
    const { id } = recorder.start({ scenarioId: "sc1", ...DEVICE });
    await settled(recorder, id);
    const element = (name: string) => recorder.screen(id).elements.find((item) => item.name === name)!;

    recorder.act(id, { kind: "type", elementId: element("email").id, value: "sara@example.com" });
    await settled(recorder, id);
    recorder.act(id, { kind: "type", elementId: element("password").id, value: "hunter22" });
    await settled(recorder, id);
    const afterTap = recorder.act(id, { kind: "tap", elementId: element("login-button").id });
    expect(afterTap.stages.map((stage) => stage.id)).toEqual(["validate", "perform", "capture", "hierarchy", "detect", "rank"]);
    const view = await settled(recorder, id);

    expect(view.actions.map((action) => action.label)).toEqual(['Type "sara@example.com" into «email»', 'Type "••••••" into «password»', "Tap «login-button»"]);
    // The password field is secret: its value is never part of the view.
    expect(view.actions[1]).toMatchObject({ secret: true });
    expect(JSON.stringify(view)).not.toContain("hunter22");
    expect(view.screenVersion).toBe(4);
    expect(view.lastAction).toEqual({ label: "Tap «login-button»", how: "accessibility id: login-button", fallback: false });
    const performed = fake.calls.filter((call) => /\/element\/\w+\/(?:value|click)$/.test(call.path)).map((call) => call.path.split("/").slice(-2).join("/"));
    expect(performed).toEqual(["email/value", "pw/value", "login/click"]);

    await recorder.stop(id);
    expect(fake.calls.at(-1)).toEqual({ method: "DELETE", path: "/session/s1" });
    const taken = recorder.take(id);
    expect(taken.actions.map((action) => [action.kind, action.value, action.secret])).toEqual([
      ["type", "sara@example.com", undefined],
      ["type", "hunter22", true],
      ["tap", undefined, undefined],
    ]);
    expect(taken.actions[2]!.target).toMatchObject({ fingerprint: { tag: "android.widget.Button", name: "login-button", resourceId: "com.shop.app:id/login" } });
    expect(taken.actions[2]!.target!.candidates.length).toBeGreaterThan(2);
    expect(() => recorder.status(id)).toThrow(NotFoundException);
  });

  it("reads the screen after an action only once it stops changing", async () => {
    const fake = fakeAppium({ source: ANDROID_LOGIN, elements: { "accessibility id|login-button": ["login"] } });
    const { recorder } = setup(fake);
    const { id } = recorder.start({ scenarioId: "sc1", ...DEVICE });
    await settled(recorder, id);
    // Mid-transition the app reports an empty screen, then a half-drawn one, then the next screen.
    fake.onClick = () => fake.sourceQueue.push("<hierarchy/>", '<hierarchy><android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2220]"/></hierarchy>');
    recorder.act(id, { kind: "tap", elementId: recorder.screen(id).elements.find((item) => item.name === "login-button")!.id });
    const view = await settled(recorder, id);
    expect(view.stages.find((stage) => stage.id === "detect")!.detail).toBe("8");
    expect(recorder.screen(id).elements.length).toBe(8);
    await recorder.discard(id);
  });

  it("falls back to the next locator that finds only this element, and remembers which one worked", async () => {
    const fake = fakeAppium({ source: ANDROID_LOGIN, elements: { "accessibility id|login-button": ["a", "b"], "id|com.shop.app:id/login": ["login"] } });
    const { recorder } = setup(fake);
    const { id } = recorder.start({ scenarioId: "sc1", ...DEVICE });
    await settled(recorder, id);
    const login = recorder.screen(id).elements.find((item) => item.name === "login-button")!;
    recorder.act(id, { kind: "tap", elementId: login.id, locatorIndex: 0 });
    const view = await settled(recorder, id);
    expect(view.stages.find((stage) => stage.id === "validate")).toEqual({ id: "validate", status: "done", detail: "fallback" });
    expect(view.lastAction).toMatchObject({ how: "id: com.shop.app:id/login", fallback: true });
    await recorder.stop(id);
    expect(recorder.take(id).actions[0]!.target!.learned).toBe(1);
  });

  it("records nothing when the element is not on the device or a check fails, and stays usable", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    const fake = fakeAppium({ source: ANDROID_LOGIN, elements: { "id|com.shop.app:id/title": ["title"] }, texts: { title: "Welcome & sign in" } });
    const { recorder } = setup(fake);
    const { id } = recorder.start({ scenarioId: "sc1", ...DEVICE });
    await settled(recorder, id);
    const help = recorder.screen(id).elements.find((item) => item.name === "Help")!;
    recorder.act(id, { kind: "tap", elementId: help.id });
    // The element is searched for a few seconds while the screen settles.
    for (let i = 0; i < 20 && recorder.status(id).state === "working"; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
    }
    let view = await settled(recorder, id);
    expect(view.state).toBe("ready");
    expect(view.error).toMatch(/^Element not found: «Help»/);
    expect(view.stages.find((stage) => stage.id === "validate")!.status).toBe("failed");
    expect(view.actions).toEqual([]);

    const title = recorder.screen(id).elements.find((item) => item.attributes["resource-id"] === "com.shop.app:id/title")!;
    recorder.act(id, { kind: "assertText", elementId: title.id, value: "Goodbye" });
    view = await settled(recorder, id);
    expect(view.error).toBe('Text check failed: the element shows "Welcome & sign in", not "Goodbye"');
    expect(view.actions).toEqual([]);
    recorder.act(id, { kind: "assertText", elementId: title.id, value: "Welcome" });
    view = await settled(recorder, id);
    expect(view.error).toBeNull();
    expect(view.actions.map((action) => action.kind)).toEqual(["assertText"]);
    await recorder.discard(id);
  });

  it("checks requests before touching the device", async () => {
    const { recorder, fake } = setup(fakeAppium({ source: IOS_LOGIN, size: { width: 390, height: 844 } }));
    const { id } = recorder.start({ scenarioId: "sc1", ...DEVICE, platform: "ios" });
    await settled(recorder, id);
    const before = fake.calls.length;
    expect(() => recorder.act(id, { kind: "back" })).toThrow("iOS has no back button");
    expect(() => recorder.act(id, { kind: "fly" })).toThrow("Unknown mobile action");
    expect(() => recorder.act(id, { kind: "tap", elementId: "9.9" })).toThrow("Choose an element on the current screen");
    expect(() => recorder.act(id, { kind: "type", elementId: "0.0.0.0.1" })).toThrow("Enter the text to type");
    expect(() => recorder.take(id)).toThrow("Stop the recording first");
    expect(fake.calls.length).toBe(before);
    recorder.act(id, { kind: "swipe", direction: "down" });
    const view = await settled(recorder, id);
    expect(view.actions.map((action) => action.label)).toEqual(["Swipe down"]);
    recorder.removeAction(id, view.actions[0]!.id);
    expect(recorder.status(id).actions).toEqual([]);
    await recorder.discard(id);
  });

  it("keeps mobile recordings apart from browser recordings", async () => {
    const { recorder } = setup();
    const web = new UiRecorderService();
    const first = recorder.start({ scenarioId: "sc1", ...DEVICE });
    const second = recorder.start({ scenarioId: "sc1", ...DEVICE });
    await settled(recorder, first.id);
    await settled(recorder, second.id);
    expect(() => web.status(first.id)).toThrow("Recording not found");
    expect(() => recorder.status("web-recording-id")).toThrow("Mobile recording not found");
    expect(() => recorder.start({ scenarioId: "sc1", ...DEVICE })).toThrow("Another mobile recording is still open");
    await recorder.stop(first.id);
    // A stopped one makes room; the other recording is untouched.
    const third = recorder.start({ scenarioId: "sc2", ...DEVICE });
    expect(recorder.status(second.id).state).toBe("ready");
    await settled(recorder, third.id);
    await Promise.all([first.id, second.id, third.id].map((item) => recorder.discard(item)));
  });
});
