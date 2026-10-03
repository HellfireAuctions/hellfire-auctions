-- Bidders a store owner has blocked
CREATE TABLE "BlockedBidder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedBidder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlockedBidder_shop_customerId_key" ON "BlockedBidder"("shop", "customerId");
