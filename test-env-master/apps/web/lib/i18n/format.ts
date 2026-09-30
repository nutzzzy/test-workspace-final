import type { Locale } from "./types";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Convert Western digits to Persian only for display (fa locale). */
export function formatNumber(
  value: number | string,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return String(value);

  if (locale === "fa") {
    const formatted = new Intl.NumberFormat("en-US", options).format(num);
    return formatted.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]!);
  }
  return new Intl.NumberFormat("en-US", options).format(num);
}

/**
 * Display a percentage computed by the API. `null` means the ratio has no
 * denominator ("not measurable") and is shown as an em dash, never as 0%.
 * The API already rounded to one decimal; this only localizes digits/sign.
 */
export function formatPercent(value: number | null | undefined, locale: Locale): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const digits = formatNumber(value, locale, { maximumFractionDigits: 1 });
  return locale === "fa" ? `${digits}٪` : `${digits}%`;
}

/**
 * Display a calendar day key (YYYY-MM-DD, already bucketed in the viewer's
 * time zone by the API). Formatting noon UTC of that day in UTC keeps the
 * same calendar day; fa shows it in the Persian (Jalali) calendar.
 */
export function formatDay(dayKey: string, locale: Locale): string {
  const date = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

export function formatDateTime(value: string | Date, locale: Locale): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

export function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(vars[key] ?? ""),
  );
}
