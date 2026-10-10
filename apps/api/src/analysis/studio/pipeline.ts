import { maskSecrets, type NormalizedTestCase, type ProviderEvaluation, type QualityReport, type QualityTiming } from "@qa-workbench/shared";
import type { z } from "zod";
import type { AppLocale } from "../../ai/localize-fa";
import { TIME_LIMIT } from "../../ai/ai-provider";
import type { CallOrigin, StageGroup } from "../../ai/ai.service";
import * as P from "./prompts";
import {
  AssessmentSchema,
  AutomationSchema,
  CriteriaSchema,
  DigestSchema,
  EdgesSchema,
  ReviewSchema,
  TranslationSchema,
  UnderstandingSchema,
  type Assessment,
  type GeneratedCase,
  type GeneratedEdge,
  type Translation,
  type Understanding,
} from "./schemas";
import { isGrounded, norm, similarity } from "./text";
import { DEFAULT_QUALITY_CONFIG, qualityLevel, type QualityConfig } from "./quality/config";
import { describe as describeSet, evaluateSet } from "./quality/evaluate";
import { normalizeCases, ProviderCasesSchema, rescore, toStudioCase } from "./quality/normalize";
import { evaluateProvider, qualityGate, selectAndMerge, type ProviderRun } from "./quality/select";
import { analyzeTask, type TaskProfile } from "./quality/task-profile";

/**
 * The analysis studio pipeline. A model does the reading and writing; this
 * code decides what each stage sees, checks every claim against the source
 * text, and lets a second model review the first one's drafts:
 *
 *   digest? → understand → criteria → { assessment ‖ test cases ‖ edge cases ‖ translation }
 *           → review → automation
 *
 * Stages routed to different connections run in parallel. A failed stage is
 * reported and the others continue — except `understand`, which every other
 * stage depends on.
 */

export const STUDIO_STAGES = ["digest", "understand", "criteria", "assessment", "cases", "edges", "translate", "review", "automation"] as const;
export type StudioStage = (typeof STUDIO_STAGES)[number];

const GROUP: Record<StudioStage, StageGroup> = {
  digest: "analysis",
  understand: "analysis",
  criteria: "analysis",
  assessment: "analysis",
  cases: "testCases",
  edges: "edgeCases",
  translate: "translate",
  review: "review",
  automation: "automation",
};

export type GuidanceScope = "criteria" | "questions" | "testCases" | "edgeCases" | "risks" | "strategy" | "automation" | "summary";

export type StudioLlm = <T>(
  group: StageGroup,
  stage: StudioStage,
  call: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    locale: AppLocale;
    deadlineAt?: number;
    /** Ask exactly this connection (no fallback) — one provider of a comparison. */
    connectionId?: string;
    /** Stops this call (a provider that timed out or is no longer needed). */
    signal?: AbortSignal;
  },
) => Promise<{ data: T; origin: CallOrigin }>;

/** A connection that generates test cases on its own, to be compared with the others. */
export type CaseProvider = { id: string; name: string; model: string };

export type SourceCriterion = { key: string; text: string; origin: string };
export type StudioSource = {
  issueKey: string;
  title: string;
  description: string;
  criteria: SourceCriterion[];
  documents: Array<{ title: string; text: string }>;
};

export type NumberedRule = Understanding["rules"][number] & { id: string; grounded: boolean };
export type StudioUnderstanding = Omit<Understanding, "rules"> & { rules: NumberedRule[] };

export type ProposedCriterion = {
  key: string;
  text: string;
  category: string;
  evidence: string;
  grounded: boolean;
  ruleRefs: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  rationale: string;
};

/** `qualityId`: the normalized case this one was made from (quality evaluation). */
export type CaseWithKeys = GeneratedCase & { criterionKeys: string[]; reviewNote?: string; qualityId?: string };

export type StudioResult = {
  understanding: StudioUnderstanding | null;
  proposed: ProposedCriterion[] | null;
  writtenIssues: Array<{ key: string; problem: string; suggestion: string }>;
  assessment: Assessment | null;
  cases: CaseWithKeys[] | null;
  edges: GeneratedEdge[] | null;
  automation: Array<{ caseIndex: number; suitability: "HIGH" | "MEDIUM" | "LOW"; layer: string; rationale: string; prerequisites: string[]; tooling: string }> | null;
  translation: Translation | null;
  sourceLanguage: AppLocale;
  dropped: { criteria: number; cases: number; edges: number };
  /** Which connection answered each stage. */
  origins: Partial<Record<StudioStage, CallOrigin[]>>;
  errors: Partial<Record<StudioStage, string>>;
  /** Provider comparison and the quality of the final test cases (when cases were generated). */
  quality: QualityReport | null;
};

