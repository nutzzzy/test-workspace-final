import { createHash } from "crypto";

export type QaLocale = "fa" | "en";

export type QaCriterion = {
  key: string;
  text: string;
  origin?: "cleaned" | "derived" | string;
};

export type QaInput = {
  title: string;
  description: string;
  acceptanceCriteria: QaCriterion[];
  issueKey?: string;
  issueType?: string;
  locale: QaLocale;
};

export type Gap = {
  id: string;
  description: string;
  impact: string;
  affectedCoverage: string;
  clarification: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
};

export type InferredAc = {
  id: string;
  text: string;
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: string;
  status: "PROPOSED";
};

export type Classification =
  | "UI"
  | "API"
  | "DATABASE"
  | "INTEGRATION"
  | "AUTHORIZATION"
  | "CRUD"
  | "STATE_TRANSITION"
  | "FINANCIAL"
  | "SEARCH"
  | "VALIDATION"
  | "DATA_INTEGRITY"
  | "WORKFLOW";

export type DesignStatus = "AI_DRAFT" | "DRAFT_REQUIRES_REVIEW";

export type EngineCase = {
  conditionKey: string;
  title: string;
  description: string;
  preconditions: string[];
  steps: string[];
  stepExpectations: string[];
  testData: string[];
  expectedResult: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  type: string;
  tags: string[];
  relatedAcceptanceCriteria: string[];
  designStatus: DesignStatus;
  technique: string;
  gapRefs: string[];
  assumptions: string[];
  postconditions: string[];
  automationSuitability: "HIGH" | "MEDIUM" | "LOW";
  automationLayer: "API" | "UI" | "DB" | "Integration";
  automationNotes: string;
  scenarioStatus:
    | "READY"
    | "REQUIRES_CONFIGURATION"
    | "REQUIRES_TECHNICAL_DETAILS";
  partition: string;
};

export type PipelineResult = {
  contentHash: string;
  /** Normalized facts extracted once; every output (questions, cases, …) reads these. */
  understanding: RequirementUnderstanding;
  classification: Classification[];
  techniques: string[];
  gaps: Gap[];
  inferredAc: InferredAc[];
  explicitAc: Array<{ key: string; text: string }>;
  conditions: Array<{
    id: string;
    description: string;
    dimension: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    source: string;
  }>;
  testCases: EngineCase[];
  strategy: {
    scope: string;
    objectives: string[];
    testTypes: string[];
    environments: string[];
    dependencies: string[];
    assumptions: string[];
  };
  edgeCases: Array<{ title: string; description: string }>;
  risks: Array<{
    description: string;
    impact: string;
    likelihood: string;
    mitigation: string;
    releaseBlocking: boolean;
    acceptanceKeys: string[];
  }>;
  automation: Array<{
    conditionKey: string;
    title: string;
    suitability: "HIGH" | "MEDIUM" | "LOW";
    layer: string;
    reason: string;
    scenarioStatus: EngineCase["scenarioStatus"];
  }>;
  intelligence: Record<string, unknown>;
};

const BANNED =
  /این کار را انجام دهید|خروجی باید این باشد|قانونی که باید برقرار شود|این قدم انجام می‌شود|نتیجه را بررسی کنید|نتیجه درست است|perform the requirement|do the requirement|the requirement happens|do this:|check ac\b|verify feature|test the feature|check the result|the result is correct|result is correct|works as expected|works correctly/i;

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function isLockedDesign(
  status: string | null | undefined,
  manuallyEdited: boolean,
): boolean {
  return (
    manuallyEdited ||
    status === "APPROVED" ||
    status === "MANUALLY_EDITED"
  );
}

/**
 * Stable identity for a generated case, used to match it to the stored row on
 * regeneration. It is derived from what the case covers (partition + the
 * texts of the criteria it traces to), not from its position in the list, so
 * inserting a criterion does not shift every key and overwrite unrelated
 * cases. Wording is excluded, so switching the generation language maps onto
 * the same rows. A suffix separates cases that cover the same thing.
 */
export function assignConditionKeys(cases: EngineCase[], input: QaInput): EngineCase[] {
  const textByKey = new Map(input.acceptanceCriteria.map((item) => [item.key, norm(item.text)]));
  const seen = new Map<string, number>();
  return cases.map((item) => {
    const covered = item.relatedAcceptanceCriteria
      .map((key) => textByKey.get(key) ?? key)
      .sort();
    const base = createHash("sha256")
      .update(JSON.stringify([item.partition, covered]))
      .digest("hex")
      .slice(0, 12);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...item, conditionKey: count === 1 ? `COND-${base}` : `COND-${base}-${count}` };
  });
}

/** Keys produced before assignConditionKeys existed (COND-01, COND-02, …). */
export function isLegacyConditionKey(key: string | null | undefined): boolean {
  return !!key && /^COND-\d{2,}$/.test(key);
}

export function requirementHash(input: QaInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        description: input.description,
        ac: input.acceptanceCriteria.map((item) => item.text),
      }),
    )
    .digest("hex");
}

/**
 * Deterministic quality checks on a generated case. A failing case is never
 * dropped silently: it is downgraded to DRAFT_REQUIRES_REVIEW and the reasons
 * are recorded in `assumptions` so the reviewer can see them.
 * `sources` are the individual requirement texts (title, description, each
 * AC); a step or expectation that merely repeats one of them is not a test.
 */
export function applyQualityGate(testCase: EngineCase, sources: string | string[]): EngineCase {
  const sourceKeys = new Set(
    (Array.isArray(sources) ? sources : [sources]).map(norm).filter(Boolean),
  );
  const issues: string[] = [];
  if (!testCase.title.trim() || /^(AC-\d+|test requirement)\b/i.test(testCase.title)) {
    issues.push("vague title");
  }
  if (testCase.steps.length === 0) issues.push("no steps");
  testCase.steps.forEach((step, index) => {
    const expected = testCase.stepExpectations[index] ?? "";
    if (!step.trim()) issues.push("empty step");
    if (norm(step) === norm(expected)) issues.push("expected repeats step");
    if (BANNED.test(step) || BANNED.test(expected)) issues.push("generic phrase");
    if (sourceKeys.has(norm(step))) issues.push("step copies source");
    if (expected && sourceKeys.has(norm(expected))) issues.push("expected copies source");
  });
  if (!testCase.expectedResult.trim()) issues.push("no observable result");
  else if (BANNED.test(testCase.expectedResult)) issues.push("generic expected result");
  if (issues.length === 0) return testCase;
  const unique = [...new Set(issues)];
  return {
    ...testCase,
    designStatus: "DRAFT_REQUIRES_REVIEW",
    tags: [...new Set([...testCase.tags, "quality-review"])],
    assumptions: [...testCase.assumptions, ...unique],
  };
}

export function runQaPipeline(input: QaInput): PipelineResult {
  const fa = input.locale === "fa";
  const text = [input.title, input.description, ...input.acceptanceCriteria.map((item) => item.text)]
    .filter(Boolean)
    .join("\n");
  const facts = extractFacts(text, fa);
  const techniques = selectTechniques(facts);
  const inferred = infer(facts, fa);
  const explicit = input.acceptanceCriteria
    .filter((item) => item.text.trim())
    .map((item) => ({ key: item.key, text: item.text }));
  // Criteria inferred from the description (origin "derived") are not
  // official acceptance criteria, so cases built on them need review.
  const official =
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.some((item) => item.origin !== "derived" && item.text.trim());
  let cases = buildCases(facts, input, official);
  const sources = [input.title, input.description, ...input.acceptanceCriteria.map((item) => item.text)];
  cases = dedupeCases(cases).map((item) => applyQualityGate(item, sources));
  cases = assignConditionKeys(cases, input);

  const strategy = buildStrategy(facts, techniques, fa);
  const risks = buildRisks(facts, fa);
  const edges = cases
    .filter((item) => item.tags.includes("edge"))
    .map((item) => ({ title: item.title, description: item.description }));

  return {
    contentHash: requirementHash(input),
    understanding: facts,
    classification: facts.classes,
    techniques,
    gaps: facts.gaps,
    inferredAc: inferred,
    explicitAc: explicit,
    conditions: cases.map((item) => ({
      id: item.conditionKey,
      description: item.description,
      dimension: item.partition,
      priority: item.priority,
      source: item.relatedAcceptanceCriteria[0] ?? input.issueKey ?? "requirement",
    })),
    testCases: cases,
    strategy,
    edgeCases: edges,
    risks,
    automation: cases.map((item) => ({
      conditionKey: item.conditionKey,
      title: item.title,
      suitability: item.automationSuitability,
      layer: item.automationLayer,
      reason: item.automationNotes,
      scenarioStatus: item.scenarioStatus,
    })),
    intelligence: {
      title: input.title,
      description: input.description,
      source: input.issueKey ?? "requirement",
      issueType: input.issueType ?? null,
      actors: facts.actors,
      page: facts.page,
      endpoint: facts.endpoint,
      trigger: facts.trigger,
      transitions: facts.transitions,
      required: facts.required,
      optional: facts.optional,
      limits: facts.limits,
      table: facts.table,
      uniqueField: facts.uniqueField,
      classification: facts.classes,
      gaps: facts.gaps,
      assumptions: inferred.map((item) => item.text),
    },
  };
}

type Endpoint = { method: string; path: string };
type Transition = { from: string; to: string; trigger: string };
type Limit = { subject: string; min?: number; max?: number };

export type RequirementUnderstanding = Facts;

type Facts = {
  fa: boolean;
  text: string;
  actors: string[];
  page: string | null;
  endpoint: Endpoint | null;
  transitions: Transition[];
  required: string[];
  optional: string[];
  limits: Limit[];
  table: string | null;
  uniqueField: string | null;
  trigger: string | null;
  classes: Classification[];
  gaps: Gap[];
  successStatus: string | null;
  errorStatus: string | null;
  payment: { success: string | null; failure: string | null; retry: boolean };
  searchBy: string | null;
  filterBy: string | null;
  sortBy: string | null;
  authRules: Array<{ actor: string; action: string; allowed: boolean }>;
};

