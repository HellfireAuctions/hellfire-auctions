-- CreateTable
CREATE TABLE IF NOT EXISTS "AuctionNotification" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuctionNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AuctionNotification_auctionId_customerId_type_key_key" ON "AuctionNotification"("auctionId", "customerId", "type", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuctionNotification_auctionId_idx" ON "AuctionNotification"("auctionId");
