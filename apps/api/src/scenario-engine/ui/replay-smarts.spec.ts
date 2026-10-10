import { hasDynamicParts, isDynamicSegment, looseTextPattern, sameRoute } from "./replay-smarts";

describe("what a replay must not take literally", () => {
  it.each(["37vvg3", "099x2d", "2673817426", "84bcc8920789df685089c9616db429a9", "69436"])("%s is a code", (segment) => {
    expect(isDynamicSegment(segment)).toBe(true);
  });
  it.each(["basket", "order", "invoice", "v1", "oauth2", "login", "%D9%BE%DB%8C%D8%AA%D8%B2%D8%A7"])("%s is part of the route", (segment) => {
    expect(isDynamicSegment(segment)).toBe(false);
  });

  it("matches the same route with other codes and any query", () => {
    expect(sameRoute("https://x.dev/order/invoice/7aa21b/?batch=1", "https://x.dev/order/invoice/099x2d/?batch=0&amount=76431")).toBe(true);
    expect(sameRoute("https://pay.x.dev/payments/2673899999/verify/aa11bb22cc33dd44", "https://pay.x.dev/payments/2673817426/verify/84bcc8920789df68")).toBe(true);
    expect(sameRoute("https://x.dev/basket/", "https://x.dev/order/invoice/099x2d/")).toBe(false);
    expect(sameRoute("https://other.dev/basket/", "https://x.dev/basket/")).toBe(false);
    expect(hasDynamicParts("https://x.dev/basket/?code=37vvg3")).toBe(true);
    expect(hasDynamicParts("https://x.dev/")).toBe(false);
  });

  it("matches text whose numbers changed", () => {
    const pattern = looseTextPattern("پیتزا سیب 360 (پارک ملت) - تست 3.9 (4,600+)");
    expect(pattern.test("پیتزا سیب 360 (پارک ملت) - تست 4.1 (4,712+)")).toBe(true);
    expect(pattern.test("پیتزا سیب 360 (پارک ملت)")).toBe(false);
    expect(looseTextPattern("جزییات کیف پول اسنپ‌فود 117٬914٬086 تومان").test("جزییات کیف پول اسنپ‌فود 117٬838٬010 تومان")).toBe(true);
    expect(looseTextPattern("سبد خرید (۱)").test("سبد خرید (۲)")).toBe(true);
  });
});
