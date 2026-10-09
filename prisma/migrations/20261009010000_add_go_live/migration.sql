-- AlterTable
ALTER TABLE "ActionSale" ADD COLUMN "streaming" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "streamUid" TEXT,
ADD COLUMN "streamPublishUrl" TEXT,
ADD COLUMN "streamPlayUrl" TEXT,
ADD COLUMN "streamStartedAt" TIMESTAMP(3),
ADD COLUMN "streamBeatAt" TIMESTAMP(3);