function extractFacts(text: string, fa: boolean): Facts {
  const actors = extractActors(text);
  const page = extractPage(text);
  const endpoint = extractEndpoint(text);
  const transitions = extractTransitions(text);
  const required = extractRequired(text);
  const optional = extractOptional(text);
  const limits = extractLimits(text);
  const table = extractTable(text);
  const uniqueField = extractUnique(text);
  const trigger = extractTrigger(text);
  const success = text.match(/\b(200|201|202|204)\b/);
  const error = text.match(/\b(400|401|403|404|409|422|500)\b/);
  const payment = extractPayment(text);
  const searchBy = text.match(/\bsearch\w*\s+\w+\s+by\s+([A-Za-z]+)/i)?.[1] ?? ( /جستجو/.test(text) ? "نام" : null);
  const filterBy = text.match(/\bfilter\w*\s+by\s+([A-Za-z]+)/i)?.[1] ?? null;
  const sortBy = text.match(/\bsort\w*\s+by\s+([A-Za-z]+)/i)?.[1] ?? null;
  const classes = classify({
    text,
    page,
    endpoint,
    transitions,
    required,
    optional,
    limits,
    table,
    uniqueField,
    payment,
    searchBy,
  });
  const gaps = detectGaps(text, fa, {
    endpoint,
    errorStatus: error?.[1] ?? null,
    page,
  });
  return {
    fa,
    text,
    actors,
    page,
    endpoint,
    transitions,
    required,
    optional,
    limits,
    table,
    uniqueField,
    trigger,
    classes,
    gaps,
    successStatus: success?.[1] ?? null,
    errorStatus: error?.[1] ?? null,
    payment,
    searchBy,
    filterBy,
    sortBy,
    authRules: extractAuth(text),
  };
}

function classify(input: {
  text: string;
  page: string | null;
  endpoint: Endpoint | null;
  transitions: Transition[];
  required: string[];
  optional: string[];
  limits: Limit[];
  table: string | null;
  uniqueField: string | null;
  payment: Facts["payment"];
  searchBy: string | null;
}): Classification[] {
  const out = new Set<Classification>();
  const text = input.text;
  if (input.endpoint || /\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(text)) out.add("API");
  if (input.page || /صفحه|فرم|\bform\b|\bpage\b|نمایش داده|is displayed|are shown/i.test(text)) {
    out.add("UI");
  }
  if (input.table || /database|جدول|persist|ذخیره می‌|writes a row/i.test(text)) out.add("DATABASE");
  if (/webhook|\bqueue\b|صف(?!حه)|third[- ]party|سرویس خارجی/i.test(text)) out.add("INTEGRATION");
  if (/only an?\s+\w+|permission|\brole\b|دسترسی|مجاز|نقش/i.test(text)) out.add("AUTHORIZATION");
  if (/\b(create|update|delete|insert|save)s?\b|ایجاد|ویرایش|حذف|ذخیره/i.test(text)) out.add("CRUD");
  if (input.transitions.length > 0) out.add("STATE_TRANSITION");
  if (input.payment.success || input.payment.failure || /payment|پرداخت|تراکنش/i.test(text)) {
    out.add("FINANCIAL");
  }
  if (input.searchBy || /search|جستجو|filter|فیلتر|sort|مرتب/i.test(text)) out.add("SEARCH");
  if (
    input.required.length > 0 ||
    input.optional.length > 0 ||
    input.limits.length > 0 ||
    /required|الزامی|optional|اختیاری|invalid|نامعتبر/i.test(text)
  ) {
    out.add("VALIDATION");
  }
  if (input.uniqueField || /unique|یکتا|integrity/i.test(text)) out.add("DATA_INTEGRITY");
  if (out.size === 0) out.add("WORKFLOW");
  return [...out];
}

function selectTechniques(facts: Facts): string[] {
  const chosen = new Set<string>();
  if (facts.classes.includes("UI") || facts.classes.includes("WORKFLOW")) {
    chosen.add("Use Case Testing");
  }
  if (facts.classes.includes("VALIDATION") || facts.limits.length > 0) {
    chosen.add("Equivalence Partitioning");
  }
  if (facts.limits.length > 0) chosen.add("Boundary Value Analysis");
  if (facts.classes.includes("STATE_TRANSITION")) chosen.add("State Transition Testing");
  if (facts.classes.includes("AUTHORIZATION")) chosen.add("Permission Matrix");
  if (facts.classes.includes("API")) chosen.add("Integration Contract Testing");
  if (facts.classes.includes("API") && /idempoten|same request twice|درخواست تکراری/i.test(facts.text)) {
    chosen.add("Idempotency Testing");
  }
  if (facts.classes.includes("DATABASE") || facts.classes.includes("DATA_INTEGRITY")) {
    chosen.add("Data Integrity Testing");
  }
  if (facts.classes.includes("CRUD")) chosen.add("CRUD coverage");
  if (facts.classes.includes("SEARCH")) chosen.add("Equivalence Partitioning");
  if (facts.classes.includes("FINANCIAL") || facts.errorStatus || /reject|رد|invalid|نامعتبر/i.test(facts.text)) {
    chosen.add("Negative Testing");
  }
  if (facts.authRules.length > 1 || (facts.required.length > 1 && facts.classes.includes("AUTHORIZATION"))) {
    chosen.add("Decision Table Testing");
  }
  return [...chosen];
}

const WHY: Record<string, { fa: string; en: string }> = {
  "Use Case Testing": {
    fa: "نتیجه قابل مشاهده برای یک کنش مشخص در متن آمده است.",
    en: "The text states an observable outcome for a specific action.",
  },
  "Equivalence Partitioning": {
    fa: "ورودی‌ها به دسته‌های معتبر و نامعتبر تقسیم می‌شوند.",
    en: "Inputs split into valid and invalid classes.",
  },
  "Boundary Value Analysis": {
    fa: "یک حد عددی در نیازمندی آمده است.",
    en: "A numeric limit is stated.",
  },
  "State Transition Testing": {
    fa: "تغییر وضعیت مبدأ و مقصد در متن مشخص است.",
    en: "A source state and a target state are specified.",
  },
  "Permission Matrix": {
    fa: "دسترسی به نقش وابسته است.",
    en: "Access depends on role.",
  },
  "Integration Contract Testing": {
    fa: "متد، مسیر یا کد پاسخ در نیازمندی آمده است.",
    en: "A method, path, or response code is specified.",
  },
  "Idempotency Testing": {
    fa: "تکرار همان درخواست در متن مطرح شده است.",
    en: "Repeating the same request is mentioned.",
  },
  "Data Integrity Testing": {
    fa: "قید یکتایی یا اثر ذخیره‌سازی مشخص است.",
    en: "Uniqueness or a persistence effect is specified.",
  },
  "CRUD coverage": {
    fa: "نیازمندی یک نوشتن، خواندن، به‌روزرسانی یا حذف را توصیف می‌کند.",
    en: "The requirement describes a create, read, update, or delete.",
  },
  "Negative Testing": {
    fa: "رفتار رد شدن یا شکست در متن آمده است.",
    en: "A rejection or failure outcome is stated.",
  },
  "Decision Table Testing": {
    fa: "چند شرط با هم نتیجه را تعیین می‌کنند.",
    en: "More than one condition controls the outcome.",
  },
};

function buildStrategy(facts: Facts, techniques: string[], fa: boolean) {
  return {
    scope: fa
      ? `فقط دسته‌های ${facts.classes.join("، ") || "عمومی"} و رفتارهایی که متن مشخص کرده پوشش داده می‌شوند.`
      : `Coverage is limited to ${facts.classes.join(", ") || "the stated behavior"} and only outcomes written in the requirement.`,
    objectives: techniques.map(
      (name) => `${name}: ${WHY[name]?.[fa ? "fa" : "en"] ?? name}`,
    ),
    testTypes: facts.classes,
    environments: ["local"],
    dependencies: [facts.endpoint ? `${facts.endpoint.method} ${facts.endpoint.path}` : null, facts.table]
      .filter((item): item is string => Boolean(item)),
    assumptions: facts.gaps.map((gap) => gap.clarification),
  };
}

function buildRisks(facts: Facts, fa: boolean): PipelineResult["risks"] {
  const risks: PipelineResult["risks"] = facts.gaps.map((gap) => ({
    description: gap.description,
    impact: gap.severity,
    likelihood: gap.severity === "HIGH" ? "MEDIUM" : "LOW",
    mitigation: gap.clarification,
    releaseBlocking: gap.severity === "HIGH",
    acceptanceKeys: [],
  }));
  if (facts.payment.success && facts.payment.failure) {
    risks.push({
      description: fa
        ? `پرداخت ناموفق نباید وضعیت سفارش را ${facts.payment.success} کند.`
        : `A failed payment must not leave the order in ${facts.payment.success}.`,
      impact: "HIGH",
      likelihood: "MEDIUM",
      mitigation: fa
        ? "بعد از پرداخت ناموفق و، اگر در متن آمده، بعد از تلاش مجدد، وضعیت سفارش را بررسی کنید."
        : "Check the order state after a failed payment and, when the text allows it, after a retry.",
      releaseBlocking: true,
      acceptanceKeys: [],
    });
  }
  return risks;
}

function infer(facts: Facts, fa: boolean): InferredAc[] {
  const items: InferredAc[] = [];
  if (facts.searchBy) {
    items.push({
      id: "INF-01",
      text: fa
        ? "جستجو بدون نتیجهٔ مطابق، هیچ رکورد منطبقی نشان نمی‌دهد."
        : "A search with no matching value shows no matching records.",
      reason: fa
        ? "این نتیجه از تعریف جستجو برمی‌آید، نه از یک قاعدهٔ صریح دربارهٔ حالت خالی."
        : "This follows from the definition of search, not from an explicit empty-state rule.",
      confidence: "MEDIUM",
      evidence: facts.searchBy,
      status: "PROPOSED",
    });
  }
  return items;
}

