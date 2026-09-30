-- Traceable requirement questions and suggested acceptance criteria.
ALTER TABLE "requirement_analyses" ADD COLUMN "questionDetails" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "requirement_analyses" ADD COLUMN "suggestedCriteria" JSONB NOT NULL DEFAULT '[]';