export type StudioProgress = { stage: StudioStage; state: "running" | "done" | "failed" | "skipped"; detail?: string; origin?: CallOrigin };

export type StudioRunInput = {
  source: StudioSource;
  locale: AppLocale;
  /** Stages wanted; dependencies missing from `previous` are added automatically. */
  stages: StudioStage[];
  previous?: { understanding?: StudioUnderstanding | null };
  /** Only design test cases for these criteria (a per-criterion re-run). */
  targetKeys?: string[];
  /** Existing test cases for an automation-only run. */
  existingCases?: Array<{ title: string; steps: string[]; expectedResult: string; type: string }>;
  llm: StudioLlm;
  guidance: (scope: GuidanceScope) => string;
  /** Characters of source material that fit the analysis model's context. */
  budgetChars: number;
  onProgress?: (progress: StudioProgress) => void;
  isCancelled?: () => boolean;
  /** Epoch ms the whole run must finish by; each stage gets its share and what is done is kept. */
  deadline?: number;
  /**
   * Connections that each write the test cases, run side by side and compared
   * (two or more); otherwise the test-case route's fallback chain answers.
   */
  caseProviders?: CaseProvider[];
  /** Longest time one provider may take for its test cases (ms); 0/undefined = the stage's share of the run. */
  providerTimeoutMs?: number;
  quality?: QualityConfig;
  /** The provider comparison as it fills in: each provider is reported as soon as it is done. */
  onQuality?: (report: QualityReport) => void;
};

/**
 * Point of the run's time budget by which each stage must be done. Later
 * stages build on earlier ones, so no stage may eat the time of the rest.
 */
const STAGE_DEADLINE: Record<StudioStage, number> = {
  digest: 0.2,
  understand: 0.35,
  criteria: 0.55,
  assessment: 0.82,
  cases: 0.82,
  edges: 0.82,
  translate: 0.82,
  review: 0.93,
  // The rest is kept for saving the results.
  automation: 0.97,
};

const CASE_BATCH = 3;
const AUTOMATION_BATCH = 10;
const MAX_UNDERSTANDING_CHARS = 14_000;

/** Warning for a stage of which some batches were left out. */
function partialNote(reason: unknown, missed: number, total: number) {
  const text = reason instanceof Error ? reason.message : String(reason);
  return maskSecrets(`${missed}/${total} batches left out — ${text}`).slice(0, 600);
}

/** Persian when Persian letters dominate. */
export function detectLanguage(value: string): AppLocale {
  const persian = (value.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return persian > latin * 0.35 ? "fa" : "en";
}

export { norm, isGrounded, similarity };

export const isOfficial = (origin: string) => origin !== "ai" && origin !== "derived";

/** The issue and its documents as one text, credentials masked. */
export function sourceMaterial(source: StudioSource) {
  const written = source.criteria.filter((item) => isOfficial(item.origin));
  const parts = [
    `ISSUE ${source.issueKey}: ${source.title}`,
    `DESCRIPTION:\n${source.description || "(empty)"}`,
    written.length ? `ACCEPTANCE CRITERIA (written):\n${written.map((item) => `${item.key}: ${item.text}`).join("\n")}` : "ACCEPTANCE CRITERIA: none written",
    ...source.documents.map((doc, index) => `DOCUMENT ${index + 1} — ${doc.title}:\n${doc.text}`),
  ];
  return maskSecrets(parts.join("\n\n"));
}

/** Split long text on paragraph boundaries into chunks of about `size` characters. */
export function chunk(text: string, size: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      out.push(current);
      current = "";
    }
    if (paragraph.length > size) {
      for (let start = 0; start < paragraph.length; start += size) out.push(paragraph.slice(start, start + size));
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}

function compactUnderstanding(understanding: StudioUnderstanding) {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(prune).filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "grounded" && key !== "evidence")
        .map(([key, item]) => [key, prune(item)] as const)
        .filter(([, item]) => item !== undefined && item !== "");
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return value === "" ? undefined : value;
  };
  return JSON.stringify(prune(understanding)).slice(0, MAX_UNDERSTANDING_CHARS);
}

