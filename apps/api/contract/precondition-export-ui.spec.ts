/**
 * The export dialog's choices (apps/web/components/scenarios/export) and its
 * error messages. The web app has no test runner of its own; the dialog's
 * logic lives in a plain module so it is tested here.
 */
import { exportFrameworkOptions } from "@qa-workbench/shared";
import { en, fa } from "../../web/lib/i18n/dictionaries";
import { localizeUserMessage } from "../../web/lib/i18n/messages";
import {
  canGenerate,
  defaultProvider,
  filenameOf,
  frameworkAvailable,
  initialSelection,
  languagesOf,
  resultMatches,
  withFramework,
  type ExportOptions,
  type ExportResult,
} from "../../web/components/scenarios/export/export-selection";
import { EXPORT_ERRORS } from "../src/scenarios/export/precondition-export.service";

const options: ExportOptions = {
  frameworks: exportFrameworkOptions("Login flow"),
  providers: [
    { id: "claude", name: "Claude", model: "sonnet", usable: true, blockedReason: null },
    { id: "gemini", name: "Gemini", model: "pro", usable: false, blockedReason: "external_not_allowed" },
  ],
  defaultProviderId: "claude",
};

describe("export dialog choices", () => {
  it("starts with the first framework, its first language and the workspace default provider", () => {
    expect(initialSelection(options)).toEqual({ framework: "playwright", language: "typescript", providerId: "" });
    expect(filenameOf(options, initialSelection(options))).toBe("login-flow.spec.ts");
    expect(defaultProvider(options)?.id).toBe("claude");
  });

  it("lists only the selected framework's languages", () => {
    expect(languagesOf(options, "playwright").map((item) => item.label)).toEqual(["TypeScript", "JavaScript", "Python", "Robot Framework"]);
    expect(languagesOf(options, "selenium").map((item) => item.label)).toEqual(["Java", "Python", "JavaScript", "TypeScript", "Robot Framework"]);
    expect(languagesOf(options, "cypress").map((item) => item.label)).toEqual(["TypeScript", "JavaScript"]);
  });

  it("keeps the language when the new framework supports it, otherwise takes its first", () => {
    const python = { framework: "playwright", language: "python", providerId: "claude" };
    expect(withFramework(options, python, "selenium")).toEqual({ framework: "selenium", language: "python", providerId: "claude" });
    expect(withFramework(options, python, "cypress")).toEqual({ framework: "cypress", language: "typescript", providerId: "claude" });
    expect(filenameOf(options, { framework: "selenium", language: "java", providerId: "" })).toBe("LoginFlowTest.java");
    expect(withFramework(options, python, "unknown")).toBe(python);
  });

  it("enables Generate only with a usable provider", () => {
    expect(canGenerate(options, initialSelection(options))).toBe(true);
    expect(canGenerate(options, { ...initialSelection(options), providerId: "gemini" })).toBe(false);
    expect(canGenerate({ ...options, providers: [options.providers[1]!] }, initialSelection(options))).toBe(false);
    expect(canGenerate(options, { framework: "cypress", language: "java", providerId: "" })).toBe(false);
  });

  it("shows a result only for the choice it was generated for", () => {
    const selection = initialSelection(options);
    const result = { framework: "playwright", language: "typescript", code: "x", filename: "a", warnings: [], provider: { id: "claude", name: "Claude", model: "sonnet" } } as ExportResult;
    expect(resultMatches(result, selection, selection)).toBe(true);
    expect(resultMatches(result, { ...selection, language: "python" }, selection)).toBe(false);
    expect(resultMatches(null, selection, selection)).toBe(false);
  });
});

