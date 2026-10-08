-- AlterTable
ALTER TABLE "ShopPlan" ADD COLUMN "planConfirmedAt" TIMESTAMP(3);

-- Stores that already have a plan record have been using the app: their plan counts as chosen.
UPDATE "ShopPlan" SET "planConfirmedAt" = NOW() WHERE "planConfirmedAt" IS NULL;
