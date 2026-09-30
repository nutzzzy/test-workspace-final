-- Additive lifecycle fields. Existing rows keep their data.

ALTER TABLE "database_connectors" ADD COLUMN "lastTestStatus" TEXT;
ALTER TABLE "database_connectors" ADD COLUMN "lastTestedAt" TIMESTAMP(3);
ALTER TABLE "database_connectors" ADD COLUMN "lastTestMessage" TEXT;

ALTER TABLE "test_cases" ADD COLUMN "testData" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "test_cases" ADD COLUMN "stepExpectations" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "test_cases" ADD COLUMN "jiraSyncStatus" TEXT NOT NULL DEFAULT 'NOT_SYNCED';
ALTER TABLE "test_cases" ADD COLUMN "jiraSyncedAt" TIMESTAMP(3);
ALTER TABLE "test_cases" ADD COLUMN "jiraSyncHash" TEXT;
ALTER TABLE "test_cases" ADD COLUMN "jiraSyncError" TEXT;
ALTER TABLE "test_cases" ADD COLUMN "jiraCommentId" TEXT;

ALTER TABLE "bugs" ADD COLUMN "scenarioRunId" TEXT;
ALTER TABLE "bugs" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "bugs" ADD COLUMN "assignee" TEXT;
ALTER TABLE "bugs" ADD COLUMN "reporter" TEXT NOT NULL DEFAULT 'QA';

CREATE TABLE "bug_comments" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bug_activities" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bug_comments_bugId_createdAt_idx" ON "bug_comments"("bugId", "createdAt");
CREATE INDEX "bug_activities_bugId_createdAt_idx" ON "bug_activities"("bugId", "createdAt");

ALTER TABLE "bug_comments" ADD CONSTRAINT "bug_comments_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "bugs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bug_activities" ADD CONSTRAINT "bug_activities_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "bugs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
