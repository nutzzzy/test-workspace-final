import { describeMobileAction, publicMobileConfig, readMobileConfig, sealMobileConfig } from "./mobile-types";

const encrypt = (plain: string) => `enc:${plain}`;
const base = { platform: "android", serverUrl: "http://127.0.0.1:4723", capabilities: {} };
const pin = { id: "p", kind: "type", secret: true, target: { candidates: [{ using: "id", value: "pin" }], fingerprint: { tag: "android.widget.EditText", name: "pin" } } };

describe("mobile step config", () => {
  it("encrypts typed secrets, keeps them when not retyped, and never sends them back", () => {
    const sealed = sealMobileConfig({ ...base, actions: [{ ...pin, value: "1234" }] }, null, encrypt);
    expect(sealed.actions).toEqual([{ ...pin, valueEnc: "enc:1234", label: 'Type "••••••" into «pin»' }]);
    const shown = publicMobileConfig(sealed);
    expect(shown.actions).toEqual([{ ...pin, value: "••••••", label: 'Type "••••••" into «pin»' }]);
    // Saved again from the client (placeholder value): the stored ciphertext stays.
    const resaved = sealMobileConfig(shown, sealed, encrypt);
    expect((resaved.actions as Array<{ valueEnc?: string; value?: string }>)[0]).toMatchObject({ valueEnc: "enc:1234" });
    expect((resaved.actions as Array<{ value?: string }>)[0]!.value).toBeUndefined();
  });

  it("rejects a step without a server, or an element action without an element", () => {
    expect(() => sealMobileConfig({ ...base, serverUrl: " ", actions: [] }, null, encrypt)).toThrow("the Appium server URL is required");
    expect(readMobileConfig({ ...base, platform: "web", actions: [] })).toMatchObject({ ok: false });
    expect(readMobileConfig({ ...base, actions: [{ id: "a", kind: "tap" }] })).toEqual({ ok: false, error: 'Invalid mobile step: action "tap" has no element' });
    expect(readMobileConfig({ ...base, actions: [{ id: "b", kind: "back" }, { id: "s", kind: "swipe", direction: "left" }] })).toMatchObject({ ok: true });
  });

  it("describes actions in words", () => {
    expect(describeMobileAction({ kind: "swipe", direction: "left" })).toBe("Swipe left");
    expect(describeMobileAction({ kind: "back" })).toBe("Go back");
    expect(describeMobileAction({ kind: "tap", target: { candidates: [], fingerprint: { tag: "android.widget.Button", resourceId: "com.app:id/buy" } } })).toBe("Tap «buy»");
  });
});
