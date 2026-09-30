export type AppLocale = "fa" | "en";

export function normalizeLocale(value: unknown): AppLocale {
  return value === "en" ? "en" : "fa";
}

/** Best-effort localization of imported English requirement text for FA UI. */
export function localizeTextToFa(input: string): string {
  let text = input.trim();
  if (!text) return text;

  const phraseMap: Array<[RegExp, string]> = [
    [
      /Calculate and Store Cumulative Balance for Biker Transactions/gi,
      "محاسبه و ذخیره موجودی تجمعی برای تراکنش‌های بایکر",
    ],
    [
      /As a Biker Transaction system,?\s*I want to calculate and store the cumulative_balance whenever a new Biker transaction is created,?\s*so that the current balance of each Biker can be determined directly from the transaction records without recalculating all previous transactions/gi,
      "به عنوان سیستم تراکنش بایکر، می‌خواهم هر زمان تراکنش جدید برای بایکر ایجاد شد، موجودی_تجمعی محاسبه و ذخیره شود تا موجودی فعلی هر بایکر مستقیماً از رکورد تراکنش‌ها بدون محاسبه مجدد تمام تراکنش‌های قبلی قابل تعیین باشد",
    ],
    [
      /Create the first transaction for a Biker/gi,
      "ایجاد اولین تراکنش برای یک بایکر",
    ],
    [
      /Create a new transaction for a Biker with previous transactions/gi,
      "ایجاد تراکنش جدید برای بایکری که تراکنش قبلی دارد",
    ],
    [
      /the Biker has no previous transactions/gi,
      "بایکر هیچ تراکنش قبلی ندارد",
    ],
    [
      /a new transaction is created for the Biker/gi,
      "تراکنش جدیدی برای بایکر ایجاد می‌شود",
    ],
    [
      /the system should calculate the cumulative balance based on the new transaction amount/gi,
      "سیستم باید موجودی تجمعی را بر اساس مبلغ تراکنش جدید محاسبه کند",
    ],
    [
      /the calculated cumulative balance should be stored in the new transaction record/gi,
      "موجودی تجمعی محاسبه‌شده باید در رکورد تراکنش جدید ذخیره شود",
    ],
    [
      /the Biker has a previous transaction with a known cumulative_balance/gi,
      "بایکر تراکنش قبلی با موجودی_تجمعی مشخص دارد",
    ],
    [
      /a new transaction is created for the same Biker/gi,
      "تراکنش جدیدی برای همان بایکر ایجاد می‌شود",
    ],
  ];

  for (const [pattern, replacement] of phraseMap) {
    text = text.replace(pattern, replacement);
  }

  const replacements: Array<[RegExp, string]> = [
    [/^Acceptance Criteria\s*$/i, "معیار پذیرش"],
    [/^Scenario\s*(\d+)\s*:?\s*/i, "سناریو $1: "],
    [/^Scenario\s*:?\s*/i, "سناریو: "],
    [/^Given:?\s*/i, "با فرض اینکه: "],
    [/^When:?\s*/i, "هنگامی که: "],
    [/^Then:?\s*/i, "آنگاه: "],
    [/^And:?\s*/i, "و: "],
    [/^But:?\s*/i, "اما: "],
    [/^As an?\s+/i, "به عنوان "],
    [/^As a\s+/i, "به عنوان یک "],
    [/\bI want to\b/gi, "می‌خواهم"],
    [/\bso that\b/gi, "تا اینکه"],
    [/\bCalculate and Store\b/gi, "محاسبه و ذخیره"],
    [/\bCumulative Balance\b/gi, "موجودی تجمعی"],
    [/\bBiker Transactions?\b/gi, "تراکنش‌های بایکر"],
    [/\bBiker\b/gi, "بایکر"],
    [/\btransaction(s)?\b/gi, "تراکنش$1"],
    [/\bcumulative balance\b/gi, "موجودی تجمعی"],
    [/\bcreated\b/gi, "ایجاد شود"],
    [/\bstored\b/gi, "ذخیره شود"],
    [/\bcalculate(d|s)?\b/gi, "محاسبه$1"],
    [/\bprevious\b/gi, "قبلی"],
    [/\bnew\b/gi, "جدید"],
    [/\bfirst\b/gi, "اولین"],
    [/\bsystem\b/gi, "سیستم"],
    [/\bshould\b/gi, "باید"],
    [/\bwithout\b/gi, "بدون"],
    [/\brecalculating\b/gi, "محاسبه مجدد"],
    [/\brecord(s)?\b/gi, "رکورد$1"],
    [/\bamount\b/gi, "مبلغ"],
    [/\bknown\b/gi, "مشخص"],
    [/\bsame\b/gi, "همان"],
    [/\bfor the\b/gi, "برای"],
    [/\bwith a\b/gi, "با یک"],
    [/\bhas no\b/gi, "هیچ"],
    [/\bhas a\b/gi, "دارای"],
    [/\bbased on\b/gi, "بر اساس"],
    [/\bin the\b/gi, "در"],
    [/\bof each\b/gi, "هر"],
    [/\bcan be determined\b/gi, "قابل تعیین باشد"],
    [/\bdirectly from\b/gi, "مستقیماً از"],
    [/\ball previous\b/gi, "تمام موارد قبلی"],
    [/\bwhenever\b/gi, "هر زمان که"],
    [/\bCreate the\b/gi, "ایجاد "],
    [/\bCreate a\b/gi, "ایجاد یک "],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  // Text that could not be translated is returned as-is. It is never
  // prefixed with a "localized version" label, which would claim a
  // translation that did not happen and would stack on repeated calls.
  return text;
}

export function localizeIssueContentToFa(input: {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}): { title: string; description: string; acceptanceCriteria: string[] } {
  return {
    title: localizeTextToFa(input.title),
    description: localizeTextToFa(input.description),
    acceptanceCriteria: input.acceptanceCriteria.map(localizeTextToFa),
  };
}
