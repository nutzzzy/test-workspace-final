import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AiConnection } from "@prisma/client";
import { z } from "zod";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import { classifyAddress, normalizeHost } from "../common/network-policy";
import { PrismaService } from "../prisma/prisma.service";
import { TIME_LIMIT, type AIProvider } from "./ai-provider";
import type { AppLocale } from "./localize-fa";
import { OllamaProvider } from "./ollama.provider";
import { OpenAICompatibleProvider } from "./openai-compatible.provider";
import { AiHttpError } from "./structured";

/**
 * Language-model access for the whole app: several configured services
 * ("connections"), and a routing table that says which ones each analysis
 * stage uses, in order. A stage falls through to the next connection when one
 * is unreachable, rate-limited or answers badly, so a local model and free
 * hosted tiers can share the work.
 */

export const STAGE_GROUPS = ["analysis", "testCases", "edgeCases", "automation", "review", "translate", "learning"] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];
export type Routing = Record<StageGroup, string[]>;

export type ConnectionView = {
  id: string;
  name: string;
  kind: "ollama" | "openai";
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  external: boolean;
  allowExternal: boolean;
  enabled: boolean;
  temperature: number;
  timeoutMs: number;
  answerBudgetMs: number;
  contextTokens: number;
  reasoning: boolean;
  priority: number;
  /** Usable for analysis right now (on paper — reachability is checked when it runs). */
  usable: boolean;
  blockedReason: "disabled" | "external_not_allowed" | "missing_api_key" | null;
  lastStatus: string | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
};

export type ConnectionInput = Partial<{
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  allowExternal: boolean;
  enabled: boolean;
  temperature: number;
  timeoutMs: number;
  answerBudgetMs: number;
  contextTokens: number;
  reasoning: boolean;
  priority: number;
}>;

export type StructuredCall<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  locale?: AppLocale;
  onTokens?: (count: number) => void;
  onCut?: (reason: "time" | "length") => void;
  /** Epoch ms by which the answer must be in (the analysis time limit). */
  deadlineAt?: number;
};

/** Which connection produced an answer. */
export type CallOrigin = { connectionId: string; name: string; model: string };