function buildCases(facts: Facts, input: QaInput, official: boolean): EngineCase[] {
  const cases: EngineCase[] = [];
  if (facts.endpoint) cases.push(...apiCases(facts, input));
  if (facts.transitions.length > 0) cases.push(...stateCases(facts, input));
  if (facts.authRules.length > 0) cases.push(...authCases(facts, input));
  if (facts.searchBy || facts.filterBy || facts.sortBy) cases.push(...searchCases(facts, input));
  if (facts.payment.success || facts.payment.failure || facts.payment.retry) {
    cases.push(...paymentCases(facts, input));
  }
  if (facts.table) cases.push(...databaseCases(facts, input));
  if (!facts.endpoint && (facts.limits.length > 0 || facts.required.length > 0 || facts.optional.length > 0)) {
    cases.push(...validationCases(facts, input));
  }
  const coveredKeys = new Set(cases.flatMap((item) => item.relatedAcceptanceCriteria));
  cases.push(...casesForCriteria(facts, input, coveredKeys));
  if (facts.page && /نمایش|displayed|shown|visible/i.test(facts.text) && cases.length === 0) {
    cases.push(visibilityCase(facts, input));
  }
  if (cases.length === 0) cases.push(insufficientCase(facts, input));
  if (!official) {
    return cases.map((item) => ({
      ...item,
      designStatus: "DRAFT_REQUIRES_REVIEW",
      assumptions: [
        ...item.assumptions,
        facts.fa
          ? "این مورد از معیار استنباط‌شده آمده و معیار رسمی نیست."
          : "This case comes from an inferred criterion, not an official one.",
      ],
    }));
  }
  return cases;
}

function casesForCriteria(
  facts: Facts,
  input: QaInput,
  coveredKeys: Set<string>,
): EngineCase[] {
  const criteria = input.acceptanceCriteria
    .filter((item) => item.text.trim() && !coveredKeys.has(item.key))
    .sort((left, right) => right.text.length - left.text.length);
  return criteria.map((criterion) => caseFromCriterion(criterion, facts, input));
}

function caseFromCriterion(
  criterion: QaCriterion,
  facts: Facts,
  input: QaInput,
): EngineCase {
  const text = criterion.text;
  // Output language is the workspace locale, not the criterion's script.
  const fa = facts.fa;
  const page = extractPage(text) ?? facts.page;
  const actor = extractActors(text)[0] ?? facts.actors[0] ?? (fa ? "رکورد" : "record");
  const trigger = extractTrigger(text);
  const failure = /ناموفق|خطا|نباید|اختلال|fail|error|must not/i.test(text);
  const identity = /احراز|هویت|verification/i.test(text);
  const visible = /نمایش|دیده|shown|displayed|visible/i.test(text) && !failure;
  const trace = /پیگیری|traceable|audit/i.test(text);
  const regression = /اختلال|نباید باعث|must not break|existing process/i.test(text);
  const states = [...text.matchAll(/\b(APPROVE|APPROVED|ACTIVE|PENDING)\b/gi)].map((match) =>
    match[1].toUpperCase(),
  );
  const signature = behaviorSignature(text);
  const gapRefs = facts.gaps
    .filter((gap) => {
      if (visible && (gap.id === "GAP-CHANNEL" || gap.id === "GAP-FIELDS")) return true;
      if (failure && gap.id === "GAP-ERROR") return true;
      return false;
    })
    .map((gap) => gap.id);

  if (visible && page) {
    const when = trigger ?? (fa ? "رخداد ذکرشده" : "the stated event");
    return bindCriterion(
      visibilityCase(
        { ...facts, fa, page, actors: [actor], trigger: when, gaps: facts.gaps.filter((gap) => gapRefs.includes(gap.id)) },
        input,
      ),
      criterion.key,
      signature,
    );
  }

  if (regression && states.length > 0) {
    const listed = [...new Set(states)].join(fa ? " و " : " and ");
    return makeCase({
      facts,
      input,
      partition: signature,
      technique: "State Transition Testing",
      type: "FUNCTIONAL",
      priority: "HIGH",
      designStatus: "AI_DRAFT",
      title: fa
        ? `بررسی ادامهٔ فرآیند ${listed} برای ${actor} بعد از تغییر`
        : `Verify the ${listed} flow for ${actor} still completes after the change`,
      description: fa
        ? `تغییر جدید نباید فرآیند فعلی ${listed} را مختل کند.`
        : `The change must not disrupt the current ${listed} flow.`,
      preconditions: [
        fa
          ? `${actor}ای که هنوز این فرآیند را طی نکرده در دسترس است.`
          : `A ${actor} that has not completed this flow is available.`,
      ],
      testData: [fa ? `شناسه ${actor}` : `${actor} identifier`],
      steps: [
        ...(fa
          ? states.map((state) => `${actor} را به وضعیت ${state} ببرید.`)
          : states.map((state) => `Move the ${actor} through ${state}.`)),
      ],
      stepExpectations: [
        ...(fa
          ? states.map((state) => `وضعیت ${state} با موفقیت ثبت می‌شود و فرآیند قبلی قطع نمی‌شود.`)
          : states.map((state) => `${state} completes and the previous process is not interrupted.`)),
      ],
      expectedResult: fa
        ? `فرآیند ${listed} برای ${actor} بعد از تغییر هم کامل می‌شود.`
        : `The ${listed} flow for the ${actor} still completes after the change.`,
      tags: ["regression", "state"],
      acceptanceKeys: [criterion.key],
      automationSuitability: "MEDIUM",
      automationLayer: "API",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes: "REQUIRES_TECHNICAL_DETAILS: the transition endpoint is not specified.",
    });
  }

  if (identity && !failure) {
    return makeCase({
      facts,
      input,
      partition: signature,
      technique: "Use Case Testing",
      type: "FUNCTIONAL",
      priority: "HIGH",
      designStatus: "AI_DRAFT",
      title: fa
        ? `بررسی فعال شدن احراز هویت ${actor} پس از ساخته شدن شناسه`
        : `Verify identity verification for ${actor} becomes available after the identifier is created`,
      description: fa
        ? `بعد از ساخته شدن شناسه، ${actor} باید بتواند مرحله احراز هویت را ادامه دهد.`
        : `After the identifier exists, the ${actor} can continue identity verification.`,
      preconditions: [
        fa ? `شناسه ${actor} هنوز ساخته نشده است.` : `The ${actor} identifier does not exist yet.`,
      ],
      testData: [fa ? `دادهٔ لازم برای ساخت شناسه ${actor}` : `The data required to create the ${actor} identifier`],
      steps: fa
        ? [
            `شناسه ${actor} را بسازید.`,
            `ورود به مرحله احراز هویت را برای همان ${actor} بررسی کنید.`,
          ]
        : [
            `Create the ${actor} identifier.`,
            `Open the identity-verification step for that same ${actor}.`,
          ],
      stepExpectations: fa
        ? [
            `شناسه ${actor} ثبت شده است.`,
            `مرحله احراز هویت برای ادامه دادن در دسترس است.`,
          ]
        : [
            `The ${actor} identifier is stored.`,
            `The identity-verification step is available to continue.`,
          ],
      expectedResult: fa
        ? `پس از ساخته شدن شناسه، احراز هویت همان ${actor} فعال و قابل ادامه است.`
        : `Identity verification for that ${actor} is available after the identifier is created.`,
      tags: ["positive", "workflow"],
      assumptions: [
        fa
          ? "نام دقیق صفحه یا اپلیکیشن احراز هویت در معیار نیامده است."
          : "The exact verification screen is not named in the criterion.",
      ],
      acceptanceKeys: [criterion.key],
      automationSuitability: "LOW",
      automationLayer: "UI",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes: "REQUIRES_TECHNICAL_DETAILS: the verification entry point is not specified.",
    });
  }

  if (failure && (trace || /خطا|error/i.test(text))) {
    return makeCase({
      facts,
      input,
      partition: signature,
      technique: "Negative Testing",
      type: "FUNCTIONAL",
      priority: "HIGH",
      designStatus: "AI_DRAFT",
      gapRefs,
      title: fa
        ? trace
          ? `بررسی قابل پیگیری بودن خطا وقتی ${identity ? "احراز هویت" : "عملیات"} ناموفق است`
          : `بررسی نمایش وضعیت خطا وقتی ${identity ? "احراز هویت" : "عملیات"} ناموفق است`
        : trace
          ? `Verify a failed ${identity ? "identity verification" : "operation"} leaves a traceable error`
          : `Verify a failed ${identity ? "identity verification" : "operation"} exposes an error status`,
      description: fa
        ? trace
          ? "خطای ناموفق باید بماند و بعداً با همان مورد قابل پیدا کردن باشد."
          : "وقتی عملیات ناموفق است، وضعیت خطا باید دیده یا ثبت شود."
        : trace
          ? "The failure remains stored and can be found again for the same record."
          : "A failed operation exposes or stores an error status.",
      preconditions: [
        fa
          ? `${actor}ای که می‌توان عملیات را برایش ناموفق کرد در دسترس است.`
          : `A ${actor} is available for a failing attempt.`,
      ],
      testData: [fa ? `شناسه ${actor}` : `${actor} identifier`],
      steps: fa
        ? trace
          ? [
              `${identity ? "فعال‌سازی احراز هویت" : "عملیات"} را برای ${actor} ناموفق کنید.`,
              `همان مورد را دوباره باز کنید و خطای ثبت‌شده را پیدا کنید.`,
            ]
          : [
              `${identity ? "فعال‌سازی احراز هویت" : "عملیات"} را برای ${actor} ناموفق کنید.`,
              `وضعیت همان ${actor} را بلافاصله بررسی کنید.`,
            ]
        : trace
          ? [
              `Make ${identity ? "identity verification" : "the operation"} fail for the ${actor}.`,
              `Open the same record again and locate the stored error.`,
            ]
          : [
              `Make ${identity ? "identity verification" : "the operation"} fail for the ${actor}.`,
              `Inspect the ${actor} status immediately afterward.`,
            ],
      stepExpectations: fa
        ? trace
          ? [
              `عملیات ناموفق تمام می‌شود.`,
              `خطا برای همان ${actor} قابل پیدا کردن است.`,
            ]
          : [
              `عملیات ناموفق تمام می‌شود.`,
              `وضعیت خطا دیده یا ثبت شده است.`,
            ]
        : trace
          ? [
              `The operation ends unsuccessfully.`,
              `The error can be found again for that ${actor}.`,
            ]
          : [
              `The operation ends unsuccessfully.`,
              `An error status is visible or stored.`,
            ],
      expectedResult: fa
        ? trace
          ? `خطای ناموفق برای ${actor} قابل پیگیری می‌ماند.`
          : `بعد از شکست، وضعیت خطا برای ${actor} دیده یا ثبت می‌شود.`
        : trace
          ? `The failed result for the ${actor} stays traceable.`
          : `An error status is shown or stored for the ${actor} after the failure.`,
      tags: ["negative", trace ? "trace" : "error"],
      assumptions: [
        fa
          ? "متن دقیق خطا و کد وضعیت در معیار نیامده است."
          : "The exact error text and status code are not specified.",
      ],
      acceptanceKeys: [criterion.key],
      automationSuitability: "MEDIUM",
      automationLayer: "API",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes: "REQUIRES_TECHNICAL_DETAILS: the failure contract is not specified.",
    });
  }

  const clause = clip(text, 80);
  return makeCase({
    facts,
    input,
    partition: signature,
    technique: "Use Case Testing",
    type: "FUNCTIONAL",
    priority: "MEDIUM",
    designStatus: "DRAFT_REQUIRES_REVIEW",
    title: fa ? `بررسی معیار ${criterion.key}` : `Verify ${criterion.key}`,
    description: clause,
    preconditions: [
      fa
        ? "دادهٔ آزمون مطابق همین معیار آماده است."
        : "Test data for this criterion is prepared.",
    ],
    testData: [fa ? `شناسه ${actor}` : `${actor} identifier`],
    steps: fa
      ? [`شرط این معیار را برقرار کنید.`, `نتیجهٔ قابل مشاهده را ثبت کنید.`]
      : [`Set up the condition stated by this criterion.`, `Record the observable result.`],
    stepExpectations: fa
      ? [`شرط برقرار شده است.`, `نتیجه با معیار ${criterion.key} می‌خواند.`]
      : [`The condition is in place.`, `The result matches ${criterion.key}.`],
    expectedResult: fa
      ? `رفتار قابل مشاهدهٔ ${criterion.key} برقرار است.`
      : `The observable behavior of ${criterion.key} holds.`,
    tags: ["draft"],
    assumptions: [
      fa
        ? "از متن معیار نتوانستم کنش و نتیجه را جدا کنم؛ این مورد نیاز به بازبینی دارد."
        : "The criterion does not separate the action from the result clearly enough.",
    ],
    acceptanceKeys: [criterion.key],
    automationSuitability: "LOW",
    automationLayer: "Integration",
    scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
    automationNotes: "REQUIRES_TECHNICAL_DETAILS: the criterion is not specific enough to automate.",
  });
}

