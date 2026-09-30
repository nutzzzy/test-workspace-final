-- CreateTable
CREATE TABLE "jira_configs" (
    "id" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "apiTokenEnc" TEXT NOT NULL,
    "projectKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "jira_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jira_issues" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "issueType" TEXT,
    "priority" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rawAcceptanceText" TEXT,
    "linkedIssuesJson" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "jira_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jira_issues_key_key" ON "jira_issues"("key");

CREATE TABLE "acceptance_criteria" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acceptance_criteria_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acceptance_criteria_jiraIssueId_key_key" ON "acceptance_criteria"("jiraIssueId", "key");

CREATE TABLE "requirement_analyses" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "acceptanceCriteria" JSONB NOT NULL,
    "gaps" JSONB NOT NULL,
    "ambiguities" JSONB NOT NULL,
    "missingScenarios" JSONB NOT NULL,
    "potentialRisks" JSONB NOT NULL,
    "questionsProduct" JSONB NOT NULL,
    "questionsDeveloper" JSONB NOT NULL,
    "questionsBusiness" JSONB NOT NULL,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "requirement_analyses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "requirement_analyses_jiraIssueId_key" ON "requirement_analyses"("jiraIssueId");

CREATE TABLE "test_strategies" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "objectives" JSONB NOT NULL,
    "testTypes" JSONB NOT NULL,
    "environments" JSONB NOT NULL,
    "dependencies" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_strategies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "test_strategies_jiraIssueId_key" ON "test_strategies"("jiraIssueId");

CREATE TABLE "test_cases" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "preconditions" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "expectedResult" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "type" TEXT NOT NULL DEFAULT 'FUNCTIONAL',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "automationStatus" TEXT NOT NULL DEFAULT 'NOT_AUTOMATED',
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "test_case_acceptance_criteria" (
    "testCaseId" TEXT NOT NULL,
    "acceptanceCriterionId" TEXT NOT NULL,
    CONSTRAINT "test_case_acceptance_criteria_pkey" PRIMARY KEY ("testCaseId","acceptanceCriterionId")
);

CREATE TABLE "edge_cases" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "edge_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "risks" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "likelihood" TEXT NOT NULL,
    "mitigation" TEXT NOT NULL,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_candidates" (
    "id" TEXT NOT NULL,
    "jiraIssueId" TEXT NOT NULL,
    "testCaseId" TEXT,
    "recommendedLevel" TEXT NOT NULL,
    "apiUiRecommendation" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "automation_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "test_suites" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_suites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "test_suite_cases" (
    "suiteId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "test_suite_cases_pkey" PRIMARY KEY ("suiteId","testCaseId")
);

CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "evidence" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "test_runs_testCaseId_executedAt_idx" ON "test_runs"("testCaseId", "executedAt");

CREATE TABLE "bugs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "reproductionSteps" JSONB NOT NULL,
    "expectedResult" TEXT NOT NULL DEFAULT '',
    "actualResult" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "environment" TEXT,
    "evidence" TEXT,
    "jiraIssueId" TEXT,
    "testCaseId" TEXT,
    "testRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bugs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "environments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "environments_name_key" ON "environments"("name");

CREATE TABLE "environment_variables" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "environment_variables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "environment_variables_environmentId_key_key" ON "environment_variables"("environmentId", "key");

CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "environmentId" TEXT,
    "stopOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scenario_steps" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scenario_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scenario_steps_scenarioId_orderIndex_idx" ON "scenario_steps"("scenarioId", "orderIndex");

CREATE TABLE "scenario_runs" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "environmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "variablesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scenario_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scenario_runs_scenarioId_createdAt_idx" ON "scenario_runs"("scenarioId", "createdAt");

CREATE TABLE "scenario_step_runs" (
    "id" TEXT NOT NULL,
    "scenarioRunId" TEXT NOT NULL,
    "scenarioStepId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "resolvedInput" JSONB,
    "output" JSONB,
    "error" TEXT,
    "extractedVars" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scenario_step_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scenario_step_runs_scenarioRunId_orderIndex_idx" ON "scenario_step_runs"("scenarioRunId", "orderIndex");

-- FKs
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_analyses" ADD CONSTRAINT "requirement_analyses_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_strategies" ADD CONSTRAINT "test_strategies_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_case_acceptance_criteria" ADD CONSTRAINT "test_case_acceptance_criteria_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_case_acceptance_criteria" ADD CONSTRAINT "test_case_acceptance_criteria_acceptanceCriterionId_fkey" FOREIGN KEY ("acceptanceCriterionId") REFERENCES "acceptance_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "edge_cases" ADD CONSTRAINT "edge_cases_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "risks" ADD CONSTRAINT "risks_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_candidates" ADD CONSTRAINT "automation_candidates_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_candidates" ADD CONSTRAINT "automation_candidates_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_suite_cases" ADD CONSTRAINT "test_suite_cases_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_suite_cases" ADD CONSTRAINT "test_suite_cases_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_jiraIssueId_fkey" FOREIGN KEY ("jiraIssueId") REFERENCES "jira_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "test_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scenario_steps" ADD CONSTRAINT "scenario_steps_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scenario_step_runs" ADD CONSTRAINT "scenario_step_runs_scenarioRunId_fkey" FOREIGN KEY ("scenarioRunId") REFERENCES "scenario_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scenario_step_runs" ADD CONSTRAINT "scenario_step_runs_scenarioStepId_fkey" FOREIGN KEY ("scenarioStepId") REFERENCES "scenario_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
