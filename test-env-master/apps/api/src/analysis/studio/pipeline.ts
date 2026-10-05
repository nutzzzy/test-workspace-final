import { maskSecrets } from "@qa-workbench/shared";
import type { z } from "zod";
import type { AppLocale } from "../../ai/localize-fa";
import type { CallOrigin, StageGroup } from "../../ai/ai.service";
import * as P from "./prompts";
import {
  AssessmentSchema,
  AutomationSchema,
  CasesSchema,
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
  call: { system: string; prompt: string; schema: z.ZodType<T>; locale: AppLocale },
) => Promise<{ data: T; origin: CallOrigin }>;

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

export type CaseWithKeys = GeneratedCase & { criterionKeys: string[]; reviewNote?: string };

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
};

const CASE_BATCH = 3;
const AUTOMATION_BATCH = 10;
const MAX_UNDERSTANDING_CHARS = 14_000;

/** Persian when Persian letters dominate. */
export function detectLanguage(value: string): AppLocale {
  const persian = (value.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return persian > latin * 0.35 ? "fa" : "en";
}

export function norm(value: string) {
  return value
    .toLowerCase()
    .replace(/[‌‏‎]/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The quote is in the source: verbatim after normalisation, or ≥70% of its words (min. 3). */
export function isGrounded(evidence: string, corpus: string): boolean {
  const quote = norm(evidence);
  if (quote.length < 3) return false;
  const haystack = norm(corpus);
  if (haystack.includes(quote)) return true;
  const words = quote.split(" ").filter((word) => word.length > 1);
  if (words.length < 3) return false;
  const present = new Set(haystack.split(" "));
  return words.filter((word) => present.has(word)).length / words.length >= 0.7;
}

/** Word-set overlap (Jaccard) of two texts. */
export function similarity(left: string, right: string) {
  const a = new Set(norm(left).split(" ").filter((word) => word.length > 2));
  const b = new Set(norm(right).split(" ").filter((word) => word.length > 2));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

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
  };
  const progress = (stage: StudioStage, state: StudioProgress["state"], extra: Partial<StudioProgress> = {}) => {
    if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
    input.onProgress?.({ stage, state, ...extra });
  };
  const ask = async <T>(stage: StudioStage, prompt: string, schema: z.ZodType<T>) => {
    if (input.isCancelled?.()) throw new Error("AI analysis was cancelled");
    const answer = await llm(GROUP[stage], stage, { system: P.SYSTEM, prompt, schema, locale });
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
      progress(stage, "failed", { detail: result.errors[stage] });
    }
  };

  // Source material, condensed by the model when it does not fit the context.
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

  // Independent stages; each is routed to its own connections and runs in parallel.
  const parallel: Array<Promise<void>> = [];
  if (wanted.has("assessment")) {
    parallel.push(
      guard("assessment", async () => {
        const guidance = [input.guidance("questions"), input.guidance("risks"), input.guidance("strategy")].filter(Boolean).join("\n");
        result.assessment = await ask("assessment", P.assessmentPrompt(context, locale, criteriaText, guidance), AssessmentSchema);
      }),
    );
  }
  if (wanted.has("cases") && targets.length > 0) {
    parallel.push(
      guard("cases", async () => {
        const cases: CaseWithKeys[] = [];
        const keys = new Set(targets.map((item) => item.key));
        for (let start = 0; start < targets.length; start += CASE_BATCH) {
          const batch = targets.slice(start, start + CASE_BATCH);
          progress("cases", "running", { detail: `${Math.min(start + CASE_BATCH, targets.length)}/${targets.length}` });
          const answer = await ask("cases", P.casesPrompt(context, locale, batch, input.guidance("testCases")), CasesSchema);
          for (const item of answer.testCases) {
            if (!item.title || item.steps.length === 0 || !item.expectedResult) continue;
            const refs = item.criterionKeys.filter((key) => keys.has(key));
            cases.push({ ...item, criterionKeys: refs.length ? refs : [batch[0]!.key] });
          }
        }
        result.cases = cases;
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
  if (wanted.has("translate") && result.sourceLanguage !== locale) {
    parallel.push(
      guard("translate", async () => {
        const issueOnly = P.contextBlock(sourceMaterial({ ...source, documents: [] }));
        const answer = await ask("translate", P.translatePrompt(issueOnly, locale, written.length), TranslationSchema);
        result.translation = answer.acceptanceCriteria.length === written.length ? answer : { ...answer, acceptanceCriteria: [] };
      }),
    );
  }
  await Promise.all(parallel);

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

  if (wanted.has("automation")) {
    const cases =
      result.cases?.map((item) => ({ title: item.title, steps: item.steps.map((step) => step.action), expectedResult: item.expectedResult, type: item.type })) ??
      input.existingCases ??
      [];
    if (cases.length > 0) {
      await guard("automation", async () => {
        const items: NonNullable<StudioResult["automation"]> = [];
        for (let start = 0; start < cases.length; start += AUTOMATION_BATCH) {
          const batch = cases.slice(start, start + AUTOMATION_BATCH).map((item, offset) => ({ index: start + offset, ...item }));
          const answer = await ask("automation", P.automationPrompt(context, locale, JSON.stringify(batch), input.guidance("automation")), AutomationSchema);
          for (const item of answer.items) {
            if (item.index < start || item.index >= start + batch.length || items.some((existing) => existing.caseIndex === item.index)) continue;
            items.push({ caseIndex: item.index, suitability: item.suitability, layer: item.layer, rationale: item.rationale, prerequisites: item.prerequisites, tooling: item.tooling });
          }
        }
        result.automation = items;
      });
    }
  }

  return result;
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
