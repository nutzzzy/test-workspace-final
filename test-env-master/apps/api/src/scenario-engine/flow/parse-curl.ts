export type ParsedHttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  timeoutMs: number;
};

export type CurlParseCode =
  | "missing_url"
  | "unclosed_quote"
  | "missing_value"
  | "file_body"
  | "bad_url";

export type CurlParseResult =
  | { ok: true; config: ParsedHttpRequest }
  | { ok: false; code: CurlParseCode };

const ARG_SHORT = new Set(["X", "H", "d", "u", "A", "b", "e", "m", "F"]);
const BOOL_SHORT = new Set(["G", "I", "k", "L", "s", "S", "v", "f", "i"]);

const ARG_LONG = new Set([
  "request",
  "header",
  "data",
  "data-raw",
  "data-binary",
  "data-ascii",
  "data-urlencode",
  "user",
  "user-agent",
  "cookie",
  "referer",
  "referrer",
  "url",
  "max-time",
  "connect-timeout",
  "output",
  "write-out",
  "retry",
  "retry-delay",
  "proxy",
  "proxy-user",
  "form",
  "form-string",
]);

/** Split pasted text into separate cURL commands without executing a shell. */
export function splitCurlCommands(input: string): string[] {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const flush = () => {
    const trimmed = current.trim();
    if (/^curl(\s|$)/i.test(trimmed)) parts.push(trimmed);
    current = "";
  };

  for (const line of text.split("\n")) {
    if (!quote && current.trim() && /^\s*curl(\s|$)/i.test(line)) flush();
    current += (current ? "\n" : "") + line;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index] ?? "";
      if (char === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') quote = char;
    }
  }
  flush();
  return parts;
}

export function parseCurl(input: string): CurlParseResult {
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch (error) {
    if (error instanceof Error && error.message === "unclosed_quote") {
      return { ok: false, code: "unclosed_quote" };
    }
    return { ok: false, code: "missing_value" };
  }

  if (tokens[0]?.toLowerCase() === "curl" || tokens[0]?.toLowerCase() === "curl.exe") {
    tokens = tokens.slice(1);
  }

  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  const formParts: string[] = [];
  let method: string | undefined;
  let methodExplicit = false;
  let url: string | undefined;
  let forceGet = false;
  let timeoutMs = 15000;
  let failed: CurlParseCode | null = null;

  const assignHeader = (name: string, value: string) => {
    const existing = Object.keys(headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (existing && existing.toLowerCase() === "cookie") {
      headers[existing] = `${headers[existing]}; ${value}`;
      return;
    }
    if (existing) delete headers[existing];
    headers[name] = value;
  };

  const takeValue = (index: number, inline: string | undefined) => {
    if (inline !== undefined) return { value: inline, next: index };
    const value = tokens[index + 1];
    if (value === undefined) {
      failed = "missing_value";
      return { value: "", next: index };
    }
    return { value, next: index + 1 };
  };

  const applyArg = (name: string, value: string) => {
    if (name === "request" || name === "X") {
      method = value.toUpperCase();
      methodExplicit = true;
      return;
    }
    if (name === "header" || name === "H") {
      const splitAt = value.indexOf(":");
      if (splitAt > 0) {
        assignHeader(value.slice(0, splitAt).trim(), value.slice(splitAt + 1).trim());
      }
      return;
    }
    if (name === "url") {
      url = value;
      return;
    }
    if (name === "user" || name === "u") {
      assignHeader("Authorization", `Basic ${encodeBase64(value)}`);
      return;
    }
    if (name === "user-agent" || name === "A") {
      assignHeader("User-Agent", value);
      return;
    }
    if (name === "cookie" || name === "b") {
      if (value.startsWith("@") && !value.startsWith("@@")) {
        failed = "file_body";
        return;
      }
      assignHeader("Cookie", value);
      return;
    }
    if (name === "referer" || name === "referrer" || name === "e") {
      assignHeader("Referer", value);
      return;
    }
    if (name === "max-time" || name === "m") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        timeoutMs = Math.round(seconds * 1000);
      }
      return;
    }
    if (
      name === "data" ||
      name === "data-raw" ||
      name === "data-binary" ||
      name === "data-ascii" ||
      name === "d"
    ) {
      if (isFileRef(value)) {
        failed = "file_body";
        return;
      }
      dataParts.push(value.startsWith("@@") ? value.slice(1) : value);
      return;
    }
    if (name === "data-urlencode") {
      const encoded = encodeDataUrl(value);
      if (encoded === null) {
        failed = "file_body";
        return;
      }
      dataParts.push(encoded);
      return;
    }
    if (name === "form" || name === "form-string" || name === "F") {
      if (isFileRef(value) || /=@/.test(value)) {
        failed = "file_body";
        return;
      }
      formParts.push(value);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--" || failed) continue;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      if (ARG_LONG.has(name)) {
        const taken = takeValue(index, inline);
        index = taken.next;
        applyArg(name, taken.value);
        continue;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const cluster = token.slice(1);
      for (let cursor = 0; cursor < cluster.length; cursor += 1) {
        const flag = cluster[cursor] ?? "";
        const rest = cluster.slice(cursor + 1);
        if (ARG_SHORT.has(flag)) {
          const taken = takeValue(index, rest || undefined);
          index = taken.next;
          applyArg(flag, taken.value);
          break;
        }
        if (flag === "G") forceGet = true;
        else if (flag === "I" && !methodExplicit) method = "HEAD";
        else if (!BOOL_SHORT.has(flag)) break;
      }
      continue;
    }

    if (!url) url = token;
  }

  if (failed) return { ok: false, code: failed };
  if (!url) return { ok: false, code: "missing_url" };

  let bodySource = "";
  if (formParts.length > 0) {
    bodySource = formParts
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq === -1) return encodeURIComponent(part);
        return `${encodeURIComponent(part.slice(0, eq))}=${encodeURIComponent(part.slice(eq + 1))}`;
      })
      .join("&");
    if (!headerValue(headers, "content-type")) {
      assignHeader("Content-Type", "application/x-www-form-urlencoded");
    }
  } else {
    bodySource = dataParts.join("&");
  }

  if (forceGet && bodySource) {
    const joiner = url.includes("?") ? "&" : "?";
    url = `${url}${joiner}${bodySource}`;
    bodySource = "";
  }

  if (!method) {
    method = bodySource && !forceGet ? "POST" : "GET";
  }

  // {{variables}} must survive URL normalization: swap them for plain tokens
  // (a leading {{base_url}} for a stand-in origin), parse, then restore.
  const vars: string[] = [];
  const leading = /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/.exec(url)?.[0] ?? null;
  let template = leading === null ? url : `${LEADING_ORIGIN}${url.slice(leading.length)}`;
  template = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match) => {
    vars.push(match);
    return `qavar${vars.length - 1}x`;
  });
  const restore = (text: string) =>
    text.replace(/qavar(\d+)x/g, (match, index: string) => vars[Number(index)] ?? match);

  let parsed: URL;
  try {
    parsed = new URL(template);
  } catch {
    return { ok: false, code: "bad_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "bad_url" };
  }

  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[restore(key)] = restore(value);
  });
  parsed.search = "";
  let finalUrl = restore(parsed.toString());
  if (leading !== null) {
    const rest = finalUrl.slice(LEADING_ORIGIN.length);
    finalUrl = `${leading}${rest === "/" && url.length === leading.length ? "" : rest}`;
  }

  const sendsBody = method !== "GET" && method !== "HEAD" && bodySource.length > 0;

  return {
    ok: true,
    config: {
      method,
      url: finalUrl,
      headers,
      query,
      body: sendsBody ? coerceBody(bodySource, headers) : {},
      timeoutMs,
    },
  };
}

