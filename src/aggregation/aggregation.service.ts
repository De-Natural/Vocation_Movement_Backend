import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';

/**
 * Central recomputation of server-derived financial values (PRD §4.5,
 * §7.3): a Bill's `raisedCents`/`status`, and a ReligiousProfile's
 * `totalRaisedCents`/`totalNeededCents`/`sponsorCount`.
 *
 * Called by the payment worker after a confirmed charge and by the
 * overdue-bills cron. Kept in one place so the numbers behind every
 * progress bar have a single source of truth.
 */
@Injectable()
export class AggregationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The instant "now" resolves to for funding logic. Honours the optional
   * frozen clock (NOW_OVERRIDE) so overdue status matches the seed data and
   * the frontend, which both treat 2026-08-18 as the present.
   */
  now(): Date {
    return this.config.clock.nowOverride ?? new Date();
  }

  /**
   * Recompute a single bill's raised amount from CONFIRMED payment
   * splits and derive its status. Runs inside an optional transaction.
   */
  async recomputeBill(
    billId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const bill = await db.bill.findUnique({ where: { id: billId } });
    if (!bill) return;

    const agg = await db.paymentSplit.aggregate({
      _sum: { netAmountCents: true },
      where: { billId, payment: { status: 'CONFIRMED' } },
    });
    // Progress bars track the NET credited to the bill (gift − platform fee,
    // Fee Model A). Legacy/seeded splits have netAmountCents == amountCents,
    // so this is identical to the old gross sum until a fee is charged.
    const raisedCents = agg._sum.netAmountCents ?? 0;

    let status = bill.status;
    if (status !== 'ARCHIVED') {
      if (raisedCents >= bill.totalCents) {
        status = 'FUNDED';
      } else if (bill.dueDate.getTime() < this.now().getTime()) {
        status = 'OVERDUE';
      } else {
        status = 'ACTIVE';
      }
    }

    await db.bill.update({
      where: { id: billId },
      data: { raisedCents, status },
    });
  }

  /**
   * Recompute a religious profile's aggregates: total raised across all
   * confirmed payments, total needed across non-archived bills, and the
   * distinct sponsor count.
   */
  async recomputeReligiousAggregates(
    religiousId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    const [raised, needed, sponsors] = await Promise.all([
      db.payment.aggregate({
        _sum: { netAmountCents: true },
        where: { religiousId, status: 'CONFIRMED' },
      }),
      db.bill.aggregate({
        _sum: { totalCents: true },
        where: { religiousId, status: { not: 'ARCHIVED' } },
      }),
      db.payment.findMany({
        where: { religiousId, status: 'CONFIRMED' },
        distinct: ['sponsorId'],
        select: { sponsorId: true },
      }),
    ]);

    await db.religiousProfile.update({
      where: { id: religiousId },
      data: {
        // Net of platform fee, to match the sum of this profile's bill
        // progress bars (recomputeBill also sums netAmountCents).
        totalRaisedCents: raised._sum.netAmountCents ?? 0,
        totalNeededCents: needed._sum.totalCents ?? 0,
        sponsorCount: sponsors.length,
      },
    });
  }

  /** Sponsor-side aggregates used by the sponsor dashboard + serializer. */
  async sponsorAggregates(sponsorId: string): Promise<{
    totalGivenCents: number;
    studentsSponsored: number;
    activeRecurring: number;
    monthlyCommitmentCents: number;
  }> {
    const [given, students, recurring] = await Promise.all([
      this.prisma.payment.aggregate({
        _sum: { amountCents: true },
        where: { sponsorId, status: 'CONFIRMED' },
      }),
      this.prisma.payment.findMany({
        where: { sponsorId, status: 'CONFIRMED' },
        distinct: ['religiousId'],
        select: { religiousId: true },
      }),
      this.prisma.sponsorship.findMany({
        where: { sponsorId, status: 'ACTIVE' },
        select: { amountCents: true },
      }),
    ]);

    return {
      totalGivenCents: given._sum.amountCents ?? 0,
      studentsSponsored: students.length,
      activeRecurring: recurring.length,
      monthlyCommitmentCents: recurring.reduce(
        (sum, r) => sum + r.amountCents,
        0,
      ),
    };
  }
}
