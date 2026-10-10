-- Shared requirement intelligence and test-case design metadata.

ALTER TABLE "test_cases" ADD COLUMN "designStatus" TEXT NOT NULL DEFAULT 'AI_DRAFT';
ALTER TABLE "test_cases" ADD COLUMN "technique" TEXT NOT NULL DEFAULT '';
ALTER TABLE "test_cases" ADD COLUMN "conditionKey" TEXT;
ALTER TABLE "test_cases" ADD COLUMN "postconditions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "test_cases" ADD COLUMN "assumptions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "test_cases" ADD COLUMN "gapRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "test_cases" ADD COLUMN "automationSuitability" TEXT;
ALTER TABLE "test_cases" ADD COLUMN "automationNotes" TEXT NOT NULL DEFAULT '';

CREATE TABLE "requirement_profiles" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "intelligence" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirement_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "requirement_profiles_jiraIssueId_key" ON "requirement_profiles"("jiraIssueId");

ALTER TABLE "requirement_profiles"
ADD CONSTRAINT "requirement_profiles_jiraIssueId_fkey"
FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
