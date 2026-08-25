import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { StatsController } from './stats.controller';
import { PaymentsModule } from '../payments/payments.module';

/**
 * Background jobs + public stats (PRD §8 / ARCHITECTURE PlatformStats).
 *
 * Registers the daily cron sweeps (overdue bills, token cleanup, recurring
 * charges) and the public GET /api/stats/platform endpoint. The scheduler
 * itself is enabled once via ScheduleModule.forRoot() in AppModule; the same
 * JobsService methods run standalone from the worker entrypoint. Imports
 * PaymentsModule for the recurring-charge driver.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [StatsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
