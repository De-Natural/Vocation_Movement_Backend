import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { SettingsService } from '../settings/settings.service';

/** Naira per 1 unit of `currency` (1 for naira), or null when no rate is set. */
export function nairaRate(currency: string, rates: Record<string, number>): number | null {
  if (currency === 'NGN') return 1;
  const r = rates[currency];
  return r && r > 0 ? r : null;
}

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
    private readonly settings: SettingsService,
  ) {}

  /**
   * Lock a confirmed payment's naira value (and its splits') at the
   * Super-Admin's current rate. Done once: later rate changes don't move
   * past gifts. Returns false when there's no rate for its currency yet
   * (it is then left out of naira totals until a rate is set).
   */
  async lockNaira(paymentId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.prisma;
    const payment = await db.payment.findUnique({ where: { id: paymentId }, include: { splits: true } });
    if (!payment || payment.nairaNetCents !== null) return false;
    const rate = nairaRate(payment.currency, (await this.settings.effective()).payoutFxRates);
    if (!rate) return false;
    await db.payment.update({
      where: { id: payment.id },
      data: {
        fxRate: rate,
        nairaAmountCents: Math.round(payment.amountCents * rate),
        nairaNetCents: Math.round(payment.netAmountCents * rate),
      },
    });
    for (const s of payment.splits) {
      await db.paymentSplit.update({
        where: { id: s.id },
        data: {
          nairaAmountCents: Math.round(s.amountCents * rate),
          nairaNetCents: Math.round(s.netAmountCents * rate),
        },
      });
    }
    return true;
  }

  /**
   * Give a naira value to every confirmed gift that has none yet, using the
   * current rates (run after the Super-Admin saves exchange rates), then
   * refresh the progress bars and totals they feed. Returns how many gifts
   * were converted.
   */
  async backfillNaira(): Promise<number> {
    const pending = await this.prisma.payment.findMany({
      where: { status: 'CONFIRMED', nairaNetCents: null },
      select: { id: true, religiousId: true, splits: { select: { billId: true } } },
    });
    let converted = 0;
    for (const p of pending) {
      if (await this.lockNaira(p.id)) converted += 1;
    }
    // Refresh every bill and student that has gifts, so no total still holds
    // amounts added up across currencies (how totals were kept before naira).
    const [bills, students] = await Promise.all([
      this.prisma.paymentSplit.findMany({
        where: { payment: { status: 'CONFIRMED' } },
        distinct: ['billId'],
        select: { billId: true },
      }),
      this.prisma.payment.findMany({
        where: { status: 'CONFIRMED' },
        distinct: ['religiousId'],
        select: { religiousId: true },
      }),
    ]);
    for (const b of bills) await this.recomputeBill(b.billId);
    for (const s of students) await this.recomputeReligiousAggregates(s.religiousId);
    return converted;
  }

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
      _sum: { nairaNetCents: true },
      where: { billId, payment: { status: 'CONFIRMED' } },
    });
    // Progress bars track the NET credited to the bill (gift − platform fee,
    // Fee Model A), in naira: bills are in naira and every gift's naira value
    // is locked at the Super-Admin's rate (gifts with no rate yet are left out).
    const raisedCents = agg._sum.nairaNetCents ?? 0;

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
        _sum: { nairaNetCents: true },
        where: { religiousId, status: 'CONFIRMED' },
      }),
      db.bill.aggregate({
        _sum: { totalCents: true },
        where: { religiousId, status: { not: 'ARCHIVED' } },
      }),
      db.payment.findMany({
        where: { religiousId, status: 'CONFIRMED' },
        // One per sponsor account plus one per guest email (guests have no sponsorId).
        distinct: ['sponsorId', 'guestEmail'],
        select: { sponsorId: true, guestEmail: true },
      }),
    ]);

    await db.religiousProfile.update({
      where: { id: religiousId },
      data: {
        // Net of platform fee, to match the sum of this profile's bill
        // progress bars (recomputeBill also sums netAmountCents).
        totalRaisedCents: raised._sum.nairaNetCents ?? 0,
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
    const [given, students, recurring, { payoutFxRates }] = await Promise.all([
      this.prisma.payment.aggregate({
        _sum: { nairaAmountCents: true },
        where: { sponsorId, status: 'CONFIRMED' },
      }),
      this.prisma.payment.findMany({
        where: { sponsorId, status: 'CONFIRMED' },
        distinct: ['religiousId'],
        select: { religiousId: true },
      }),
      this.prisma.sponsorship.findMany({
        where: { sponsorId, status: 'ACTIVE' },
        select: { amountCents: true, currency: true },
      }),
      this.settings.effective(),
    ]);

    // All in naira: past gifts at their locked value, the monthly commitment
    // at today's rate (a currency with no rate counts as 0 until one is set).
    return {
      totalGivenCents: given._sum.nairaAmountCents ?? 0,
      studentsSponsored: students.length,
      activeRecurring: recurring.length,
      monthlyCommitmentCents: recurring.reduce(
        (sum, r) => sum + Math.round(r.amountCents * (nairaRate(r.currency, payoutFxRates) ?? 0)),
        0,
      ),
    };
  }
}