describe("export error messages", () => {
  type Tree = { [key: string]: string | Tree };
  const flatten = (tree: Tree, prefix = ""): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(tree)) {
      if (typeof value === "string") out.set(prefix + key, value);
      else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
    }
    return out;
  };

  it("translates every export error in both locales", () => {
    for (const [locale, dict] of [["en", flatten(en as unknown as Tree)], ["fa", flatten(fa as unknown as Tree)]] as const) {
      const t = (path: string, vars?: Record<string, string | number>) => {
        const text = dict.get(path);
        if (!text) return `MISSING:${path}`;
        return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? ""));
      };
      for (const raw of [
        ...Object.values(EXPORT_ERRORS),
        "The generated code was rejected: The code uses Selenium APIs instead of Playwright",
        "Code generation failed: Claude: AI service error 400",
      ]) {
        const text = localizeUserMessage(raw, t);
        expect(text).not.toContain("MISSING:");
        // Persian always differs from the English backend text; English may read the same.
        if (locale === "fa") expect(text).toMatch(/[؀-ۿ]/);
      }
    }
  });
});

describe("export dialog choices for mobile steps and single steps", () => {
  const mobile: ExportOptions = {
    frameworks: exportFrameworkOptions("Open cart", new Set(["mobile"])),
    step: { id: "m1", name: "Open cart", type: "MOBILE_FLOW" },
    providers: options.providers,
    defaultProviderId: "claude",
  };

  it("starts with the first framework that can drive the steps", () => {
    expect(initialSelection(mobile)).toEqual({ framework: "appium", language: "java", providerId: "" });
    expect(filenameOf(mobile, initialSelection(mobile))).toBe("OpenCartTest.java");
    expect(frameworkAvailable(mobile, "playwright")).toBe(false);
    expect(frameworkAvailable(options, "playwright")).toBe(true);
  });

  it("cannot switch to or generate with a framework that cannot drive the steps", () => {
    const selection = initialSelection(mobile);
    expect(withFramework(mobile, selection, "playwright")).toBe(selection);
    expect(canGenerate(mobile, { framework: "playwright", language: "typescript", providerId: "" })).toBe(false);
    expect(canGenerate(mobile, selection)).toBe(true);
  });

  it("explains every unavailable framework and every mobile message in both locales", () => {
    for (const dict of [en, fa]) {
      const flat = JSON.stringify(dict);
      for (const reason of ["mobileOnly", "noMobileSteps"]) expect(flat).toContain(`"${reason}":`);
    }
    for (const [locale, dict] of [["en", en], ["fa", fa]] as const) {
      const lookup = (path: string, vars?: Record<string, string | number>) => {
        const text = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], dict);
        if (typeof text !== "string") return `MISSING:${path}`;
        return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? ""));
      };
      for (const raw of [
        EXPORT_ERRORS.frameworkCannotExport,
        "Mobile recording not found",
        "Choose the platform (Android or iOS)",
        "Enter the Appium server URL (http:// or https://)",
        "Capabilities must be a JSON object",
        "Another mobile recording is still open; stop it first",
        "Wait for the current operation to finish",
        "The recording is not connected to a device",
        "Choose an element on the current screen",
        "No locator finds this element; choose another one",
        "Enter the text to type",
        "Enter the text the element must show",
        "iOS has no back button; tap the app's own back control",
        "The screen has not been read yet",
        "Unknown mobile action",
        "The Appium session has ended (the app or device was closed)",
        "Could not reach the Appium server at http://127.0.0.1:4723. Start it (appium) and check the URL.",
        "Appium could not start the session: Could not find a connected Android device",
        'Text check failed: the element shows "Hi", not "Bye"',
        "Element not found: «Sign in»",
        'Ambiguous element: «Help» — xpath "//x" matches 2 elements',
      ]) {
        const text = localizeUserMessage(raw, lookup);
        expect(text).not.toContain("MISSING:");
        if (locale === "fa") expect(text).toMatch(/[؀-ۿ]/);
      }
    }
    expect(localizeUserMessage("Could not reach the Appium server at http://127.0.0.1:4723. Start it (appium) and check the URL.", (path, vars) => `${path}|${vars?.value}`)).toBe(
      "errors.mobileUnreachable|http://127.0.0.1:4723",
    );
  });
});
