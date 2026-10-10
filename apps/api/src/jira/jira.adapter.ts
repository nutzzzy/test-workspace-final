import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { NormalizedJiraIssue } from "@qa-workbench/shared";

export type JiraCredentials = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export interface JiraAdapter {
  fetchIssue(key: string): Promise<NormalizedJiraIssue>;
}

const AC_SECTION =
  /acceptance\s*criteria[:\s]*([\s\S]*?)(?=\n#{1,3}\s|\n[A-Z][a-z]+ ?:|\n---|\n\*\*[A-Z]|$)/i;

function extractAcceptanceCriteria(description: string): string[] {
  const fromSection = description.match(AC_SECTION)?.[1] ?? description;
  const lines = fromSection
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((l) => l.length > 3);

  const unique = [...new Set(lines)].slice(0, 30);
  if (unique.length > 0) return unique;
  return description.trim() ? [description.trim().slice(0, 500)] : [];
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export const JIRA_TIMEOUT_MS = 15_000;

/**
 * Translate a Jira HTTP status into an error the user can act on. The
 * response body is not included: it can echo request details and is not
 * needed to explain the failure.
 */
export function jiraHttpError(status: number, key: string): HttpException {
  if (status === 404) {
    return new NotFoundException(
      `Jira issue ${key} was not found, or the configured account cannot see it.`,
    );
  }
  if (status === 401) {
    return new BadRequestException(
      "Jira rejected the credentials. Check the email and API token in Settings.",
    );
  }
  if (status === 403) {
    return new BadRequestException(
      "The Jira account does not have permission for this issue or project.",
    );
  }
  if (status === 429) {
    return new ServiceUnavailableException("Jira is rate limiting requests. Try again in a minute.");
  }
  return new ServiceUnavailableException(`Jira returned an error (HTTP ${status}). Try again later.`);
}

export class HttpJiraAdapter implements JiraAdapter {
  constructor(private readonly credentials: JiraCredentials) {}

  async fetchIssue(key: string): Promise<NormalizedJiraIssue> {
    const base = this.credentials.baseUrl.replace(/\/$/, "");
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,priority,labels,issuelinks`;
    const auth = Buffer.from(
      `${this.credentials.email}:${this.credentials.apiToken}`,
    ).toString("base64");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Jira could not be reached. Check the Jira base URL and your network connection.",
      );
    }

    if (!response.ok) throw jiraHttpError(response.status, key);

    const data = (await response.json()) as {
      key: string;
      fields: {
        summary?: string;
        description?: unknown;
        issuetype?: { name?: string };
        priority?: { name?: string };
        labels?: string[];
        issuelinks?: Array<{
          type?: { name?: string };
          inwardIssue?: { key?: string; fields?: { summary?: string } };
          outwardIssue?: { key?: string; fields?: { summary?: string } };
        }>;
      };
    };

    const description = normalizeDescription(data.fields.description);
    const linkedIssues: NormalizedJiraIssue["linkedIssues"] = [];
    for (const link of data.fields.issuelinks ?? []) {
      const issue = link.outwardIssue ?? link.inwardIssue;
      if (issue?.key) {
        linkedIssues.push({
          key: issue.key,
          type: link.type?.name,
          summary: issue.fields?.summary,
        });
      }
    }

    return {
      key: data.key,
      title: data.fields.summary ?? key,
      description,
      issueType: data.fields.issuetype?.name,
      priority: data.fields.priority?.name,
      labels: data.fields.labels ?? [],
      acceptanceCriteria: extractAcceptanceCriteria(description),
      linkedIssues,
    };
  }
}

function normalizeDescription(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return stripHtml(description);
  // ADF (Atlassian Document Format) — flatten text nodes
  try {
    const texts: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text" && n.text) texts.push(n.text);
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(description);
    return texts.join(" ").trim();
  } catch {
    return "";
  }
}

export function createJiraAdapter(credentials: JiraCredentials): JiraAdapter {
  return new HttpJiraAdapter(credentials);
}

export { extractAcceptanceCriteria };
