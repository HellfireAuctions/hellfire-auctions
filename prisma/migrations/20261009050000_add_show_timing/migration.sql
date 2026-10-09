-- AlterTable
ALTER TABLE "ActionSale" ADD COLUMN "lastActivityAt" TIMESTAMP(3),
ADD COLUMN "endedAt" TIMESTAMP(3);

-- Shows already live get a fresh hour; shows already ended count from their last change.
UPDATE "ActionSale" SET "lastActivityAt" = NOW() WHERE "status" = 'LIVE';
UPDATE "ActionSale" SET "endedAt" = "updatedAt" WHERE "status" = 'ENDED';
