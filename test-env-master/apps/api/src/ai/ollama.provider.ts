import type { z } from "zod";
import type { AIProvider, AiGenerateOptions } from "./ai-provider";
import { normalizeLocale } from "./localize-fa";
import { outputLanguageInstruction } from "./prompt-contract";
import { longRequest } from "./long-request";
import { AiHttpError, jsonSchemaOf, parseAndValidate } from "./structured";

export { parseAndValidate } from "./structured";

export type OllamaOptions = {
  temperature?: number;
  timeoutMs?: number;
  /** Context window to request (Ollama's own default is far too small for a PRD). */
  contextTokens?: number;
  /** Let thinking models reason first (slower); off sends `think: false`. */
  reasoning?: boolean;
};

export class OllamaProvider implements AIProvider {
  readonly name = "ollama";
  private readonly options: Required<OllamaOptions>;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    temperatureOrOptions: number | OllamaOptions = 0.2,
    timeoutMs = 60_000,
  ) {
    const options = typeof temperatureOrOptions === "number" ? { temperature: temperatureOrOptions, timeoutMs } : temperatureOrOptions;
    this.options = {
      temperature: options.temperature ?? 0.2,
      timeoutMs: options.timeoutMs ?? timeoutMs,
      contextTokens: options.contextTokens ?? 16_384,
      reasoning: options.reasoning ?? false,
    };
  }

  async generateStructured<T>(options: AiGenerateOptions<T>): Promise<T> {
    const schema = jsonSchemaOf(options.schema as z.ZodType<unknown>);
    const response = await longRequest(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: this.options.timeoutMs,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        // Constrained decoding to the schema: small local models stay on shape.
        format: schema ?? "json",
        think: this.options.reasoning,
        options: { temperature: this.options.temperature, num_ctx: this.options.contextTokens },
        messages: [
          { role: "system", content: options.system },
          {
            role: "user",
            content: `${options.prompt}\n\nRespond with valid JSON only. ${outputLanguageInstruction(normalizeLocale(options.locale))}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new AiHttpError(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
    }
    const data = JSON.parse(await response.text()) as { message?: { content?: string } };
    return parseAndValidate(data.message?.content ?? "", options.schema);
  }
}
