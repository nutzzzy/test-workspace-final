import { maskSecrets } from "@qa-workbench/shared";

/**
 * Key names whose values are credentials. Matched on the normalized key
 * (lower-case, no `-`/`_`), so X-Api-Key, client_secret, set-cookie and
 * accessToken are all covered.
 */
const SECRET_KEY =
  /^(?:.*(?:password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey|sessionid)|jwt|pwd|pin|otp)$/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[-_\s]/g, "").toLowerCase());
}

/** Shortest value that is redacted by value; shorter strings cause false hits. */
const MIN_SECRET_LENGTH = 4;

function redactValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

/**
 * Mask credentials before anything is stored or returned: by key name, by
 * known patterns (Bearer …), and by value for every secret the caller knows
 * (e.g. SECRET environment variables interpolated into a header or body).
 */
export function maskDeep(value: unknown, secrets: Iterable<string> = []): unknown {
  const known = [...secrets].sort((a, b) => b.length - a.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return maskSecrets(redactValues(item, known));
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && (typeof v === "string" || typeof v === "number") ? "***" : visit(v);
      }
      return out;
    }
    return item;
  };
  return visit(value);
}
