-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "defaultWeight" DOUBLE PRECISION,
ADD COLUMN "defaultWeightUnit" TEXT NOT NULL DEFAULT 'OUNCES';
