-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "bidderRule" TEXT NOT NULL DEFAULT 'ANYONE',
ADD COLUMN "approvedTag" TEXT NOT NULL DEFAULT 'bidder-approved';
