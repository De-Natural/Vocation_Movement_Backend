import { Module } from '@nestjs/common';
import { SponsorsController } from './sponsors.controller';
import { RecurringController } from './recurring.controller';
import { SponsorsService } from './sponsors.service';

/**
 * Sponsors module — PRD 3.4 / ARCHITECTURE §7.8, §7.4.
 * Sponsor profile + preferences, giving dashboard (KPIs from the single
 * AggregationService), "My Students", giving history, and recurring-gift
 * management (pause/resume/cancel via the gateway). Cancelling never
 * deletes history — the Sponsorship flips to CANCELLED.
 */
@Module({
  controllers: [SponsorsController, RecurringController],
  providers: [SponsorsService],
  exports: [SponsorsService],
})
export class SponsorsModule {}