export async function runStudio(input: StudioRunInput): Promise<StudioResult> {
  const { source, locale, llm } = input;
  const wanted = new Set(input.stages);
  const corpus = [source.title, source.description, ...source.criteria.map((item) => item.text), ...source.documents.map((doc) => doc.text)].join("\n");
  const result: StudioResult = {
    understanding: input.previous?.understanding ?? null,
    proposed: null,
    writtenIssues: [],
    assessment: null,
    cases: null,
    edges: null,
    automation: null,
    translation: null,
    sourceLanguage: detectLanguage(`${source.title}\n${source.description}`),
    dropped: { criteria: 0, cases: 0, edges: 0 },
    origins: {},
    errors: {},
    quality: null,
  };
  const progress = (stage: StudioStage, state: StudioProgress["state"], extra: Partial<StudioProgress> = {}) => {
    if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
    input.onProgress?.({ stage, state, ...extra });
  };
  const startedAt = Date.now();
  const timing: QualityTiming = {
    taskParsingMs: 0,
    requirementExtractionMs: 0,
    providers: {},
    normalizationMs: 0,
    scoringMs: 0,
    deduplicationMs: 0,
    selectionMs: 0,
    qualityGateMs: 0,
    totalMs: 0,
  };
  const deadlineOf = (stage: StudioStage) =>
    input.deadline ? startedAt + Math.round((input.deadline - startedAt) * STAGE_DEADLINE[stage]) : undefined;
  const ask = async <T>(stage: StudioStage, prompt: string, schema: z.ZodType<T>, only?: { connectionId: string; signal: AbortSignal; deadlineAt?: number }) => {
    if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
    const stageDeadline = deadlineOf(stage);
    const deadlineAt = stageDeadline && only?.deadlineAt ? Math.min(stageDeadline, only.deadlineAt) : (stageDeadline ?? only?.deadlineAt);
    if (deadlineAt && Date.now() >= deadlineAt) throw new Error(TIME_LIMIT);
    const answer = await llm(GROUP[stage], stage, {
      system: P.SYSTEM,
      prompt,
      schema,
      locale,
      deadlineAt,
      ...(only ? { connectionId: only.connectionId, signal: only.signal } : {}),
    });
    (result.origins[stage] ??= []).push(answer.origin);
    progress(stage, "running", { origin: answer.origin });
    return answer.data;
  };
  /** Run a stage; a failure is recorded and the run continues. */
  const guard = async (stage: StudioStage, work: () => Promise<void>) => {
    progress(stage, "running");
    try {
      await work();
      progress(stage, "done");
    } catch (error) {
      if (input.isCancelled?.()) throw error;
      result.errors[stage] = maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600);
      // Out of time is not a failure: the stage is skipped and the run keeps what it has.
      const deadlineAt = deadlineOf(stage);
      const outOfTime = Boolean(deadlineAt && Date.now() >= deadlineAt - 1_000);
      if (outOfTime) result.errors[stage] = TIME_LIMIT;
      progress(stage, outOfTime ? "skipped" : "failed", { detail: result.errors[stage] });
    }
  };

  // Source material, condensed by the model when it does not fit the context.
  const parsingStart = Date.now();
  let material = sourceMaterial(source);
  if (material.length > input.budgetChars) {
    const parts = chunk(material, Math.max(4000, Math.floor(input.budgetChars * 0.8)));
    progress("digest", "running", { detail: `0/${parts.length}` });
    const notes: string[] = [];
    for (const [index, part] of parts.entries()) {
      const digest = await ask("digest", P.digestPrompt(part, index + 1, parts.length, locale), DigestSchema);
      notes.push(...digest.notes.map((note) => `- [${note.kind}] ${note.text}${note.evidence ? ` («${note.evidence}»)` : ""}`));
      progress("digest", "running", { detail: `${index + 1}/${parts.length}` });
    }
    const head = sourceMaterial({ ...source, documents: [] }).slice(0, Math.floor(input.budgetChars * 0.35));
    material = `${head}\n\nNOTES EXTRACTED FROM THE FULL MATERIAL:\n${notes.join("\n")}`.slice(0, input.budgetChars);
    progress("digest", "done");
  } else {
    progress("digest", "skipped");
  }
  timing.taskParsingMs = Date.now() - parsingStart;

  const extractionStart = Date.now();
  const needsUnderstanding = !result.understanding || wanted.has("understand");
  if (needsUnderstanding) {
    progress("understand", "running");
    let raw: Understanding;
    try {
      raw = await ask("understand", P.understandPrompt(P.contextBlock(material), locale, input.guidance("summary")), UnderstandingSchema);
    } catch (error) {
      // Nothing else can be designed without it: report it and stop.
      if (!input.isCancelled?.()) input.onProgress?.({ stage: "understand", state: "failed", detail: error instanceof Error ? error.message.slice(0, 300) : undefined });
      throw error;
    }
    result.understanding = {
      ...raw,
      rules: raw.rules
        .filter((rule) => rule.text)
        .map((rule, index) => ({ ...rule, id: `R${index + 1}`, grounded: isGrounded(rule.evidence, corpus) })),
    };
    progress("understand", "done");
  }
  const understanding = result.understanding!;
  const context = P.contextBlock(material, compactUnderstanding(understanding));

  const written = source.criteria.filter((item) => isOfficial(item.origin)).map((item) => ({ key: item.key, text: item.text }));
  let targets: Array<{ key: string; text: string }> = source.criteria
    .filter((item) => !input.targetKeys?.length || input.targetKeys.includes(item.key))
    .map((item) => ({ key: item.key, text: item.text }));

  if (wanted.has("criteria")) {
    await guard("criteria", async () => {
      const answer = await ask("criteria", P.criteriaPrompt(context, locale, written, input.guidance("criteria")), CriteriaSchema);
      const proposed: ProposedCriterion[] = [];
      for (const item of answer.criteria) {
        if (item.text.length < 8) continue;
        if (written.some((existing) => similarity(existing.text, item.text) > 0.7)) continue;
        if (proposed.some((existing) => similarity(existing.text, item.text) > 0.8)) continue;
        const grounded = isGrounded(item.evidence, corpus);
        proposed.push({
          key: `AI-${String(proposed.length + 1).padStart(2, "0")}`,
          text: item.text,
          category: item.category,
          evidence: item.evidence,
          grounded,
          ruleRefs: item.ruleRefs,
          confidence: grounded ? item.confidence : "LOW",
          rationale: item.rationale,
        });
      }
      result.proposed = proposed;
      result.writtenIssues = answer.writtenIssues
        .filter((item) => written.some((criterion) => criterion.key === item.key))
        .map((item) => ({ key: item.key, problem: item.problem, suggestion: item.suggestion }));
      targets = [...written, ...proposed.map((item) => ({ key: item.key, text: item.text }))];
    });
  }
  const criteriaText = targets.map((item) => `${item.key}: ${item.text}`).join("\n");
  timing.requirementExtractionMs = Date.now() - extractionStart;

  // The requirements the test cases are judged against, extracted once and reused by every provider's evaluation.
  const config = input.quality ?? DEFAULT_QUALITY_CONFIG;
  const categories = new Map((result.proposed ?? []).map((item) => [item.key, item.category]));
  const requirements = targets.map((item) => ({ key: item.key, text: item.text, category: categories.get(item.key) }));
  const profileOf = () =>
    analyzeTask({ understanding, requirements, risks: result.assessment?.risks, corpus }, config);
  const caseOutput: { runs: RawRun[] | null } = { runs: null };

  // Independent stages; each is routed to its own connections and runs in parallel.
  // Started in order of value: when a service limits concurrent requests, test cases go first.
  const parallel: Array<Promise<void>> = [];
  if (wanted.has("cases") && targets.length > 0) {
    parallel.push(
      guard("cases", async () => {
        const keys = new Set(targets.map((item) => item.key));
        // Built from what is known now (the risks come later); good enough to judge answers as they arrive.
        const early = analyzeTask({ understanding, requirements, corpus }, config);
        const critical = new Set(early.requirements.filter((item) => item.critical).map((item) => item.key));
        // Critical requirements first: when a service queues requests or time runs out, they are done.
        const ordered = targets
          .map((item, index) => ({ item, index }))
          .sort((a, b) => Number(critical.has(b.item.key)) - Number(critical.has(a.item.key)) || a.index - b.index)
          .map(({ item }) => item);
        const batches: Array<typeof targets> = [];
        for (let start = 0; start < ordered.length; start += CASE_BATCH) batches.push(ordered.slice(start, start + CASE_BATCH));
        // Each batch's prompt is built once and sent unchanged to every provider (same prefix → prompt cache).
        const prompts = batches.map((batch) => P.casesPrompt(context, locale, batch, input.guidance("testCases")));
        const collect = (answers: Array<PromiseSettledResult<{ testCases: GeneratedCase[] }>>) => {
          const cases: CaseWithKeys[] = [];
          answers.forEach((settled, index) => {
            if (settled.status !== "fulfilled") return;
            for (const item of settled.value.testCases) {
              if (!item.title || item.steps.length === 0 || !item.expectedResult) continue;
              const refs = item.criterionKeys.filter((key) => keys.has(key));
              cases.push({ ...item, criterionKeys: refs.length ? refs : [batches[index]![0]!.key] });
            }
          });
          return cases;
        };
        const providers = input.caseProviders && input.caseProviders.length >= 2 ? input.caseProviders : null;

        if (!providers) {
          // One route: the test-case connections are tried in order (fallback), as before.
          // Batches run at once on hosted services (a local model queues them); a batch
          // that runs out of time is left out and the others are kept.
          const started = Date.now();
          let finished = 0;
          progress("cases", "running", { detail: `0/${targets.length}` });
          const answers = await Promise.allSettled(
            batches.map(async (batch, index) => {
              const answer = await ask("cases", prompts[index]!, ProviderCasesSchema);
              finished += batch.length;
              progress("cases", "running", { detail: `${finished}/${targets.length}` });
              return answer;
            }),
          );
          if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
          const cases = collect(answers);
          const missed = answers.find((settled) => settled.status === "rejected");
          if (missed && cases.length === 0) throw missed.reason;
          if (missed) result.errors.cases = partialNote(missed.reason, answers.filter((settled) => settled.status === "rejected").length, batches.length);
          result.cases = cases;
          const names = [...new Set((result.origins.cases ?? []).map((origin) => origin.name))];
          const models = [...new Set((result.origins.cases ?? []).map((origin) => origin.model))];
          caseOutput.runs = [
            { provider: "default", name: names.join(" + ") || "AI", model: models.join(", "), status: missed ? "partial" : "ok", processingMs: Date.now() - started, raws: cases },
          ];
          return;
        }

        // Several providers: each writes the whole set on its own, all at once; a slow or
        // failing provider never holds up the others.
        const runs = new Map<string, RawRun>(providers.map((provider) => [provider.id, { provider: provider.id, name: provider.name, model: provider.model, status: "running", processingMs: 0, raws: [] }]));
        const stops = new Map<string, (reason: "timeout" | "lowQuality") => void>();
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const report = () => input.onQuality?.(provisionalReport([...runs.values()], early, config, timing));
        let doneProviders = 0;
        progress("cases", "running", { detail: `0/${providers.length}` });
        report();

        const runProvider = async (provider: CaseProvider) => {
          const run = runs.get(provider.id)!;
          const started = Date.now();
          const controller = new AbortController();
          let stopped: "timeout" | "lowQuality" | null = null;
          stops.set(provider.id, (reason) => {
            if (stopped || run.status !== "running") return;
            stopped = reason;
            controller.abort();
          });
          const limitAt = input.providerTimeoutMs ? started + input.providerTimeoutMs : undefined;
          // The deadline stops a call by itself; this catches a call that does not honour it.
          if (input.providerTimeoutMs) timers.push(setTimeout(() => stops.get(provider.id)!("timeout"), input.providerTimeoutMs + 1_000));
          // A stopped provider is let go at once, even if its service does not honour the abort.
          const released = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error(TIME_LIMIT)), { once: true }));
          released.catch(() => undefined);
          let answered = 0;
          let usable = 0;
          const answers = await Promise.allSettled(
            prompts.map(async (prompt) => {
              const answer = await Promise.race([
                ask("cases", prompt, ProviderCasesSchema, { connectionId: provider.id, signal: controller.signal, deadlineAt: limitAt }),
                released,
              ]);
              if (stopped) throw new Error(TIME_LIMIT);
              // Stop a provider early when what it writes cannot be used at all.
              answered += 1;
              usable += normalizeCases(answer.testCases, provider.name, early).filter((item) => item.qualityScore >= config.gateMinCaseQuality).length;
              if (answered >= 2 && usable === 0 && answered < prompts.length) stops.get(provider.id)!("lowQuality");
              return answer;
            }),
          );
          run.processingMs = Date.now() - started;
          run.raws = collect(answers);
          const failures = answers.filter((settled): settled is PromiseRejectedResult => settled.status === "rejected");
          const outOfTime =
            stopped === "timeout" ||
            failures.some((settled) => String((settled.reason as Error)?.message ?? settled.reason).includes(TIME_LIMIT)) ||
            Boolean(limitAt && Date.now() >= limitAt - 1_000);
          if (failures.length === 0) run.status = "ok";
          else if (run.raws.length > 0) run.status = "partial";
          else run.status = stopped === "lowQuality" ? "failed" : outOfTime ? "timeout" : "failed";
          if (stopped === "lowQuality") run.error = "Stopped early: the answers could not be used";
          else if (failures.length) run.error = maskSecrets(String((failures[0]!.reason as Error)?.message ?? failures[0]!.reason)).slice(0, 300);
          timing.providers[provider.name] = run.processingMs;
          doneProviders += 1;
          progress("cases", "running", { detail: `${doneProviders}/${providers.length}` });
          // One provider covering every requirement: the others get a grace period, then are cut off.
          if (run.status === "ok" && keys.size > 0 && [...keys].every((key) => run.raws.some((item) => item.criterionKeys.includes(key)))) {
            for (const [id, stop] of stops) if (id !== provider.id) timers.push(setTimeout(() => stop("timeout"), config.stragglerGraceMs));
          }
          report();
        };

        try {
          await Promise.allSettled(providers.map(runProvider));
        } finally {
          for (const timer of timers) clearTimeout(timer);
        }
        if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
        const caseRuns = [...runs.values()];
        const answered = caseRuns.filter((run) => run.raws.length > 0);
        // Nothing to compare: the stage fails and the stored test cases stay as they are.
        if (answered.length === 0) throw new Error(`No provider produced test cases — ${caseRuns.map((run) => `${run.name}: ${run.status}${run.error ? ` (${run.error})` : ""}`).join(" | ")}`);
        caseOutput.runs = caseRuns;
        const missing = caseRuns.filter((run) => run.status !== "ok");
        if (missing.length) result.errors.cases = maskSecrets(`${missing.map((run) => `${run.name}: ${run.status}`).join(", ")} — continued with ${answered.map((run) => run.name).join(", ")}`).slice(0, 600);
        result.cases = answered.flatMap((run) => run.raws);
      }),
    );
  }
  if (wanted.has("edges")) {
    parallel.push(
      guard("edges", async () => {
        const answer = await ask("edges", P.edgesPrompt(context, locale, criteriaText, input.guidance("edgeCases")), EdgesSchema);
        result.edges = answer.edgeCases.filter((item) => item.title && item.scenario);
      }),
    );
  }
  if (wanted.has("assessment")) {
    parallel.push(
      guard("assessment", async () => {
        const guidance = [input.guidance("questions"), input.guidance("risks"), input.guidance("strategy")].filter(Boolean).join("\n");
        result.assessment = await ask("assessment", P.assessmentPrompt(context, locale, criteriaText, guidance), AssessmentSchema);
      }),
    );
  }
  if (wanted.has("translate") && result.sourceLanguage !== locale) {
    parallel.push(
      guard("translate", async () => {
        const issueOnly = P.contextBlock(sourceMaterial({ ...source, documents: [] }));
        const answer = await ask("translate", P.translatePrompt(issueOnly, locale, written.length), TranslationSchema);
        result.translation = answer.acceptanceCriteria.length === written.length ? answer : { ...answer, acceptanceCriteria: [] };
      }),
    );
  }  // Same language as the issue: nothing to translate.
  else if (wanted.has("translate")) progress("translate", "skipped");

  await Promise.all(parallel);

  // Normalize → score → compare → select and merge → quality gate. Deterministic: no model call, no tokens.
  let quality: { profile: TaskProfile; finalCases: NormalizedTestCase[]; selection: ReturnType<typeof selectAndMerge>; gate: ReturnType<typeof qualityGate>; runs: ProviderRun[] } | null = null;
  if (caseOutput.runs) {
    const runs = caseOutput.runs;
    const profile = profileOf();
    let mark = performance.now();
    const normalized: ProviderRun[] = runs.map(({ raws, ...run }) => ({ ...run, cases: normalizeCases(raws, run.name, profile) }));
    timing.normalizationMs = Math.round(performance.now() - mark);
    mark = performance.now();
    const scored = normalized.map((run) => evaluateProvider(run, profile, config));
    timing.scoringMs = Math.round(performance.now() - mark);
    const selection = selectAndMerge(scored, profile, config);
    timing.deduplicationMs = Math.round(selection.timing.deduplicationMs);
    timing.selectionMs = Math.round(selection.timing.selectionMs);
    mark = performance.now();
    const gate = qualityGate(selection.cases, profile, config);
    timing.qualityGateMs = Math.round(performance.now() - mark);
    for (const run of runs) timing.providers[run.name] ??= run.processingMs;
    // Nothing passed: the stored test cases are kept instead of being replaced by nothing.
    if (gate.cases.length === 0) result.errors.cases ??= "Every generated test case failed the quality gate";
    result.cases = gate.cases.length ? gate.cases.map((item) => toStudioCase(item)) : null;
    quality = { profile, finalCases: gate.cases, selection, gate, runs: normalized };
  }

  // A different model checks the drafts (the review chain prefers one).
  const reviewable = (result.proposed?.length ?? 0) + (result.cases?.length ?? 0) + (result.edges?.length ?? 0);
  if (wanted.has("review") && reviewable > 0) {
    await guard("review", async () => {
      const payload = [
        result.proposed?.length ? `<proposed_criteria>\n${JSON.stringify(result.proposed.map(({ key, text, evidence }) => ({ key, text, evidence })))}\n</proposed_criteria>` : "",
        result.cases?.length
          ? `<test_cases>\n${JSON.stringify(result.cases.map((item, index) => ({ index, criterionKeys: item.criterionKeys, title: item.title, steps: item.steps, expectedResult: item.expectedResult })))}\n</test_cases>`
          : "",
        result.edges?.length ? `<edge_cases>\n${JSON.stringify(result.edges.map((item, index) => ({ index, title: item.title, scenario: item.scenario })))}\n</edge_cases>` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const review = await ask("review", P.reviewPrompt(context, locale, payload), ReviewSchema);
      applyReview(result, review);
    });
  }

  if (quality) {
    // The reviewer's fixes go through the same gate, then the final report is made against the
    // requirements that are still in force (a criterion the review dropped is no longer one).
    const alive = new Set(result.proposed ? [...written.map((item) => item.key), ...result.proposed.map((item) => item.key)] : targets.map((item) => item.key));
    const profile = analyzeTask({ understanding, requirements: requirements.filter((item) => alive.has(item.key)), risks: result.assessment?.risks, corpus }, config);
    const byId = new Map(quality.finalCases.map((item) => [item.id, item]));
    const notes = new Map<string, string>();
    const reviewed = (result.cases ?? []).flatMap((item) => {
      const base = item.qualityId ? byId.get(item.qualityId) : undefined;
      if (!base) return [];
      if (item.reviewNote) notes.set(base.id, item.reviewNote);
      const expectedResults = item.expectedResult.split("\n").map((line) => line.trim()).filter(Boolean);
      return [rescore({ ...base, title: item.title, steps: item.steps, expectedResults, requirementIds: item.criterionKeys.filter((key) => alive.has(key)) }, profile)];
    });
    const mark = performance.now();
    const gate = qualityGate(reviewed, profile, config);
    timing.qualityGateMs += Math.round(performance.now() - mark);
    if (result.cases) result.cases = gate.cases.map((item) => toStudioCase(item, notes.get(item.id)));
    const evaluation = evaluateSet(gate.cases, profile, config);
    result.quality = {
      applicableTechniques: profile.techniques,
      weights: roundWeights(profile.weights),
      emphasis: profile.kinds,
      providers: quality.runs.map((run) => evaluateProvider(run, profile, config).report),
      selection: { base: quality.selection.base?.name ?? null, merged: quality.selection.merged, reasons: quality.selection.reasons },
      final: {
        overallScore: evaluation.overallScore,
        qualityLevel: qualityLevel(evaluation.overallScore, config),
        caseCount: gate.cases.length,
        requirementCoverage: evaluation.requirementCoverage,
        istqbCoverage: evaluation.istqbCoverage,
        riskCoverage: evaluation.riskCoverage,
        negativeCoverage: evaluation.negativeCoverage,
        dimensionScores: evaluation.dimensionScores,
        duplicatesRemoved: quality.selection.duplicatesRemoved + quality.gate.duplicatesRemoved + gate.duplicatesRemoved,
        rejected: [...quality.gate.rejected, ...gate.rejected].slice(0, 50),
        improved: quality.gate.improved + gate.improved,
        untracedRequirements: gate.untracedRequirements,
        missingScenarios: evaluation.missingScenarios,
      },
      timing: { ...timing, totalMs: Date.now() - startedAt },
    };
    input.onQuality?.(result.quality);
  }

  if (wanted.has("automation")) {
    const cases =
      result.cases?.map((item) => ({ title: item.title, steps: item.steps.map((step) => step.action), expectedResult: item.expectedResult, type: item.type })) ??
      input.existingCases ??
      [];
    if (cases.length > 0) {
      await guard("automation", async () => {
        const items: NonNullable<StudioResult["automation"]> = [];
        const starts: number[] = [];
        for (let start = 0; start < cases.length; start += AUTOMATION_BATCH) starts.push(start);
        const answers = await Promise.allSettled(
          starts.map((start) => {
            const batch = cases.slice(start, start + AUTOMATION_BATCH).map((item, offset) => ({ index: start + offset, ...item }));
            return ask("automation", P.automationPrompt(context, locale, JSON.stringify(batch), input.guidance("automation")), AutomationSchema);
          }),
        );
        if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
        answers.forEach((settled, position) => {
          if (settled.status !== "fulfilled") return;
          const start = starts[position]!;
          const end = Math.min(start + AUTOMATION_BATCH, cases.length);
          for (const item of settled.value.items) {
            if (item.index < start || item.index >= end || items.some((existing) => existing.caseIndex === item.index)) continue;
            items.push({ caseIndex: item.index, suitability: item.suitability, layer: item.layer, rationale: item.rationale, prerequisites: item.prerequisites, tooling: item.tooling });
          }
        });
        const missed = answers.find((settled) => settled.status === "rejected");
        if (missed && items.length === 0) throw missed.reason;
        if (missed) result.errors.automation = partialNote(missed.reason, answers.filter((settled) => settled.status === "rejected").length, starts.length);
        result.automation = items;
      });
    }
  }

  if (result.quality) result.quality.timing.totalMs = Date.now() - startedAt;
  return result;
}

