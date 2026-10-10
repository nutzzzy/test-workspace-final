/**
 * Persian and English must describe the same product: same keys, same
 * interpolated values, and every backend message the UI translates must
 * exist in both dictionaries. (The web app has no test runner of its own.)
 */
import { en, fa } from "../../web/lib/i18n/dictionaries";
import { localizeUserMessage } from "../../web/lib/i18n/messages";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");

describe("i18n parity", () => {
  const english = flatten(en as unknown as Tree);
  const persian = flatten(fa as unknown as Tree);

  it("has exactly the same keys in both locales", () => {
    expect([...english.keys()].filter((key) => !persian.has(key))).toEqual([]);
    expect([...persian.keys()].filter((key) => !english.has(key))).toEqual([]);
  });

  it("interpolates the same values in both locales", () => {
    const mismatched = [...english.keys()].filter(
      (key) => placeholders(english.get(key)!) !== placeholders(persian.get(key) ?? ""),
    );
    expect(mismatched).toEqual([]);
  });

  it("keeps Persian out of the English dictionary", () => {
    expect([...english].filter(([, value]) => /[؀-ۿ]/.test(value)).map(([key]) => key)).toEqual([]);
  });

  it("translates every mapped backend message in both locales", () => {
    const unresolved: string[] = [];
    for (const dict of [english, persian]) {
      const t = (path: string) => dict.get(path) ?? `MISSING:${path}`;
      for (const raw of [
        "Issue not found",
        "The record no longer exists. Reload the page and try again.",
        "Only a failed test run can create a bug",
        "Unresolved variable: {{accessToken}}",
        "Request timed out after 15000 ms",
        "Jira issue QA-1 was not found, or the configured account cannot see it.",
        "Invalid test case field: priority",
        "Variable {{accessToken}} was not produced: step 1 (Login) did not provide it",
        "Variable {{userId}} is used before step 3 (Create user) produces it",
        "Extraction failed for {{orderId}} (body $.data.order.id): not found in the response",
        "Invalid response mapping {{x}}: invalid_path (recursive descent (..) is not supported)",
        "JSON body is not valid JSON after variable substitution",
        "Blocked: Step 1 (Login) has no successful response in this run (needed for header.Authorization)",
        "Blocked: Step 1 (Login) returned several values that could be token (needed for header.Authorization)",
        "Blocked: Step 2 (Get user) did not provide response.body.id for path.userId",
        "cURL unclosed_quote",
        "A manual mapping already exists for this field",
      ]) {
        const text = localizeUserMessage(raw, t);
        if (text.includes("MISSING:")) unresolved.push(text);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("gives every status its own label, so no two states read the same", () => {
    const statuses = ["NOT_RUN", "PASSED", "FAILED", "BLOCKED", "SKIPPED", "RUNNING", "CANCELLED", "PENDING"];
    for (const dict of [english, persian]) {
      const labels = statuses.map((status) => dict.get(`status.${status}`));
      expect(labels.every(Boolean)).toBe(true);
      expect(new Set(labels).size).toBe(statuses.length);
    }
    const bugStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "REOPENED"];
    for (const dict of [english, persian]) {
      const labels = bugStatuses.map((status) => dict.get(`bugs.statuses.${status}`));
      expect(labels.every(Boolean)).toBe(true);
      expect(new Set(labels).size).toBe(bugStatuses.length);
    }
  });
});
