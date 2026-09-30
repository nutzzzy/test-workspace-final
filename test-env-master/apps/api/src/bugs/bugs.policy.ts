export const BUG_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "REOPENED",
] as const;

export type BugStatus = (typeof BUG_STATUSES)[number];

const TRANSITIONS: Record<BugStatus, BugStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["RESOLVED", "OPEN", "CLOSED"],
  RESOLVED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
};

export function isBugStatus(value: string): value is BugStatus {
  return (BUG_STATUSES as readonly string[]).includes(value);
}

export function assertStatusTransition(from: string, to: string): void {
  if (!isBugStatus(from) || !isBugStatus(to) || !TRANSITIONS[from].includes(to)) {
    throw new Error("This status change is not allowed.");
  }
}

const LEVELS = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export function assertLevel(value: string, label: string): void {
  if (!LEVELS.has(value)) {
    throw new Error(`${label} is invalid`);
  }
}

export function cleanAuthor(value: string | undefined): string {
  const author = (value ?? "").trim();
  if (!author) return "QA";
  return author.slice(0, 80);
}

export function statusDetail(from: string, to: string): string {
  return `changed status from ${from} to ${to}`;
}
