import { assertHostTextAllowed, classifyAddress, isAmbiguousNumericHost } from "./network-policy";

describe("network policy", () => {
  const original = process.env.HTTP_BLOCK_PRIVATE;
  afterEach(() => {
    process.env.HTTP_BLOCK_PRIVATE = original;
  });

  it("classifies IPv4, IPv6 and IPv4-mapped IPv6 consistently", () => {
    expect(classifyAddress("169.254.169.254")).toBe("blocked");
    expect(classifyAddress("169.254.170.2")).toBe("blocked");
    expect(classifyAddress("[::ffff:169.254.169.254]")).toBe("blocked");
    expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("blocked");
    expect(classifyAddress("fe80::1")).toBe("blocked");
    expect(classifyAddress("::1")).toBe("private");
    expect(classifyAddress("[::1]")).toBe("private");
    expect(classifyAddress("127.0.0.2")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("fd00::1")).toBe("private");
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("2001:4860:4860::8888")).toBe("public");
    expect(classifyAddress("example.com")).toBeNull();
  });

  it("rejects numeric shorthands that resolvers turn into IPv4", () => {
    for (const host of ["2130706433", "127.1", "0x7f000001", "2852039166"]) {
      expect(isAmbiguousNumericHost(host)).toBe(true);
      expect(() => assertHostTextAllowed(host)).toThrow("Host is not allowed");
    }
  });

  it("always blocks metadata names, including a trailing dot", () => {
    expect(() => assertHostTextAllowed("metadata.google.internal.")).toThrow();
    expect(() => assertHostTextAllowed("169.254.169.254")).toThrow();
  });

  it("blocks private ranges only when HTTP_BLOCK_PRIVATE=true", () => {
    delete process.env.HTTP_BLOCK_PRIVATE;
    expect(assertHostTextAllowed("127.0.0.1")).toBe("127.0.0.1");
    expect(assertHostTextAllowed("localhost")).toBe("localhost");
    process.env.HTTP_BLOCK_PRIVATE = "true";
    expect(() => assertHostTextAllowed("127.0.0.2")).toThrow();
    expect(() => assertHostTextAllowed("[::1]")).toThrow();
    expect(() => assertHostTextAllowed("localhost.")).toThrow();
    expect(assertHostTextAllowed("api.example.com")).toBe("api.example.com");
  });
});
