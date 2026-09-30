import { assertHostTextAllowed, classifyAddress } from "../common/network-policy";

const HOSTNAME =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;

/**
 * Connector hosts share the scenario network policy (common/network-policy):
 * metadata and link-local addresses are always refused, private ranges only
 * when HTTP_BLOCK_PRIVATE=true, and numeric shorthands such as 2130706433 or
 * 0x7f000001 are refused because drivers resolve them to IPv4 addresses.
 */
export function assertHostAllowed(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!host || /[/@\s\\]/.test(host)) throw new Error("Host is not allowed");
  if (host.includes(":") && classifyAddress(host) === null) {
    throw new Error("Host is not allowed");
  }
  const normalized = assertHostTextAllowed(host);
  if (classifyAddress(normalized)) return normalized;
  if (!HOSTNAME.test(normalized)) throw new Error("Host is not allowed");
  return normalized;
}

export function assertPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port is invalid");
  }
  return port;
}
