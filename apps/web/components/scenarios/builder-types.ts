/** Shapes the scenario builder reads from the API (scenarios.controller). */

export type InputLocation = "url" | "path" | "query" | "header" | "body" | "form" | "cookie";

export type Step = {
  id: string;
  name: string;
  type: string;
  orderIndex: number;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type StepRun = {
  id: string;
  scenarioStepId?: string | null;
  name: string;
  type: string;
  status: string;
  orderIndex: number;
  durationMs?: number | null;
  error?: string | null;
  resolvedInput?: unknown;
  output?: unknown;
};

/** Mirrors the API's UiLiveProgress (scenario-engine/types.ts). */
export type UiLiveProgress = {
  phase: "starting" | "signingIn" | "opening" | "actions" | "finishing";
  current: number;
  total: number;
  actions: Array<{ id: string; kind: string; label: string; status: "pending" | "running" | "passed" | "failed" | "skipped" }>;
};

export type ScenarioRun = {
  id: string;
  status: string;
  durationMs?: number | null;
  error?: string | null;
  stepRuns: StepRun[];
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  live?: {
    orderIndex: number;
    stepId?: string;
    stepName: string;
    state: "RUNNING" | "RECOVERING" | "NEEDS_INPUT";
    attempt?: number;
    max?: number;
    awaitingInput: boolean;
    stepRunId: string | null;
    /** A UI step: which of its actions is running. */
    ui?: UiLiveProgress;
  } | null;
};

export type Scenario = {
  id: string;
  name: string;
  description: string;
  stopOnFailure: boolean;
  environmentId?: string | null;
  steps: Step[];
  runs: ScenarioRun[];
};

export type Env = { id: string; name: string };

export type ExpectedValue = { kind: "token" | "value"; key: string; alt?: string[] };

/** A condition that recognises one item of a list (see apps/api/src/scenario-engine/flow/list-pick.ts). */
export type PickCondition = {
  field: string;
  op: "equals" | "in";
  value: { text: string } | { source: { stepId?: string; stepName?: string; orderIndex?: number; path: string } };
};

/** Which item of a list a mapping reads: first / last, or the one the conditions single out. */
export type ListPick = { list: string; item: string; position?: "first" | "last"; where?: PickCondition[] };

export type ResponseSource = { stepId?: string; stepName?: string; orderIndex?: number; path: string; expect?: ExpectedValue; pick?: ListPick };

export type StepBinding = {
  target: { location: InputLocation; field: string; key?: string };
  source: ResponseSource | { value: string };
  origin?: "manual" | "accepted";
  enabled?: boolean;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  evidence?: "response" | "request";
  verifiedAt?: string;
  createdAt?: string;
};

export type MappingStatus =
  | "ok"
  | "unverified"
  | "disabled"
  | "source_missing"
  | "source_after_target"
  | "source_disabled"
  | "target_missing"
  | "path_missing";

export type MappingReview = {
  stepId: string;
  index: number;
  binding: StepBinding;
  status: MappingStatus;
  sourceStep: number | null;
  sourceName: string | null;
};

export type Suggestion = {
  id: string;
  producerStepId: string;
  producerName: string;
  consumerStepId: string;
  consumerName: string;
  sourcePath: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  masked: boolean;
  target: { location: InputLocation; field: string; key: string };
  evidence: "response" | "request";
  reason: "same_value" | "auth_token" | "creates_entity" | "returns_entity" | "auth_user" | "recovered";
  expect?: ExpectedValue;
};

export type InputField = {
  location: InputLocation;
  field: string;
  key: string;
  type: "number" | "string" | "boolean";
  secret: boolean;
  display: string;
};

export type FlowAnalysis = {
  dependencies: Suggestion[];
  mappings: MappingReview[];
  inputs: Array<{ stepId: string; fields: InputField[] }>;
  environmentKeys?: string[];
  variables?: import("./response-mapping-editor").VariableProducer[];
  issues: Array<{ stepId: string; severity: string; code: string; detail: string }>;
};

export const isResponseSource = (source: StepBinding["source"]): source is ResponseSource => !("value" in source);

/** A mapping that can no longer work as saved and needs the user. */
export const NEEDS_REVIEW: MappingStatus[] = ["source_missing", "source_after_target", "source_disabled", "target_missing", "path_missing"];

export const sameTarget = (a: { location: string; field: string }, b: { location: string; field: string }) =>
  a.location === b.location && (a.location === "header" ? a.field.toLowerCase() === b.field.toLowerCase() : a.field === b.field);

/** Executor output as stored on a step run (response plus flow details). */
export type StepOutput = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  durationMs?: number;
  recovery?: RecoveryTrace;
  assertions?: Array<{ label: string; passed: boolean; error?: string }>;
  manual?: ManualOptions;
  blocked?: Array<{ target: string; sourceStep: string; path: string; reason: string }>;
  consumedVars?: Array<{ variable: string; location: string; source?: { stepId?: string; orderIndex: number; path: string } }>;
  responseError?: ResponseError;
};

