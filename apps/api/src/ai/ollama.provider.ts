import type { z } from "zod";
import type { AIProvider, AiGenerateOptions } from "./ai-provider";
import { normalizeLocale } from "./localize-fa";
import { outputLanguageInstruction } from "./prompt-contract";
import { longRequest } from "./long-request";
import { AiHttpError, closePartialJson, jsonSchemaOf, parseAndValidate } from "./structured";

export { parseAndValidate } from "./structured";

export type OllamaOptions = {
  temperature?: number;
  timeoutMs?: number;
  /** Context window to request (Ollama's own default is far too small for a PRD). */
  contextTokens?: number;
  /** Let thinking models reason first (slower); off sends `think: false`. */
  reasoning?: boolean;
  /**
   * Longest time the model may spend writing (from its first token); at the
   * limit it is stopped and the answer written so far is used. 0 = no limit.
   */
  answerBudgetMs?: number;
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
      answerBudgetMs: options.answerBudgetMs ?? 0,
    };
  }

  async generateStructured<T>(options: AiGenerateOptions<T>): Promise<T> {
    const schema = jsonSchemaOf(options.schema as z.ZodType<unknown>);
    // Streamed: the page can show the model writing, and a slow model can be
    // stopped at its writing budget while keeping what it wrote.
    const stop = new AbortController();
    let written = "";
    let pending = "";
    let budget: NodeJS.Timeout | undefined;
    let cut = false;
    let broken: unknown;
    const read = (line: string) => {
      if (!line.trim()) return;
      const data = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (data.error) throw new Error(`AI service error: ${data.error}`);
      const piece = data.message?.content ?? "";
      if (!piece) return;
      written += piece;
      options.onTokens?.(1);
      if (!budget && this.options.answerBudgetMs > 0) {
        budget = setTimeout(() => {
          cut = true;
          stop.abort();
        }, this.options.answerBudgetMs);
      }
    };
    // The analysis time limit stops the model even while it is still reading the prompt.
    const deadline = options.deadlineAt
      ? setTimeout(() => {
          cut = true;
          stop.abort();
        }, Math.max(0, options.deadlineAt - Date.now()))
      : undefined;
    try {
      const response = await longRequest(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: this.options.timeoutMs,
        signal: options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal,
        onData: (chunk) => {
          const lines = (pending + chunk).split("\n");
          pending = lines.pop() ?? "";
          try {
            lines.forEach(read);
          } catch (error) {
            broken = error;
            stop.abort();
          }
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
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
      read(pending);
      return parseAndValidate(written, options.schema);
    } catch (error) {
      if (broken) throw broken;
      if (!cut || options.signal?.aborted) throw error;
      const closed = closePartialJson(written);
      if (!closed) throw new Error("The model reached its writing time limit before writing anything usable");
      const data = parseAndValidate(closed, options.schema);
      options.onCut?.("time");
      return data;
    } finally {
      clearTimeout(budget);
      clearTimeout(deadline);
    }
  }
}
