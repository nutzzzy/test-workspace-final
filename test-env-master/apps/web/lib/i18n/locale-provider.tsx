"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { dictionaries, type Dictionary } from "./dictionaries";
import { formatDateTime, formatNumber, formatPercent, interpolate } from "./format";
import { localizeUserMessage } from "./messages";
import {
  DEFAULT_LOCALE,
  isLocale,
  localeDir,
  LOCALE_STORAGE_KEY,
  type Locale,
} from "./types";

type I18nContextValue = {
  locale: Locale;
  dir: "rtl" | "ltr";
  isRtl: boolean;
  dict: Dictionary;
  setLocale: (locale: Locale) => void;
  t: (path: string, vars?: Record<string, string | number>) => string;
  label: (group: string, code: string) => string;
  err: (raw: string) => string;
  n: (value: number | string, options?: Intl.NumberFormatOptions) => string;
  /** Percentage from the API; null renders as "—" (not measurable). */
  p: (value: number | null | undefined) => string;
  d: (value: string | Date) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getByPath(dict: Dictionary, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    // ignore
  }
  return DEFAULT_LOCALE;
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLocaleState(readStoredLocale());
    setReady(true);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const dir = localeDir(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.documentElement.classList.toggle("locale-fa", locale === "fa");
    document.documentElement.classList.toggle("locale-en", locale === "en");
  }, [locale, ready]);

  const value = useMemo<I18nContextValue>(() => {
    const dict = dictionaries[locale];
    return {
      locale,
      dir: localeDir(locale),
      isRtl: locale === "fa",
      dict,
      setLocale,
      t: (path, vars) => {
        const raw = getByPath(dict, path) ?? getByPath(dictionaries.en, path) ?? path;
        return vars ? interpolate(raw, vars) : raw;
      },
      label: (group, code) => {
        // Codes from external sources (Jira sends "High") are matched
        // case-insensitively for display only; stored values are untouched.
        for (const candidate of [code, code?.toUpperCase?.()]) {
          if (!candidate) continue;
          const path = `${group}.${candidate}`;
          const hit = getByPath(dict, path) ?? getByPath(dictionaries.en, path);
          if (hit) return hit;
        }
        return code;
      },
      err: (raw) =>
        localizeUserMessage(raw, (path, vars) => {
          const text =
            getByPath(dict, path) ?? getByPath(dictionaries.en, path) ?? path;
          return vars ? interpolate(text, vars) : text;
        }),
      n: (v, options) => formatNumber(v, locale, options),
      p: (v) => formatPercent(v, locale),
      d: (v) => formatDateTime(v, locale),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LocaleProvider");
  return ctx;
}

export function useOptionalI18n() {
  return useContext(I18nContext);
}
