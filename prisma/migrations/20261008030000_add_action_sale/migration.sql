-- CreateTable
CREATE TABLE "ActionSale" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "videoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionDrop" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "perPerson" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ActionDrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionClaim" (
    "id" TEXT NOT NULL,
    "dropId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "draftOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionBuyer" (
    "saleId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "draftOrderId" TEXT,
    "invoiceUrl" TEXT,
    "invoiceSentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionBuyer_pkey" PRIMARY KEY ("saleId","customerId")
);

-- CreateIndex
CREATE INDEX "ActionSale_shop_status_idx" ON "ActionSale"("shop", "status");

-- CreateIndex
CREATE INDEX "ActionDrop_saleId_position_idx" ON "ActionDrop"("saleId", "position");

-- CreateIndex
CREATE INDEX "ActionClaim_saleId_customerId_idx" ON "ActionClaim"("saleId", "customerId");

-- CreateIndex
CREATE INDEX "ActionClaim_dropId_customerId_idx" ON "ActionClaim"("dropId", "customerId");

-- AddForeignKey
ALTER TABLE "ActionDrop" ADD CONSTRAINT "ActionDrop_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "ActionSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionClaim" ADD CONSTRAINT "ActionClaim_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "ActionDrop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
