export type AppLocale = "fa" | "en";

export function normalizeLocale(value: unknown): AppLocale {
  return value === "en" ? "en" : "fa";
}
