ALTER TABLE "acceptance_criteria" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'imported';

ALTER TABLE "risks" ADD COLUMN "releaseBlocking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "risks" ADD COLUMN "acceptanceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
