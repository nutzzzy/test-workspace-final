import type { AppLocale } from "./localize-fa";

/**
 * The output-language contract appended to every LLM request. The output
 * language is the workspace locale passed by the caller — never inferred from
 * the source issue's language.
 */
export function outputLanguageInstruction(locale: AppLocale): string {
  const language = locale === "fa" ? "natural Persian" : "natural English";
  return (
    `Generate all human-readable explanatory content in ${language}. ` +
    "Preserve technical identifiers, API paths, JSON keys, code, enum values and variable names in their original form. " +
    "Do not label the text as translated or as a localized version; return the content directly."
  );
}
