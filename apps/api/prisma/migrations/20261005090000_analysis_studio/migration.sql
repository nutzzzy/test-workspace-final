-- Analysis studio: AI connections, PRD documents, learning from user feedback,
-- and richer AI-generated artifacts. Additive only; existing rows keep working.

CREATE TABLE "issue_documents" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PRD',
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "issue_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "issue_documents_jiraIssueId_idx" ON "issue_documents"("jiraIssueId");
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ai_connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL DEFAULT '',
    "allowExternal" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "contextTokens" INTEGER NOT NULL DEFAULT 16384,
    "reasoning" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "artifact" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "jiraIssueId" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "before" JSONB,
    "after" JSONB,
    "learned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_feedback_artifact_createdAt_idx" ON "ai_feedback"("artifact", "createdAt");

CREATE TABLE "ai_guidelines" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "feedbackIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_guidelines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "acceptance_criteria" ADD COLUMN "evidence" TEXT NOT NULL DEFAULT '';
ALTER TABLE "acceptance_criteria" ADD COLUMN "confidence" TEXT;
ALTER TABLE "acceptance_criteria" ADD COLUMN "rationale" TEXT NOT NULL DEFAULT '';
ALTER TABLE "acceptance_criteria" ADD COLUMN "category" TEXT;

ALTER TABLE "requirement_analyses" ADD COLUMN "understanding" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "edge_cases" ADD COLUMN "rationale" TEXT NOT NULL DEFAULT '';
ALTER TABLE "edge_cases" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "edge_cases" ADD COLUMN "ruleRefs" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "edge_cases" ADD COLUMN "acceptanceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "automation_candidates" ADD COLUMN "prerequisites" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "automation_candidates" ADD COLUMN "tooling" TEXT NOT NULL DEFAULT '';
