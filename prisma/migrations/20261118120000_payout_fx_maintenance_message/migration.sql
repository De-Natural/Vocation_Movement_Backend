-- Additive: Super-Admin maintenance message + payout exchange rates into naira.

-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "maintenanceMessage" TEXT,
ADD COLUMN     "payoutFxRates" JSONB NOT NULL DEFAULT '{}';
