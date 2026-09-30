export type StepExecutionResult = {
  status: "PASSED" | "FAILED" | "SKIPPED" | "CANCELLED";
  output?: unknown;
  error?: string;
  extractedVars?: Record<string, string>;
  resolvedInput?: unknown;
  /** Variables this step read, and where ({{x}} or auto-bound fields). */
  consumedVars?: Array<{ variable: string; location: string }>;
  /** Present when the step failed its expectation and recovery was evaluated. */
  recovery?: RecoveryTrace;
};

import { isSecretKey, maskDeep } from "../common/mask.util";
import type { FlowHistoryEntry, RecoveryTrace } from "./flow/recovery";

export class ExecutionContext {
  private readonly variables = new Map<string, string>();
  private readonly initialKeys = new Set<string>();
  private readonly secretValues = new Set<string>();
  /** Origin whose response supplied the current bearer token, if known. */
  tokenOrigin: string | null = null;
  /** Successful HTTP steps of this run, oldest first (runtime flow context). */
  readonly history: FlowHistoryEntry[] = [];
  private cancelled = false;
  private readonly abortHandlers = new Set<() => void>();
  lastHttpResponse: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    rawBody: string;
  } | null = null;

  constructor(initial: Record<string, string> = {}, options: { secretKeys?: Iterable<string> } = {}) {
    const secretKeys = new Set(options.secretKeys ?? []);
    for (const [k, v] of Object.entries(initial)) {
      this.variables.set(k, v);
      this.initialKeys.add(k);
      if (secretKeys.has(k) || isSecretKey(k)) this.markSecret(v);
    }
  }

  /** Remember a value that must never appear in stored inputs/outputs/logs. */
  markSecret(value: string | undefined) {
    if (value) this.secretValues.add(value);
  }

  /** Mask secrets (by key, pattern and known value) before persisting. */
  redact<T>(value: T): unknown {
    return maskDeep(value, this.secretValues);
  }

  isInitial(key: string) {
    return this.initialKeys.has(key);
  }

  cancel() {
    this.cancelled = true;
    for (const handler of this.abortHandlers) {
      try {
        handler();
      } catch {
        // ignore abort handler errors
      }
    }
  }

  onAbort(handler: () => void): () => void {
    this.abortHandlers.add(handler);
    return () => this.abortHandlers.delete(handler);
  }

  isCancelled() {
    return this.cancelled;
  }

  get(key: string): string | undefined {
    return this.variables.get(key);
  }

  set(key: string, value: string) {
    this.variables.set(key, value);
    if (isSecretKey(key)) this.markSecret(value);
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.variables.entries());
  }

  /** Variables and token origin, so a rejected retry can be undone. */
  snapshot() {
    return { variables: this.entries(), tokenOrigin: this.tokenOrigin };
  }

  restore(snapshot: ReturnType<ExecutionContext["snapshot"]>) {
    this.variables.clear();
    for (const [key, value] of Object.entries(snapshot.variables)) this.variables.set(key, value);
    this.tokenOrigin = snapshot.tokenOrigin;
  }

  interpolate(input: string): string {
    return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
      const value = this.variables.get(key);
      if (value === undefined) {
        throw new Error(`Unresolved variable: {{${key}}}`);
      }
      return value;
    });
  }

  interpolateDeep<T>(value: T): T {
    if (typeof value === "string") {
      return this.interpolate(value) as T;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.interpolateDeep(v)) as T;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.interpolateDeep(v);
      }
      return out as T;
    }
    return value;
  }
}

export interface StepExecutor {
  readonly type: string;
  execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<StepExecutionResult>;
}

export type OrchestrationStep = {
  id?: string;
  name: string;
  type: string;
  enabled: boolean;
  orderIndex: number;
  config: Record<string, unknown>;
};

export type OrchestrationStepResult = StepExecutionResult & {
  name: string;
  type: string;
  orderIndex: number;
  durationMs: number;
};

export type OrchestrationResult = {
  status: "PASSED" | "FAILED" | "CANCELLED";
  error?: string;
  stepResults: OrchestrationStepResult[];
};
