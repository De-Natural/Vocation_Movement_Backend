import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments module — PRD §3.5, §4 / ARCHITECTURE §7.3, §7.4.
 *
 * The heart of the platform: creates gateway intents (Stripe/Paystack),
 * confirms charges via signature-verified webhooks, records splits, and
 * moves `Bill.raised` + `ReligiousProfile.totalRaised` through the single
 * AggregationService source of truth. Card data never touches this server.
 * Recurring monthly sponsorships are opened here; later charges are driven
 * by the §8 cron. Exports PaymentsService for the recurring-charge job.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
