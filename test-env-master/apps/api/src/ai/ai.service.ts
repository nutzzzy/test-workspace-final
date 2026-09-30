import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import type { AIProvider } from "./ai-provider";
import { HeuristicAIProvider } from "./heuristic.provider";
import type { AppLocale } from "./localize-fa";
import { OllamaProvider } from "./ollama.provider";

const SETTING_KEYS = [
  "ai.provider",
  "ai.baseUrl",
  "ai.model",
  "ai.temperature",
  "ai.timeoutMs",
] as const;

export type AiSettingsView = {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  connection: "unknown" | "ok" | "failed";
  latencyMs: number | null;
  structuredOutput: "passed" | "failed" | null;
  lastError: string | null;
};

@Injectable()
export class AIService {
  private readonly heuristic = new HeuristicAIProvider();
  private diagnostics: Omit<
    AiSettingsView,
    "provider" | "baseUrl" | "model" | "temperature" | "timeoutMs"
  > = {
    connection: "unknown",
    latencyMs: null,
    structuredOutput: null,
    lastError: null,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async getSettings(): Promise<AiSettingsView> {
    const runtime = await this.runtime();
    return { ...runtime, ...this.diagnostics };
  }

  async saveSettings(input: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<AiSettingsView> {
    const current = await this.runtime();
    const next = {
      provider: clean(input.provider, current.provider),
      baseUrl: clean(input.baseUrl, current.baseUrl).replace(/\/$/, ""),
      model: clean(input.model, current.model),
      temperature: clamp(input.temperature ?? current.temperature, 0, 1),
      timeoutMs: Math.round(clamp(input.timeoutMs ?? current.timeoutMs, 1000, 180000)),
    };
    await Promise.all(
      Object.entries({
        "ai.provider": next.provider,
        "ai.baseUrl": next.baseUrl,
        "ai.model": next.model,
        "ai.temperature": String(next.temperature),
        "ai.timeoutMs": String(next.timeoutMs),
      }).map(([key, value]) =>
        this.prisma.systemSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        }),
      ),
    );
    return this.getSettings();
  }

  async listModels(): Promise<{ models: string[]; error: string | null }> {
    const runtime = await this.runtime();
    try {
      const response = await fetch(`${runtime.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(runtime.timeoutMs),
      });
      if (!response.ok) {
        return { models: [], error: `Ollama error ${response.status}` };
      }
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return {
        models: (data.models ?? [])
          .map((item) => item.name)
          .filter((name): name is string => Boolean(name)),
        error: null,
      };
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : "Connection failed" };
    }
  }

  async testConnection(): Promise<AiSettingsView> {
    const runtime = await this.runtime();
    const started = Date.now();
    try {
      const tags = await fetch(`${runtime.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(runtime.timeoutMs),
      });
      if (!tags.ok) throw new Error(`Ollama error ${tags.status}`);
      const chat = await fetch(`${runtime.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(runtime.timeoutMs),
        body: JSON.stringify({
          model: runtime.model,
          stream: false,
          format: "json",
          options: { temperature: runtime.temperature },
          messages: [
            { role: "system", content: "Reply with JSON only." },
            { role: "user", content: 'Return {"ok":true}' },
          ],
        }),
      });
      if (!chat.ok) throw new Error(`Ollama error ${chat.status}`);
      const data = (await chat.json()) as { message?: { content?: string } };
      JSON.parse(data.message?.content ?? "");
      this.diagnostics = {
        connection: "ok",
        latencyMs: Date.now() - started,
        structuredOutput: "passed",
        lastError: null,
      };
    } catch (error) {
      this.diagnostics = {
        connection: "failed",
        latencyMs: Date.now() - started,
        structuredOutput: "failed",
        lastError: error instanceof Error ? error.message : "Connection failed",
      };
    }
    return this.getSettings();
  }

  getProvider(): AIProvider {
    const baseUrl = this.config.get<string>("OLLAMA_BASE_URL", "http://localhost:11434");
    const model = this.config.get<string>("OLLAMA_MODEL", "llama3.2");
    return new OllamaProvider(baseUrl, model);
  }

  async generateStructured<T>(options: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    locale?: AppLocale;
  }): Promise<{ data: T; provider: string }> {
    const runtime = await this.runtime();
    const provider = new OllamaProvider(
      runtime.baseUrl,
      runtime.model,
      runtime.temperature,
      runtime.timeoutMs,
    );
    try {
      const data = await provider.generateStructured(options);
      this.diagnostics = {
        connection: "ok",
        latencyMs: this.diagnostics.latencyMs,
        structuredOutput: "passed",
        lastError: null,
      };
      return { data, provider: provider.name };
    } catch (error) {
      this.diagnostics = {
        connection: "failed",
        latencyMs: this.diagnostics.latencyMs,
        structuredOutput: "failed",
        lastError: error instanceof Error ? error.message : "Generation failed",
      };
      const data = await this.heuristic.generateStructured(options);
      return { data, provider: this.heuristic.name };
    }
  }

  private async runtime(): Promise<{
    provider: string;
    baseUrl: string;
    model: string;
    temperature: number;
    timeoutMs: number;
  }> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: [...SETTING_KEYS] } },
    });
    const saved = new Map(rows.map((row) => [row.key, row.value]));
    return {
      provider: saved.get("ai.provider") || "ollama",
      baseUrl: (
        saved.get("ai.baseUrl") ||
        this.config.get<string>("OLLAMA_BASE_URL", "http://localhost:11434")
      ).replace(/\/$/, ""),
      model: saved.get("ai.model") || this.config.get<string>("OLLAMA_MODEL", "llama3.2"),
      temperature: numberOr(saved.get("ai.temperature"), 0.2),
      timeoutMs: numberOr(saved.get("ai.timeoutMs"), 60_000),
    };
  }
}

function clean(value: string | undefined, fallback: string): string {
  const next = value?.trim();
  return next ? next : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
