-- Speed indexes (safe: create only if missing)
CREATE INDEX IF NOT EXISTS "Auction_shop_productId_idx" ON "Auction"("shop", "productId");
CREATE INDEX IF NOT EXISTS "Auction_endsAt_idx" ON "Auction"("endsAt");
CREATE INDEX IF NOT EXISTS "Bid_auctionId_maxBid_idx" ON "Bid"("auctionId", "maxBid");