function bindCriterion(testCase: EngineCase, key: string, partition: string): EngineCase {
  return {
    ...testCase,
    partition,
    relatedAcceptanceCriteria: [key],
    tags: testCase.tags.map((tag) => (tag.startsWith("partition:") ? `partition:${partition}` : tag)),
  };
}

function behaviorSignature(text: string): string {
  const page = (extractPage(text) ?? "").toLowerCase();
  const failure = /ناموفق|خطا|نباید|اختلال|fail|error|must not/i.test(text) ? "neg" : "pos";
  const topics: string[] = [];
  if (/نمایش|دیده|shown|displayed|visible/i.test(text)) topics.push("visible");
  if (/احراز|هویت|verification/i.test(text)) topics.push("identity");
  if (/فعال/i.test(text)) topics.push("activate");
  if (/پیگیری|traceable|audit/i.test(text)) topics.push("trace");
  if (/\b(approve|approved|active|pending)\b|تأیید|تایید/i.test(text)) topics.push("state");
  if (/اختلال|نباید باعث|must not break/i.test(text)) topics.push("regression");
  if (topics.length === 0) topics.push(norm(text).slice(0, 48));
  return `${failure}|${page}|${topics.sort().join("+")}`;
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function visibilityCase(facts: Facts, input: QaInput): EngineCase {
  const fa = facts.fa;
  const actor = facts.actors[0] ?? (fa ? "رکورد" : "record");
  const page = facts.page ?? "";
  const trigger = facts.trigger ?? (fa ? "رویداد توصیف‌شده" : "the described event");
  const gapRefs = facts.gaps.map((gap) => gap.id);
  return makeCase({
    facts,
    input,
    partition: "visible",
    technique: "Use Case Testing",
    type: "FUNCTIONAL",
    priority: "HIGH",
    designStatus: "AI_DRAFT",
    gapRefs,
    title: fa
      ? `بررسی دیده شدن ${actor} در صفحه ${page} پس از ${trigger}`
      : `Verify the ${actor} is visible on ${page} after ${trigger}`,
    description: fa
      ? `بعد از ${trigger}، ${actor} در صفحه «${page}» قابل مشاهده باشد.`
      : `After ${trigger}, the ${actor} is visible on “${page}”.`,
    preconditions: [
      fa
        ? `صفحه «${page}» در محیط آزمون باز می‌شود.`
        : `The “${page}” page can be opened in the test environment.`,
    ],
    testData: [
      fa
        ? `یک ${actor} با شناسه‌ای که در صفحه قابل جستجو است`
        : `One ${actor} with an identifier that can be found on the page`,
    ],
    steps: fa
      ? [
          `صفحه «${page}» را باز کنید.`,
          `یک ${actor} بسازید که ${trigger} را انجام داده باشد.`,
          `همان ${actor} را در صفحه «${page}» پیدا کنید.`,
        ]
      : [
          `Open the “${page}” page.`,
          `Create one ${actor} that has completed ${trigger}.`,
          `Find that ${actor} on the “${page}” page.`,
        ],
    stepExpectations: fa
      ? [
          `صفحه «${page}» بدون خطا باز می‌شود.`,
          `${actor} در سیستم ثبت شده و شناسه دارد.`,
          `اطلاعات این ${actor} در صفحه «${page}» دیده می‌شود.`,
        ]
      : [
          `The “${page}” page opens without an error.`,
          `The ${actor} is stored and has an identifier.`,
          `That ${actor} is visible on the “${page}” page.`,
        ],
    expectedResult: fa
      ? `اطلاعات ${actor} پس از ${trigger} در صفحه «${page}» دیده می‌شود.`
      : `The ${actor} is visible on “${page}” after ${trigger}.`,
    tags: ["positive", "ui"],
    assumptions: facts.gaps.map((gap) => gap.clarification),
    automationSuitability: "LOW",
    automationLayer: "UI",
    scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
    automationNotes: fa
      ? "REQUIRES_TECHNICAL_DETAILS: شناسه صفحه و دادهٔ نمایشی برای اتوماسیون مشخص نیست."
      : "REQUIRES_TECHNICAL_DETAILS: the page selector and displayed fields are not specified.",
  });
}

function apiCases(facts: Facts, input: QaInput): EngineCase[] {
  const endpoint = facts.endpoint;
  if (!endpoint) return [];
  const fa = facts.fa;
  const cases: EngineCase[] = [];
  const target = `${endpoint.method} ${endpoint.path}`;
  if (facts.successStatus) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: "api-valid",
        technique: "Integration Contract Testing",
        type: "API",
        priority: "HIGH",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی پاسخ ${facts.successStatus} برای ${target} با داده معتبر`
          : `Verify ${target} returns ${facts.successStatus} for a valid request`,
        description: fa
          ? `درخواست معتبر به ${target} باید وضعیت ${facts.successStatus} بدهد.`
          : `A valid call to ${target} returns ${facts.successStatus}.`,
        preconditions: [
          fa
            ? `سرویس ${endpoint.path} در محیط آزمون در دسترس است.`
            : `The ${endpoint.path} service is available in the test environment.`,
        ],
        testData: facts.required.length
          ? facts.required.map((field) =>
              fa ? `${field}: مقدار معتبر` : `${field}: a valid value`,
            )
          : [fa ? "بدنهٔ معتبر مطابق متن" : "A request body that matches the stated contract"],
        steps: fa
          ? [
              `بدنه را با ${facts.required.join(" و ") || "فیلدهای معتبر"} پر کنید.`,
              `${endpoint.method} را به ${endpoint.path} بفرستید.`,
              `وضعیت و شناسهٔ برگشتی را بخوانید.`,
            ]
          : [
              `Fill ${facts.required.join(" and ") || "the stated fields"} with valid values.`,
              `Send ${endpoint.method} ${endpoint.path}.`,
              `Read the status code and the returned identifier.`,
            ],
        stepExpectations: fa
          ? [
              `همهٔ فیلدهای لازم مقدار دارند.`,
              `درخواست به سرویس می‌رسد.`,
              `وضعیت ${facts.successStatus} برمی‌گردد و شناسهٔ نتیجه در پاسخ هست.`,
            ]
          : [
              `Every required field has a value.`,
              `The service receives the request.`,
              `The response status is ${facts.successStatus} and includes the result identifier.`,
            ],
        expectedResult: fa
          ? `پاسخ ${target} وضعیت ${facts.successStatus} و شناسهٔ نتیجه را دارد.`
          : `${target} responds with ${facts.successStatus} and a result identifier.`,
        tags: ["positive", "api"],
        automationSuitability: "HIGH",
        automationLayer: "API",
        scenarioStatus: "READY",
        automationNotes: `READY ${target} expect ${facts.successStatus}`,
      }),
    );
  } else {
    facts.gaps.push(gap("success-contract", facts, "MEDIUM"));
  }
  if (facts.errorStatus) {
    for (const field of facts.required) {
      cases.push(
        makeCase({
          facts,
          input,
          partition: `api-missing:${field}`,
          technique: "Negative Testing",
          type: "API",
          priority: "HIGH",
          designStatus: "AI_DRAFT",
          title: fa
            ? `بررسی وضعیت ${facts.errorStatus} برای ${target} وقتی ${field} نباشد`
            : `Verify ${target} returns ${facts.errorStatus} when ${field} is missing`,
          description: fa
            ? `حذف ${field} باید وضعیت ${facts.errorStatus} بدهد.`
            : `Omitting ${field} returns ${facts.errorStatus}.`,
          preconditions: [
            fa
              ? `سرویس ${endpoint.path} در محیط آزمون در دسترس است.`
              : `The ${endpoint.path} service is available in the test environment.`,
          ],
          testData: [fa ? `${field}: حذف شده` : `${field}: omitted`],
          steps: fa
            ? [
                `بدنهٔ معتبر بسازید و ${field} را حذف کنید.`,
                `${endpoint.method} را به ${endpoint.path} بفرستید.`,
              ]
            : [
                `Build a valid body and remove ${field}.`,
                `Send ${endpoint.method} ${endpoint.path}.`,
              ],
          stepExpectations: fa
            ? [
                `${field} در بدنه نیست و بقیهٔ فیلدهای لازم هستند.`,
                `وضعیت پاسخ ${facts.errorStatus} است و منبع موفق ساخته نمی‌شود.`,
              ]
            : [
                `${field} is absent and the other required fields remain.`,
                `The response status is ${facts.errorStatus} and no successful resource is created.`,
              ],
          expectedResult: fa
            ? `${target} بدون ${field} با وضعیت ${facts.errorStatus} رد می‌شود.`
            : `${target} without ${field} is rejected with ${facts.errorStatus}.`,
          tags: ["negative", "api"],
          automationSuitability: "HIGH",
          automationLayer: "API",
          scenarioStatus: "READY",
          automationNotes: `READY ${target} omit ${field} expect ${facts.errorStatus}`,
        }),
      );
    }
  }
  return cases;
}

function stateCases(facts: Facts, input: QaInput): EngineCase[] {
  return facts.transitions.map((transition) => {
    const fa = facts.fa;
    const known = transition.trigger.trim().length > 0;
    return makeCase({
      facts,
      input,
      partition: `state:${transition.from}:${transition.to}`,
      technique: "State Transition Testing",
      type: "FUNCTIONAL",
      priority: "HIGH",
      designStatus: known ? "AI_DRAFT" : "DRAFT_REQUIRES_REVIEW",
      title: fa
        ? `بررسی تغییر ${transition.from} به ${transition.to}${known ? ` وقتی ${transition.trigger}` : ""}`
        : `Verify ${transition.from} becomes ${transition.to}${known ? ` when ${transition.trigger}` : ""}`,
      description: fa
        ? `رخداد مشخص باید وضعیت را از ${transition.from} به ${transition.to} ببرد.`
        : `The stated event moves the record from ${transition.from} to ${transition.to}.`,
      preconditions: [
        fa
          ? `رکوردی در وضعیت ${transition.from} وجود دارد.`
          : `A record is currently ${transition.from}.`,
      ],
      testData: [fa ? `وضعیت اولیه: ${transition.from}` : `Initial state: ${transition.from}`],
      steps: fa
        ? [
            `رکورد را در وضعیت ${transition.from} آماده کنید.`,
            known
              ? `این رخداد را اجرا کنید: ${transition.trigger}.`
              : `رخدادی که باید وضعیت را عوض کند هنوز در نیازمندی نام ندارد؛ آن را از محصول بپرسید و سپس اجرا کنید.`,
          ]
        : [
            `Prepare a record in ${transition.from}.`,
            known
              ? `Perform this event: ${transition.trigger}.`
              : `The trigger is not named. Confirm it with the product owner before executing the transition.`,
          ],
      stepExpectations: fa
        ? [
            `وضعیت رکورد ${transition.from} است.`,
            known
              ? `وضعیت رکورد ${transition.to} شده است.`
              : `تا مشخص شدن رخداد، نتیجهٔ این گذار قابل تأیید نیست.`,
          ]
        : [
            `The record is ${transition.from}.`,
            known
              ? `The record is now ${transition.to}.`
              : `The resulting state cannot be confirmed until the trigger is named.`,
          ],
      expectedResult: known
        ? fa
          ? `پس از «${transition.trigger}» وضعیت از ${transition.from} به ${transition.to} تغییر می‌کند.`
          : `After “${transition.trigger}”, the state changes from ${transition.from} to ${transition.to}.`
        : fa
          ? `گذار ${transition.from} به ${transition.to} بدون رخداد مشخص قابل اجرا نیست.`
          : `The ${transition.from} to ${transition.to} transition cannot be executed until its trigger is known.`,
      tags: ["positive", "state"],
      assumptions: known
        ? []
        : [
            fa
              ? "رخداد گذار در متن نیامده است."
              : "The transition trigger is not written in the requirement.",
          ],
      automationSuitability: "MEDIUM",
      automationLayer: "API",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes: "REQUIRES_TECHNICAL_DETAILS: no endpoint is given for this transition.",
    });
  });
}

function authCases(facts: Facts, input: QaInput): EngineCase[] {
  return facts.authRules.map((rule) => {
    const fa = facts.fa;
    return makeCase({
      facts,
      input,
      partition: `auth:${rule.actor}:${rule.action}:${rule.allowed ? "allow" : "deny"}`,
      technique: "Permission Matrix",
      type: "SECURITY",
      priority: "HIGH",
      designStatus: "AI_DRAFT",
      title: fa
        ? rule.allowed
          ? `بررسی مجاز بودن ${rule.action} برای ${rule.actor}`
          : `بررسی رد شدن ${rule.action} برای ${rule.actor}`
        : rule.allowed
          ? `Verify ${rule.actor} can ${rule.action}`
          : `Verify ${rule.actor} cannot ${rule.action}`,
      description: fa
        ? rule.allowed
          ? `${rule.actor} باید بتواند ${rule.action} را انجام دهد.`
          : `${rule.actor} نباید بتواند ${rule.action} را انجام دهد.`
        : rule.allowed
          ? `${rule.actor} is allowed to ${rule.action}.`
          : `${rule.actor} is not allowed to ${rule.action}.`,
      preconditions: [
        fa
          ? `نشست با نقش ${rule.actor} برقرار است.`
          : `A session exists for the ${rule.actor} role.`,
      ],
      testData: [fa ? `نقش: ${rule.actor}` : `Role: ${rule.actor}`],
      steps: fa
        ? [
            `با نقش ${rule.actor} وارد شوید.`,
            `عمل ${rule.action} را انجام دهید.`,
          ]
        : [`Sign in as ${rule.actor}.`, `Attempt to ${rule.action}.`],
      stepExpectations: fa
        ? [
            `نشست متعلق به ${rule.actor} است.`,
            rule.allowed
              ? `عمل ${rule.action} پذیرفته می‌شود.`
              : `عمل ${rule.action} پذیرفته نمی‌شود.`,
          ]
        : [
            `The session belongs to ${rule.actor}.`,
            rule.allowed
              ? `The ${rule.action} action is accepted.`
              : `The ${rule.action} action is not accepted.`,
          ],
      expectedResult: fa
        ? rule.allowed
          ? `${rule.actor} می‌تواند ${rule.action} را انجام دهد.`
          : `${rule.actor} نمی‌تواند ${rule.action} را انجام دهد.`
        : rule.allowed
          ? `${rule.actor} can ${rule.action}.`
          : `${rule.actor} cannot ${rule.action}.`,
      tags: ["permission", rule.allowed ? "positive" : "negative"],
      automationSuitability: "MEDIUM",
      automationLayer: "API",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes:
        "REQUIRES_TECHNICAL_DETAILS: the authentication mechanism and endpoint are not specified.",
    });
  });
}

function searchCases(facts: Facts, input: QaInput): EngineCase[] {
  const fa = facts.fa;
  const field = facts.searchBy ?? (fa ? "عبارت" : "term");
  const cases: EngineCase[] = [];
  if (facts.searchBy) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: `search:exact:${field}`,
        technique: "Equivalence Partitioning",
        type: "FUNCTIONAL",
        priority: "HIGH",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی جستجوی دقیق بر اساس ${field}`
          : `Verify exact search by ${field}`,
        description: fa
          ? `فقط رکوردهای منطبق با ${field} باید برگردند.`
          : `Only records matching ${field} are returned.`,
        preconditions: [
          fa
            ? `حداقل یک رکورد با ${field} مشخص و یک رکورد دیگر وجود دارد.`
            : `At least one record with a known ${field} and one different record exist.`,
        ],
        testData: [fa ? `${field}: مقدار موجود` : `${field}: a value that exists`],
        steps: fa
          ? [
              `جستجو را با همان ${field} اجرا کنید.`,
              `فهرست نتایج را با رکوردهای موجود مقایسه کنید.`,
            ]
          : [
              `Run the search with that exact ${field}.`,
              `Compare the result list with the known records.`,
            ],
        stepExpectations: fa
          ? [
              `عبارت جستجو ثبت شده است.`,
              `فقط رکورد منطبق دیده می‌شود و رکورد دیگر در نتیجه نیست.`,
            ]
          : [
              `The search value is submitted.`,
              `Only the matching record is listed.`,
            ],
        expectedResult: fa
          ? `نتیجه فقط رکورد منطبق با ${field} را نشان می‌دهد.`
          : `The result lists only the record that matches ${field}.`,
        tags: ["positive", "search"],
        automationSuitability: "MEDIUM",
        automationLayer: "API",
        scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
        automationNotes: "REQUIRES_TECHNICAL_DETAILS: the search endpoint is not specified.",
      }),
    );
  }
  if (facts.filterBy && facts.sortBy) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: `search:filter:${facts.filterBy}:sort:${facts.sortBy}`,
        technique: "Equivalence Partitioning",
        type: "FUNCTIONAL",
        priority: "MEDIUM",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی فیلتر ${facts.filterBy} همراه با مرتب‌سازی ${facts.sortBy}`
          : `Verify filtering by ${facts.filterBy} together with sorting by ${facts.sortBy}`,
        description: fa
          ? `فیلتر و مرتب‌سازی باید هم‌زمان روی یک فهرست اعمال شوند.`
          : `The filter and the sort apply to the same result list.`,
        preconditions: [
          fa
            ? `چند رکورد با ${facts.filterBy} یکسان و ${facts.sortBy} متفاوت وجود دارد.`
            : `Several records share ${facts.filterBy} and differ by ${facts.sortBy}.`,
        ],
        testData: [
          fa
            ? `${facts.filterBy}: یک مقدار، ${facts.sortBy}: چند مقدار`
            : `${facts.filterBy}: one value, ${facts.sortBy}: several values`,
        ],
        steps: fa
          ? [
              `فیلتر ${facts.filterBy} را اعمال کنید.`,
              `مرتب‌سازی ${facts.sortBy} را روی همان نتیجه اعمال کنید.`,
            ]
          : [
              `Apply the ${facts.filterBy} filter.`,
              `Sort that same result by ${facts.sortBy}.`,
            ],
        stepExpectations: fa
          ? [
              `فقط رکوردهای همان ${facts.filterBy} مانده‌اند.`,
              `ترتیب رکوردها با ${facts.sortBy} هم‌خوان است.`,
            ]
          : [
              `Only records for that ${facts.filterBy} remain.`,
              `Their order follows ${facts.sortBy}.`,
            ],
        expectedResult: fa
          ? `فهرست هم با ${facts.filterBy} محدود شده و هم بر اساس ${facts.sortBy} مرتب است.`
          : `The list is limited by ${facts.filterBy} and ordered by ${facts.sortBy}.`,
        tags: ["positive", "search"],
        automationSuitability: "MEDIUM",
        automationLayer: "API",
        scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
        automationNotes: "REQUIRES_TECHNICAL_DETAILS: filter and sort parameters are not specified as a contract.",
      }),
    );
  }
  cases.push(
    makeCase({
      facts,
      input,
      partition: "search:empty",
      technique: "Equivalence Partitioning",
      type: "FUNCTIONAL",
      priority: "MEDIUM",
      designStatus: "DRAFT_REQUIRES_REVIEW",
      title: fa
        ? "بررسی جستجویی که هیچ رکورد منطبقی ندارد"
        : "Verify a search that matches no records",
      description: fa
        ? "این مورد استنباط است: نبود انطباق نباید رکورد نامرتبط نشان دهد."
        : "This is an inference: no match should not list unrelated records.",
      preconditions: [
        fa
          ? "مقداری که در داده‌های آزمون وجود ندارد انتخاب شده است."
          : "A value absent from the test data is chosen.",
      ],
      testData: [fa ? "عبارت بدون انطباق" : "A term with no match"],
      steps: fa
        ? ["جستجو را با مقدار ناموجود اجرا کنید.", "فهرست نتایج را ببینید."]
        : ["Search for a value that does not exist.", "Inspect the result list."],
      stepExpectations: fa
        ? ["جستجو اجرا شده است.", "هیچ رکورد نامرتبطی در نتیجه نیست."]
        : ["The search has run.", "No unrelated record is listed."],
      expectedResult: fa
        ? "نتیجه رکورد منطبقی ندارد."
        : "The result contains no matching record.",
      tags: ["negative", "search", "edge"],
      assumptions: [
        fa
          ? "متن، شکل حالت خالی را مشخص نکرده است. این انتظار فقط نبود رکورد منطبق است."
          : "The requirement does not define the empty-state presentation. The expectation is only that no match is listed.",
      ],
      automationSuitability: "LOW",
      automationLayer: "API",
      scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
      automationNotes: "REQUIRES_TECHNICAL_DETAILS: empty-state contract is not specified.",
    }),
  );
  return cases;
}

function paymentCases(facts: Facts, input: QaInput): EngineCase[] {
  const fa = facts.fa;
  const cases: EngineCase[] = [];
  if (facts.payment.success) {
    cases.push(
      paymentCase(facts, input, {
        partition: "payment:success",
        title: fa
          ? `بررسی ثبت وضعیت ${facts.payment.success} پس از پرداخت موفق`
          : `Verify a successful payment sets the order to ${facts.payment.success}`,
        expected: fa
          ? `پس از پرداخت موفق، سفارش در وضعیت ${facts.payment.success} است.`
          : `After a successful payment the order is ${facts.payment.success}.`,
        action: fa ? "پرداخت را با نتیجهٔ موفق تمام کنید." : "Complete the payment with a successful result.",
        observation: fa
          ? `وضعیت سفارش ${facts.payment.success} است.`
          : `The order state is ${facts.payment.success}.`,
        positive: true,
      }),
    );
  }
  if (facts.payment.failure) {
    cases.push(
      paymentCase(facts, input, {
        partition: "payment:failure",
        title: fa
          ? `بررسی باقی ماندن سفارش در ${facts.payment.failure} پس از پرداخت ناموفق`
          : `Verify a failed payment leaves the order ${facts.payment.failure}`,
        expected: fa
          ? `پس از پرداخت ناموفق، سفارش ${facts.payment.failure} می‌ماند.`
          : `After a failed payment the order stays ${facts.payment.failure}.`,
        action: fa ? "پرداخت را با نتیجهٔ ناموفق تمام کنید." : "Complete the payment with a failed result.",
        observation: fa
          ? `وضعیت سفارش ${facts.payment.failure} است.`
          : `The order state is ${facts.payment.failure}.`,
        positive: false,
      }),
    );
  }
  if (facts.payment.retry && facts.payment.failure && facts.payment.success) {
    cases.push(
      paymentCase(facts, input, {
        partition: "payment:retry",
        title: fa
          ? `بررسی تلاش مجدد پرداخت بعد از وضعیت ${facts.payment.failure}`
          : `Verify a payment can be retried after ${facts.payment.failure}`,
        expected: fa
          ? `تلاش مجدد موفق، سفارش را به ${facts.payment.success} می‌برد.`
          : `A successful retry moves the order to ${facts.payment.success}.`,
        action: fa
          ? `بعد از پرداخت ناموفق، پرداخت را دوباره انجام دهید و این بار موفق شود.`
          : `After the failed payment, submit the payment again and let it succeed.`,
        observation: fa
          ? `وضعیت سفارش ${facts.payment.success} است.`
          : `The order state is ${facts.payment.success}.`,
        positive: true,
      }),
    );
  }
  return cases;
}

function paymentCase(
  facts: Facts,
  input: QaInput,
  spec: {
    partition: string;
    title: string;
    expected: string;
    action: string;
    observation: string;
    positive: boolean;
  },
): EngineCase {
  const fa = facts.fa;
  return makeCase({
    facts,
    input,
    partition: spec.partition,
    technique: "Negative Testing",
    type: "FUNCTIONAL",
    priority: "HIGH",
    designStatus: "AI_DRAFT",
    title: spec.title,
    description: spec.expected,
    preconditions: [
      fa
        ? "سفارشی که هنوز پرداخت موفق نداشته آماده است."
        : "An order without a successful payment is ready.",
    ],
    testData: [fa ? "مبلغ سفارش موجود" : "The order amount already stored"],
    steps: [
      spec.action,
      fa ? "وضعیت سفارش را بلافاصله بعد از نتیجه بخوانید." : "Read the order state immediately after the result.",
    ],
    stepExpectations: [
      fa ? "نتیجهٔ پرداخت ثبت شده است." : "The payment result is recorded.",
      spec.observation,
    ],
    expectedResult: spec.expected,
    tags: [spec.positive ? "positive" : "negative", "financial", ...(spec.partition === "payment:success" ? [] : ["edge"])],
    automationSuitability: "MEDIUM",
    automationLayer: "API",
    scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
    automationNotes: "REQUIRES_TECHNICAL_DETAILS: the payment endpoint and provider are not specified.",
  });
}

function databaseCases(facts: Facts, input: QaInput): EngineCase[] {
  const fa = facts.fa;
  const table = facts.table ?? (fa ? "جدول" : "table");
  const field = facts.uniqueField ?? (fa ? "شناسه" : "identifier");
  const cases: EngineCase[] = [
    makeCase({
      facts,
      input,
      partition: "db:insert",
      technique: "Data Integrity Testing",
      type: "DATABASE",
      priority: "HIGH",
      designStatus: "AI_DRAFT",
      title: fa
        ? `بررسی ذخیره شدن ردیف جدید در ${table}`
        : `Verify a new row is stored in ${table}`,
      description: fa
        ? `ذخیرهٔ موفق باید یک ردیف با ${field} جدید در ${table} بسازد.`
        : `A successful save creates a row with a new ${field} in ${table}.`,
      preconditions: [
        fa
          ? `مقدار ${field} از قبل در ${table} نیست.`
          : `The ${field} value is not already present in ${table}.`,
      ],
      testData: [fa ? `${field}: مقدار تازه` : `${field}: a new value`],
      steps: fa
        ? [`ذخیره را با ${field} تازه انجام دهید.`, `ردیف را در ${table} پیدا کنید.`]
        : [`Save a record with a new ${field}.`, `Look up the row in ${table}.`],
      stepExpectations: fa
        ? [`عملیات ذخیره بدون رد شدن تمام می‌شود.`, `یک ردیف با همان ${field} در ${table} وجود دارد.`]
        : [`The save is accepted.`, `One row with that ${field} exists in ${table}.`],
      expectedResult: fa
        ? `ردیف جدید با ${field} داده‌شده در ${table} ذخیره شده است.`
        : `The new row is stored in ${table} with the given ${field}.`,
      tags: ["positive", "database"],
      automationSuitability: "MEDIUM",
      automationLayer: "DB",
      scenarioStatus: "REQUIRES_CONFIGURATION",
      automationNotes: `REQUIRES_CONFIGURATION: table ${table} is named, but no database connector is configured.`,
    }),
  ];
  if (facts.uniqueField) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: `db:duplicate:${facts.uniqueField}`,
        technique: "Data Integrity Testing",
        type: "DATABASE",
        priority: "HIGH",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی رد شدن ${field} تکراری در ${table}`
          : `Verify a duplicate ${field} is rejected in ${table}`,
        description: fa
          ? `مقدار تکراری ${field} نباید ردیف دوم بسازد.`
          : `A repeated ${field} must not create a second row.`,
        preconditions: [
          fa
            ? `یک ردیف با این ${field} از قبل در ${table} هست.`
            : `A row with this ${field} already exists in ${table}.`,
        ],
        testData: [fa ? `${field}: مقدار موجود` : `${field}: an existing value`],
        steps: fa
          ? [`ذخیره را با همان ${field} تکرار کنید.`, `تعداد ردیف‌های آن ${field} را بشمارید.`]
          : [`Repeat the save with the same ${field}.`, `Count rows for that ${field}.`],
        stepExpectations: fa
          ? [`ذخیره پذیرفته نمی‌شود.`, `همچنان فقط یک ردیف با آن ${field} وجود دارد.`]
          : [`The save is not accepted.`, `Still only one row has that ${field}.`],
        expectedResult: fa
          ? `${field} تکراری در ${table} رد می‌شود و ردیف دوم ساخته نمی‌شود.`
          : `The duplicate ${field} is rejected and no second row is stored in ${table}.`,
        tags: ["negative", "database", "edge"],
        automationSuitability: "MEDIUM",
        automationLayer: "DB",
        scenarioStatus: "REQUIRES_CONFIGURATION",
        automationNotes: `REQUIRES_CONFIGURATION: uniqueness of ${field} on ${table} needs a configured connector.`,
      }),
    );
  }
  return cases;
}

