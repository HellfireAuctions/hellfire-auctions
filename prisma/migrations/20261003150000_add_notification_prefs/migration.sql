-- Each customer's choices for optional emails (outbid alerts, reminders, results)
CREATE TABLE "NotificationPref" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "outbid" BOOLEAN NOT NULL DEFAULT true,
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "results" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationPref_shop_customerId_key" ON "NotificationPref"("shop", "customerId");
