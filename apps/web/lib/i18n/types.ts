export type Locale = "fa" | "en";

export const LOCALE_STORAGE_KEY = "qa-workbench.locale";
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return value === "fa" || value === "en";
}

export function localeDir(locale: Locale): "rtl" | "ltr" {
  return locale === "fa" ? "rtl" : "ltr";
}
