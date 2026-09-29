-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "winnerCheckoutUrl" TEXT,
ADD COLUMN     "winnerNotifiedAt" TIMESTAMP(3);
