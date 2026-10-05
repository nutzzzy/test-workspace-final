import { z } from "zod";

/** Shared by every provider: the expected JSON shape, parsing, and HTTP errors. */

/** JSON Schema of the expected answer, for structured output and for the prompt. */
export function jsonSchemaOf(schema: z.ZodType<unknown>): Record<string, unknown> | null {
  try {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return null;
  }
}

/** An HTTP error from the AI service; the body is kept short and never includes the request. */
export class AiHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
    readonly retryAfter: string | null = null,
  ) {
    super(`AI service error ${status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  }
}

export function parseAndValidate<T>(content: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("AI response is not valid JSON");
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error("AI response is not valid JSON");
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`AI schema validation failed: ${result.error.message.slice(0, 600)}`);
  }
  return result.data;
}

/**
 * Close a JSON object that was cut off while being written (a model stopped
 * at its time limit). Everything after the last complete array element or
 * top-level field is dropped, so no half-written item survives; the open
 * containers are then closed. Null when nothing usable was written.
 */
export function closePartialJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let safe = -1;
  let safeStack: string[] = [];
  const mark = (at: number) => {
    safe = at;
    safeStack = [...stack];
  };
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      // An empty list is fine; an empty item is not.
      if (char === "[" || stack.length === 1) mark(index + 1);
    } else if (char === "}" || char === "]") {
      stack.pop();
      if (stack.length === 0) return text.slice(start, index + 1);
      mark(index + 1);
    } else if (char === "," && (stack.length === 1 || stack[stack.length - 1] === "]")) {
      mark(index);
    }
  }
  if (safe < 0) return null;
  return text.slice(start, safe) + [...safeStack].reverse().join("");
}
