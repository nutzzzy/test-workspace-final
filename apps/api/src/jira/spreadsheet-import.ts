export type SpreadsheetIssueRow = {
  key: string;
  title: string;
  description: string;
  issueType?: string;
  priority?: string;
  labels: string[];
  acceptanceCriteria: string[];
};

const KEY_ALIASES = ["key", "issue_key", "issuekey", "کلید", "شناسه"];
const TITLE_ALIASES = ["title", "summary", "عنوان", "خلاصه"];
const DESC_ALIASES = ["description", "desc", "شرح", "توضیحات"];
const TYPE_ALIASES = ["issue_type", "issuetype", "type", "نوع"];
const PRIORITY_ALIASES = ["priority", "اولویت"];
const LABELS_ALIASES = ["labels", "tags", "برچسب", "لیبل"];
const AC_ALIASES = [
  "acceptance_criteria",
  "acceptancecriteria",
  "ac",
  "معیارهای_پذیرش",
  "معیار پذیرش",
  "acceptance",
];

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function pick(
  row: Record<string, unknown>,
  aliases: string[],
): string {
  const normalizedAliases = new Set(aliases.map((a) => normalizeHeader(a)));
  for (const [k, v] of Object.entries(row)) {
    if (normalizedAliases.has(normalizeHeader(k)) && v != null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return "";
}

function splitList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n|\||;/)
    .map((part) => part.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function splitLabels(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[,|;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function rowsToIssues(
  rows: Record<string, unknown>[],
): SpreadsheetIssueRow[] {
  const issues: SpreadsheetIssueRow[] = [];
  for (const row of rows) {
    const key = pick(row, KEY_ALIASES).toUpperCase();
    const title = pick(row, TITLE_ALIASES);
    if (!key || !title) continue;
    issues.push({
      key,
      title,
      description: pick(row, DESC_ALIASES),
      issueType: pick(row, TYPE_ALIASES) || undefined,
      priority: pick(row, PRIORITY_ALIASES) || undefined,
      labels: splitLabels(pick(row, LABELS_ALIASES)),
      acceptanceCriteria: splitList(pick(row, AC_ALIASES)),
    });
  }
  return issues;
}

export const SPREADSHEET_TEMPLATE_HEADERS = [
  "key",
  "title",
  "description",
  "issue_type",
  "priority",
  "labels",
  "acceptance_criteria",
] as const;

export const SPREADSHEET_TEMPLATE_SAMPLE = [
  "QA-101",
  "User can cancel an order",
  "As a customer I want to cancel my order",
  "Story",
  "High",
  "orders,payments",
  "User can cancel in CREATED status\nRefund is issued when paid\nUser receives confirmation",
] as const;