/** One provider's raw answers, before normalization. */
type RawRun = Omit<ProviderRun, "cases"> & { raws: CaseWithKeys[] };

function roundWeights(weights: Partial<Record<string, number>>) {
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.round(value! * 100) / 100]));
}

/** The comparison while providers are still running: finished ones are scored, the rest show their status. */
function provisionalReport(runs: RawRun[], profile: TaskProfile, config: QualityConfig, timing: QualityTiming): QualityReport {
  const providers: ProviderEvaluation[] = runs.map(({ raws, ...run }) => {
    if (run.status !== "running") return evaluateProvider({ ...run, cases: normalizeCases(raws, run.name, profile) }, profile, config).report;
    const empty = evaluateSet([], profile, config);
    return {
      provider: run.provider,
      name: run.name,
      model: run.model,
      status: "running",
      processingMs: 0,
      caseCount: 0,
      overallScore: 0,
      qualityLevel: describeSet(empty, config).qualityLevel,
      dimensionScores: {},
      requirementCoverage: 0,
      istqbCoverage: null,
      riskCoverage: null,
      negativeCoverage: null,
      duplicateCount: 0,
      detectedRisks: [],
      missingScenarios: [],
      applicableISTQBTechniques: profile.techniques.map((entry) => entry.technique),
      strengths: [],
      weaknesses: [],
      recommendations: [],
    };
  });
  return {
    applicableTechniques: profile.techniques,
    weights: roundWeights(profile.weights),
    emphasis: profile.kinds,
    providers,
    selection: { base: null, merged: [], reasons: [] },
    final: null,
    timing: { ...timing, providers: { ...timing.providers } },
  };
}

