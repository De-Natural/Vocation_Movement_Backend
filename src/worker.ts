import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { JobsService } from './jobs/jobs.service';

/**
 * One-shot worker entrypoint (PRD §8).
 *
 * Boots a standalone application context (no HTTP server) and runs the
 * background jobs once, then exits. Useful for cron drivers / container
 * schedulers that prefer to invoke a process per tick rather than rely on
 * the in-process @Cron scheduler that runs inside the API.
 *
 *   npm run worker            # run all jobs
 *   npm run worker recurring  # recurring charges only
 *   npm run worker overdue    # overdue-bill sweep only
 *   npm run worker cleanup    # expired-token cleanup only
 */
type JobName = 'recurring' | 'overdue' | 'cleanup' | 'all';

async function run(): Promise<void> {
  const logger = new Logger('Worker');
  const which = (process.argv[2] as JobName) ?? 'all';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const jobs = app.get(JobsService);

    if (which === 'recurring' || which === 'all') {
      const r = await jobs.runRecurringCharges();
      logger.log(
        `Recurring charges — due:${r.due} charged:${r.charged} skipped:${r.skipped}`,
      );
    }
    if (which === 'overdue' || which === 'all') {
      const r = await jobs.checkOverdueBills();
      logger.log(`Overdue sweep — scanned:${r.scanned} flagged:${r.flagged}`);
    }
    if (which === 'cleanup' || which === 'all') {
      const r = await jobs.cleanupExpiredTokens();
      logger.log(`Token cleanup — deleted:${r.deleted}`);
    }
  } finally {
    await app.close();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Worker failed:', err);
    process.exit(1);
  });
