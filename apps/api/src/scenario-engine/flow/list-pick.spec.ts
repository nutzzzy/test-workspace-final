import { applyBindings, intoCurrent, isBinding, type StepBinding } from "./bindings";
import { resolvePick, splitListPath, suggestAnchors } from "./list-pick";
import { ValueRegistry } from "./value-registry";

const orders = {
  orders: [
    { id: 69470, code: "zz11aa", vendor: { code: "37vvg3" } }, // someone else's newer order
    { id: 69462, code: "p47l5j", vendor: { code: "37vvg3" } },
    { id: 69461, code: "p8gxng", vendor: { code: "37vvg3" } },
  ],
};

function registryWithUi(path: string) {
  const registry = new ValueRegistry();
  registry.addResponse({ stepId: "ui", stepName: "UI", orderIndex: 0 }, { status: 200, headers: {}, body: { path, url: `https://shop.test${path}` } });
  registry.addResponse({ stepId: "index", stepName: "GET /order/index/", orderIndex: 1 }, { status: 200, headers: {}, body: orders });
  return registry;
}

describe("reading one item of a list", () => {
  it("splits a list path", () => {
    expect(splitListPath("response.body.orders.0.id")).toEqual({ list: "response.body.orders", index: 0, item: "id" });
    expect(splitListPath("response.body.data.items.3.vendor.code")).toEqual({ list: "response.body.data.items", index: 3, item: "vendor.code" });
    expect(splitListPath("response.body.token")).toBeNull();
  });

  it("first, last, or the item a condition singles out — from the whole list", () => {
    const registry = registryWithUi("/order/follow/p47l5j/");
    const fill = () => undefined;
    expect(resolvePick({ list: "response.body.orders", item: "id" }, orders, registry, fill)).toMatchObject({ ok: true, value: 69470 });
    expect(resolvePick({ list: "response.body.orders", item: "id", position: "last" }, orders, registry, fill)).toMatchObject({ ok: true, value: 69461 });
    const byCode = {
      list: "response.body.orders",
      item: "id",
      where: [{ field: "code", op: "in" as const, value: { source: { stepId: "ui", orderIndex: 0, path: "response.body.path" } } }],
    };
    expect(resolvePick(byCode, orders, registry, fill)).toMatchObject({ ok: true, value: 69462, index: 1 });
  });

  it("says why when no item matches, instead of taking another one", () => {
    const registry = registryWithUi("/order/follow/nope99/");
    const result = resolvePick(
      { list: "response.body.orders", item: "id", where: [{ field: "code", op: "in", value: { source: { stepId: "ui", orderIndex: 0, path: "response.body.path" } } }] },
      orders,
      registry,
      () => undefined,
    );
    expect(result).toMatchObject({ ok: false, reason: "no_match" });
    expect((result as { detail: string }).detail).toContain("code in /order/follow/nope99/");
  });

  it("suggests recognising the item by data another step produced", () => {
    const anchors = suggestAnchors(orders.orders[1], [{ stepId: "ui", stepName: "UI", orderIndex: 0, path: "response.body.path", text: "/order/follow/p47l5j/" }]);
    expect(anchors[0]).toMatchObject({ condition: { field: "code", op: "in" } });
  });

  it("is applied when the request is built, and a URL field keeps its URL", () => {
    const registry = registryWithUi("/order/follow/p47l5j/");
    const bindings: StepBinding[] = [
      {
        target: { location: "path", field: "2", key: "orderId" },
        source: {
          stepId: "index",
          orderIndex: 1,
          path: "response.body.orders.0.id",
          pick: { list: "response.body.orders", item: "id", where: [{ field: "code", op: "in", value: { source: { stepId: "ui", orderIndex: 0, path: "response.body.path" } } }] },
        },
      },
      {
        target: { location: "header", field: "Referer" },
        source: {
          stepId: "index",
          orderIndex: 1,
          path: "response.body.orders.0.id",
          pick: { list: "response.body.orders", item: "id", where: [{ field: "code", op: "in", value: { source: { stepId: "ui", orderIndex: 0, path: "response.body.path" } } }] },
        },
      },
    ];
    expect(bindings.every(isBinding)).toBe(true);
    const result = applyBindings(
      { method: "POST", url: "https://backend.test/order/69436/edit", headers: { Referer: "https://backend.test/order/69438" } },
      bindings,
      registry,
      { bodyOf: () => orders, fill: () => undefined },
    );
    expect(result.missing).toEqual([]);
    expect(result.request.url).toBe("https://backend.test/order/69462/edit");
    expect(result.request.headers!.Referer).toBe("https://backend.test/order/69462");
  });

  it("puts an id where the old id was in a URL value, and leaves other values alone", () => {
    expect(intoCurrent("https://backend.test/order/69438", 69462)).toBe("https://backend.test/order/69462");
    expect(intoCurrent("/order/69438?x=1", "69462")).toBe("/order/69462?x=1");
    expect(intoCurrent("69438", 69462)).toBe(69462);
    expect(intoCurrent("Bearer abc", "def")).toBe("def");
    expect(intoCurrent("https://backend.test/orders", 5)).toBe(5);
  });
});
