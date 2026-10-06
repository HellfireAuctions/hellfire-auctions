-- CreateTable
CREATE TABLE "LiveSale" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "videoUrl" TEXT,
    "lotSeconds" INTEGER NOT NULL DEFAULT 120,
    "lotIds" TEXT[],
    "currentIndex" INTEGER NOT NULL DEFAULT -1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveSale_shop_status_idx" ON "LiveSale"("shop", "status");
