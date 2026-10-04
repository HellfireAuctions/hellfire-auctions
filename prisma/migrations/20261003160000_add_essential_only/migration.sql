-- "Receive only necessary emails" master switch
ALTER TABLE "NotificationPref" ADD COLUMN "essentialOnly" BOOLEAN NOT NULL DEFAULT false;
