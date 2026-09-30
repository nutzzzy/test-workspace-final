import type { AppLocale } from "../ai/localize-fa";
import type { Gap, InferredAc, RequirementUnderstanding } from "../qa-engine/pipeline";

/**
 * Contextual requirement questions and suggested acceptance criteria.
 *
 * Each detector looks for one specific kind of missing information in THIS
 * requirement (title + description + acceptance criteria) and asks only when
 * it is really absent. Questions name the requirement's own operation,
 * entity, state and fields. Nothing is generated to fill a section: a
 * well-specified requirement yields few or no questions.
 */

export type QuestionCategory = "product" | "developer" | "business";

export type AnalysisQuestion = {
  question: string;
  category: QuestionCategory;
  /** Why it is asked: the gap in this requirement. */
  reason: string;
  /** Detector or pipeline gap id, for traceability. */
  source: string;
};

export type SuggestedCriterion = { text: string; reason: string; source: string };

export type RequirementGapAnalysis = {
  questions: AnalysisQuestion[];
  suggestedCriteria: SuggestedCriterion[];
};

const FAILURE =
  /\b(fail\w*|error\w*|timeout|time[sd]? out|unavailable|reject\w*|invalid|rollback|roll back|[45]\d\d)\b|خطا|ناموفق|شکست|رد شود|رد می|نامعتبر|تایم‌?اوت|در دسترس نباشد|قطع شود|برگشت/i;
const ERROR_CONTRACT = /\b[45]\d\d\b|status code|error code|error message|کد خطا|کد وضعیت|پیام خطا/i;
const AUTH = /\b(role|permission|authori[sz]\w*|admin\w*|access|allowed|only\b[^.]*\bcan)\b|نقش|دسترسی|مجوز|مجاز|ادمین|فقط\s/i;
const DUPLICATE = /\b(duplicate\w*|idempoten\w*|twice|again|already exists|unique)\b|تکرار|دوباره|یکتا|دو بار/i;
const EXISTING = /\b(existing|already|previous(ly)?|legacy|migrat\w*|backfill\w*|historical)\b|قبلی|موجود|از قبل|سابق|مهاجرت/i;
const MUTATION =
  /\b(create[sd]?|register\w*|activat\w*|update[sd]?|submit\w*|save[sd]?|delete[sd]?|approve[sd]?|cancel\w*)\b|ایجاد|ثبت|فعال|به‌روز|ذخیره|حذف|ساخته|تأیید|تایید|لغو/i;
const INTEGRATION =
  /\b(verif\w*|integration|external|third[- ]party|provider|callback|webhook|sms|e-?mail|payment|gateway)\b|احراز|سرویس|یکپارچه|پیامک|ایمیل|پرداخت|درگاه/i;
const NEW_RULE = /\b(after|when|once|from now|new|whenever)\b|بعد از|پس از|وقتی|هنگامی|جدید|هر زمان/i;
const STATE_WORD = /\b(ACTIVE|INACTIVE|APPROVED|PENDING|REJECTED|ACTIVATED|VERIFIED)\b|فعال شد|تأیید شد/i;
const FIELD_RULES = /\b(format|length|pattern|regex|max\w*|min\w*|characters?|digits?)\b|فرمت|طول|کاراکتر|حداکثر|حداقل|رقم/i;
const VAGUE_EN = /\b(fast|quickly|appropriate(ly)?|properly|user[- ]friendly|reasonable|as soon as possible|immediately|sufficient)\b/i;
const VAGUE_FA = /(سریع|مناسب|به‌درستی|در اسرع وقت|کافی)/;

/** Generic questions that never help a tester; removed even if produced. */
const FILLER =
  /^(does (this|the) feature work|what is the expected behaviou?r\??|has (this|it) been tested|are there (any )?other requirements|آیا این قابلیت درست کار می‌کند|رفتار مورد انتظار چیست|آیا تست شده است|آیا نیاز دیگری وجود دارد)/i;

type Context = {
  fa: boolean;
  blob: string;
  entity: string;
  operation: string;
  state: string | null;
  from: string | null;
  mutating: boolean;
};

function contextOf(
  title: string,
  description: string,
  criteria: Array<{ text: string }>,
  understanding: RequirementUnderstanding,
  locale: AppLocale,
): Context {
  const fa = locale === "fa";
  const blob = [title, description, ...criteria.map((item) => item.text)].join("\n");
  const endpoint = understanding.endpoint;
  const transition = understanding.transitions[0] ?? null;
  const stateMatch = blob.match(STATE_WORD)?.[0] ?? null;
  const entity = understanding.actors[0] ?? (fa ? "رکورد" : "record");
  const operation = endpoint
    ? `${endpoint.method} ${endpoint.path}`
    : understanding.trigger ?? (fa ? `«${title}»` : `“${title}”`);
  const mutating = endpoint ? endpoint.method !== "GET" : MUTATION.test(blob);
  return {
    fa,
    blob,
    entity,
    operation,
    state: transition?.to ?? stateMatch,
    from: transition?.from ?? null,
    mutating,
  };
}

