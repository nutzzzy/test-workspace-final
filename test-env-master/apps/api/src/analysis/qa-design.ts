import type { AppLocale } from "../ai/localize-fa";

export type CriterionOrigin = "cleaned" | "derived";

export type DesignedCriterion = {
  key: string;
  text: string;
  origin: CriterionOrigin;
  orderIndex: number;
};

export type DesignedTestCase = {
  title: string;
  description: string;
  preconditions: string[];
  steps: string[];
  stepExpectations: string[];
  testData: string[];
  expectedResult: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: "FUNCTIONAL" | "REGRESSION" | "EDGE" | "API" | "UI";
  relatedAcceptanceCriteria: string[];
  tags: string[];
};

type DraftTestCase = Omit<DesignedTestCase, "stepExpectations" | "testData">;

export type DesignedRisk = {
  description: string;
  impact: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  likelihood: "HIGH" | "MEDIUM" | "LOW";
  mitigation: string;
  releaseBlocking: boolean;
  acceptanceKeys: string[];
};

const NOISE =
  /^(acceptance criteria|acceptance criterion|acceptance|criteria|ac|معیارهای پذیرش|معیار پذیرش)\s*[:：-]?\s*$/i;

const CRITICAL_TOPIC =
  /(pay|payment|refund|wallet|auth|password|token|permission|secret|delete|حذف|پرداخت|کیف پول|رمز|توکن|دسترسی|محرمان)/i;

export function designAcceptanceCriteria(input: {
  title: string;
  description: string;
  rawCriteria: string[];
  locale: AppLocale;
}): DesignedCriterion[] {
  const cleaned = dedupe(
    splitRaw(input.rawCriteria).map((item) =>
      asStatement(item, input.locale),
    ),
  );
  const origin: CriterionOrigin = cleaned.length > 0 ? "cleaned" : "derived";
  const texts =
    cleaned.length > 0
      ? cleaned
      : deriveFromTask(input.title, input.description, input.locale);

  return texts.map((text, index) => ({
    key: `AC-${String(index + 1).padStart(2, "0")}`,
    text,
    origin,
    orderIndex: index,
  }));
}

export function designTestCases(
  criteria: DesignedCriterion[],
  locale: AppLocale,
): DesignedTestCase[] {
  const cases: DraftTestCase[] = [];
  for (const criterion of criteria) {
    const critical = CRITICAL_TOPIC.test(criterion.text);
    cases.push(
      positiveCase(criterion, locale, critical ? "CRITICAL" : "HIGH"),
      negativeCase(criterion, locale),
    );
    if (mentionsBoundary(criterion.text)) {
      cases.push(boundaryCase(criterion, locale));
    }
    cases.push(...relatedCases(criterion, locale));
  }
  return dedupeTestCases(cases).map((item) => attachDetail(item, locale));
}

