import { assertMedia, displayName, parseOwnerIds } from "./media-policy";

describe("media policy", () => {
  it("accepts images and videos and rejects other types", () => {
    expect(assertMedia("image/png", 1200)).toBe(".png");
    expect(assertMedia("video/mp4", 2_000_000)).toBe(".mp4");
    expect(() => assertMedia("text/html", 20)).toThrow(/image and video/);
    expect(() => assertMedia("application/javascript", 20)).toThrow(/image and video/);
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertMedia("image/jpeg", 0)).toThrow(/too large/);
    expect(() => assertMedia("image/jpeg", 41 * 1024 * 1024)).toThrow(/too large/);
  });

  it("parses owner ids and rejects path-like values", () => {
    expect(parseOwnerIds("ckabcdefgh, cm12345678")).toEqual(["ckabcdefgh", "cm12345678"]);
    expect(parseOwnerIds("")).toEqual([]);
    expect(() => parseOwnerIds("../etc/passwd")).toThrow(/owner/);
    expect(() => parseOwnerIds("short")).toThrow(/owner/);
  });

  it("keeps a safe display name", () => {
    expect(displayName("../../etc/passwd")).toBe("passwd");
    expect(displayName("شواهد.png")).toBe("شواهد.png");
    expect(displayName("")).toBe("file");
  });
});
