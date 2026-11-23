-- Guest checkout: a one-time gift can be made without a sponsor account.
-- Additive only: sponsorId becomes optional (existing rows keep their sponsor)
-- and the guest's name + email are stored for the receipt.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "guestEmail" TEXT,
ADD COLUMN     "guestName" TEXT,
ALTER COLUMN "sponsorId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "payments_guestEmail_idx" ON "payments"("guestEmail");
