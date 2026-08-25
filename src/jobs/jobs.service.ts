import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';
import { AggregationService } from '../aggregation/aggregation.service';
import { NotificationsService } from '../notifications/notifications.module';
import { PaymentsService } from '../payments/payments.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { centsToUnits } from '../common/serializers';
import { PlatformStats } from '../common/serializers/api-types';

/**
 * Background jobs (PRD §8). Three scheduled sweeps plus the public platform
 * stats query. Each job is also exposed as a plain method so the one-shot
 * worker entrypoint (`npm run worker`) and tests can invoke it directly.
 *
 * Overdue logic reckons against the shared clock (AggregationService.now),
 * which honours the frozen demo date so results match the seed + frontend.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─────────────────── Overdue bills (daily) ───────────────────

  /**
   * Flip past-due, under-funded bills to OVERDUE and notify the student once.
   * FUNDED and ARCHIVED bills are never marked overdue. Runs daily at 02:00.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'overdue-bills' })
  async checkOverdueBills(): Promise<{ scanned: number; flagged: number }> {
    const now = this.aggregation.now();

    const candidates = await this.prisma.bill.findMany({
      where: {
        status: { in: ['ACTIVE'] },
        dueDate: { lt: now },
      },
      include: { religious: true },
    });

    let flagged = 0;
    for (const bill of candidates) {
      // Guard: a bill fully funded but not yet recomputed shouldn't flip.
      if (bill.raisedCents >= bill.totalCents) continue;

      await this.prisma.bill.update({
        where: { id: bill.id },
        data: { status: 'OVERDUE' },
      });
      flagged += 1;

      await this.notifications.notify({
        userId: bill.religious.userId,
        type: 'BILL_OVERDUE',
        title: 'A bill is now overdue',
        body: `"${bill.name}" passed its due date and is still under-funded.`,
        meta: { billId: bill.id },
      });
    }

    if (flagged) {
      this.logger.log(
        `Overdue sweep: ${candidates.length} past-due, ${flagged} flagged`,
      );
    }
    return { scanned: candidates.length, flagged };
  }

  // ─────────────────── Expired-token cleanup (daily) ───────────────────

  /**
   * Delete used or expired email/reset tokens. Redis refresh tokens expire
   * on their own TTL, so only the DB EmailToken rows need sweeping. Always
   * uses the real wall clock (token validity is not part of the demo freeze).
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'cleanup-tokens' })
  async cleanupExpiredTokens(): Promise<{ deleted: number }> {
    const { count } = await this.prisma.emailToken.deleteMany({
      where: {
        OR: [{ expires: { lt: new Date() } }, { usedAt: { not: null } }],
      },
    });
    if (count) this.logger.log(`Token cleanup: removed ${count} stale tokens`);
    return { deleted: count };
  }

  // ─────────────────── Recurring charges (daily) ───────────────────

  /**
   * Drive due recurring sponsorships. Delegates to PaymentsService so the
   * money still moves through the one idempotent webhook path (PRD §4.3).
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'recurring-charges' })
  async runRecurringCharges(): Promise<{
    due: number;
    charged: number;
    skipped: number;
  }> {
    return this.payments.chargeDueRecurring();
  }

  // ─────────────────── Public platform stats ───────────────────

  /**
   * GET /api/stats/platform — the marketing-site headline numbers
   * (ARCHITECTURE PlatformStats). Derived live from the database.
   */
  async platformStats(): Promise<PlatformStats> {
    const [studentsSupported, fundsAgg, sponsors, activeSponsorships] =
      await Promise.all([
        // Students who have received at least one confirmed gift.
        this.prisma.payment
          .findMany({
            where: { status: 'CONFIRMED' },
            distinct: ['religiousId'],
            select: { religiousId: true },
          })
          .then((rows) => rows.length),
        this.prisma.payment.aggregate({
          _sum: { amountCents: true },
          where: { status: 'CONFIRMED' },
        }),
        this.prisma.sponsorProfile.count(),
        this.prisma.sponsorship.count({ where: { status: 'ACTIVE' } }),
      ]);

    return {
      studentsSupported,
      fundsRaised: centsToUnits(fundsAgg._sum.amountCents ?? 0),
      sponsors,
      activeSponsorships,
    };
  }
}
