/**
 * Step states. RECOVERED = passed only after automatic or manual correction;
 * NEEDS_INPUT = the request failed and the user can map an input by hand.
 * NOT_RUN / RUNNING / RECOVERING exist only in the live view.
 */
export type StepStatus = "PASSED" | "FAILED" | "SKIPPED" | "CANCELLED" | "RECOVERED" | "NEEDS_INPUT";

/** Where a consumed value came from, when an earlier step produced it. */
export type ValueSource = { stepId?: string; stepName: string; orderIndex: number; path: string };

export type StepExecutionResult = {
  status: StepStatus;
  output?: unknown;
  error?: string;
  extractedVars?: Record<string, string>;
  resolvedInput?: unknown;
  /** Variables this step read, and where ({{x}} or auto-bound fields). */
  consumedVars?: Array<{ variable: string; location: string; source?: ValueSource }>;
  /** Present when the step failed its expectation and recovery was evaluated. */
  recovery?: RecoveryTrace;
  /** Status / assertion checks the step's final response was judged by. */
  assertions?: AssertionCheck[];
  /** Manual Recovery options for a NEEDS_INPUT step (secret values masked). */
  manual?: ManualRecoveryOptions;
  /** Saved mappings that had no value in this run. */
  bindingWarnings?: string[];
  /** Response mappings (`config.extract`) of this step and what each produced (no values). */
  extractions?: ExtractionOutcome[];
  /** Registry values this step produced, and the few worth showing first. */
  values?: RegistryView[];
  important?: RegistryView[];
};

import { isSecretKey, maskDeep } from "../common/mask.util";
import type { FlowHistoryEntry, RecoveryTrace } from "./flow/recovery";
import type { ManualRecoveryOptions } from "./flow/manual-recovery";
import type { ExtractionOutcome } from "./flow/response-mapping";
import type { AssertionCheck } from "./flow/recover-step";
import { ValueRegistry, type RegistryView } from "./flow/value-registry";

export class ExecutionContext {
  private readonly variables = new Map<string, string>();
  private readonly initialKeys = new Set<string>();
  private readonly secretValues = new Set<string>();
  /** Origin whose response supplied the current bearer token, if known. */
  tokenOrigin: string | null = null;
  /** Successful HTTP steps of this run, oldest first (runtime flow context). */
  readonly history: FlowHistoryEntry[] = [];
  /** Runtime Value Registry: every value earlier successful steps produced. */
  readonly registry = new ValueRegistry();
  /** Variable → the response value it was learned from. */
  private varSources = new Map<string, ValueSource>();
  /** Variable → JSON type of the value it was learned from (numbers stay numbers, objects stay objects). */
  private varTypes = new Map<string, "number" | "boolean" | "json">();
  private cancelled = false;
  private readonly abortHandlers = new Set<() => void>();
  lastHttpResponse: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    rawBody: string;
    cookies?: Record<string, string>;
    durationMs?: number;
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

  /** Values known to be secret (for masking views of the registry). */
  secretSet(): ReadonlySet<string> {
    return this.secretValues;
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

  /** Remember the JSON type and origin path of a learned variable. */
  describeVariable(key: string, meta: { type?: string; path?: string; source?: ValueSource }) {
    if (meta.type === "number" || meta.type === "boolean") this.varTypes.set(key, meta.type);
    else if (meta.type === "object" || meta.type === "array") this.varTypes.set(key, "json");
    else if (meta.type) this.varTypes.delete(key);
    if (meta.source) this.varSources.set(key, meta.source);
    else if (meta.path) this.pendingPaths.set(key, meta.path);
  }

  /** Paths learned by the last response, until the step that sent it is known. */
  readonly pendingPaths = new Map<string, string>();

  sourceOf(key: string): ValueSource | undefined {
    return this.varSources.get(key);
  }

  /** The value was read from an API response (untrusted data, not configuration). */
  fromResponse(key: string): boolean {
    return this.varSources.has(key) || this.pendingPaths.has(key);
  }

  /** The variable's value in its original JSON type (number/boolean/object/array), else the text. */
  typedValue(key: string): unknown {
    const value = this.variables.get(key);
    if (value === undefined) return undefined;
    const type = this.varTypes.get(key);
    if (type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
    if (type === "json") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }

  /** Variables, their types/sources and token origin, so a rejected retry can be undone. */
  snapshot() {
    return {
      variables: this.entries(),
      tokenOrigin: this.tokenOrigin,
      types: new Map(this.varTypes),
      sources: new Map(this.varSources),
    };
  }

  restore(snapshot: ReturnType<ExecutionContext["snapshot"]>) {
    this.variables.clear();
    for (const [key, value] of Object.entries(snapshot.variables)) this.variables.set(key, value);
    this.tokenOrigin = snapshot.tokenOrigin;
    this.varTypes = new Map(snapshot.types);
    this.varSources = new Map(snapshot.sources);
    this.pendingPaths.clear();
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
  status: "PASSED" | "FAILED" | "CANCELLED" | "NEEDS_INPUT";
  error?: string;
  stepResults: OrchestrationStepResult[];
};
