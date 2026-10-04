import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import { classifyAddress, normalizeHost } from "../common/network-policy";
import { PrismaService } from "../prisma/prisma.service";
import type { AIProvider } from "./ai-provider";
import { HeuristicAIProvider } from "./heuristic.provider";
import type { AppLocale } from "./localize-fa";
import { OllamaProvider } from "./ollama.provider";
import { AiHttpError, OpenAICompatibleProvider } from "./openai-compatible.provider";

const SETTING_KEYS = [
  "ai.provider",
  "ai.baseUrl",
  "ai.model",
  "ai.temperature",
  "ai.timeoutMs",
  "ai.apiKeyEnc",
  "ai.allowExternal",
  "ai.deepAnalysis",
] as const;

/** ollama = local Ollama API · openai = any OpenAI-compatible chat-completions API. */
export type AiProviderKind = "ollama" | "openai";

export type AiSettingsView = {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** An API key is stored (it is never returned). */
  hasApiKey: boolean;
  /** The base URL leaves this machine / private network. */
  external: boolean;
  /** The user allowed sending requirement text to an external service. */
  allowExternal: boolean;
  /** Use the model for deep workspace analysis. */
  deepAnalysis: boolean;
  /** Deep analysis can run with these settings; otherwise `blockedReason` says why. */
  analysisReady: boolean;
  blockedReason: "disabled" | "external_not_allowed" | "missing_api_key" | null;
  connection: "unknown" | "ok" | "failed";
  latencyMs: number | null;
  structuredOutput: "passed" | "failed" | null;
  lastError: string | null;
};

type Runtime = {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  apiKey: string;
  allowExternal: boolean;
  deepAnalysis: boolean;
};

export type StructuredCall<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  locale?: AppLocale;
};

/** Longest a single model call may take; slow local models are fine, analysis runs in the background. */
const MAX_TIMEOUT_MS = 600_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

@Injectable()
export class AIService {
  private readonly heuristic = new HeuristicAIProvider();
  private diagnostics: Pick<AiSettingsView, "connection" | "latencyMs" | "structuredOutput" | "lastError"> = {
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
    const external = isExternal(runtime.baseUrl);
    const blockedReason = readiness(runtime, external);
    return {
      provider: runtime.provider,
      baseUrl: runtime.baseUrl,
      model: runtime.model,
      temperature: runtime.temperature,
      timeoutMs: runtime.timeoutMs,
      hasApiKey: Boolean(runtime.apiKey),
      external,
      allowExternal: runtime.allowExternal,
      deepAnalysis: runtime.deepAnalysis,
      analysisReady: blockedReason === null,
      blockedReason,
      ...this.diagnostics,
    };
  }