const ROUTING_KEY = "ai.routing";
const MAX_TIMEOUT_MS = 3_600_000;
/** A rate limit longer than this moves on to the next connection instead of waiting. */
const MAX_WAIT_MS = 30_000;
/** Free tiers (Pollinations) refuse a 4th concurrent request. */
const HOSTED_CONCURRENCY = 3;
const RATE_LIMIT_ATTEMPTS = 6;
const RUN_BUDGET_KEY = "ai.runBudgetMs";
const DEFAULT_RUN_BUDGET_MS = 180_000;
const LEGACY_KEYS = ["ai.provider", "ai.baseUrl", "ai.model", "ai.temperature", "ai.timeoutMs", "ai.apiKeyEnc", "ai.allowExternal", "ai.deepAnalysis"];

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  /** Connection id → time until which it is skipped (rate limit / outage). */
  private readonly cooldown = new Map<string, number>();
  private migrated: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // ── connections ───────────────────────────────────────────────────────

  async listConnections(): Promise<ConnectionView[]> {
    await this.ensureMigrated();
    const rows = await this.prisma.aiConnection.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    return rows.map((row) => this.view(row));
  }

  async createConnection(input: ConnectionInput): Promise<ConnectionView> {
    await this.ensureMigrated();
    const data = this.validate(input, null);
    const count = await this.prisma.aiConnection.count();
    const row = await this.prisma.aiConnection.create({ data: { ...data, priority: input.priority ?? count } as never });
    return this.view(row);
  }

  async updateConnection(id: string, input: ConnectionInput): Promise<ConnectionView> {
    const current = await this.prisma.aiConnection.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("AI connection not found");
    const data = this.validate(input, current);
    const row = await this.prisma.aiConnection.update({ where: { id }, data: data as never });
    this.cooldown.delete(id);
    return this.view(row);
  }

  async deleteConnection(id: string) {
    await this.prisma.aiConnection.delete({ where: { id } }).catch(() => {
      throw new NotFoundException("AI connection not found");
    });
    const routing = await this.getRouting();
    await this.saveRouting(
      Object.fromEntries(Object.entries(routing).map(([group, ids]) => [group, ids.filter((item) => item !== id)])) as Routing,
    );
    return { ok: true };
  }

  async listModels(id: string): Promise<{ models: string[]; error: string | null }> {
    const row = await this.connection(id);
    try {
      if (row.kind === "openai") return { models: await this.openai(row).listModels(), error: null };
      const response = await fetch(`${row.baseUrl}/api/tags`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { models: [], error: `Ollama error ${response.status}` };
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      return { models: (data.models ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)), error: null };
    } catch (error) {
      return { models: [], error: message(error) };
    }
  }

  /** One small structured request: proves URL, key, model and JSON output. */
  async testConnection(id: string): Promise<ConnectionView> {
    const row = await this.connection(id);
    const started = Date.now();
    let lastStatus = "ok";
    let lastError: string | null = null;
    try {
      await this.provider(row).generateStructured({
        system: "Reply with JSON only.",
        prompt: 'Return {"ok": true}',
        schema: z.object({ ok: z.boolean() }),
      });
    } catch (error) {
      lastStatus = "failed";
      lastError = message(error);
    }
    const updated = await this.prisma.aiConnection.update({
      where: { id },
      data: { lastStatus: `${lastStatus} · ${Date.now() - started} ms`, lastError, lastCheckedAt: new Date() },
    });
    return this.view(updated);
  }

  /**
   * Download a model into a local Ollama server, reporting progress. Only for
   * Ollama connections; the request goes to that server, which fetches from
   * its own registry.
   */
  async pullModel(id: string, model: string, onProgress: (progress: { status: string; completed?: number; total?: number }) => void) {
    const row = await this.connection(id);
    if (row.kind !== "ollama") throw new BadRequestException("Only Ollama connections can download models");
    if (!/^[\w.:/-]{1,120}$/.test(model)) throw new BadRequestException("Invalid model name");
    const response = await fetch(`${row.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok || !response.body) throw new BadRequestException(`Ollama error ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (event.error) throw new Error(event.error);
          onProgress({ status: event.status ?? "", completed: event.completed, total: event.total });
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
  }

  private readonly pulls = new Map<string, { model: string; status: string; completed: number; total: number; state: "running" | "done" | "failed"; error?: string }>();

  /** Start downloading a model into an Ollama connection in the background. */
  startPull(id: string, model: string) {
    const current = this.pulls.get(id);
    if (current?.state === "running") return current;
    const job = { model, status: "starting", completed: 0, total: 0, state: "running" as "running" | "done" | "failed", error: undefined as string | undefined };
    this.pulls.set(id, job);
    void this.pullModel(id, model, (progress) => {
      job.status = progress.status;
      if (progress.total) {
        job.total = progress.total;
        job.completed = progress.completed ?? 0;
      }
    })
      .then(() => {
        job.state = "done";
        job.status = "success";
      })
      .catch((error: unknown) => {
        job.state = "failed";
        job.error = message(error);
      });
    return job;
  }

  pullStatus(id: string) {
    return this.pulls.get(id) ?? null;
  }

  // ── routing ───────────────────────────────────────────────────────────

  async getRouting(): Promise<Routing> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ROUTING_KEY } });
    let saved: Partial<Record<string, unknown>> = {};
    try {
      saved = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
    } catch {
      saved = {};
    }
    return Object.fromEntries(
      STAGE_GROUPS.map((group) => [group, Array.isArray(saved[group]) ? (saved[group] as unknown[]).filter((id): id is string => typeof id === "string") : []]),
    ) as Routing;
  }

  /** Longest time one analysis run may take (ms); at the limit it keeps what is done. 0 = no limit. */
  async getRunBudget(): Promise<{ runBudgetMs: number }> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: RUN_BUDGET_KEY } });
    const value = Number(row?.value);
    return { runBudgetMs: row && Number.isFinite(value) ? value : DEFAULT_RUN_BUDGET_MS };
  }

  async saveRunBudget(input: { runBudgetMs?: unknown }): Promise<{ runBudgetMs: number }> {
    const runBudgetMs = Math.round(clamp(Number(input.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS) || 0, 0, MAX_TIMEOUT_MS));
    const value = String(runBudgetMs);
    await this.prisma.systemSetting.upsert({ where: { key: RUN_BUDGET_KEY }, create: { key: RUN_BUDGET_KEY, value }, update: { value } });
    return { runBudgetMs };
  }

  async saveRouting(input: Partial<Record<string, unknown>>): Promise<Routing> {
    const ids = new Set((await this.prisma.aiConnection.findMany({ select: { id: true } })).map((row) => row.id));
    const routing = Object.fromEntries(
      STAGE_GROUPS.map((group) => {
        const list = Array.isArray(input[group]) ? (input[group] as unknown[]) : [];
        return [group, [...new Set(list.filter((id): id is string => typeof id === "string" && ids.has(id)))]];
      }),
    ) as Routing;
    const value = JSON.stringify(routing);
    await this.prisma.systemSetting.upsert({ where: { key: ROUTING_KEY }, create: { key: ROUTING_KEY, value }, update: { value } });
    return routing;
  }

  /**
   * The connections a stage tries, in order: its routing list, then every
   * other usable connection by priority (so a stage never fails while a
   * working model exists). The review stage prefers a different model than
   * the one that writes test cases, so one model checks another's work.
   */
  async chainFor(group: StageGroup): Promise<AiConnection[]> {
    await this.ensureMigrated();
    const rows = (await this.prisma.aiConnection.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] })).filter(
      (row) => this.blocked(row) === null,
    );
    const routing = await this.getRouting();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const routed = routing[group].map((id) => byId.get(id)).filter((row): row is AiConnection => Boolean(row));
    let rest = rows.filter((row) => !routed.includes(row));
    if (group === "review" && routed.length === 0) {
      const writer = routing.testCases.map((id) => byId.get(id)).find(Boolean) ?? rows[0];
      rest = [...rest.filter((row) => row !== writer), ...rest.filter((row) => row === writer)];
    }
    return [...routed, ...rest];
  }

  /**
   * Characters of source material a stage can send: the smallest context of
   * the connections it may fall back to, about 2.4 characters per token for
   * mixed Persian/English text, with roughly half kept for instructions and
   * the answer.
   */
  async contextBudget(group: StageGroup): Promise<number> {
    const chain = await this.chainFor(group);
    const tokens = chain.length ? Math.min(...chain.slice(0, 3).map((row) => row.contextTokens)) : 16_384;
    return Math.max(6_000, Math.floor(tokens * 2.4 * 0.5));
  }

  async analysisStatus(): Promise<{ ready: boolean; connections: number; primary: string | null; reason: ConnectionView["blockedReason"] | "none" }> {
    const all = await this.listConnections();
    const usable = all.filter((item) => item.usable);
    if (usable.length > 0) {
      const chain = await this.chainFor("analysis");
      return { ready: true, connections: usable.length, primary: chain[0] ? `${chain[0].name} · ${chain[0].model}` : null, reason: null };
    }
    return { ready: false, connections: 0, primary: null, reason: all[0]?.blockedReason ?? "none" };
  }

  // ── calls ─────────────────────────────────────────────────────────────

  /**
   * A structured model call for one stage. Each connection of the stage's
   * chain is tried in turn; within one connection, short rate limits and
   * server errors are retried, and an answer that does not fit the schema is
   * asked again with the validation error. Throws when every connection fails.
   */
  async call<T>(
    group: StageGroup,
    call: StructuredCall<T>,
    options: {
      signal?: AbortSignal;
      attemptsPerConnection?: number;
      onConnection?: (origin: CallOrigin) => void;
      onTokens?: (count: number) => void;
      /** The answer was stopped at the connection's writing time limit (partial). */
      onCut?: (reason: "time" | "length") => void;
    } = {},
  ): Promise<{ data: T; origin: CallOrigin }> {
    const chain = await this.chainFor(group);
    if (chain.length === 0) throw new Error("AI analysis is not available: none");
    const failures: string[] = [];
    for (const row of chain) {
      if (options.signal?.aborted) throw new Error("AI analysis was cancelled");
      const until = this.cooldown.get(row.id) ?? 0;
      if (until > Date.now()) {
        failures.push(`${row.name}: cooling down`);
        continue;
      }
      const origin = { connectionId: row.id, name: row.name, model: row.model };
      options.onConnection?.(origin);
      try {
        const data = await this.tryConnection(row, { ...call, onTokens: options.onTokens, onCut: options.onCut }, options.attemptsPerConnection ?? 3, options.signal);
        return { data, origin };
      } catch (error) {
        if (options.signal?.aborted) throw new Error("AI analysis was cancelled");
        failures.push(`${row.name}: ${message(error).slice(0, 160)}`);
        this.logger.warn(`AI ${group} failed on ${row.name}: ${message(error).slice(0, 200)}`);
      }
    }
    throw new Error(`AI ${group} failed on every connection — ${failures.join(" | ")}`);
  }

  /** Structured output for small helpers (scenario ranking); null when no model answers. */
  async tryStructured<T>(group: StageGroup, call: StructuredCall<T>): Promise<T | null> {
    try {
      return (await this.call(group, call, { attemptsPerConnection: 1 })).data;
    } catch {
      return null;
    }
  }

  /** One model call at a time per connection: a local model gains nothing from parallel requests. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private tryConnection<T>(row: AiConnection, call: StructuredCall<T>, attempts: number, signal?: AbortSignal): Promise<T> {
    // Hosted services answer a few requests at once (free tiers limit bursts); a local model one at a time.
    if (isExternal(row.baseUrl)) return this.limited(row.id, HOSTED_CONCURRENCY, () => this.attempt(row, call, attempts, signal), signal);
    const previous = this.queues.get(row.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.attempt(row, call, attempts, signal));
    this.queues.set(row.id, next);
    void next.finally(() => {
      if (this.queues.get(row.id) === next) this.queues.delete(row.id);
    }).catch(() => undefined);
    if (!signal) return next;
    // A cancelled call stops waiting at once, even while queued behind another analysis.
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("AI analysis was cancelled"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private readonly slots = new Map<string, { active: number; waiting: Array<() => void> }>();

  /** Run `work` when fewer than `max` calls to this connection are in flight. */
  private async limited<T>(id: string, max: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slot = this.slots.get(id) ?? { active: 0, waiting: [] };
    this.slots.set(id, slot);
    if (slot.active >= max) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        // A cancelled call leaves the line, so it never holds up the calls behind it.
        const onAbort = () => {
          slot.waiting.splice(slot.waiting.indexOf(wake), 1);
          reject(new Error("AI analysis was cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        slot.waiting.push(wake);
      });
    }
    slot.active += 1;
    try {
      return await work();
    } finally {
      slot.active -= 1;
      slot.waiting.shift()?.();
    }
  }

  private async attempt<T>(row: AiConnection, call: StructuredCall<T>, attempts: number, signal?: AbortSignal): Promise<T> {
    const provider = this.provider(row);
    let prompt = call.prompt;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw new Error("AI analysis was cancelled");
      if (call.deadlineAt && Date.now() >= call.deadlineAt) throw new Error(TIME_LIMIT);
      try {
        return await provider.generateStructured({ ...call, prompt, signal });
      } catch (error) {
        lastError = error;
        if (signal?.aborted) break;
        if (error instanceof AiHttpError) {
          // Rate limits (free tiers answer 402 or 429) and server errors are short-lived.
          if (error.status === 402 || error.status === 429 || error.status >= 500) {
            const wait = backoff(attempt, error.retryAfter) + Math.random() * 1_000;
            if (wait > MAX_WAIT_MS) {
              this.cooldown.set(row.id, Date.now() + wait);
              break;
            }
            // Within an analysis time limit a busy service is worth more retries than a slow fallback.
            const limit = call.deadlineAt ? Math.max(attempts, RATE_LIMIT_ATTEMPTS) : attempts;
            if (attempt >= limit || (call.deadlineAt && Date.now() + wait >= call.deadlineAt)) break;
            if (call.deadlineAt) attempts = limit;
            await sleep(wait, signal);
            continue;
          }
          break;
        }
        const text = message(error);
        if (/response is empty/i.test(text) && attempt < attempts) continue;
        if (/JSON|schema/i.test(text)) {
          prompt = `${call.prompt}\n\nYour previous answer was rejected: ${text.slice(0, 500)}\nReturn one JSON object that matches the requested shape exactly.`;
          continue;
        }
        // Unreachable server (fetch failed, connection refused): no point retrying this one.
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text)) {
          this.cooldown.set(row.id, Date.now() + 60_000);
          break;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) break;
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("AI generation failed");
  }

  private provider(row: AiConnection): AIProvider {
    if (row.kind === "openai") return this.openai(row);
    return new OllamaProvider(row.baseUrl, row.model, {
      temperature: row.temperature,
      timeoutMs: row.timeoutMs,
      answerBudgetMs: row.answerBudgetMs,
      contextTokens: row.contextTokens,
      reasoning: row.reasoning,
    });
  }

  private openai(row: AiConnection) {
    return new OpenAICompatibleProvider(row.baseUrl, row.model, this.apiKey(row), row.temperature, row.timeoutMs, row.reasoning);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async connection(id: string) {
    const row = await this.prisma.aiConnection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("AI connection not found");
    return row;
  }

  private apiKey(row: AiConnection) {
    if (!row.apiKeyEnc) return "";
    try {
      return decryptSecret(row.apiKeyEnc, this.encryptionKey());
    } catch {
      return "";
    }
  }

  private blocked(row: AiConnection): ConnectionView["blockedReason"] {
    if (!row.enabled) return "disabled";
    const external = isExternal(row.baseUrl);
    if (external && !row.allowExternal) return "external_not_allowed";
    // Some free services (LLM7, Pollinations) need no key; one that does answers 401.
    return null;
  }

  private view(row: AiConnection): ConnectionView {
    const blockedReason = this.blocked(row);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind === "openai" ? "openai" : "ollama",
      baseUrl: row.baseUrl,
      model: row.model,
      hasApiKey: Boolean(row.apiKeyEnc),
      external: isExternal(row.baseUrl),
      allowExternal: row.allowExternal,
      enabled: row.enabled,
      temperature: row.temperature,
      timeoutMs: row.timeoutMs,
      answerBudgetMs: row.answerBudgetMs,
      contextTokens: row.contextTokens,
      reasoning: row.reasoning,
      priority: row.priority,
      usable: blockedReason === null,
      blockedReason,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastCheckedAt: row.lastCheckedAt,
    };
  }

  private validate(input: ConnectionInput, current: AiConnection | null) {
    const kind = input.kind === "openai" || input.kind === "ollama" ? input.kind : (current?.kind ?? "ollama");
    const baseUrl = (input.baseUrl?.trim() || current?.baseUrl || "").replace(/\/+$/, "");
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new BadRequestException("AI base URL must be a valid http(s) URL");
    }
    const model = input.model?.trim() || current?.model || "";
    if (!model) throw new BadRequestException("Choose a model");
    const hostChanged = current && hostOf(current.baseUrl) !== hostOf(baseUrl);
    return {
      name: (input.name?.trim() || current?.name || hostOf(baseUrl) || "AI").slice(0, 80),
      kind,
      baseUrl,
      model: model.slice(0, 200),
      apiKeyEnc: input.clearApiKey ? "" : input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), this.encryptionKey()) : (current?.apiKeyEnc ?? ""),
      // Consent is for one service: pointing the connection elsewhere asks again.
      allowExternal: input.allowExternal ?? (hostChanged ? false : (current?.allowExternal ?? false)),
      enabled: input.enabled ?? current?.enabled ?? true,
      temperature: clamp(input.temperature ?? current?.temperature ?? 0.2, 0, 1),
      timeoutMs: Math.round(clamp(input.timeoutMs ?? current?.timeoutMs ?? 600_000, 5_000, MAX_TIMEOUT_MS)),
      answerBudgetMs: Math.round(clamp(input.answerBudgetMs ?? current?.answerBudgetMs ?? 180_000, 0, MAX_TIMEOUT_MS)),
      contextTokens: Math.round(clamp(input.contextTokens ?? current?.contextTokens ?? 16_384, 2_048, 1_048_576)),
      reasoning: input.reasoning ?? current?.reasoning ?? false,
      ...(input.priority !== undefined ? { priority: Math.round(input.priority) } : {}),
    };
  }

  private encryptionKey() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  /** The single-provider settings of earlier versions become the first connection. */
  private ensureMigrated() {
    this.migrated ??= (async () => {
      if ((await this.prisma.aiConnection.count()) > 0) return;
      const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: LEGACY_KEYS } } });
      const saved = new Map(rows.map((row) => [row.key, row.value]));
      const kind = saved.get("ai.provider") === "openai" ? "openai" : "ollama";
      await this.prisma.aiConnection.create({
        data: {
          name: kind === "ollama" ? "Local Ollama" : hostOf(saved.get("ai.baseUrl") ?? "") || "AI",
          kind,
          baseUrl: (saved.get("ai.baseUrl") || this.config.get<string>("OLLAMA_BASE_URL", "http://localhost:11434")).replace(/\/$/, ""),
          model: saved.get("ai.model") || this.config.get<string>("OLLAMA_MODEL", "qwen3:8b"),
          apiKeyEnc: saved.get("ai.apiKeyEnc") ?? "",
          allowExternal: saved.get("ai.allowExternal") === "true",
          enabled: saved.get("ai.deepAnalysis") !== "false",
          temperature: Number(saved.get("ai.temperature") ?? 0.2) || 0.2,
          priority: 0,
        },
      });
    })().catch((error: unknown) => {
      this.migrated = null;
      throw error;
    });
    return this.migrated;
  }
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
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Math.min(2000 * 2 ** (attempt - 1), MAX_WAIT_MS);
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

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
