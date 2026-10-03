-- Public bid history (one row per accepted bid)
CREATE TABLE "BidEvent" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BidEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BidEvent_auctionId_createdAt_idx" ON "BidEvent"("auctionId", "createdAt");
CREATE INDEX "BidEvent_bidderId_idx" ON "BidEvent"("bidderId");
ALTER TABLE "BidEvent" ADD CONSTRAINT "BidEvent_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