/** What the response said was wrong (also with a 2xx), and the request field and mapping it is about. */
export type ResponseError = {
  message: string;
  code: string | null;
  signal: string;
  field: { location: InputLocation; field: string; key: string } | null;
  fieldEvidence: "named" | "mentioned" | "auth" | null;
  mapping: { stepName: string | null; orderIndex: number | null; path: string | null; fixedValue: boolean } | null;
};

export type CandidateChange = {
  location: InputLocation;
  field: string;
  fieldName: string;
  original: string;
  replacement: string;
  source: { stepId?: string; stepName: string; orderIndex: number; path: string; ref?: string };
};

export type RecoveryAttempt = {
  candidate: CandidateChange & { changes?: CandidateChange[]; confidence: string; reason: string };
  status: number | null;
  expectationMet: boolean;
  failures: string[];
  error?: string;
  request?: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  durationMs?: number;
  message?: string;
  manual?: boolean;
};

export type RecoveryTrace = {
  outcome: string;
  originalStatus: number | null;
  failures: string[];
  attempts: RecoveryAttempt[];
  suggestions: RecoveryAttempt["candidate"][];
  maxAttempts: number;
  stoppedBecause?: string;
  original?: { method: string; url: string; status: number | null; durationMs?: number; message?: string };
  likelyField?: { location: InputLocation; field: string; fieldName: string } | null;
  manual?: boolean;
  savedMapping?: boolean;
};

export type RegistryView = {
  ref: string;
  stepId?: string;
  stepName: string;
  orderIndex: number;
  path: string;
  key: string;
  semanticKey: string;
  display: string;
  secret: boolean;
  category: string;
};

export type ManualOptions = {
  targets: Array<{ location: InputLocation; field: string; key: string; display: string; type: string; secret: boolean }>;
  likelyField: { location: InputLocation; field: string; fieldName: string } | null;
  recommended: Array<{
    target: { location: InputLocation; field: string; fieldName: string };
    ref: string;
    display: string;
    stepName: string;
    orderIndex: number;
    path: string;
    confidence: string;
    tried: boolean;
  }>;
  values: RegistryView[];
  truncated: boolean;
};

export function outputOf(run: StepRun | undefined | null): StepOutput | null {
  const output = run?.output;
  return output && typeof output === "object" && !Array.isArray(output) ? (output as StepOutput) : null;
}

/** "response.body.data.user.id" → "data.user.id"; headers keep their prefix. */
export function shortPath(path: string) {
  return path.replace(/^response\.body\.?/, "").replace(/^\$\.?/, "").replace(/^response\./, "") || "body";
}

export function httpSummary(config: Record<string, unknown>) {
  const method = typeof config.method === "string" ? config.method.toUpperCase() : "GET";
  const url = typeof config.url === "string" ? config.url : "";
  return { method, url };
}

export type StepState =
  | "NOT_RUN"
  | "PENDING"
  | "RUNNING"
  | "RECOVERING"
  | "NEEDS_INPUT"
  | "PASSED"
  | "RECOVERED"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED"
  | "CANCELLED";

export const ACTIVE_RUN = new Set(["RUNNING", "NEEDS_INPUT", "PENDING"]);

export function stepRunOf(step: Step, run: ScenarioRun | null | undefined) {
  return run?.stepRuns.find((item) => item.scenarioStepId === step.id);
}

/** What a step shows for a run: live state while it runs, else its stored result. */
export function stepStateOf(step: Step, run: ScenarioRun | null | undefined): StepState {
  if (!run) return "NOT_RUN";
  if (run.live?.stepId === step.id && ACTIVE_RUN.has(run.status)) return run.live.state;
  const stepRun = stepRunOf(step, run);
  if (stepRun) {
    if (stepRun.status === "FAILED" && outputOf(stepRun)?.blocked?.length) return "BLOCKED";
    return stepRun.status as StepState;
  }
  return ACTIVE_RUN.has(run.status) ? "PENDING" : "NOT_RUN";
}

export function stateTone(state: StepState | string) {
  switch (state) {
    case "PASSED":
      return { text: "text-success", dot: "bg-success" };
    case "RECOVERED":
      return { text: "text-success", dot: "bg-success" };
    case "FAILED":
      return { text: "text-destructive", dot: "bg-destructive" };
    case "BLOCKED":
    case "NEEDS_INPUT":
      return { text: "text-warning", dot: "bg-warning" };
    case "RUNNING":
    case "RECOVERING":
      return { text: "text-primary", dot: "bg-primary animate-pulse" };
    case "CANCELLED":
      return { text: "text-warning", dot: "bg-warning" };
    default:
      return { text: "text-muted-foreground", dot: "bg-border" };
  }
}