/** Drop cases that exercise the same behavior with different wording. */
export function dedupeTestCases(cases: DraftTestCase[]): DraftTestCase[] {
  const seen = new Set<string>();
  const out: DraftTestCase[] = [];
  for (const item of cases) {
    const kind =
      item.tags.find((tag) =>
        ["positive", "negative", "boundary", "validation", "permission", "error"].includes(
          tag,
        ),
      ) ?? "case";
    const key = `${kind}::${normalizeBehavior(`${item.steps.join(" | ")} || ${item.expectedResult}`)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function designRisks(
  criteria: DesignedCriterion[],
  locale: AppLocale,
): DesignedRisk[] {
  const blocking: DesignedRisk[] = criteria.map((criterion) => {
    const critical = CRITICAL_TOPIC.test(criterion.text);
    return {
      description:
        locale === "fa"
          ? `مانع انتشار: اگر ${criterion.key} پاس نشود این تسک نباید به پروداکشن برود. معیار: ${criterion.text}`
          : `Release gate: if ${criterion.key} fails, this task must not go to production. Criterion: ${criterion.text}`,
      impact: critical ? "CRITICAL" : "HIGH",
      likelihood: "MEDIUM",
      mitigation: releaseMitigation(criterion, locale),
      releaseBlocking: true,
      acceptanceKeys: [criterion.key],
    };
  });

  blocking.push({
    description:
      locale === "fa"
        ? "شکاف‌های نوشته‌نشده (خطا، دسترسی، تکرار درخواست) می‌توانند بعد از پاس شدن معیارهای اصلی هم کیفیت انتشار را پایین بیاورند."
        : "Unstated gaps (errors, permissions, repeated requests) can still reduce release quality after the written criteria pass.",
    impact: "MEDIUM",
    likelihood: "MEDIUM",
    mitigation:
      locale === "fa"
        ? "حالات مرزی و سوال‌های باز محصول را قبل از انتشار مرور کنید؛ این مورد به‌تنهایی گیت پروداکشن نیست."
        : "Review edge cases and open product questions before release. This item alone is not a production gate.",
    releaseBlocking: false,
    acceptanceKeys: [],
  });

  return blocking;
}

export function designAnalysis(input: {
  title: string;
  criteria: DesignedCriterion[];
  locale: AppLocale;
}) {
  const { title, criteria, locale } = input;
  const fa = locale === "fa";
  const derived = criteria.some((item) => item.origin === "derived");
  const blob = criteria.map((item) => item.text).join("\n");
  const checks = criteria
    .map((item) => `${item.key}: ${clipSentence(item.text, 90)}`)
    .join(" | ");

  const gaps: string[] = [];
  if (!/(نقش|دسترسی|مجاز|مجوز|auth|permission|role)/i.test(blob)) {
    gaps.push(
      fa
        ? "در معیارها نقش یا مجوز فراخوان نوشته نشده. قبل از اجرا از محصول بپرسید چه کسی اجازهٔ این کار را دارد و با نقش غیرمجاز هم یک بار تست کنید."
        : "No criterion names the allowed role. Ask product who may call this, and run one case with a disallowed role.",
    );
  }
  if (!/(خطا|نشود|نباید|رد|status|code|reject|fail)/i.test(blob)) {
    gaps.push(
      fa
        ? "نتیجهٔ شکست (کد، پیام یا وضعیت ذخیره‌نشده) در معیارها نیست. بدون آن، تستر نمی‌تواند ناموفق را از موفق جدا کند."
        : "Failure output (code, message, or unchanged state) is not written down, so a tester cannot tell a fail from a pass.",
    );
  }
  if (derived) {
    gaps.push(
      fa
        ? "روی تسک معیار پذیرش نبود. متن زیر از توضیحات درآمده و تا محصول آن را تأیید نکند، گیت انتشار قابل اعتماد نیست."
        : "The task had no acceptance criteria. The statements below were derived from the description and are not a release gate until product confirms them.",
    );
  }
  const orCriteria = criteria.filter((item) => /\sیا\s|\bor\b/i.test(item.text));
  // Nothing ambiguous → an empty list, never a filler sentence.
  const ambiguities = orCriteria.slice(0, 3).map((item) =>
    fa
      ? `${item.key} با «یا» نوشته شده. هر شاخه را جدا تست کنید و مشخص کنید اگر فقط یکی از شاخه‌ها برقرار باشد نتیجه کدام است: ${clipSentence(item.text, 160)}`
      : `${item.key} uses “or”. Test each branch alone and decide the result when only one branch is true: ${clipSentence(item.text, 160)}`,
  );

  const missingScenarios: string[] = [];
  if (!/(تکرار|دوباره|idempoten|duplicate|retry)/i.test(blob)) {
    missingScenarios.push(
      fa
        ? "همان درخواست را دو بار پشت سر هم بفرستید. بار دوم نباید رکورد یا وضعیت اضافه بسازد، مگر معیاری خلافش را گفته باشد."
        : "Send the same request twice. The second call must not create an extra record unless a criterion says otherwise.",
    );
  }
  if (!/(خالی|empty|null|نامعتبر)/i.test(blob)) {
    missingScenarios.push(
      fa
        ? "یک فیلد اجباری را خالی بفرستید. انتظار: رد شدن با خطای مشخص، نه ساخت رکورد نصفه‌کاره."
        : "Send one required field empty. Expect a clear rejection and no half-written record.",
    );
  }
  return {
    summary: fa
      ? `«${title}» فقط وقتی قابل انتشار است که این ${criteria.length} معیار با نتیجهٔ نوشته‌شده پاس شوند. ${checks}`
      : `“${title}” can ship only when these ${criteria.length} criteria pass with the written result. ${checks}`,
    acceptanceCriteria: criteria.map((item) => item.text),
    gaps,
    ambiguities,
    missingScenarios,
    potentialRisks: criteria.map((item) =>
      fa
        ? `اگر ${item.key} پاس نشود تسک قابل رفتن روی پروداکشن نیست. نتیجهٔ لازم: ${clipSentence(item.text, 180)}`
        : `If ${item.key} fails, this task must not go to production. Required result: ${clipSentence(item.text, 180)}`,
    ),
  };
}

export function designStrategy(
  title: string,
  criteria: DesignedCriterion[],
  locale: AppLocale,
) {
  const fa = locale === "fa";
  const objectives = criteria.map((item) => {
    const script = readRule(item.text, locale);
    const result = script.given ? script.outcomes.join(fa ? "؛ " : "; ") : script.rule;
    return fa
      ? `${item.key} را این‌طور بسنجید: ${script.given ? script.given.replace(/^اگر\s+/, "") : "قانون معیار"}. قبول فقط اگر: ${clipSentence(result, 160)}`
      : `Test ${item.key} like this: ${script.given ?? "the rule"}. Pass only when: ${clipSentence(result, 160)}`;
  });
  const paths = [
    ...new Set(
      criteria.flatMap((item) => readRule(item.text, locale).paths),
    ),
  ];
  const checks = [
    ...new Set(
      criteria.flatMap((item) => readRule(item.text, locale).checks),
    ),
  ].slice(0, 8);
  return {
    scope: fa
      ? `محدوده: «${title}». هر معیار یک تست موفق، یک تست ناموفق و در صورت حد عددی یک تست مرزی دارد. معیارها: ${criteria.map((item) => item.key).join("، ")}.`
      : `Scope: “${title}”. Each criterion gets a pass case, a fail case, and a boundary case when it has a numeric limit. Criteria: ${criteria.map((item) => item.key).join(", ")}.`,
    objectives:
      objectives.length > 0
        ? objectives
        : [
            fa
              ? "معیاری برای برنامه‌ریزی تست نیست."
              : "There is no criterion to plan against.",
          ],
    testTypes: fa
      ? ["عملکردی", "ناموفق", "مرزی"]
      : ["Functional", "Negative", "Boundary"],
    environments: fa ? ["محیط تست با دادهٔ قابل پاک‌کردن"] : ["A test environment with disposable data"],
    dependencies: [
      ...(paths.length
        ? [
            fa
              ? `اندپوینت‌ها: ${paths.join("، ")}`
              : `Endpoints: ${paths.join(", ")}`,
          ]
        : []),
      ...(checks.length
        ? [
            fa
              ? `مقدارهایی که باید در پاسخ خوانده شوند: ${checks.join("، ")}`
              : `Values to read in the response: ${checks.join(", ")}`,
          ]
        : []),
      fa ? "دادهٔ تست مطابق پیش‌شرط هر کیس" : "Test data matching each case precondition",
    ],
    assumptions: [
      fa
        ? "متن معیار پس از تمیز شدن همان قصد محصول است. اگر نیست، قبل از اجرا معیار را اصلاح کنید."
        : "The cleaned criterion text matches product intent. Correct it before execution if it does not.",
      ...(criteria.some((item) => item.origin === "derived")
        ? [
            fa
              ? "معیارهای استخراج‌شده از توضیحات تا تأیید محصول گیت انتشار نیستند."
              : "Criteria derived from the description are not a release gate until product confirms them.",
          ]
        : []),
    ],
  };
}

export function designEdgeCases(
  criteria: DesignedCriterion[],
  locale: AppLocale,
) {
  const fa = locale === "fa";
  const edges: Array<{ title: string; description: string }> = [];
  for (const criterion of criteria) {
    const script = readRule(criterion.text, locale);
    const path = script.paths[0];
    if (script.inputs.length > 1 && path) {
      edges.push({
        title: fa
          ? `${criterion.key} · فقط یکی از ورودی‌ها`
          : `${criterion.key} · only one of the inputs`,
        description: fa
          ? [
              `پیش‌شرط: اندپوینت ${path} در دسترس است.`,
              "قدم‌ها:",
              numbered(
                [
                  `درخواست را فقط با ${script.inputs[0]} و بدون ${script.inputs[1]} بفرستید.`,
                  `درخواست را فقط با ${script.inputs[1]} و بدون ${script.inputs[0]} بفرستید.`,
                  "هر دو پاسخ را با قانون معیار مقایسه کنید.",
                ],
                true,
              ),
              `انتظار: هر ورودی به‌تنهایی اگر قانون اجازه داده پذیرفته شود؛ ترکیب خالی هر دو رد شود.`,
            ].join("\n")
          : [
              `Precondition: ${path} is available.`,
              "Steps:",
              numbered(
                [
                  `Send only ${script.inputs[0]}, without ${script.inputs[1]}.`,
                  `Send only ${script.inputs[1]}, without ${script.inputs[0]}.`,
                  "Compare both responses with the criterion.",
                ],
                false,
              ),
              "Expected: each input alone is accepted only if the rule allows it; sending neither is rejected.",
            ].join("\n"),
      });
    }
    for (const limit of boundaryLimits(criterion.text)) {
      const verdict = boundaryVerdict(criterion, limit, locale);
      edges.push({
        title: fa
          ? `${criterion.key} · حد ${limit.raw}`
          : `${criterion.key} · limit ${limit.raw}`,
        description: fa
          ? [
              `پیش‌شرط: بقیهٔ شرایط ${criterion.key} ثابت بماند.`,
              "قدم‌ها:",
              numbered(
                [
                  `${limit.name} را برابر ${limit.value} بگذارید و پاسخ را یادداشت کنید.`,
                  `${limit.name} را برابر ${limit.below} بگذارید و پاسخ را یادداشت کنید.`,
                  `${limit.name} را برابر ${limit.above} بگذارید و پاسخ را یادداشت کنید.`,
                ],
                true,
              ),
              `انتظار: ${verdict}`,
            ].join("\n")
          : [
              `Precondition: keep the rest of ${criterion.key} fixed.`,
              "Steps:",
              numbered(
                [
                  `Set ${limit.name} to ${limit.value} and record the response.`,
                  `Set ${limit.name} to ${limit.below} and record the response.`,
                  `Set ${limit.name} to ${limit.above} and record the response.`,
                ],
                false,
              ),
              `Expected: ${verdict}`,
            ].join("\n"),
      });
    }
  }
  const covered = new Set(edges.map((edge) => edge.title.split(" · ")[0]));
  for (const criterion of criteria) {
    if (covered.has(criterion.key)) continue;
    edges.push(plainEdge(criterion, locale));
  }
  const blob = criteria.map((item) => item.text).join("\n");
  if (!/(تکرار|دوباره|idempoten|duplicate)/i.test(blob) && criteria[0]) {
    const path = readRule(criteria[0].text, locale).paths[0];
    edges.push({
      title: fa ? "تکرار همان درخواست" : "Repeat the same request",
      description: fa
        ? [
            "پیش‌شرط: یک درخواست معتبر که معیار اصلی را پاس می‌کند.",
            "قدم‌ها:",
            numbered(
              [
                path
                  ? `همان درخواست موفق را دو بار به ${path} بفرستید.`
                  : "همان اقدام موفق را دو بار انجام دهید.",
                "تعداد رکوردهای ساخته‌شده و پاسخ بار دوم را یادداشت کنید.",
              ],
              true,
            ),
            "انتظار: بار دوم رکورد اضافه یا وضعیت ناسازگار نسازد.",
          ].join("\n")
        : [
            "Precondition: one valid request that passes the main criterion.",
            "Steps:",
            numbered(
              [
                path
                  ? `Send that successful request to ${path} twice.`
                  : "Perform the same successful action twice.",
                "Record how many rows were created and what the second response says.",
              ],
              false,
            ),
            "Expected: the second call does not add a duplicate or an inconsistent state.",
          ].join("\n"),
    });
  }
  if (edges.length === 0 && criteria[0]) {
    edges.push({
      title: fa
        ? `${criteria[0].key} · ورودی خالی`
        : `${criteria[0].key} · empty input`,
      description: fa
        ? `قدم: فیلد اصلی «${clipSentence(criteria[0].text, 80)}» را خالی بفرستید.\nانتظار: رد شدن با خطای مشخص و بدون ذخیرهٔ موفق.`
        : `Step: send the main field of “${clipSentence(criteria[0].text, 80)}” empty.\nExpected: a clear rejection and no successful save.`,
    });
  }
  return edges.slice(0, 40);
}

export function designAutomation(
  criteria: DesignedCriterion[],
  locale: AppLocale,
) {
  const fa = locale === "fa";
  const cases = designTestCases(criteria, locale);
  if (criteria.length === 0) {
    return [
      {
        relatedTestCaseTitle: fa ? "کیسی نیست" : "No case",
        recommendedLevel: "MANUAL_ONLY" as const,
        apiUiRecommendation: "NONE" as const,
        reasoning: fa
          ? "معیاری برای اتوماسیون نیست."
          : "There is no criterion to automate.",
      },
    ];
  }
  return criteria.map((criterion) => {
    const positive = cases.find(
      (item) =>
        item.relatedAcceptanceCriteria.includes(criterion.key) &&
        item.tags.includes("positive"),
    );
    const script = readRule(criterion.text, locale);
    const api = script.paths.length > 0 || script.checks.length > 0;
    const assertText = script.given
      ? script.outcomes.join(fa ? "؛ " : "; ")
      : script.rule;
    return {
      relatedTestCaseTitle: positive?.title ?? criterion.key,
      recommendedLevel: api ? ("FULL" as const) : ("PARTIAL" as const),
      apiUiRecommendation: api ? ("API" as const) : ("BOTH" as const),
      reasoning: fa
        ? `تست «${positive?.title ?? criterion.key}» را خودکار کنید. بعد از اجرا این را ادعا کنید: ${clipSentence(assertText, 180)}`
        : `Automate “${positive?.title ?? criterion.key}”. After the call, assert: ${clipSentence(assertText, 180)}`,
    };
  });
}

function splitRaw(raw: string[]): string[] {
  const chunks: string[] = [];
  for (const rawLine of raw) {
    const broken = rawLine
      .replace(/[•●▪◦]/g, "\n- ")
      .replace(/\s+(?=\d{1,2}[.)]\s+)/g, "\n")
      .replace(/\s+(?=AC\s*-?\s*\d+\s*[:.)-])/gi, "\n");
    for (const piece of broken.split(/\n+/)) {
      for (const semi of piece.split(/\s*[;؛]\s*/)) {
        const text = semi
          .replace(/^[-*–—]\s+/, "")
          .replace(/^\d{1,2}[.)]\s+/, "")
          .replace(/^AC\s*-?\s*\d+\s*[:.)-]\s*/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if (text && !NOISE.test(text)) chunks.push(text);
      }
    }
  }
  return coalesceScenarios(coalesceGwt(chunks));
}

function coalesceGwt(parts: string[]): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  const isGwt =
    /^(given|when|then|and|but|با فرض|وقتی|آنگاه)(?:\s|$)/i;
  for (const part of parts) {
    if (isGwt.test(part)) {
      buffer.push(part);
      continue;
    }
    if (buffer.length > 0) {
      out.push(buffer.join(" "));
      buffer = [];
    }
    out.push(part);
  }
  if (buffer.length > 0) out.push(buffer.join(" "));
  return out;
}

/** A line ending with ":" is a scenario header. The following lines are its outcomes. */
function coalesceScenarios(parts: string[]): string[] {
  const out: string[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (header) {
      const head = header.replace(/[:：]\s*$/, "").trim();
      out.push(body.length > 0 ? `${head}: ${body.join(". ")}` : head);
    }
    header = null;
    body = [];
  };
  for (const part of parts) {
    if (/[:：]\s*$/.test(part)) {
      flush();
      header = part;
      continue;
    }
    if (header && isScenarioOutcome(part)) {
      body.push(part.replace(/[.。]\s*$/, "").trim());
      continue;
    }
    if (header) flush();
    out.push(part.replace(/[.。]\s*$/, "").trim());
  }
  flush();
  return out.filter(Boolean);
}

function isScenarioOutcome(line: string) {
  return (
    /^(?:پاسخ|درخواست|هیچ|مقدار)(?:\s|$)/.test(line) ||
    /^Reason دارای(?:\s|$)/.test(line) ||
    /^Backend\b/.test(line) ||
    /^(?:the|a|an|it|response|status)\s/i.test(line)
  );
}

function deriveFromTask(
  title: string,
  description: string,
  locale: AppLocale,
): string[] {
  const sentences = description
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?؟])\s+/)
    .map((sentence) => sentence.replace(/^[-*•]\s+/, "").trim())
    .filter((sentence) => sentence.length >= 12);
  const signal =
    /(must|should|shall|can|cannot|user|display|show|allow|prevent|return|save|update|delete|create|باید|نباید|بتواند|می‌تواند|نمایش|ذخیره|حذف|کاربر|سیستم)/i;
  const signaled = sentences.filter((sentence) => signal.test(sentence));
  const picked = (signaled.length > 0 ? signaled : sentences).slice(0, 6);
  if (picked.length > 0) {
    return dedupe(picked.map((sentence) => asStatement(sentence, locale)));
  }
  const fallback =
    languageOf(`${title}\n${description}`, locale) === "fa"
      ? `رفتار شرح‌داده‌شده برای «${title || "این تسک"}» مطابق توضیحات تسک انجام شود`
      : `The behavior described for “${title || "this task"}” works as specified in the task`;
  return [fallback];
}

/**
 * Normalize one criterion. The language is decided by the criterion's own
 * script, never by the UI locale: stored AC text must be identical whichever
 * language the user happens to generate in, and an English criterion must
 * never be prefixed with a Persian actor ("کاربر بتواند").
 */
function asStatement(text: string, locale: AppLocale): string {
  const compact = text.replace(/\s+/g, " ").replace(/[.。]+$/g, "").trim();
  if (languageOf(compact, locale) === "fa") {
    if (
      /^(اگر|چنانچه|وقتی|در صورتی|با فرض)\b/.test(compact) ||
      /(باید|نباید|بتواند|می‌تواند|کاربر|سیستم|وقتی|آنگاه|شود|شوند|نشود|بماند|برگردانده|کند|می‌شود|گردد)/.test(
        compact,
      )
    ) {
      return compact;
    }
    return `کاربر بتواند ${compact}`;
  }
  const sentence =
    compact.charAt(0).toUpperCase() + compact.slice(1);
  if (/^(The |A |An |User |System |When |Given |If )/i.test(sentence)) {
    return sentence;
  }
  if (/^(Can|Cannot|Must|Should)\b/.test(sentence)) {
    return `User ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
  }
  return sentence;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mentionsBoundary(text: string) {
  return /[A-Za-z_][\w]*\s*(?:<=|>=|<|>)\s*\d+/.test(text);
}

function positiveCase(
  criterion: DesignedCriterion,
  locale: AppLocale,
  priority: "CRITICAL" | "HIGH",
): DraftTestCase {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  const focus = script.given ?? script.rule;
  const condition = script.given?.replace(/^اگر\s+/, "");
  const steps = concreteSteps(script, "positive");
  const preconditions =
    script.inputs.length > 0 && script.paths.length > 0
      ? fa
        ? [
            `اندپوینت ${script.paths[0]} در دسترس است.`,
            `یک ${script.inputs[0]} معتبر و یک ${script.inputs[1]} معتبر آماده است.`,
          ]
        : [
            `${script.paths[0]} is available.`,
            `A valid ${script.inputs[0]} and a valid ${script.inputs[1]} are ready.`,
          ]
      : script.given
        ? [
            fa
              ? `این وضعیت را بسازید: ${condition}`
              : `Set up this situation: ${script.given}`,
          ]
        : [
            fa
              ? `قانونی که باید برقرار شود: ${script.rule}`
              : `Rule that must hold: ${script.rule}`,
          ];
  return {
    title: `${criterion.key} · ${fa ? "موفق" : "Positive"}: ${clipSentence(focus.replace(/^اگر\s+/, ""), 110)}`,
    description: script.rule,
    preconditions,
    steps,
    expectedResult: script.given ? script.outcomes.join(fa ? "؛ " : "; ") : script.rule,
    priority,
    type: "FUNCTIONAL",
    relatedAcceptanceCriteria: [criterion.key],
    tags: ["positive", criterion.key],
  };
}

function negativeCase(
  criterion: DesignedCriterion,
  locale: AppLocale,
): DraftTestCase {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  const condition = script.given?.replace(/^اگر\s+/, "") ?? script.rule;
  const steps = concreteSteps(script, "negative");
  return {
    title: `${criterion.key} · ${fa ? "ناموفق" : "Negative"}: ${clipSentence(
      script.inputs.length > 1
        ? fa
          ? `بدون ${script.inputs.join(" و بدون ")}`
          : `without ${script.inputs.join(" or ")}`
        : fa
          ? `وقتی «${condition}» برقرار نیست`
          : `when “${condition}” is not true`,
      110,
    )}`,
    description: fa
      ? `نقض این قانون: ${script.rule}`
      : `Break this rule: ${script.rule}`,
    preconditions: [
      script.inputs.length > 1
        ? fa
          ? `درخواستی بسازید که نه ${script.inputs[0]} دارد و نه ${script.inputs[1]}.`
          : `Prepare a request that has neither ${script.inputs[0]} nor ${script.inputs[1]}.`
        : fa
          ? `عمداً این شرط را نقض کنید: ${condition}`
          : `Deliberately break this condition: ${condition}`,
    ],
    steps,
    expectedResult:
      script.inputs.length > 1
        ? fa
          ? `درخواست پذیرفته نمی‌شود، چون نه ${script.inputs[0]} آمده و نه ${script.inputs[1]}.`
          : `The request is rejected because neither ${script.inputs[0]} nor ${script.inputs[1]} was sent.`
        : script.given
          ? fa
            ? `چون شرط برقرار نیست، این اتفاق نباید بیفتد: ${script.outcomes.join("؛ ")}`
            : `Because the condition is false, this must not happen: ${script.outcomes.join("; ")}`
          : fa
            ? `این قانون پاس نمی‌شود: ${script.rule}`
            : `This rule does not pass: ${script.rule}`,
    priority: "MEDIUM",
    type: "FUNCTIONAL",
    relatedAcceptanceCriteria: [criterion.key],
    tags: ["negative", criterion.key],
  };
}

function boundaryCase(
  criterion: DesignedCriterion,
  locale: AppLocale,
): DraftTestCase {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  const limits = boundaryLimits(criterion.text);
  const label = limits.map((item) => item.raw).join(fa ? "، " : ", ");
  return {
    title: `${criterion.key} · ${fa ? "مرز" : "Boundary"}: ${clipSentence(label || script.rule, 110)}`,
    description: fa
      ? `مقدار روی حد و یک واحد دو طرف آن برای: ${label}`
      : `The limit value and one step on each side for: ${label}`,
    preconditions: [
      fa
        ? `بقیه شرایط قانون ثابت بماند و فقط ${label} عوض شود.`
        : `Keep the rest of the rule fixed and change only ${label}.`,
    ],
    steps: limits.flatMap((item) =>
      fa
        ? [
            `${item.name} را برابر ${item.value} بگذارید و پاسخ را یادداشت کنید.`,
            `${item.name} را برابر ${item.below} بگذارید و پاسخ را یادداشت کنید.`,
            `${item.name} را برابر ${item.above} بگذارید و پاسخ را یادداشت کنید.`,
          ]
        : [
            `Set ${item.name} to ${item.value} and record the response.`,
            `Set ${item.name} to ${item.below} and record the response.`,
            `Set ${item.name} to ${item.above} and record the response.`,
          ],
    ),
    expectedResult: limits.map((item) => boundaryVerdict(criterion, item, locale)).join(fa ? " " : " "),
    priority: "MEDIUM",
    type: "EDGE",
    relatedAcceptanceCriteria: [criterion.key],
    tags: ["boundary", criterion.key],
  };
}

function readRule(text: string, locale: AppLocale) {
  const rule = text.replace(/^کاربر بتواند\s+/, "").trim();
  // `lang` is the OUTPUT language (the workspace locale), never the language
  // the source criterion happens to be written in.
  const lang = locale;
  const headed = rule.match(/^(اگر\s+.+?)\s*[:：]\s*(.+)$/s);
  const given = headed?.[1]?.trim() ?? null;
  const outcomes = (headed?.[2] ?? rule)
    .split(/\s*\.\s+/)
    .map((part) => part.replace(/[.。]\s*$/, "").trim())
    .filter(Boolean);
  return {
    lang,
    rule,
    given,
    outcomes: outcomes.length > 0 ? outcomes : [rule],
    paths: [...new Set([...rule.matchAll(/\/[A-Za-z0-9._~/-]+/g)].map((match) => match[0]))],
    checks: [
      ...rule.matchAll(/[A-Za-z_][\w]*\s*(?:<=|>=|<|>|=)\s*[^\s،,.]+/g),
    ].map((match) => match[0]),
    inputs: inputChoices(rule),
  };
}

function inputChoices(text: string) {
  const match = text.match(
    /(شماره\s+[\u0600-\u06FF]+|شناسه\s+[\u0600-\u06FF]+|ID\s+[\u0600-\u06FF]+)\s+یا\s+(شماره\s+[\u0600-\u06FF]+|شناسه\s+[\u0600-\u06FF]+|ID\s+[\u0600-\u06FF]+)/,
  );
  if (!match?.[1] || !match[2]) return [];
  return [match[1], match[2]];
}

function concreteSteps(
  script: ReturnType<typeof readRule>,
  kind: "positive" | "negative",
): string[] {
  const fa = script.lang === "fa";
  const path = script.paths[0];
  const condition = script.given?.replace(/^اگر\s+/, "");
  if (script.inputs.length > 1 && path) {
    return kind === "positive"
      ? fa
        ? [
            `یک درخواست با ${script.inputs[0]} معتبر به ${path} بفرستید.`,
            `همان درخواست را با ${script.inputs[1]} معتبر تکرار کنید.`,
            "هر دو درخواست باید به‌عنوان ورودی پذیرفته شوند.",
          ]
        : [
            `Send one request to ${path} with a valid ${script.inputs[0]}.`,
            `Repeat it with a valid ${script.inputs[1]}.`,
            "Both requests must be accepted as input.",
          ]
      : fa
        ? [
            `درخواست را بدون ${script.inputs[0]} و بدون ${script.inputs[1]} به ${path} بفرستید.`,
            "بررسی کنید درخواست به‌خاطر نبودن این ورودی رد شده است.",
          ]
        : [
            `Call ${path} with neither ${script.inputs[0]} nor ${script.inputs[1]}.`,
            "Confirm the request is rejected because that input is missing.",
          ];
  }
  if (kind === "positive") {
    return fa
      ? [
          ...(condition ? [`قبل از اجرا این شرط را برقرار کنید: ${condition}.`] : []),
          path
            ? `درخواست را به ${path} بفرستید.`
            : condition
              ? "اقدام را یک بار اجرا کنید و پاسخ را نگه دارید."
              : `این کار را انجام دهید: ${script.rule}`,
          condition
            ? `بررسی کنید این نتایج دیده شود: ${script.outcomes.join("؛ ")}.`
            : script.checks.length
              ? `در نتیجه این مقدارها را بخوانید: ${script.checks.join("، ")}.`
              : `خروجی باید این باشد: ${script.rule}`,
        ]
      : [
          ...(condition ? [`Before you run it, make this condition true: ${condition}.`] : []),
          path
            ? `Call ${path}.`
            : condition
              ? "Run the action once and keep the response."
              : `Do this: ${script.rule}`,
          condition
            ? `Confirm you see: ${script.outcomes.join("; ")}.`
            : script.checks.length
              ? `Read these values in the result: ${script.checks.join(", ")}.`
              : `The outcome must be: ${script.rule}`,
        ];
  }
  return condition
    ? fa
      ? [
          `قبل از اجرا این شرط را برقرار نکنید: ${condition}.`,
          path ? `درخواست را به ${path} بفرستید.` : "همان اقدام را اجرا کنید.",
          `بررسی کنید این نتایج دیده نشوند: ${script.outcomes.join("؛ ")}.`,
        ]
      : [
          `Before you run it, do not make this condition true: ${condition}.`,
          path ? `Call ${path}.` : "Run the same action.",
          `Confirm these outcomes do not appear: ${script.outcomes.join("; ")}.`,
        ]
    : fa
      ? [
          `خلاف این قانون عمل کنید: ${script.rule}`,
          "بررسی کنید سیستم آن را نپذیرفته و نتیجه موفق ذخیره نشده است.",
        ]
      : [
          `Do the opposite of this rule: ${script.rule}`,
          "Confirm the system rejects it and does not store a success.",
        ];
}

function languageOf(text: string, locale: AppLocale): AppLocale {
  if (/[\u0600-\u06FF]/.test(text)) return "fa";
  if (/[A-Za-z]/.test(text)) return "en";
  return locale;
}


function numbered(lines: string[], fa: boolean) {
  const digits = "۰۱۲۳۴۵۶۷۸۹";
  return lines
    .map((line, index) => {
      const n = String(index + 1).replace(/\d/g, (digit) =>
        fa ? digits[Number(digit)]! : digit,
      );
      return `${n}. ${line}`;
    })
    .join("\n");
}

function releaseMitigation(criterion: DesignedCriterion, locale: AppLocale) {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  if (script.given) {
    return fa
      ? `تست کنید: ${script.given.replace(/^اگر\s+/, "")}. اگر نتیجه این نبود، انتشار را متوقف کنید: ${script.outcomes.join("؛ ")}.`
      : `Test this: ${script.given}. Stop the release unless the result is: ${script.outcomes.join("; ")}.`;
  }
  return fa
    ? `تست کنید: ${script.rule} اگر این نتیجه دیده نشد، تسک به پروداکشن نرود.`
    : `Test this: ${script.rule} If that result is missing, do not ship.`;
}

function boundaryLimits(text: string) {
  return [...text.matchAll(/([A-Za-z_][\w]*)\s*(<=|>=|<|>)\s*(\d+)/g)].map((match) => {
    const name = match[1] ?? "";
    const op = match[2] ?? "<=";
    const value = Number(match[3]);
    return {
      raw: match[0],
      name,
      op,
      value,
      below: value - 1,
      above: value + 1,
    };
  });
}

function satisfiesLimit(op: string, candidate: number, value: number) {
  if (op === "<=") return candidate <= value;
  if (op === "<") return candidate < value;
  if (op === ">=") return candidate >= value;
  return candidate > value;
}

function boundaryVerdict(
  criterion: DesignedCriterion,
  limit: ReturnType<typeof boundaryLimits>[number],
  locale: AppLocale,
) {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  const probes = [limit.value, limit.below, limit.above];
  const on = probes.filter((candidate) => satisfiesLimit(limit.op, candidate, limit.value));
  const off = probes.filter((candidate) => !satisfiesLimit(limit.op, candidate, limit.value));
  const join = (values: number[]) => values.join(fa ? " یا " : " or ");
  const inCondition = Boolean(script.given?.includes(limit.raw));
  if (inCondition) {
    return fa
      ? `وقتی ${limit.name} برابر ${join(on)} است، شرط «${limit.raw}» برقرار است و باید ببینید: ${script.outcomes.join("؛ ")}. وقتی برابر ${join(off)} است، این شرط برقرار نیست و آن نتیجه نباید به‌خاطر این مقایسه دیده شود.`
      : `When ${limit.name} is ${join(on)}, “${limit.raw}” is true and you must see: ${script.outcomes.join("; ")}. When it is ${join(off)}, that condition is false and those outcomes must not appear because of this comparison.`;
  }
  return fa
    ? `${limit.name} را روی ${limit.value}، ${limit.below} و ${limit.above} با این قانون مقایسه کنید: ${clipSentence(script.rule, 180)}`
    : `Compare ${limit.name} at ${limit.value}, ${limit.below} and ${limit.above} with this rule: ${clipSentence(script.rule, 180)}`;
}

function plainEdge(criterion: DesignedCriterion, locale: AppLocale) {
  const script = readRule(criterion.text, locale);
  const fa = script.lang === "fa";
  const condition = script.given?.replace(/^اگر\s+/, "");
  const path = script.paths[0];
  if (condition) {
    return {
      title: fa
        ? `${criterion.key} · شرط برقرار و برقرار نیست`
        : `${criterion.key} · condition on and off`,
      description: fa
        ? [
            "پیش‌شرط: بقیهٔ سیستم آماده است و فقط همین شرط عوض می‌شود.",
            "قدم‌ها:",
            numbered(
              [
                `این شرط را برقرار کنید: ${condition}.`,
                path
                  ? `درخواست را به ${path} بفرستید و پاسخ را یادداشت کنید.`
                  : "اقدام را اجرا کنید و پاسخ را یادداشت کنید.",
                `همان کار را وقتی این شرط برقرار نیست تکرار کنید.`,
              ],
              true,
            ),
            `انتظار: فقط وقتی شرط برقرار است باید ببینید: ${script.outcomes.join("؛ ")}. وقتی برقرار نیست، آن نتیجه نباید دیده شود.`,
          ].join("\n")
        : [
            "Precondition: the rest of the system stays fixed and only this condition changes.",
            "Steps:",
            numbered(
              [
                `Make this condition true: ${condition}.`,
                path ? `Call ${path} and record the response.` : "Run the action and record the response.",
                "Repeat the same action while the condition is false.",
              ],
              false,
            ),
            `Expected: only while the condition is true you must see: ${script.outcomes.join("; ")}. While it is false, that result must not appear.`,
          ].join("\n"),
    };
  }
  return {
    title: fa
      ? `${criterion.key} · قانون و خلاف آن`
      : `${criterion.key} · the rule and its opposite`,
    description: fa
      ? [
          "پیش‌شرط: دادهٔ تست آماده است.",
          "قدم‌ها:",
          numbered(
            [
              path
                ? `درخواست را به ${path} بفرستید و نتیجه را با قانون مقایسه کنید.`
                : `این کار را انجام دهید و نتیجه را یادداشت کنید: ${clipSentence(script.rule, 140)}`,
              "خلاف همین قانون عمل کنید و پاسخ را یادداشت کنید.",
            ],
            true,
          ),
          `انتظار: قدم اول باید با این قانون جور باشد: ${clipSentence(script.rule, 160)} قدم دوم نباید به‌عنوان موفقیت ذخیره شود.`,
        ].join("\n")
      : [
          "Precondition: test data is ready.",
          "Steps:",
          numbered(
            [
              path
                ? `Call ${path} and compare the result with the rule.`
                : `Do this and record the result: ${clipSentence(script.rule, 140)}`,
              "Do the opposite of the same rule and record the response.",
            ],
            false,
          ),
          `Expected: the first step must match this rule: ${clipSentence(script.rule, 160)} The second step must not be stored as a success.`,
        ].join("\n"),
  };
}

function relatedCases(
  criterion: DesignedCriterion,
  locale: AppLocale,
): DraftTestCase[] {
  const text = criterion.text;
  const script = readRule(text, locale);
  const fa = script.lang === "fa";
  const extra: DraftTestCase[] = [];
  if (/(مجوز|دسترسی|نقش|permission|unauthor|forbidden|\brole\b)/i.test(text)) {
    extra.push({
      title: `${criterion.key} · ${fa ? "دسترسی" : "Permission"}: ${clipSentence(script.rule, 90)}`,
      description: fa
        ? `کاربر بدون مجوز نباید این رفتار را انجام دهد: ${script.rule}`
        : `A user without permission must not complete: ${script.rule}`,
      preconditions: [
        fa
          ? "یک کاربر واردشده که نقش مجاز این کار را ندارد."
          : "A signed-in user whose role is not allowed to perform this action.",
      ],
      steps: fa
        ? [
            "با همان کاربر غیرمجاز وارد شوید.",
            script.paths[0]
              ? `اقدام معیار را روی ${script.paths[0]} انجام دهید.`
              : "همان اقدام معیار را انجام دهید.",
            "پیام خطا و وضعیت ذخیره‌شده را یادداشت کنید.",
          ]
        : [
            "Sign in as that user.",
            script.paths[0]
              ? `Perform the criterion action on ${script.paths[0]}.`
              : "Perform the same action described by the criterion.",
            "Record the error message and whether any data changed.",
          ],
      expectedResult: fa
        ? "درخواست رد می‌شود، پیام دسترسی نمایش داده می‌شود و دادهٔ موفق ذخیره نمی‌شود."
        : "The action is rejected, an authorization message is shown, and no successful data is stored.",
      priority: "HIGH",
      type: "FUNCTIONAL",
      relatedAcceptanceCriteria: [criterion.key],
      tags: ["permission", criterion.key],
    });
  }
  if (/(خالی|الزام|نامعتبر|قالب|required|invalid|format|empty)/i.test(text)) {
    extra.push({
      title: `${criterion.key} · ${fa ? "اعتبارسنجی" : "Validation"}: ${clipSentence(script.rule, 90)}`,
      description: fa
        ? `ورودی نامعتبر یا خالی نباید به‌عنوان موفقیت پذیرفته شود: ${script.rule}`
        : `Empty or invalid input must not be accepted as success: ${script.rule}`,
      preconditions: [
        fa
          ? "بقیهٔ شرایط معتبر است و فقط ورودی مورد آزمون خالی یا خارج از قالب است."
          : "The rest of the setup is valid. Only the field under test is empty or the wrong format.",
      ],
      steps: fa
        ? [
            "فیلد مورد آزمون را خالی بگذارید و فرم یا درخواست را ارسال کنید.",
            "همان فیلد را با یک مقدار خارج از قالب پر کنید و دوباره ارسال کنید.",
            "بررسی کنید رکورد یا وضعیت موفق ساخته نشده است.",
          ]
        : [
            "Leave the field under test empty and submit the form or request.",
            "Fill the same field with a value in the wrong format and submit again.",
            "Confirm no successful record or status was stored.",
          ],
      expectedResult: fa
        ? "هر دو ارسال رد می‌شوند، خطای اعتبارسنجی مشخص است و دادهٔ ناقص ذخیره نمی‌شود."
        : "Both submissions are rejected with a clear validation error and no partial data is stored.",
      priority: "MEDIUM",
      type: "FUNCTIONAL",
      relatedAcceptanceCriteria: [criterion.key],
      tags: ["validation", criterion.key],
    });
  }
  if (
    extra.length === 0 &&
    /(خطا|شکست|رد شود|error|reject|\bfail)/i.test(text)
  ) {
    extra.push({
      title: `${criterion.key} · ${fa ? "خطا" : "Error"}: ${clipSentence(script.rule, 90)}`,
      description: fa
        ? `مسیر خطا باید نتیجهٔ قابل تشخیص داشته باشد: ${script.rule}`
        : `The error path must have a distinguishable result: ${script.rule}`,
      preconditions: [
        fa
          ? "شرایطی که این معیار را به شکست می‌رساند آماده است."
          : "The situation that makes this criterion fail is prepared.",
      ],
      steps: fa
        ? [
            "اقدام را در شرایط شکست اجرا کنید.",
            "کد، پیام یا وضعیت نمایش‌داده‌شده را یادداشت کنید.",
            "بررسی کنید وضعیت موفق ذخیره نشده است.",
          ]
        : [
            "Run the action in the failing situation.",
            "Record the code, message, or status that is shown.",
            "Confirm a successful state was not stored.",
          ],
      expectedResult: fa
        ? "شکست با پیام یا وضعیت مشخص دیده می‌شود و نتیجهٔ موفق ذخیره نمی‌شود."
        : "The failure is visible as a specific message or status, and success is not stored.",
      priority: "MEDIUM",
      type: "FUNCTIONAL",
      relatedAcceptanceCriteria: [criterion.key],
      tags: ["error", criterion.key],
    });
  }
  return extra;
}

function attachDetail(item: DraftTestCase, locale: AppLocale): DesignedTestCase {
  const fa = locale === "fa";
  return {
    ...item,
    testData: collectTestData(item),
    stepExpectations: item.steps.map((step, index) =>
      expectationFor(step, item.expectedResult, index === item.steps.length - 1, fa),
    ),
  };
}

function expectationFor(
  step: string,
  finalExpected: string,
  isLast: boolean,
  fa: boolean,
): string {
  if (isLast) return finalExpected;
  const path = step.match(/(\/[A-Za-z0-9._~/-]+)/)?.[1];
  if (path && /(بفرستید|Call |انجام دهید|Perform )/i.test(step)) {
    return fa
      ? `درخواست به ${path} ارسال می‌شود و پاسخی برای بررسی برمی‌گردد.`
      : `The request is sent to ${path} and a response comes back to inspect.`;
  }
  if (/(قبل از اجرا|Sign in|وارد شوید|برقرار کنید|do not make|برقرار نکنید)/i.test(step)) {
    return fa
      ? "شرایط این قدم برقرار است و می‌توان قدم بعد را اجرا کرد."
      : "The setup for this step is in place and the next step can run.";
  }
  if (/(برابر|Set .+ to)/i.test(step)) {
    return fa
      ? "مقدار پذیرفته می‌شود و پاسخ برای مقایسه با حد معیار ثبت می‌شود."
      : "The value is accepted and the response is recorded for comparison with the limit.";
  }
  if (/(خالی|wrong format|خارج از قالب)/i.test(step)) {
    return fa
      ? "ورودی نامعتبر پذیرفته نمی‌شود و خطای اعتبارسنجی دیده می‌شود."
      : "The invalid input is not accepted and a validation error is shown.";
  }
  return fa
    ? `این قدم انجام می‌شود: ${clipSentence(step, 140)}`
    : `This step is completed: ${clipSentence(step, 140)}`;
}

function collectTestData(item: DraftTestCase): string[] {
  const blob = [...item.preconditions, ...item.steps, item.expectedResult].join("\n");
  const found = new Set<string>();
  for (const match of blob.matchAll(/\/[A-Za-z0-9._~/-]+/g)) found.add(match[0]);
  for (const match of blob.matchAll(/\b[A-Za-z_][\w]*\s*(?:<=|>=|<|>|=)\s*[^\s،,.;]+/g)) {
    found.add(match[0]);
  }
  return [...found].slice(0, 8);
}

function normalizeBehavior(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/\b(the|a|an|this|that|and|or)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipSentence(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}
