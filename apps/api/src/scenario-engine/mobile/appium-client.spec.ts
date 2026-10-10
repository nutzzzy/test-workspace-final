import { AppiumError, normalizeCapabilities, normalizeServerUrl, openAppiumSession } from "./appium-client";
import { fakeAppium } from "./fake-appium";

describe("Appium client", () => {
  it("creates a W3C session with Appium-prefixed capabilities", async () => {
    const fake = fakeAppium();
    const session = await openAppiumSession(
      { serverUrl: "http://127.0.0.1:4723/", platform: "android", capabilities: { deviceName: "Pixel 7", "appium:appPackage": "com.shop.app", platformName: "ios" } },
      { fetch: fake.fetch },
    );
    expect(session.id).toBe("s1");
    expect(fake.calls[0]).toEqual({
      method: "POST",
      path: "/session",
      body: {
        capabilities: {
          alwaysMatch: { "appium:deviceName": "Pixel 7", "appium:appPackage": "com.shop.app", platformName: "Android", "appium:automationName": "UiAutomator2" },
          firstMatch: [{}],
        },
      },
    });
    expect(normalizeCapabilities("ios", { "appium:automationName": "XCUITest", bundleId: "com.shop" })).toEqual({
      "appium:automationName": "XCUITest",
      "appium:bundleId": "com.shop",
      platformName: "iOS",
    });
  });

  it("explains an Appium server that cannot be reached", async () => {
    const fake = fakeAppium({ unreachable: true });
    await expect(openAppiumSession({ serverUrl: "http://127.0.0.1:4723", platform: "android", capabilities: {} }, { fetch: fake.fetch })).rejects.toMatchObject({
      code: "UNREACHABLE",
      message: "Could not reach the Appium server at http://127.0.0.1:4723. Start it (appium) and check the URL.",
    });
  });

  it("passes on why Appium could not start the session", async () => {
    const fake = fakeAppium({ sessionError: { status: 500, message: "Could not find a connected Android device in 20000ms.\nstack…" } });
    const failure = await openAppiumSession({ serverUrl: "http://localhost:4723", platform: "android", capabilities: {} }, { fetch: fake.fetch }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppiumError);
    expect(failure).toMatchObject({ code: "SESSION_FAILED", message: "Appium could not start the session: Could not find a connected Android device in 20000ms." });
  });

  it("rejects a server URL that is not http(s)", () => {
    expect(() => normalizeServerUrl("ftp://device")).toThrow("Enter the Appium server URL");
    expect(() => normalizeServerUrl("")).toThrow("Enter the Appium server URL");
    expect(normalizeServerUrl(" http://hub:4444/wd/hub/?x=1#y ")).toBe("http://hub:4444/wd/hub");
  });

  it("finds elements, reads the screen, acts, and ends the session", async () => {
    const fake = fakeAppium({ source: "<hierarchy/>", elements: { "accessibility id|login": ["e1"] }, texts: { e1: "Sign in" } });
    const session = await openAppiumSession({ serverUrl: "http://127.0.0.1:4723", platform: "android", capabilities: {} }, { fetch: fake.fetch });
    expect(await session.findAll("accessibility id", "login")).toEqual(["e1"]);
    expect(await session.findAll("id", "missing")).toEqual([]);
    expect(await session.source()).toBe("<hierarchy/>");
    expect(await session.screenshot()).toBe("iVBORw0KGgo=");
    expect(await session.text("e1")).toBe("Sign in");
    await session.type("e1", "ab");
    await session.longPress("e1");
    await session.swipe("up");
    await session.quit();
    const paths = fake.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual(expect.arrayContaining(["POST /session/s1/element/e1/value", "POST /session/s1/actions", "DELETE /session/s1"]));
    expect(fake.calls.find((call) => call.path.endsWith("/value"))!.body).toEqual({ text: "ab", value: ["a", "b"] });
    const swipe = fake.calls.filter((call) => call.path === "/session/s1/actions" && call.method === "POST")[1]!.body as { actions: Array<{ actions: Array<{ y?: number }> }> };
    // Swiping up starts low and ends high.
    expect(swipe.actions[0]!.actions[0]!.y!).toBeGreaterThan(swipe.actions[0]!.actions[3]!.y!);
  });
});
