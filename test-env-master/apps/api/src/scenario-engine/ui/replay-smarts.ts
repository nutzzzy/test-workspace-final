/**
 * What a replay must not take literally from a recording: codes and ids in
 * URLs (a basket code, an order id, a payment token) and counts inside
 * visible text (a rating count, a wallet balance) change on every run.
 */

/** A path segment that is an id or code rather than a fixed part of the route. */
export function isDynamicSegment(segment: string): boolean {
  const value = decodeSafe(segment);
  if (!value) return false;
  if (/^\d+$/.test(value)) return true; // 2673817426
  if (/^[0-9a-f]{8,}$/i.test(value)) return true; // 84bcc8920789df68…
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return true; // uuid
  // Short mixed codes: 37vvg3, 099x2d (letters and at least two digits; "oauth2", "v1" stay route parts).
  if (/^[a-z0-9]{5,16}$/i.test(value) && (value.match(/\d/g) ?? []).length >= 2 && /[a-z]/i.test(value)) return true;
  return false;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parts(url: string) {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, segments: parsed.pathname.split("/").filter(Boolean) };
  } catch {
    return null;
  }
}

/** True when `recorded` has ids or codes that will differ on the next run. */
export function hasDynamicParts(recorded: string): boolean {
  const target = parts(recorded);
  if (!target) return false;
  return target.segments.some(isDynamicSegment) || /[?&](code|id|token|order|batch|amount)=/i.test(recorded);
}

/**
 * The page is where a recorded URL led, ignoring what changes per run: same
 * host and route, any value where the recording had an id or code, any query.
 */
export function sameRoute(current: string, recorded: string): boolean {
  const a = parts(current);
  const b = parts(recorded);
  if (!a || !b || a.host !== b.host || a.segments.length !== b.segments.length) return false;
  return b.segments.every((segment, index) => isDynamicSegment(segment) || decodeSafe(segment) === decodeSafe(a.segments[index]!));
}

const DIGIT = "[0-9۰-۹٠-٩]";
const NUMBER_RUN = new RegExp(`${DIGIT}[${"0-9۰-۹٠-٩"},٬٫.+٫٬]*`, "g");

/** Visible text with numbers in it (counts, prices, balances): matched with any number in their place. */
export function hasNumbers(text: string): boolean {
  return new RegExp(DIGIT).test(text);
}

/**
 * A pattern for text whose numbers change between runs: «پیتزا سیب 360 (4,600+)»
 * matches «پیتزا سیب 360 (4,700+)». Words stay exact; spacing is free.
 */
export function looseTextPattern(text: string): RegExp {
  const pieces = text.trim().split(NUMBER_RUN);
  const numbers = text.trim().match(NUMBER_RUN) ?? [];
  let source = "";
  pieces.forEach((piece, index) => {
    source += piece
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    if (index < numbers.length) source += `[${"0-9۰-۹٠-٩"},٬٫.+٫٬]+`;
  });
  return new RegExp(`^\\s*${source}\\s*$`);
}
