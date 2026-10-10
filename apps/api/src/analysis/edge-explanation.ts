import type { AppLocale } from "../ai/localize-fa";
import type { StudioUnderstanding } from "./studio/pipeline";

export type EdgeExplanation = {
  /** Kept for the web client: a run would fill the list. */
  wouldGenerate: number;
  reasons: string[];
  suggestions: string[];
};

/**
 * Why the edge-case list is empty: what the last analysis run did for edge
 * cases, and which kinds of detail the understanding of this requirement
 * lacks. Nothing is guessed.
 */
export function explainNoEdgeCases(input: {
  run: { edges: { state: string; error?: string } | null; dropped: number; current: boolean } | null;
  understanding: StudioUnderstanding | null;
  aiReady: boolean;
  locale: AppLocale;
}): EdgeExplanation {
  const fa = input.locale === "fa";
  const say = (en: string, persian: string) => (fa ? persian : en);
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const run = input.run;

  if (!run || !run.edges) {
    reasons.push(
      input.aiReady
        ? say("Edge cases have not been analysed for this issue yet.", "حالات مرزی این ایشو هنوز تحلیل نشده‌اند.")
        : say("No AI service is set up, so edge cases cannot be analysed.", "هیچ سرویس هوش مصنوعی‌ای تنظیم نشده و حالات مرزی قابل تحلیل نیستند."),
    );
    suggestions.push(
      input.aiReady
        ? say("Use “Generate edge cases”, or run the full analysis.", "«تولید حالات مرزی» را بزنید یا تحلیل کامل را اجرا کنید.")
        : say("Add an AI service under Settings → AI.", "از تنظیمات ← هوش مصنوعی یک سرویس اضافه کنید."),
    );
    return { wouldGenerate: 0, reasons, suggestions };
  }
  if (run.edges.state === "failed") {
    reasons.push(
      say(
        `The last run could not analyse edge cases: ${run.edges.error ?? "the AI service failed"}.`,
        `آخرین اجرا نتوانست حالات مرزی را تحلیل کند: ${run.edges.error ?? "سرویس هوش مصنوعی خطا داد"}.`,
      ),
    );
    suggestions.push(say("Check the AI service in Settings and run it again.", "سرویس هوش مصنوعی را در تنظیمات بررسی کنید و دوباره اجرا کنید."));
  } else if (run.dropped > 0) {
    reasons.push(
      say(
        `Edge cases were proposed, but the review removed all ${run.dropped} of them as not supported by the requirement text.`,
        `حالات مرزی پیشنهاد شدند، اما بازبینی همهٔ ${run.dropped} مورد را چون در متن نیازمندی پشتوانه نداشتند حذف کرد.`,
      ),
    );
  } else {
    reasons.push(
      say(
        "The analysis found no edge case that this requirement makes real (only edge cases tied to the source text are listed).",
        "تحلیل هیچ حالت مرزی‌ای پیدا نکرد که این نیازمندی واقعاً ایجاد کند (فقط حالاتی آورده می‌شوند که به متن نیازمندی گره خورده باشند).",
      ),
    );
  }
  if (!run.current) {
    reasons.push(say("The issue or its documents changed after that run.", "ایشو یا اسناد آن بعد از آن اجرا تغییر کرده‌اند."));
    suggestions.push(say("Run the analysis again.", "تحلیل را دوباره اجرا کنید."));
  }

  // What would give edge cases something to work with.
  const understanding = input.understanding;
  if (understanding && Array.isArray(understanding.configurations)) {
    if (understanding.configurations.length === 0 && (understanding.calculations ?? []).length === 0) {
      suggestions.push(
        say(
          "State the limits and configurable values (maximums, minimums, counts, time windows); boundaries come from them.",
          "محدودیت‌ها و مقادیر قابل تنظیم (حداکثر، حداقل، تعداد، بازهٔ زمانی) را مشخص کنید؛ حالات مرزی از آن‌ها ساخته می‌شوند.",
        ),
      );
    }
    if ((understanding.transitions ?? []).length === 0) {
      suggestions.push(say("Describe the statuses and which actions are allowed in each.", "وضعیت‌ها و اینکه در هر وضعیت چه کاری مجاز است را توضیح دهید."));
    }
    if ((understanding.apis ?? []).length > 0 && understanding.apis.every((api) => api.responses.length === 0)) {
      suggestions.push(say("Document the error responses of the APIs.", "پاسخ‌های خطای APIها را مستند کنید."));
    }
  }
  suggestions.push(
    say(
      "Attach the PRD if there is one — it usually holds the business rules edge cases come from.",
      "اگر PRD دارید پیوست کنید — معمولاً قواعد کسب‌وکاری که حالات مرزی از آن‌ها می‌آیند آنجاست.",
    ),
  );
  return { wouldGenerate: 0, reasons, suggestions: [...new Set(suggestions)] };
}
