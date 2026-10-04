import type { AppLocale } from "../ai/localize-fa";
import type { PipelineResult } from "../qa-engine/pipeline";
import type { DeepAnalysis } from "./deep-analysis";

export type EdgeExplanation = {
  /** Why this requirement produced no edge cases, most important first. */
  reasons: string[];
  /** What would let the analysis find some. */
  suggestions: string[];
};

/**
 * Why the edge-case list is empty, in terms of THIS requirement: each kind of
 * edge case the analysis can produce is listed with the detail it was missing.
 * Nothing here guesses; it reports what the rule engine and the AI analysis
 * did and did not find.
 */
export function explainNoEdgeCases(input: {
  result: PipelineResult;
  deep: Pick<DeepAnalysis, "testCases" | "dropped"> | null;
  aiReady: boolean;
  locale: AppLocale;
}): EdgeExplanation {
  const fa = input.locale === "fa";
  const facts = input.result.understanding;
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const say = (en: string, persian: string) => (fa ? persian : en);

  if (input.result.testCases.some((item) => item.partition === "insufficient")) {
    reasons.push(
      say(
        "The requirement does not describe an executable action with an observable result, so no case — normal or edge — could be designed from it.",
        "نیازمندی کنش قابل اجرا و نتیجهٔ قابل مشاهده‌ای توصیف نمی‌کند؛ بنابراین هیچ کیسی (عادی یا مرزی) از آن طراحی نشد.",
      ),
    );
  }
  const text = facts.text;
  const mentions = (pattern: RegExp) => pattern.test(text);
  /**
   * Each kind of edge case: present in the text but not recognised by the
   * rules (a deep analysis can use it), or simply not described.
   */
  const kind = (spec: { found: boolean; mentioned: boolean; absent: [string, string]; unrecognised: [string, string]; suggestion?: [string, string] }) => {
    if (spec.found) return;
    if (spec.mentioned) {
      reasons.push(say(...spec.unrecognised));
      unrecognised = true;
      return;
    }
    reasons.push(say(...spec.absent));
    if (spec.suggestion) suggestions.push(say(...spec.suggestion));
  };
  let unrecognised = false;

  kind({
    found: facts.limits.length > 0,
    mentioned:
      // Persian and Arabic-Indic digits count too: "حداکثر ۳۰ کاراکتر".
      /[0-9۰-۹٠-٩]/.test(text) &&
      mentions(/(at (most|least)|maximum|minimum|\bmax\b|\bmin\b|up to|between|more than|less than|exceed|characters?|digits?|length|حداکثر|حداقل|بیشتر از|کمتر از|بیش از|کاراکتر|رقم|طول|بین)/i),
    absent: [
      "No numeric limit is given (minimum, maximum, length, count or amount), so there are no boundary values to test.",
      "هیچ محدودیت عددی (حداقل، حداکثر، طول، تعداد یا مبلغ) ذکر نشده؛ بنابراین مقدار مرزی‌ای برای آزمون وجود ندارد.",
    ],
    unrecognised: [
      "The text mentions a numeric limit, but the rule engine could not turn it into boundary values.",
      "متن به یک محدودیت عددی اشاره می‌کند، اما موتور قاعده‌محور نتوانست از آن مقدار مرزی بسازد.",
    ],
    suggestion: ["State the allowed ranges of the inputs (e.g. amount 1,000–5,000,000).", "بازهٔ مجاز ورودی‌ها را مشخص کنید (مثلاً مبلغ بین ۱٬۰۰۰ تا ۵٬۰۰۰٬۰۰۰)."],
  });
  kind({
    found: facts.required.length > 0 || facts.optional.length > 0,
    mentioned: mentions(/(required|mandatory|optional|must (be )?(provided|entered|filled)|الزامی|اجباری|اختیاری|باید وارد)/i),
    absent: [
      "No required or optional fields are named, so missing or empty input cannot be tested.",
      "هیچ فیلد الزامی یا اختیاری نام برده نشده؛ بنابراین ورودی ناقص یا خالی قابل آزمون نیست.",
    ],
    unrecognised: [
      "The text says some input is required or optional, but the rule engine could not tell which fields.",
      "متن می‌گوید ورودی‌ای الزامی یا اختیاری است، اما موتور قاعده‌محور تشخیص نداد کدام فیلدها.",
    ],
    suggestion: ["List the input fields and which of them are required.", "فیلدهای ورودی و الزامی بودن هر کدام را فهرست کنید."],
  });
  kind({
    found: Boolean(facts.uniqueField || facts.table),
    mentioned: mentions(/(unique|duplicate|already exists|twice|یکتا|تکراری|دو بار|از قبل وجود)/i),
    absent: [
      "No uniqueness rule or stored record is described, so duplicate-data cases do not apply.",
      "هیچ قاعدهٔ یکتایی یا رکورد ذخیره‌شده‌ای توصیف نشده؛ بنابراین کیس دادهٔ تکراری مطرح نیست.",
    ],
    unrecognised: [
      "The text mentions uniqueness or duplicates, but the rule engine could not tell which field must be unique.",
      "متن به یکتایی یا تکرار اشاره می‌کند، اما موتور قاعده‌محور تشخیص نداد کدام فیلد باید یکتا باشد.",
    ],
  });
  kind({
    found: Boolean(facts.searchBy || facts.filterBy || facts.sortBy),
    mentioned: mentions(/(search|filter|sort|جستجو|فیلتر|مرتب)/i),
    absent: ["There is no search, filter or sort, so no empty-result case applies.", "جستجو، فیلتر یا مرتب‌سازی‌ای وجود ندارد؛ بنابراین کیس «بدون نتیجه» مطرح نیست."],
    unrecognised: [
      "The text mentions search, filter or sort, but not the field it works on.",
      "متن به جستجو، فیلتر یا مرتب‌سازی اشاره می‌کند، اما فیلد آن را مشخص نکرده است.",
    ],
  });
  kind({
    found: Boolean(facts.payment.failure || facts.payment.retry || facts.payment.success),
    mentioned: mentions(/(payment|transaction|refund|پرداخت|تراکنش|بازپرداخت|استرداد)/i),
    absent: ["No payment or transaction failure/retry is described.", "شکست یا تلاش دوبارهٔ پرداخت و تراکنشی توصیف نشده است."],
    unrecognised: [
      "The text involves a payment or transaction, but not what happens when it fails or is retried.",
      "متن با پرداخت یا تراکنش سروکار دارد، اما نگفته در صورت شکست یا تلاش دوباره چه اتفاقی می‌افتد.",
    ],
  });
  if (!facts.errorStatus && facts.gaps.some((gap) => gap.id === "GAP-ERROR")) {
    reasons.push(
      say(
        "Failure behaviour is mentioned but its contract (status or message) is not defined, so negative cases would have to guess the result.",
        "رفتار خطا ذکر شده ولی قرارداد آن (کد وضعیت یا پیام) مشخص نیست؛ کیس منفی ناچار به حدس زدن نتیجه می‌شد.",
      ),
    );
    suggestions.push(say("Define the error status and message for invalid input.", "کد وضعیت و پیام خطا برای ورودی نامعتبر را مشخص کنید."));
  }

  if (unrecognised && !input.deep) {
    suggestions.unshift(
      say(
        "Run the deep AI analysis: it reads the text itself and can design edge cases from the details above.",
        "تحلیل عمیق هوش مصنوعی را اجرا کنید: متن را خودش می‌خواند و می‌تواند از جزئیات بالا حالت مرزی طراحی کند.",
      ),
    );
  }
  if (!input.deep) {
    reasons.push(
      input.aiReady
        ? say(
            "Only the rule-based engine has analysed this requirement; a deep AI analysis can find edge cases the rules cannot.",
            "این نیازمندی فقط با موتور قاعده‌محور تحلیل شده؛ تحلیل عمیق هوش مصنوعی می‌تواند حالت‌های مرزی‌ای پیدا کند که قاعده‌ها نمی‌بینند.",
          )
        : say(
            "AI analysis is not set up, so only the rule-based engine looked for edge cases.",
            "هوش مصنوعی تنظیم نشده و فقط موتور قاعده‌محور به‌دنبال حالت‌های مرزی گشت.",
          ),
    );
    if (!unrecognised || !input.aiReady) suggestions.push(
      input.aiReady
        ? say("Run “Persian analysis” or “English analysis” on the Overview tab.", "از زبانهٔ نمای کلی «تحلیل فارسی» یا «تحلیل انگلیسی» را اجرا کنید.")
        : say("Set up an AI service in Settings, then run the analysis again.", "در تنظیمات یک سرویس هوش مصنوعی وصل کنید و دوباره تحلیل را اجرا کنید."),
    );
  } else if (input.deep.dropped.testCases > 0) {
    reasons.push(
      say(
        `The AI analysis proposed cases, but its review removed ${input.deep.dropped.testCases} of them as unsupported by the requirement text.`,
        `تحلیل هوش مصنوعی کیس‌هایی پیشنهاد داد، اما بازبینی ${input.deep.dropped.testCases} مورد را چون در متن نیازمندی پشتوانه نداشتند حذف کرد.`,
      ),
    );
  } else {
    reasons.push(
      say(
        "The AI analysis did not find an edge case supported by the requirement text.",
        "تحلیل هوش مصنوعی هیچ حالت مرزی‌ای با پشتوانهٔ متن نیازمندی پیدا نکرد.",
      ),
    );
  }

  return { reasons, suggestions: [...new Set(suggestions)] };
}
