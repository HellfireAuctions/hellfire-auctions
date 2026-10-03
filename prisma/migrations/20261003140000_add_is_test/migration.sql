-- Test auctions (5/10 minute) are flagged so they can never produce a real sale on a live store
ALTER TABLE "Auction" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Auction" SET "isTest" = true WHERE ("endsAt" - "startsAt") < interval '1 hour';
