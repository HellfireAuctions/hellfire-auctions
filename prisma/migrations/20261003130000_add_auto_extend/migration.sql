-- Optional anti-sniping: a bid in the last 2 minutes adds 2 minutes
ALTER TABLE "Auction" ADD COLUMN "autoExtend" BOOLEAN NOT NULL DEFAULT false;
