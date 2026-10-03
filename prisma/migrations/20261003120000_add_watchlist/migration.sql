-- Shoppers watching an auction (reminders before it starts / ends)
CREATE TABLE "Watch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Watch_auctionId_customerId_key" ON "Watch"("auctionId", "customerId");
CREATE INDEX "Watch_customerId_idx" ON "Watch"("customerId");
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
