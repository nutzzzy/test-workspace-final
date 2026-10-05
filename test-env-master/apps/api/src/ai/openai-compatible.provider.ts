import type { AIProvider, AiGenerateOptions } from "./ai-provider";
import { normalizeLocale } from "./localize-fa";
import { longRequest } from "./long-request";
import { AiHttpError, closePartialJson, parseAndValidate } from "./structured";

export { AiHttpError } from "./structured";
import { outputLanguageInstruction } from "./prompt-contract";

/**
 * Any service that speaks the OpenAI chat-completions protocol: Groq,
 * OpenRouter (including its free models), Google Gemini's OpenAI endpoint,
 * LM Studio, vLLM, … The base URL ends before `/chat/completions`
 * (e.g. https://api.groq.com/openai/v1).
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai";

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly temperature = 0.2,
    private readonly timeoutMs = 120_000,
    /** Let reasoning models think at their default effort (slower). */
    private readonly reasoning = false,
  ) {}

  async generateStructured<T>(options: AiGenerateOptions<T>): Promise<T> {
    const content = await this.chat(
      [
        { role: "system", content: options.system },
        {
          role: "user",
          content: `${options.prompt}\n\nRespond with one valid JSON object only. ${outputLanguageInstruction(
            normalizeLocale(options.locale),
          )}`,
        },
      ],
      true,
      options.signal,
      options.deadlineAt,
    );
    try {
      return parseAndValidate(content, options.schema);
    } catch (error) {
      // Free tiers cap the answer length: keep the complete part of a cut-off answer.
      const closed = closePartialJson(content);
      if (!closed || closed === content.trim()) throw error;
      const data = parseAndValidate(closed, options.schema);
      options.onCut?.("length");
      return data;
    }
  }

  /** One chat completion; `json` asks for JSON mode and falls back when the model does not support it. */
  async chat(messages: Array<{ role: string; content: string }>, json: boolean, signal?: AbortSignal, deadlineAt?: number): Promise<string> {
    const timeoutMs = deadlineAt ? Math.max(1_000, Math.min(this.timeoutMs, deadlineAt - Date.now())) : this.timeoutMs;
    // Reasoning models (e.g. on Pollinations) can spend the whole answer length
    // thinking and return nothing; ask for little reasoning unless it is wanted.
    const send = async (withFormat: boolean, lowReasoning: boolean) =>
      longRequest(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        timeoutMs,
        signal,
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages,
          ...(withFormat ? { response_format: { type: "json_object" } } : {}),
          ...(lowReasoning ? { reasoning_effort: "low" } : {}),
        }),
      });
    let withFormat = json;
    let lowReasoning = !this.reasoning;
    let response = await send(withFormat, lowReasoning);
    // A service that rejects an optional parameter is asked again without it.
    for (let retry = 0; retry < 2 && response.status === 400; retry += 1) {
      const text = await response.text();
      if (lowReasoning && /reasoning/i.test(text)) lowReasoning = false;
      // Some free models reject JSON mode; the prompt still demands JSON.
      else if (withFormat && /response_format|json/i.test(text)) withFormat = false;
      else throw new AiHttpError(400, text);
      response = await send(withFormat, lowReasoning);
    }
    if (!response.ok) {
      throw new AiHttpError(response.status, await response.text().catch(() => ""), response.headers.get("retry-after"));
    }
    const data = JSON.parse(await response.text()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI response is empty");
    return content;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
    });
    if (!response.ok) throw new AiHttpError(response.status, await response.text().catch(() => ""));
    const data = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    const ids = (data.data ?? []).map((item) => item.id).concat((data.models ?? []).map((item) => item.name));
    return ids.filter((id): id is string => Boolean(id)).map((id) => id.replace(/^models\//, "")).sort();
  }
}
