import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * Where an address points:
 * - "blocked": never reachable from a scenario (cloud metadata, link-local,
 *   "this network" 0.0.0.0/8, unspecified ::);
 * - "private": loopback, RFC 1918, CGNAT, IPv6 ULA; blocked only when
 *   HTTP_BLOCK_PRIVATE=true (the tool targets internal QA environments);
 * - "public": everything else.
 */
export type AddressClass = "blocked" | "private" | "public";

/** Lower-case, drop IPv6 brackets and a trailing root dot. */
export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Class(parts: number[]): AddressClass {
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || (a === 169 && b === 254)) return "blocked";
  if (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return "private";
  }
  return "public";
}

function parseIpv4(host: string): number[] | null {
  if (isIP(host) !== 4) return null;
  return host.split(".").map(Number);
}

/** Expand an IPv6 literal into eight 16-bit groups. */
function ipv6Groups(host: string): number[] | null {
  if (isIP(host) !== 6) return null;
  let text = host.split("%")[0]!;
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1]!.split(".").map(Number);
    text = text.replace(dotted[1]!, `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`);
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

export function classifyAddress(rawHost: string): AddressClass | null {
  const host = normalizeHost(rawHost);
  const v4 = parseIpv4(host);
  if (v4) return ipv4Class(v4);
  const g = ipv6Groups(host);
  if (!g) return null;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return g[7] === 0 ? "blocked" : "private"; // :: and ::1
    }
    return ipv4Class([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return "blocked"; // link-local fe80::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // ULA fc00::/7
  return "public";
}

const BLOCKED_NAMES = new Set(["metadata.google.internal", "metadata"]);

/**
 * Hostnames made only of digits/dots or hex (2130706433, 127.1, 0x7f000001)
 * are resolved as IPv4 by getaddrinfo/WHATWG URL, so they must not slip past
 * the literal-address checks as "names".
 */
export function isAmbiguousNumericHost(host: string): boolean {
  return isIP(host) === 0 && (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host));
}

export function privateBlocked(): boolean {
  return process.env.HTTP_BLOCK_PRIVATE === "true";
}

export function isAllowedClass(value: AddressClass): boolean {
  return value === "public" || (value === "private" && !privateBlocked());
}

/** Synchronous checks on the host text itself. Returns the normalized host. */
export function assertHostTextAllowed(rawHost: string): string {
  const host = normalizeHost(rawHost);
  if (!host || BLOCKED_NAMES.has(host) || isAmbiguousNumericHost(host)) {
    throw new Error("Host is not allowed");
  }
  const literal = classifyAddress(host);
  if (literal && !isAllowedClass(literal)) throw new Error("Host is not allowed");
  if (!literal && privateBlocked() && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))) {
    throw new Error("Host is not allowed");
  }
  return host;
}

/**
 * Resolve a hostname and check every address it maps to, so names such as
 * 169.254.169.254.nip.io cannot reach blocked ranges. Resolution failures
 * are left to the actual request, which reports its own network error.
 * Note: the request re-resolves the name, so a DNS-rebinding server with a
 * zero TTL is not fully covered by this check.
 */
export async function assertResolvedHostAllowed(rawHost: string): Promise<void> {
  const host = assertHostTextAllowed(rawHost);
  if (classifyAddress(host)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return;
  }
  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind && !isAllowedClass(kind)) throw new Error("Host is not allowed");
  }
}