  async saveSettings(input: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    timeoutMs?: number;
    /** A new key; empty or absent keeps the stored one. */
    apiKey?: string;
    clearApiKey?: boolean;
    allowExternal?: boolean;
    deepAnalysis?: boolean;
  }): Promise<AiSettingsView> {
    const current = await this.runtime();
    const baseUrl = clean(input.baseUrl, current.baseUrl).replace(/\/$/, "");
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new BadRequestException("AI base URL must be a valid http(s) URL");
    }
    const next: Record<(typeof SETTING_KEYS)[number], string> = {
      "ai.provider": input.provider === "openai" || input.provider === "ollama" ? input.provider : current.provider,
      "ai.baseUrl": baseUrl,
      "ai.model": clean(input.model, current.model),
      "ai.temperature": String(clamp(input.temperature ?? current.temperature, 0, 1)),
      "ai.timeoutMs": String(Math.round(clamp(input.timeoutMs ?? current.timeoutMs, 1000, MAX_TIMEOUT_MS))),
      "ai.apiKeyEnc": input.clearApiKey
        ? ""
        : input.apiKey?.trim()
          ? encryptSecret(input.apiKey.trim(), this.encryptionKey())
          : await this.storedKeyCipher(),
      "ai.allowExternal": String(input.allowExternal ?? current.allowExternal),
      "ai.deepAnalysis": String(input.deepAnalysis ?? current.deepAnalysis),
    };
    // A different service is a new decision: consent does not carry over to another host.
    if (input.allowExternal === undefined && hostOf(baseUrl) !== hostOf(current.baseUrl)) next["ai.allowExternal"] = "false";
    await Promise.all(
      Object.entries(next).map(([key, value]) =>
        this.prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    );
    return this.getSettings();
  }

  async listModels(): Promise<{ models: string[]; error: string | null }> {
    const runtime = await this.runtime();
    try {
      if (runtime.provider === "openai") {
        return { models: await this.openai(runtime).listModels(), error: null };
      }
      const response = await fetch(`${runtime.baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(runtime.timeoutMs, 30_000)) });
      if (!response.ok) return { models: [], error: `Ollama error ${response.status}` };
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return { models: (data.models ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)), error: null };
    } catch (error) {
      return { models: [], error: errorText(error, "Connection failed") };
    }
  }

  /** One tiny structured request: proves the URL, key, model and JSON output all work. */
  async testConnection(): Promise<AiSettingsView> {
    const runtime = await this.runtime();
    const started = Date.now();
    try {
      await this.providerFor(runtime).generateStructured({
        system: "Reply with JSON only.",
        prompt: 'Return {"ok":true}',
        schema: z.object({ ok: z.boolean() }),
      });
      this.diagnostics = { connection: "ok", latencyMs: Date.now() - started, structuredOutput: "passed", lastError: null };
    } catch (error) {
      this.diagnostics = {
        connection: "failed",
        latencyMs: Date.now() - started,
        structuredOutput: "failed",
        lastError: errorText(error, "Connection failed"),
      };
    }
    return this.getSettings();
  }

  getProvider(): AIProvider {
    const baseUrl = this.config.get<string>("OLLAMA_BASE_URL", "http://localhost:11434");
    const model = this.config.get<string>("OLLAMA_MODEL", "llama3.2");
    return new OllamaProvider(baseUrl, model);
  }

  /** Can the workspace use the model for deep analysis right now? */
  async analysisStatus(): Promise<{ ready: boolean; provider: AiProviderKind; model: string; reason: AiSettingsView["blockedReason"] }> {
    const runtime = await this.runtime();
    const reason = readiness(runtime, isExternal(runtime.baseUrl));
    return { ready: reason === null, provider: runtime.provider, model: runtime.model, reason };
  }

  /**
   * A model call that must succeed or fail — no heuristic stand-in. Rate
   * limits and server errors are retried with backoff (free tiers limit
   * often); an answer that is not valid JSON for the schema is asked again
   * with the validation error.
   */
  async structured<T>(call: StructuredCall<T>, options: { attempts?: number; signal?: AbortSignal } = {}): Promise<T> {
    const runtime = await this.runtime();
    const reason = readiness(runtime, isExternal(runtime.baseUrl));
    if (reason) throw new Error(`AI analysis is not available: ${reason}`);
    const provider = this.providerFor(runtime);
    const attempts = options.attempts ?? 4;
    let prompt = call.prompt;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted) throw new Error("AI analysis was cancelled");
      try {
        const data = await provider.generateStructured({ ...call, prompt });
        this.diagnostics = { ...this.diagnostics, connection: "ok", structuredOutput: "passed", lastError: null };
        return data;
      } catch (error) {
        lastError = error;
        this.diagnostics = { ...this.diagnostics, lastError: errorText(error, "Generation failed") };
        if (error instanceof AiHttpError) {
          if (error.status === 401 || error.status === 403 || error.status === 404) break;
          if (error.status === 429 || error.status >= 500) {
            await sleep(backoff(attempt, error.retryAfter), options.signal);
            continue;
          }
          break;
        }
        const message = error instanceof Error ? error.message : "";
        if (/JSON|schema/i.test(message)) {
          // Ask again, telling the model exactly what was wrong.
          prompt = `${call.prompt}\n\nYour previous answer was rejected: ${message.slice(0, 400)}\nReturn a JSON object that matches the requested shape exactly.`;
          continue;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) continue;
        break;
      }
    }
    this.diagnostics = { ...this.diagnostics, connection: "failed", structuredOutput: "failed" };
    throw lastError instanceof Error ? lastError : new Error("AI generation failed");
  }

  /** Structured output with the deterministic heuristic as a fallback (scenario ranking, legacy callers). */
  async generateStructured<T>(options: StructuredCall<T>): Promise<{ data: T; provider: string }> {
    const runtime = await this.runtime();
    try {
      const data = await this.providerFor(runtime).generateStructured(options);
      this.diagnostics = { ...this.diagnostics, connection: "ok", structuredOutput: "passed", lastError: null };
      return { data, provider: runtime.provider };
    } catch (error) {
      this.diagnostics = {
        ...this.diagnostics,
        connection: "failed",
        structuredOutput: "failed",
        lastError: errorText(error, "Generation failed"),
      };
      const data = await this.heuristic.generateStructured(options);
      return { data, provider: this.heuristic.name };
    }
  }

  private providerFor(runtime: Runtime): AIProvider {
    if (runtime.provider === "openai") return this.openai(runtime);
    return new OllamaProvider(runtime.baseUrl, runtime.model, runtime.temperature, runtime.timeoutMs);
  }

  private openai(runtime: Runtime) {
    return new OpenAICompatibleProvider(runtime.baseUrl, runtime.model, runtime.apiKey, runtime.temperature, runtime.timeoutMs);
  }

  private encryptionKey() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  private async storedKeyCipher() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: "ai.apiKeyEnc" } });
    return row?.value ?? "";
  }

  private async runtime(): Promise<Runtime> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
    const saved = new Map(rows.map((row) => [row.key, row.value]));
    let apiKey = "";
    const cipher = saved.get("ai.apiKeyEnc");
    if (cipher) {
      try {
        apiKey = decryptSecret(cipher, this.encryptionKey());
      } catch {
        apiKey = "";
      }
    }
    return {
      provider: saved.get("ai.provider") === "openai" ? "openai" : "ollama",
      baseUrl: (saved.get("ai.baseUrl") || this.config.get<string>("OLLAMA_BASE_URL", "http://localhost:11434")).replace(/\/$/, ""),
      model: saved.get("ai.model") || this.config.get<string>("OLLAMA_MODEL", "llama3.2"),
      temperature: numberOr(saved.get("ai.temperature"), 0.2),
      timeoutMs: numberOr(saved.get("ai.timeoutMs"), 120_000),
      apiKey,
      allowExternal: saved.get("ai.allowExternal") === "true",
      deepAnalysis: saved.get("ai.deepAnalysis") !== "false",
    };
  }
}

function readiness(runtime: Runtime, external: boolean): AiSettingsView["blockedReason"] {
  if (!runtime.deepAnalysis) return "disabled";
  if (external && !runtime.allowExternal) return "external_not_allowed";
  if (runtime.provider === "openai" && external && !runtime.apiKey) return "missing_api_key";
  return null;
}

function hostOf(baseUrl: string) {
  try {
    return normalizeHost(new URL(baseUrl).hostname);
  } catch {
    return "";
  }
}

/** Loopback, private ranges and local names stay on this machine or network; anything else is external. */
export function isExternal(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const kind = classifyAddress(host);
  return kind === null || kind === "public";
}

function backoff(attempt: number, retryAfter: string | null) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS);
  return Math.min(2000 * 2 ** (attempt - 1), MAX_RATE_LIMIT_WAIT_MS);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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
