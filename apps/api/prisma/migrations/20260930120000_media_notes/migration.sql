ALTER TABLE "test_cases" ADD COLUMN "executionNotes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "test_cases" ADD COLUMN "executionEvidence" TEXT NOT NULL DEFAULT '';

CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "ownerKind" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attachments_ownerKind_ownerId_idx" ON "attachments"("ownerKind", "ownerId");