const LEADING_ORIGIN = "http://qavar-base.invalid";

function tokenize(input: string): string[] {
  const source = input.replace(/^\s*\$\s*/, "").replace(/\r\n/g, "\n");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let ansi = false;

  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";

    if (ansi) {
      if (char === "\\" && index + 1 < source.length) {
        const next = source[index + 1] ?? "";
        const simple: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          "'": "'",
          "\\": "\\",
        };
        if (simple[next] !== undefined) {
          current += simple[next];
          index += 1;
          continue;
        }
      }
      if (char === "'") {
        ansi = false;
        push();
        continue;
      }
      current += char;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (quote === '"') {
      if (char === "\\" && index + 1 < source.length) {
        const next = source[index + 1] ?? "";
        if (next === "\n") {
          index += 1;
          continue;
        }
        if (next === '"' || next === "\\" || next === "$") {
          current += next;
          index += 1;
          continue;
        }
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "\\" && source[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (char === "^" && source[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (char === " " || char === "\n" || char === "\t") {
      push();
      continue;
    }
    if (char === "'" && current === "$") {
      current = "";
      ansi = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    current += char;
  }

  if (quote || ansi) throw new Error("unclosed_quote");
  push();
  return tokens;
}

function isFileRef(value: string) {
  return value.startsWith("@") && !value.startsWith("@@");
}

function encodeDataUrl(raw: string) {
  if (isFileRef(raw)) return null;
  const eq = raw.indexOf("=");
  if (eq === -1) return encodeURIComponent(raw);
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (isFileRef(value)) return null;
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

function headerValue(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function coerceBody(raw: string, headers: Record<string, string>) {
  const type = headerValue(headers, "content-type") ?? "";
  const trimmed = raw.trim();
  const looksJson =
    type.includes("application/json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!looksJson) return raw;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

function encodeBase64(value: string) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  return btoa(value);
}
