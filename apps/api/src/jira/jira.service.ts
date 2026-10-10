import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NormalizedJiraIssue } from "@qa-workbench/shared";
import * as XLSX from "xlsx";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../common/crypto.util";
import { syncAcceptanceCriteria } from "../analysis/acceptance-sync";
import { createJiraAdapter, JIRA_TIMEOUT_MS } from "./jira.adapter";
import {
  noteDocument,
  testCaseContentHash,
  testCaseDocument,
} from "./test-case-document";
import {
  rowsToIssues,
  SPREADSHEET_TEMPLATE_HEADERS,
  SPREADSHEET_TEMPLATE_SAMPLE,
  type SpreadsheetIssueRow,
} from "./spreadsheet-import";

function importedCriteria(texts: string[]) {
  return texts.map((text, index) => ({
    key: `AC-${index + 1}`,
    text,
    orderIndex: index,
    origin: "imported",
  }));
}

@Injectable()
export class JiraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private encryptionKey() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  async getConfigPublic() {
    const cfg = await this.prisma.jiraConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (!cfg) return null;
    return {
      id: cfg.id,
      baseUrl: cfg.baseUrl,
      email: cfg.email,
      projectKey: cfg.projectKey,
      hasToken: Boolean(cfg.apiTokenEnc),
      updatedAt: cfg.updatedAt,
    };
  }

  async upsertConfig(input: {
    baseUrl: string;
    email: string;
    apiToken?: string;
    projectKey?: string;
  }) {
    const existing = await this.prisma.jiraConfig.findFirst({ orderBy: { updatedAt: "desc" } });
    const apiToken = typeof input.apiToken === "string" ? input.apiToken.trim() : "";
    // The stored token is never sent back to the client, so an update may omit
    // it to keep the current one. A first-time setup must provide it.
    if (!input.baseUrl || !input.email || (!apiToken && !existing)) {
      throw new BadRequestException("baseUrl, email and apiToken are required");
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.baseUrl.trim());
    } catch {
      throw new BadRequestException("Jira base URL must be a valid http(s) URL");
    }
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      throw new BadRequestException("Jira base URL must be a valid http(s) URL");
    }
    const enc = apiToken ? encryptSecret(apiToken, this.encryptionKey()) : undefined;
    if (existing) {
      return this.prisma.jiraConfig.update({
        where: { id: existing.id },
        data: {
          baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
          email: input.email.trim(),
          ...(enc ? { apiTokenEnc: enc } : {}),
          projectKey: input.projectKey || null,
        },
      });
    }
    if (!enc) throw new BadRequestException("baseUrl, email and apiToken are required");
    return this.prisma.jiraConfig.create({
      data: {
        baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
        email: input.email.trim(),
        apiTokenEnc: enc,
        projectKey: input.projectKey || null,
      },
    });
  }

  private async getCredentials() {
    const cfg = await this.prisma.jiraConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (!cfg) {
      throw new BadRequestException("Jira is not configured");
    }
    return {
      baseUrl: cfg.baseUrl,
      email: cfg.email,
      apiToken: decryptSecret(cfg.apiTokenEnc, this.encryptionKey()),
    };
  }

  async upsertNormalizedIssue(issue: NormalizedJiraIssue | SpreadsheetIssueRow) {
    if (typeof issue.key !== "string" || typeof issue.title !== "string") {
      throw new BadRequestException("key and title are required");
    }
    const key = issue.key.trim().toUpperCase();
    if (!key || !issue.title.trim()) {
      throw new BadRequestException("key and title are required");
    }

    const acceptanceCriteria = issue.acceptanceCriteria ?? [];
    const labels = issue.labels ?? [];
    const linkedIssues =
      "linkedIssues" in issue ? (issue.linkedIssues ?? []) : [];

    const existing = await this.prisma.jiraIssue.findUnique({ where: { key } });

    if (existing) {
      // Re-import updates criteria in place so unchanged criteria keep their
      // ids and every test-case coverage link survives.
      await this.prisma.$transaction(async (tx) => {
        await tx.jiraIssue.update({
          where: { id: existing.id },
          data: {
            title: issue.title,
            description: issue.description ?? "",
            issueType: issue.issueType,
            priority: issue.priority,
            labels,
            rawAcceptanceText: acceptanceCriteria.join("\n"),
            linkedIssuesJson: linkedIssues,
          },
        });
        await syncAcceptanceCriteria(tx, existing.id, importedCriteria(acceptanceCriteria));
      });
      return this.getIssue(existing.id);
    }

    const created = await this.prisma.jiraIssue.create({
      data: {
        key,
        title: issue.title,
        description: issue.description ?? "",
        issueType: issue.issueType,
        priority: issue.priority,
        labels,
        rawAcceptanceText: acceptanceCriteria.join("\n"),
        linkedIssuesJson: linkedIssues,
        acceptanceCriteria: {
          create: acceptanceCriteria.map((text, index) => ({
            key: `AC-${index + 1}`,
            text,
            orderIndex: index,
          })),
        },
      },
    });
    return this.getIssue(created.id);
  }

  async createManualIssue(input: {
    key: string;
    title: string;
    description?: string;
    issueType?: string;
    priority?: string;
    labels?: string[];
    acceptanceCriteria?: string[];
  }) {
    // "Create" must not silently replace an existing issue (and its title,
    // description and criteria); editing goes through updateIssue.
    const key = typeof input.key === "string" ? input.key.trim().toUpperCase() : "";
    if (key && (await this.prisma.jiraIssue.findUnique({ where: { key } }))) {
      throw new BadRequestException("Issue key already exists");
    }
    return this.upsertNormalizedIssue({
      key: input.key,
      title: input.title,
      description: input.description ?? "",
      issueType: input.issueType,
      priority: input.priority,
      labels: input.labels ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      linkedIssues: [],
    });
  }

  async importFromSpreadsheet(buffer: Buffer, filename: string) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException("Spreadsheet has no sheets");
    }
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    const parsed = rowsToIssues(rows);
    if (parsed.length === 0) {
      throw new BadRequestException(
        "No valid rows found. Need at least key + title columns.",
      );
    }

    const imported = [];
    for (const row of parsed) {
      imported.push(await this.upsertNormalizedIssue(row));
    }

    return {
      filename,
      importedCount: imported.length,
      keys: imported.map((i) => i.key),
      issues: imported,
    };
  }

  buildTemplateBuffer(format: "csv" | "xlsx" = "xlsx") {
    const rows: string[][] = [
      [...SPREADSHEET_TEMPLATE_HEADERS],
      [...SPREADSHEET_TEMPLATE_SAMPLE],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "issues");
    const bookType = format === "csv" ? "csv" : "xlsx";
    return XLSX.write(book, { type: "buffer", bookType }) as Buffer;
  }

  async importIssue(key: string) {
    const normalizedKey = key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalizedKey)) {
      throw new BadRequestException("Invalid issue key format");
    }

    const credentials = await this.getCredentials();
    const adapter = createJiraAdapter(credentials);
    const issue = await adapter.fetchIssue(normalizedKey);
    return this.upsertNormalizedIssue(issue);
  }

  async updateIssue(
    id: string,
    input: {
      key: string;
      title: string;
      description?: string;
      priority?: string;
      acceptanceCriteria?: string[];
    },
  ) {
    const existing = await this.prisma.jiraIssue.findUnique({
      where: { id },
      include: { acceptanceCriteria: { orderBy: { orderIndex: "asc" } } },
    });
    if (!existing) throw new NotFoundException("Issue not found");

    const key = input.key.trim().toUpperCase();
    const title = input.title.trim();
    if (!key || !title) {
      throw new BadRequestException("key and title are required");
    }
    if (!/^[A-Z][A-Z0-9]*-[A-Z0-9]+$/.test(key)) {
      throw new BadRequestException("Invalid issue key format");
    }
    if (key !== existing.key) {
      const clash = await this.prisma.jiraIssue.findUnique({ where: { key } });
      if (clash) throw new BadRequestException("Issue key already exists");
    }

    const acceptanceCriteria = (input.acceptanceCriteria ?? [])
      .map((text) => text.trim())
      .filter(Boolean);
    const currentTexts = existing.acceptanceCriteria.map((item) => item.text);
    const criteriaChanged =
      currentTexts.length !== acceptanceCriteria.length ||
      currentTexts.some((text, index) => text !== acceptanceCriteria[index]);

    await this.prisma.$transaction(async (tx) => {
      await tx.jiraIssue.update({
        where: { id },
        data: {
          key,
          title,
          description: input.description ?? "",
          priority: input.priority?.trim() || null,
          rawAcceptanceText: acceptanceCriteria.join("\n"),
        },
      });
      if (criteriaChanged) {
        await syncAcceptanceCriteria(tx, id, importedCriteria(acceptanceCriteria));
      }
    });
    return this.getIssue(id);
  }

  async deleteIssue(id: string) {
    const existing = await this.prisma.jiraIssue.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Issue not found");

    await this.prisma.$transaction(async (tx) => {
      const cases = await tx.testCase.findMany({
        where: { jiraIssueId: id },
        select: { id: true },
      });
      const caseIds = cases.map((item) => item.id);
      await tx.bug.deleteMany({
        where: {
          OR: [
            { jiraIssueId: id },
            ...(caseIds.length ? [{ testCaseId: { in: caseIds } }] : []),
          ],
        },
      });
      await tx.testCase.deleteMany({ where: { jiraIssueId: id } });
      await tx.jiraIssue.delete({ where: { id } });
    });

    return { deleted: true, id, key: existing.key };
  }

  async listIssues() {
    return this.prisma.jiraIssue.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        acceptanceCriteria: { orderBy: { orderIndex: "asc" } },
        _count: { select: { testCases: true, risks: true, bugs: true } },
      },
    });
  }

  async getIssue(idOrKey: string) {
    const issue = await this.prisma.jiraIssue.findFirst({
      where: {
        OR: [{ id: idOrKey }, { key: idOrKey.toUpperCase() }],
      },
      include: {
        acceptanceCriteria: { orderBy: { orderIndex: "asc" } },
        requirementAnalysis: true,
        testStrategy: true,
        testCases: {
          include: {
            acceptanceLinks: { include: { acceptanceCriterion: true } },
            runs: { orderBy: { executedAt: "desc" }, take: 20 },
          },
          orderBy: { createdAt: "asc" },
        },
        edgeCases: { orderBy: { createdAt: "asc" } },
        risks: {
          orderBy: [{ releaseBlocking: "desc" }, { createdAt: "asc" }],
        },
        automationCandidates: { orderBy: { createdAt: "asc" } },
        bugs: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!issue) throw new NotFoundException("Issue not found");
    return issue;
  }

  async syncTestCases(issueId: string, testCaseIds?: string[]) {
    const issue = await this.prisma.jiraIssue.findFirst({
      where: { OR: [{ id: issueId }, { key: issueId.toUpperCase() }] },
    });
    if (!issue) throw new NotFoundException("Issue not found");

    const ids = [...new Set((testCaseIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const cases = await this.prisma.testCase.findMany({
      where: {
        jiraIssueId: issue.id,
        ...(ids.length > 0 ? { id: { in: ids } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    if (cases.length === 0) {
      throw new BadRequestException("Select at least one test case");
    }
    if (ids.length > 0 && cases.length !== ids.length) {
      throw new BadRequestException("Select at least one test case");
    }

    await this.getCredentials();

    const results: Array<{
      id: string;
      title: string;
      status: "SYNCED" | "SYNC_FAILED" | "SKIPPED";
      message?: string;
    }> = [];

    for (const testCase of cases) {
      const hash = testCaseContentHash(testCase);
      if (
        testCase.jiraSyncStatus === "SYNCED" &&
        testCase.jiraSyncHash === hash &&
        testCase.jiraCommentId
      ) {
        results.push({ id: testCase.id, title: testCase.title, status: "SKIPPED" });
        continue;
      }
      try {
        const commentId = await this.publishComment(
          issue.key,
          testCase.jiraCommentId,
          testCaseDocument(testCase),
        );
        await this.prisma.testCase.update({
          where: { id: testCase.id },
          data: {
            jiraSyncStatus: "SYNCED",
            jiraSyncedAt: new Date(),
            jiraSyncHash: hash,
            jiraSyncError: null,
            jiraCommentId: commentId,
          },
        });
        results.push({ id: testCase.id, title: testCase.title, status: "SYNCED" });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Jira issue could not be updated.";
        await this.prisma.testCase.update({
          where: { id: testCase.id },
          data: {
            jiraSyncStatus: "SYNC_FAILED",
            jiraSyncError: message.slice(0, 240),
          },
        });
        results.push({
          id: testCase.id,
          title: testCase.title,
          status: "SYNC_FAILED",
          message,
        });
      }
    }

    return { issueKey: issue.key, results };
  }

  async notifyIssue(issueId: string, lines: string[]) {
    const issue = await this.prisma.jiraIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new NotFoundException("Issue not found");
    await this.publishComment(issue.key, null, noteDocument(lines));
    return { ok: true };
  }

  private async publishComment(
    issueKey: string,
    commentId: string | null,
    body: Record<string, unknown>,
  ): Promise<string> {
    try {
      return await this.writeComment(issueKey, commentId, body);
    } catch (error) {
      if (commentId && error instanceof JiraHttpError && error.status === 404) {
        return this.writeComment(issueKey, null, body);
      }
      throw error;
    }
  }

  private async writeComment(
    issueKey: string,
    commentId: string | null,
    body: Record<string, unknown>,
  ): Promise<string> {
    const credentials = await this.getCredentials();
    const base = credentials.baseUrl.replace(/\/$/, "");
    const path = commentId
      ? `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`
      : `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const auth = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString(
      "base64",
    );
    const response = await fetch(`${base}${path}`, {
      method: commentId ? "PUT" : "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
      // A hung Jira must not block bug edits or sync indefinitely.
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new JiraHttpError(response.status);
    }
    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new JiraHttpError(502);
    return data.id;
  }
}

class JiraHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? "You do not have permission to perform this action."
        : "Jira issue could not be updated.",
    );
  }
}