function applyReview(result: StudioResult, review: z.infer<typeof ReviewSchema>) {
  // Case and edge verdicts refer to the original list positions: apply them first.
  if (result.cases) {
    const before = result.cases.length;
    const verdicts = new Map(review.testCases.map((item) => [item.index, item]));
    result.cases = result.cases.flatMap((item, index) => {
      const verdict = verdicts.get(index);
      if (verdict?.verdict === "drop") return [];
      if (verdict?.verdict === "fix") {
        return [
          {
            ...item,
            title: verdict.title || item.title,
            expectedResult: verdict.expectedResult || item.expectedResult,
            steps: verdict.steps.length ? verdict.steps : item.steps,
            reviewNote: verdict.reason,
          },
        ];
      }
      return [item];
    });
    result.dropped.cases += before - result.cases.length;
  }
  if (result.edges) {
    const before = result.edges.length;
    const dropped = new Set(review.edgeCases.filter((item) => item.verdict === "drop").map((item) => item.index));
    result.edges = result.edges.filter((_, index) => !dropped.has(index));
    result.dropped.edges = before - result.edges.length;
  }
  if (result.proposed) {
    const before = result.proposed.length;
    const verdicts = new Map(review.criteria.map((item) => [item.key, item]));
    result.proposed = result.proposed
      .filter((item) => verdicts.get(item.key)?.verdict !== "drop")
      .map((item) => {
        const verdict = verdicts.get(item.key);
        return verdict?.verdict === "fix" && verdict.fixedText ? { ...item, text: verdict.fixedText } : item;
      });
    result.dropped.criteria = before - result.proposed.length;
    // Cases that only covered a dropped criterion go with it.
    const alive = new Set(result.proposed.map((item) => item.key));
    if (result.cases) {
      const count = result.cases.length;
      result.cases = result.cases
        .map((item) => ({ ...item, criterionKeys: item.criterionKeys.filter((key) => !key.startsWith("AI-") || alive.has(key)) }))
        .filter((item) => item.criterionKeys.length > 0);
      result.dropped.cases += count - result.cases.length;
    }
  }
}
