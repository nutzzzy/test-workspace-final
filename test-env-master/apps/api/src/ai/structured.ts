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
