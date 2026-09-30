import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurl, splitCurlCommands } from "./parse-curl";

describe("parseCurl", () => {
  it("reads a browser-copied GET", () => {
    const result = parseCurl(`curl 'https://api.wallgold.ir/api/v1/price?side=buy&symbol=GLD' \\
  -H 'accept: application/json' \\
  -H 'accept-language: fa'`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.method, "GET");
    assert.equal(result.config.url, "https://api.wallgold.ir/api/v1/price");
    assert.deepEqual(result.config.query, { side: "buy", symbol: "GLD" });
    assert.equal(result.config.headers.accept, "application/json");
    assert.deepEqual(result.config.body, {});
  });

  it("turns --data-raw JSON into a POST body", () => {
    const result = parseCurl(
      `curl --request POST --url https://example.com/login --header 'content-type: application/json' --data-raw '{"phone":"0912"}'`,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.method, "POST");
    assert.equal(result.config.url, "https://example.com/login");
    assert.deepEqual(result.config.body, { phone: "0912" });
  });

  it("defaults to POST when data is present and no method is set", () => {
    const result = parseCurl(`curl https://example.com/orders -d '{"id":1}'`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.method, "POST");
    assert.deepEqual(result.config.body, { id: 1 });
  });

  it("moves data onto the query string when -G is set", () => {
    const result = parseCurl(
      `curl -G https://example.com/search --data-urlencode 'q=gold price'`,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.method, "GET");
    assert.equal(result.config.query.q, "gold price");
    assert.deepEqual(result.config.body, {});
  });

  it("builds a basic auth header from -u", () => {
    const result = parseCurl(`curl -u alice:secret https://example.com/me`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.config.headers.Authorization,
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    );
  });

  it("rejects a command without a URL", () => {
    const result = parseCurl(`curl -H 'accept: application/json'`);
    assert.deepEqual(result, { ok: false, code: "missing_url" });
  });

  it("rejects file uploads", () => {
    const result = parseCurl(`curl https://example.com/upload -F file=@./a.png`);
    assert.deepEqual(result, { ok: false, code: "file_body" });
  });

  it("splits several cURL commands", () => {
    const commands = splitCurlCommands(
      "curl https://example.com/a\ncurl https://example.com/b\ncurl https://example.com/c",
    );
    assert.equal(commands.length, 3);
    assert.equal(parseCurl(commands[1] ?? "").ok, true);
  });

  it("rejects an unclosed quote", () => {
    const result = parseCurl(`curl 'https://example.com`);
    assert.deepEqual(result, { ok: false, code: "unclosed_quote" });
  });
});
