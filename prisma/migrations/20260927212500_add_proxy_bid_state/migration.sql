-- Add proxy bidding maximum and enforce one active maximum per bidder per auction
ALTER TABLE "Bid" ADD COLUMN "maxBid" REAL NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Bid_auctionId_bidderId_key" ON "Bid"("auctionId", "bidderId");
