-- Additive: every gift gets a naira value, locked at the Super-Admin's exchange rate.

-- AlterTable
ALTER TABLE "payment_splits" ADD COLUMN     "nairaAmountCents" INTEGER,
ADD COLUMN     "nairaNetCents" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "nairaAmountCents" INTEGER,
ADD COLUMN     "nairaNetCents" INTEGER;

-- Gifts already paid in naira need no rate.
UPDATE "payments" SET "fxRate" = 1, "nairaAmountCents" = "amountCents", "nairaNetCents" = "netAmountCents"
WHERE "currency" = 'NGN' AND "status" = 'CONFIRMED';
UPDATE "payment_splits" s SET "nairaAmountCents" = s."amountCents", "nairaNetCents" = s."netAmountCents"
FROM "payments" p WHERE s."paymentId" = p."id" AND p."currency" = 'NGN' AND p."status" = 'CONFIRMED';
