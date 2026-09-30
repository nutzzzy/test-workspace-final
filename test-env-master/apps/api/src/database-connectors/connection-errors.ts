import { maskSecrets } from "@qa-workbench/shared";

/** User-facing database errors. Secrets and driver dumps stay out of the message. */
export function publicDatabaseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const cleaned = maskSecrets(raw)
    .replace(/\/\/[^/\s@]+@/g, "//***@")
    .replace(/password[=:]\s*\S+/gi, "password=***")
    .replace(/\s+/g, " ")
    .trim();

  if (/timed out|etimedout|timeout/i.test(cleaned)) {
    return "Database request timed out";
  }
  if (
    /econnrefused|enotfound|ehostunreach|connect|getaddrinfo|could not connect/i.test(
      cleaned,
    )
  ) {
    return "Unable to connect to the selected database.";
  }
  // "authentication", not "auth": a column named "author" is not a login failure.
  if (/authentication|access denied|password|28p01|28000|login failed/i.test(cleaned)) {
    return "Database authentication failed. Check the username and password.";
  }
  if (
    cleaned &&
    cleaned.length < 180 &&
    !/stack|node_modules|\/home\/|secret|token/i.test(cleaned)
  ) {
    return cleaned;
  }
  return "Unable to connect to the selected database.";
}