export function analyzeRequirementGaps(input: {
  title: string;
  description: string;
  criteria: Array<{ key: string; text: string; origin?: string }>;
  understanding: RequirementUnderstanding;
  gaps: Gap[];
  inferred: InferredAc[];
  locale: AppLocale;
}): RequirementGapAnalysis {
  const c = contextOf(input.title, input.description, input.criteria, input.understanding, input.locale);
  const { fa } = c;
  const questions: AnalysisQuestion[] = [];
  const suggested: SuggestedCriterion[] = [];
  const ask = (category: QuestionCategory, source: string, question: string, reason: string) =>
    questions.push({ category, source, question, reason });
  const suggest = (source: string, text: string, reason: string) => suggested.push({ source, text, reason });

  // Failure behaviour of an operation that changes state or calls another system.
  if ((c.mutating || INTEGRATION.test(c.blob) || input.understanding.endpoint) && !FAILURE.test(c.blob)) {
    const after = c.state
      ? fa
        ? ` پس از اینکه ${c.entity} به وضعیت ${c.state} رفته است`
        : ` after the ${c.entity} has already moved to ${c.state}`
      : "";
    ask(
      "developer",
      "failure-behaviour",
      fa
        ? `اگر ${c.operation}${after} با خطا یا تایم‌اوت روبه‌رو شود، تغییر باید برگردانده شود، باقی بماند یا به یک وضعیت میانی برود؟ فراخوان چه پاسخی می‌گیرد؟`
        : `If ${c.operation} fails or times out${after}, should the change be rolled back, kept, or moved to an intermediate state, and what does the caller receive?`,
      fa
        ? `برای ${c.operation} هیچ رفتاری در زمان خطا یا تایم‌اوت تعریف نشده است.`
        : `No failure or timeout behaviour is defined for ${c.operation}.`,
    );
    suggest(
      "failure-behaviour",
      fa
        ? `اگر ${c.operation} ناموفق شود، ${c.entity} در وضعیت قبلی${c.from ? ` (${c.from})` : ""} می‌ماند و خطای مشخصی برگردانده می‌شود.`
        : `When ${c.operation} fails, the ${c.entity} stays in its previous state${c.from ? ` (${c.from})` : ""} and a defined error is returned.`,
      fa ? "مسیر شکست در معیارها نیست." : "The failure path is missing from the criteria.",
    );
  }

  // Error contract of an API whose failures are mentioned but not specified.
  const endpoint = input.understanding.endpoint;
  if (endpoint && FAILURE.test(c.blob) && !ERROR_CONTRACT.test(c.blob)) {
    const field = input.understanding.required[0];
    const when = field
      ? fa
        ? `${field} وارد نشده یا نامعتبر است`
        : `${field} is missing or invalid`
      : fa
        ? "درخواست نامعتبر است"
        : "the request is invalid";
    ask(
      "developer",
      "error-contract",
      fa
        ? `وقتی ${when}، ${endpoint.method} ${endpoint.path} باید چه کد HTTP و چه بدنهٔ خطایی برگرداند؟`
        : `Which HTTP status and error body should ${endpoint.method} ${endpoint.path} return when ${when}?`,
      fa ? "به شکست اشاره شده، اما کد و پیام خطا مشخص نیست." : "Failure is mentioned, but the status code and error body are not specified.",
    );
  }

  // Who may perform a state-changing operation.
  if (c.mutating && !AUTH.test(c.blob) && input.understanding.authRules.length === 0) {
    ask(
      "business",
      "authorization",
      fa
        ? `چه نقش یا کاربرانی اجازهٔ ${c.operation} را برای ${c.entity} دارند و بقیه در صورت تلاش چه می‌بینند؟`
        : `Which roles or users may perform ${c.operation} for a ${c.entity}, and what do others see if they try?`,
      fa ? "هیچ نقش یا مجوزی برای این عملیات ذکر نشده است." : "No role or permission is stated for this operation.",
    );
    suggest(
      "authorization",
      fa
        ? `فقط نقش مجاز می‌تواند ${c.operation} را انجام دهد و درخواست دیگران با خطای مشخص رد می‌شود.`
        : `Only the authorized role can perform ${c.operation}; other callers are rejected with a defined error.`,
      fa ? "کنترل دسترسی در معیارها نیست." : "Authorization is missing from the criteria.",
    );
  }

  // A new rule tied to a state: what about records already in that state?
  if (c.state && NEW_RULE.test(c.blob) && !EXISTING.test(c.blob)) {
    ask(
      "business",
      "existing-records",
      fa
        ? `برای ${c.entity}هایی که پیش از انتشار این تغییر در وضعیت ${c.state} بوده‌اند، رفتار جدید هم اعمال شود یا فقط برای ${c.entity}هایی که از این به بعد ${c.state} می‌شوند؟`
        : `For ${c.entity}s that were already ${c.state} before this change is released, should the new behaviour apply to them too, or only to ${c.entity}s that become ${c.state} afterwards?`,
      fa
        ? `نیازمندی نمی‌گوید با ${c.entity}هایی که از قبل ${c.state} هستند چه شود.`
        : `The requirement does not say how existing ${c.entity}s already ${c.state} are handled.`,
    );
    suggest(
      "existing-records",
      fa
        ? `تکلیف ${c.entity}هایی که پیش از انتشار ${c.state} بوده‌اند مشخص است (شامل یا مستثنا).`
        : `The behaviour for ${c.entity}s already ${c.state} before release is defined (included or excluded).`,
      fa ? "سازگاری با داده‌های موجود تعریف نشده است." : "Backward compatibility with existing records is undefined.",
    );
  }

  // Repeating a state-changing request.
  if (c.mutating && !DUPLICATE.test(c.blob)) {
    ask(
      "developer",
      "duplicate-request",
      fa
        ? `اگر همان درخواست ${c.operation} دو بار ارسال شود (مثلاً تکرار پس از تایم‌اوت)، درخواست دوم ${c.entity} جدیدی بسازد، نتیجهٔ قبلی را برگرداند یا رد شود؟`
        : `If the same ${c.operation} request is sent twice (for example a retry after a timeout), should the second call create another ${c.entity}, return the existing result, or be rejected?`,
      fa ? "رفتار درخواست تکراری مشخص نیست." : "Duplicate-request behaviour is not defined.",
    );
    suggest(
      "duplicate-request",
      fa
        ? `ارسال دوبارهٔ همان ${c.operation} ${c.entity} تکراری نمی‌سازد.`
        : `Sending the same ${c.operation} again does not create a duplicate ${c.entity}.`,
      fa ? "رفتار درخواست تکراری در معیارها نیست." : "Duplicate-request behaviour is missing from the criteria.",
    );
  }

  // Required inputs without format/length rules (at most two fields).
  if (!FIELD_RULES.test(c.blob) && input.understanding.limits.length === 0) {
    for (const field of input.understanding.required.slice(0, 2)) {
      ask(
        "developer",
        `field-rules:${field}`,
        fa
          ? `چه فرمت و طولی برای ${field} معتبر است و در صورت نقض چه خطایی برگردانده می‌شود؟`
          : `What format and length are valid for ${field}, and which error is returned when it is violated?`,
        fa ? `${field} اجباری است، اما قاعدهٔ اعتبارسنجی آن نوشته نشده است.` : `${field} is required, but its validation rule is not written.`,
      );
    }
  }

  // Unmeasurable wording.
  const vague = [...new Set([...(c.blob.match(new RegExp(VAGUE_EN, "gi")) ?? []), ...(c.blob.match(new RegExp(VAGUE_FA, "g")) ?? [])])];
  for (const word of vague.slice(0, 2)) {
    const owner = input.criteria.find((item) => item.text.includes(word))?.key;
    const where = owner ?? (fa ? "توضیحات" : "the description");
    ask(
      "product",
      `vague:${word.toLowerCase()}`,
      fa ? `چه مقدار قابل اندازه‌گیری‌ای «${word}» را در ${where} تعریف می‌کند؟` : `What measurable value defines “${word}” in ${where}?`,
      fa ? `«${word}» بدون معیار قابل سنجش آمده است.` : `“${word}” has no measurable threshold.`,
    );
  }

  // Specific gaps detected by the pipeline (channels, displayed fields).
  for (const gap of input.gaps) {
    if (gap.id === "GAP-ERROR") continue; // covered by the error-contract detector
    ask("product", gap.id, gap.clarification, gap.description);
  }

  // No official criteria: the derived ones must be confirmed, not assumed.
  if (input.criteria.length > 0 && input.criteria.every((item) => item.origin === "derived")) {
    ask(
      "product",
      "derived-criteria",
      fa
        ? "این ایشو در Jira معیار پذیرش ندارد. آیا معیارهای استخراج‌شده از توضیحات را تأیید می‌کنید یا اصلاح می‌شوند؟"
        : "The Jira issue has no acceptance criteria. Do you confirm the criteria derived from the description, or should they change?",
      fa ? "معیارها از توضیحات استخراج شده‌اند و رسمی نیستند." : "The criteria were derived from the description and are not official.",
    );
  }

  for (const item of input.inferred) suggest(item.id, item.text, item.reason);

  return {
    questions: dedupeQuestions(questions),
    suggestedCriteria: dedupeBy(suggested, (item) => item.text),
  };
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Drop filler, exact duplicates and near-paraphrases (token Jaccard ≥ 0.8). */
export function dedupeQuestions(items: AnalysisQuestion[]): AnalysisQuestion[] {
  const out: AnalysisQuestion[] = [];
  for (const item of items) {
    const text = item.question.trim();
    if (!text || FILLER.test(text)) continue;
    if (out.some((kept) => kept.source === item.source || similarity(kept.question, text) >= 0.8)) continue;
    out.push({ ...item, question: text });
  }
  return out;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item).trim().toLowerCase();
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
