-- CreateTable
CREATE TABLE IF NOT EXISTS "ShopPlan" (
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'SPARK',
    "subscriptionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopPlan_pkey" PRIMARY KEY ("shop")
);