function validationCases(facts: Facts, input: QaInput): EngineCase[] {
  const fa = facts.fa;
  const cases: EngineCase[] = [];
  for (const limit of facts.limits) {
    if (limit.min === undefined) continue;
    const below = limit.min - 1;
    cases.push(
      boundaryCase(facts, input, {
        partition: `boundary:${limit.subject}:${limit.min}`,
        value: String(limit.min),
        accepted: true,
        subject: limit.subject,
      }),
      boundaryCase(facts, input, {
        partition: `boundary:${limit.subject}:${below}`,
        value: String(below),
        accepted: false,
        subject: limit.subject,
      }),
    );
  }
  for (const field of facts.required) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: `validation:missing:${field}`,
        technique: "Equivalence Partitioning",
        type: "FUNCTIONAL",
        priority: "HIGH",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی پذیرفته نشدن فرم وقتی ${field} خالی است`
          : `Verify the form is not accepted when ${field} is empty`,
        description: fa
          ? `${field} الزامی است، پس ارسال بدون آن پذیرفته نمی‌شود.`
          : `${field} is required, so a submit without it is not accepted.`,
        preconditions: [fa ? "فرم ثبت باز است." : "The form is open."],
        testData: [fa ? `${field}: خالی` : `${field}: empty`],
        steps: fa
          ? [`${field} را خالی بگذارید و بقیهٔ فیلدهای لازم را پر کنید.`, "فرم را ارسال کنید."]
          : [`Leave ${field} empty and fill the other required fields.`, "Submit the form."],
        stepExpectations: fa
          ? [`${field} خالی است.`, "ارسال به‌عنوان موفق پذیرفته نمی‌شود."]
          : [`${field} is empty.`, "The submit is not accepted as successful."],
        expectedResult: fa
          ? `فرم بدون ${field} پذیرفته نمی‌شود.`
          : `The form is not accepted without ${field}.`,
        tags: ["negative", "validation"],
        assumptions: [
          fa
            ? "متن، متن پیام خطا را مشخص نکرده است. انتظار فقط نپذیرفتن ارسال است."
            : "The requirement does not define the error message. The expectation is only that the submit is not accepted.",
        ],
        automationSuitability: "LOW",
        automationLayer: "UI",
        scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
        automationNotes: "REQUIRES_TECHNICAL_DETAILS: form selectors and the error contract are not specified.",
      }),
    );
  }
  for (const field of facts.optional) {
    cases.push(
      makeCase({
        facts,
        input,
        partition: `validation:optional:${field}`,
        technique: "Equivalence Partitioning",
        type: "FUNCTIONAL",
        priority: "MEDIUM",
        designStatus: "AI_DRAFT",
        title: fa
          ? `بررسی پذیرفتن فرم بدون ${field}`
          : `Verify the form can be submitted without ${field}`,
        description: fa
          ? `${field} اختیاری است و نباید مانع ارسال شود.`
          : `${field} is optional and must not block the submit.`,
        preconditions: [fa ? "بقیهٔ فیلدهای الزامی مقدار معتبر دارند." : "The other required fields have valid values."],
        testData: [fa ? `${field}: خالی` : `${field}: empty`],
        steps: fa
          ? [`${field} را خالی بگذارید.`, "فرم را با بقیهٔ داده‌های معتبر ارسال کنید."]
          : [`Leave ${field} empty.`, "Submit the form with the other valid values."],
        stepExpectations: fa
          ? [`${field} خالی مانده است.`, `فرم به‌خاطر نبود ${field} رد نمی‌شود.`]
          : [`${field} stays empty.`, `The form is not rejected because ${field} is missing.`],
        expectedResult: fa
          ? `نبود ${field} باعث رد شدن فرم نمی‌شود.`
          : `Omitting ${field} does not reject the form.`,
        tags: ["positive", "validation"],
        automationSuitability: "LOW",
        automationLayer: "UI",
        scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
        automationNotes: "REQUIRES_TECHNICAL_DETAILS: form selectors are not specified.",
      }),
    );
  }
  return cases;
}

function boundaryCase(
  facts: Facts,
  input: QaInput,
  spec: { partition: string; value: string; accepted: boolean; subject: string },
): EngineCase {
  const fa = facts.fa;
  return makeCase({
    facts,
    input,
    partition: spec.partition,
    technique: "Boundary Value Analysis",
    type: "FUNCTIONAL",
    priority: "HIGH",
    designStatus: "AI_DRAFT",
    title: fa
      ? spec.accepted
        ? `بررسی پذیرفتن ${spec.subject} با طول ${spec.value}`
        : `بررسی رد شدن ${spec.subject} با طول ${spec.value}`
      : spec.accepted
        ? `Verify ${spec.subject} of length ${spec.value} is accepted`
        : `Verify ${spec.subject} of length ${spec.value} is rejected`,
    description: fa
      ? `حد مشخص‌شده برای ${spec.subject} باید در مقدار ${spec.value} رعایت شود.`
      : `The stated limit for ${spec.subject} is applied at value ${spec.value}.`,
    preconditions: [fa ? "فرم یا ورودی مربوط باز است." : "The related input is available."],
    testData: [`${spec.subject}: ${spec.value}`],
    steps: fa
      ? [`برای ${spec.subject} مقدار با طول ${spec.value} وارد کنید.`, "ورودی را ثبت کنید."]
      : [`Enter a ${spec.subject} value of length ${spec.value}.`, "Submit the input."],
    stepExpectations: fa
      ? [
          `طول ${spec.subject} برابر ${spec.value} است.`,
          spec.accepted ? "ورودی پذیرفته می‌شود." : "ورودی پذیرفته نمی‌شود.",
        ]
      : [
          `${spec.subject} has length ${spec.value}.`,
          spec.accepted ? "The input is accepted." : "The input is not accepted.",
        ],
    expectedResult: fa
      ? spec.accepted
        ? `${spec.subject} با طول ${spec.value} پذیرفته می‌شود.`
        : `${spec.subject} با طول ${spec.value} پذیرفته نمی‌شود.`
      : spec.accepted
        ? `${spec.subject} of length ${spec.value} is accepted.`
        : `${spec.subject} of length ${spec.value} is not accepted.`,
    tags: [spec.accepted ? "positive" : "negative", "boundary", "edge"],
    assumptions: [
      fa
        ? "متن پیام خطا مشخص نشده است."
        : "The exact validation message is not specified.",
    ],
    automationSuitability: "LOW",
    automationLayer: "UI",
    scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
    automationNotes: "REQUIRES_TECHNICAL_DETAILS: the input control is not specified.",
  });
}

function insufficientCase(facts: Facts, input: QaInput): EngineCase {
  const fa = facts.fa;
  return makeCase({
    facts,
    input,
    partition: "insufficient",
    technique: "Use Case Testing",
    type: "FUNCTIONAL",
    priority: "LOW",
    designStatus: "DRAFT_REQUIRES_REVIEW",
    title: fa
      ? "پیش‌نویس بررسی نیازمندی؛ اطلاعات اجرا کافی نیست"
      : "Draft review of the requirement; execution detail is missing",
    description: fa
      ? "از متن نمی‌توان قدم قابل اجرا و نتیجهٔ قابل مشاهده ساخت."
      : "The text does not provide an executable step and an observable result.",
    preconditions: [
      fa
        ? "جزئیات کنش، داده و نتیجه هنوز باید از محصول پرسیده شود."
        : "Action, data, and outcome still need to be confirmed with the product owner.",
    ],
    testData: [],
    steps: fa
      ? ["شکاف‌های همین نیازمندی را با محصول مرور کنید."]
      : ["Review the gaps on this requirement with the product owner."],
    stepExpectations: fa
      ? ["فهرست ابهام‌ها ثبت شده و هنوز رفتار حدسی به‌عنوان نتیجهٔ رسمی نوشته نشده است."]
      : ["The open questions are recorded, and no guessed behavior is treated as an official result."],
    expectedResult: fa
      ? "تا رفع شکاف‌ها این مورد قابل اجرای رسمی نیست."
      : "This item is not officially executable until the gaps are resolved.",
    tags: ["draft"],
    automationSuitability: "LOW",
    automationLayer: "Integration",
    scenarioStatus: "REQUIRES_TECHNICAL_DETAILS",
    automationNotes: "REQUIRES_TECHNICAL_DETAILS: there is not enough information to automate.",
  });
}

function makeCase(
  spec: {
    facts: Facts;
    input: QaInput;
    partition: string;
    technique: string;
    type: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    designStatus: DesignStatus;
    title: string;
    description: string;
    preconditions: string[];
    testData: string[];
    steps: string[];
    stepExpectations: string[];
    expectedResult: string;
    tags: string[];
    assumptions?: string[];
    gapRefs?: string[];
    acceptanceKeys?: string[];
    automationSuitability: EngineCase["automationSuitability"];
    automationLayer: EngineCase["automationLayer"];
    scenarioStatus: EngineCase["scenarioStatus"];
    automationNotes: string;
  },
): EngineCase {
  return {
    conditionKey: spec.partition,
    title: spec.title,
    description: spec.description,
    preconditions: spec.preconditions,
    steps: spec.steps,
    stepExpectations: spec.stepExpectations,
    testData: spec.testData,
    expectedResult: spec.expectedResult,
    priority: spec.priority,
    type: spec.type,
    tags: [...spec.tags, `partition:${spec.partition}`, `technique:${spec.technique}`],
    relatedAcceptanceCriteria: spec.acceptanceKeys ?? relatedKeys(spec.input, spec.expectedResult),
    designStatus: spec.designStatus,
    technique: spec.technique,
    gapRefs: spec.gapRefs ?? [],
    assumptions: spec.assumptions ?? [],
    postconditions: [],
    automationSuitability: spec.automationSuitability,
    automationLayer: spec.automationLayer,
    automationNotes: spec.automationNotes,
    scenarioStatus: spec.scenarioStatus,
    partition: spec.partition,
  };
}

/**
 * AC keys a template case can honestly claim. When no criterion shares a
 * meaningful word with the expected result the case stays unlinked (and shows
 * up as "not linked to an AC" in traceability) instead of being attributed to
 * the first criterion, which would inflate coverage.
 */
function relatedKeys(input: QaInput, expected: string): string[] {
  const explicit = input.acceptanceCriteria.filter((item) => item.origin !== "derived" && item.text.trim());
  return explicit.filter((item) => shares(item.text, expected)).map((item) => item.key);
}

function shares(left: string, right: string): boolean {
  const words = new Set(norm(left).split(" ").filter((word) => word.length > 3));
  return norm(right)
    .split(" ")
    .some((word) => word.length > 3 && words.has(word));
}

/**
 * Merge cases whose behavior signature (partition) is the same; the merged
 * case keeps every AC key it stands for. The signature is intentionally
 * coarse (see behaviorSignature), which is covered by pipeline.spec.
 */
export function dedupeCases(cases: EngineCase[]): EngineCase[] {
  const out: EngineCase[] = [];
  for (const item of cases) {
    const index = out.findIndex((current) => current.partition === item.partition);
    if (index < 0) {
      out.push(item);
      continue;
    }
    const current = out[index];
    out[index] = {
      ...current,
      relatedAcceptanceCriteria: [
        ...new Set([...current.relatedAcceptanceCriteria, ...item.relatedAcceptanceCriteria]),
      ],
    };
  }
  return out;
}

function detectGaps(
  text: string,
  fa: boolean,
  extra: { endpoint: Endpoint | null; errorStatus: string | null; page: string | null },
): Gap[] {
  const gaps: Gap[] = [];
  // A gap id is reported once; a second rule hitting the same gap would
  // otherwise duplicate the risk, assumption and product question.
  const add = (id: string, gapItem: Omit<Gap, "id">) => {
    if (!gaps.some((item) => item.id === id)) gaps.push({ id, ...gapItem });
  };
  if (/هر\s+کانال|every\s+channel|any\s+channel|all\s+channels/i.test(text) && !/(?:channels?|کانال‌ها)\s*[:：]/i.test(text)) {
    add("GAP-CHANNEL", {
      description: fa
        ? "کانال‌ها فهرست نشده‌اند و عبارت «هر کانال» قابل اندازه‌گیری نیست."
        : "Channels are not listed, so “every channel” cannot be measured.",
      impact: fa ? "گذر از یک کانال، پوشش بقیه را ثابت نمی‌کند." : "Passing one channel does not cover the others.",
      affectedCoverage: fa ? "کانال" : "channel",
      clarification: fa ? "فهرست کانال‌های معتبر را مشخص کنید." : "List the valid channels.",
      severity: "HIGH",
    });
  }
  if (/(نمایش داده|is displayed|are shown|are visible|اطلاعاتشان)/i.test(text) && !/(فیلد|field|ستون|column|شامل|including)/i.test(text)) {
    add("GAP-FIELDS", {
      description: fa
        ? "فیلدهایی که باید دیده شوند مشخص نشده‌اند."
        : "The fields that must be shown are not defined.",
      impact: fa ? "نمی‌توان درستی محتوای نمایش را سنجید." : "The displayed content cannot be checked precisely.",
      affectedCoverage: fa ? "فیلدهای نمایش" : "displayed fields",
      clarification: fa ? "فیلدهای قابل مشاهده را نام ببرید." : "Name the visible fields.",
      severity: "HIGH",
    });
  }
  if (/(invalid|نامعتبر|error|خطا|rejected|رد می‌)/i.test(text) && !extra.errorStatus && !/\b(400|401|403|404|409|422)\b/.test(text)) {
    add("GAP-ERROR", {
      description: fa
        ? "قرارداد خطا، شامل وضعیت یا متن خطا، مشخص نیست."
        : "The error contract, including status or message, is not defined.",
      impact: fa ? "انتظار خطای دقیق ساخته نمی‌شود." : "A precise error expectation must not be invented.",
      affectedCoverage: fa ? "خطا" : "error",
      clarification: fa ? "وضعیت و بدنهٔ خطا را مشخص کنید." : "Specify the error status and body.",
      severity: "MEDIUM",
    });
  }
  if (extra.endpoint && !extra.errorStatus && /invalid|نامعتبر/.test(text)) {
    add("GAP-ERROR", {
      description: fa ? "کد خطای درخواست نامعتبر مشخص نیست." : "The status for an invalid request is not defined.",
      impact: fa ? "نمی‌توان کد پاسخ را قطعی دانست." : "The response code cannot be asserted.",
      affectedCoverage: "API",
      clarification: fa ? "کد وضعیت خطا را مشخص کنید." : "Specify the error status code.",
      severity: "MEDIUM",
    });
  }
  if (extra.page && gaps.length === 0 && /باید نمایش|should be displayed/i.test(text) === false) {
    return gaps;
  }
  return gaps;
}

function gap(kind: string, facts: Facts, severity: Gap["severity"]): Gap {
  const fa = facts.fa;
  return {
    id: `GAP-${kind}`,
    description: fa ? "قرارداد پاسخ موفق مشخص نیست." : "The success response contract is not defined.",
    impact: fa ? "نمی‌توان وضعیت موفق را حدس زد." : "A success status must not be guessed.",
    affectedCoverage: "API",
    clarification: fa ? "وضعیت و بدنهٔ موفق را مشخص کنید." : "Specify the success status and body.",
    severity,
  };
}

function extractActors(text: string): string[] {
  const found: string[] = [];
  const subject = text.match(/(?:^|[\n.])\s*(\S+?)\s+که\s+/);
  if (subject?.[1]) found.push(subject[1].replace(/(?:هایی|ها)$/, ""));
  const only = text.match(/\bonly an?\s+([A-Za-z]{3,24})\b/i);
  if (only?.[1]) found.push(only[1]);
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,24})\s+can\s+/g)) {
    found.push(match[1]);
  }
  for (const word of ["admin", "customer", "user", "operator", "guest", "کاربر", "ادمین", "مشتری", "اپراتور"]) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) found.push(word);
  }
  return [...new Set(found.map((item) => item.trim()))].slice(0, 6);
}

function extractPage(text: string): string | null {
  const match = text.match(
    /(?:صفحه|page)\s+[«"]?([A-Za-z0-9\u0600-\u06FF][\w\u0600-\u06FF ._-]{1,48}?)(?=\s+(?:نمایش|is\b|are\b|shows\b)|[،.]|$)/i,
  );
  return match?.[1]?.trim() ?? null;
}

function extractEndpoint(text: string): Endpoint | null {
  const match = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}-]*)/);
  if (!match || !HTTP_VERBS.has(match[1])) return null;
  return { method: match[1], path: match[2] };
}

function extractTransitions(text: string): Transition[] {
  const found: Transition[] = [];
  const pattern =
    /\b(?:from\s+)?([A-Z][A-Z0-9_]{2,})\s+(?:→|->|to)\s+([A-Z][A-Z0-9_]{2,})(?:\s+when\s+([^.,\n]+))?/gi;
  for (const match of text.matchAll(pattern)) {
    if (HTTP_VERBS.has(match[1]) || HTTP_VERBS.has(match[2])) continue;
    found.push({
      from: match[1],
      to: match[2],
      trigger: (match[3] ?? "").trim(),
    });
  }
  return found;
}

function extractRequired(text: string): string[] {
  const listed = text.match(/required fields?:\s*([^.]+)/i);
  if (listed?.[1]) {
    return splitFields(listed[1]);
  }
  const pair = text.match(/\brequires?\s+([A-Za-z][\w]*)\s+and\s+([A-Za-z][\w]*)/i);
  if (pair) return [pair[1], pair[2]];
  return [];
}

function extractOptional(text: string): string[] {
  const match = text.match(/\b([A-Za-z][\w]*)\s+is optional\b/i);
  return match?.[1] ? [match[1]] : [];
}

function extractLimits(text: string): Limit[] {
  const match = text.match(/\b([A-Za-z][\w]*)\s+must be at least\s+(\d+)/i);
  if (!match) return [];
  return [{ subject: match[1], min: Number(match[2]) }];
}

function extractTable(text: string): string | null {
  const match = text.match(/\b(?:in|into)\s+the\s+([a-z_][\w]*)\s+table\b/i) ?? text.match(/\b([a-z_][\w]*)\s+table\b/i);
  return match?.[1] ?? null;
}

function extractUnique(text: string): string | null {
  const match = text.match(/\bunique\s+([A-Za-z_][\w]*)/i);
  return match?.[1] ?? null;
}

function extractTrigger(text: string): string | null {
  const persian = text.match(/که\s+(.+?)\s+(?:خود\s+)?را\s+/);
  if (persian?.[1]) return persian[1].trim();
  const english = text.match(/\bwhen\s+([^.,\n]+)/i);
  return english?.[1]?.trim() ?? null;
}

function extractPayment(text: string): Facts["payment"] {
  const success = text.match(/successful payment marks the order\s+([A-Z][A-Z0-9_]*)/i)?.[1] ?? null;
  const failure = text.match(/failed payment leaves the order\s+([A-Z][A-Z0-9_]*)/i)?.[1] ?? null;
  return {
    success,
    failure,
    retry: /retry|تلاش مجدد/i.test(text),
  };
}

function extractAuth(text: string): Array<{ actor: string; action: string; allowed: boolean }> {
  const rules: Array<{ actor: string; action: string; allowed: boolean }> = [];
  const only = text.match(/\bonly an?\s+([A-Za-z]+)\s+can\s+([a-z]+)\b/i);
  if (!only) return rules;
  rules.push({ actor: only[1], action: only[2], allowed: true });
  for (const match of text.matchAll(/\b([A-Z][a-z]+)\s+can\s+([a-z]+)\b/g)) {
    if (match[1].toLowerCase() === only[1].toLowerCase()) continue;
    rules.push({ actor: match[1], action: match[2], allowed: true });
    if (match[2].toLowerCase() !== only[2].toLowerCase()) {
      rules.push({ actor: match[1], action: only[2], allowed: false });
    }
  }
  return rules;
}

function splitFields(value: string): string[] {
  return value
    .split(/\s+and\s+|,| و /i)
    .map((item) => item.replace(/[^A-Za-z0-9_]/g, "").trim())
    .filter((item) => item.length > 1);
}

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
