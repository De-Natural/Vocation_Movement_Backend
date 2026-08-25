import { Inject, Injectable } from '@nestjs/common';
import { Gateway, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AggregationService } from '../aggregation/aggregation.service';
import { NotificationsService } from '../notifications/notifications.module';
import { AppException } from '../common/http/app-exception';
import { parsePagination, paginationMeta } from '../common/utils/pagination';
import { PaginationMeta } from '../common/http/response';
import {
  serializeSponsor,
  serializeStudent,
  serializeRecurring,
  centsToUnits,
  paymentStatusToApi,
  resolveDonorName,
} from '../common/serializers';
import { PaymentStatus, Sponsor, Student } from '../common/serializers/api-types';
import {
  PaymentGateway,
  STRIPE_GATEWAY,
  PAYSTACK_GATEWAY,
} from '../providers/payments/gateway.interface';
import {
  UpsertSponsorProfileInput,
  SentPaymentsQuery,
} from './sponsors.dto';

// A sent-payment row = a Contribution enriched with who/what it funded.
export interface SentPaymentRow {
  id: string;
  billId: string;
  studentId: string;
  studentName: string;
  studentPhoto: string;
  billName: string;
  donorName: string;
  anonymous: boolean;
  amount: number;
  date: string;
  transactionId: string;
  status: PaymentStatus;
  recurring: boolean;
}

@Injectable()
export class SponsorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly notifications: NotificationsService,
    @Inject(STRIPE_GATEWAY) private readonly stripe: PaymentGateway,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaymentGateway,
  ) {}

  private gatewayFor(gateway: Gateway): PaymentGateway {
    return gateway === 'STRIPE' ? this.stripe : this.paystack;
  }

  /** Resolve the SponsorProfile row owned by a user (throws if none). */
  private async requireOwnProfile(userId: string) {
    const sponsor = await this.prisma.sponsorProfile.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!sponsor) {
      throw AppException.notFound(
        'No sponsor profile for this account',
        'SPONSOR_PROFILE_NOT_FOUND',
      );
    }
    return sponsor;
  }

  /** Serialize a sponsor with its derived aggregates attached. */
  private async serializeWithAggregates(
    sponsor: Prisma.SponsorProfileGetPayload<{ include: { user: true } }>,
  ): Promise<Sponsor> {
    const agg = await this.aggregation.sponsorAggregates(sponsor.id);
    return serializeSponsor({ ...sponsor, _agg: agg });
  }

  // ─────────────────── Profile (get / upsert) ───────────────────

  /** GET /api/sponsors/me — the sponsor's own profile + aggregates. */
  async getOwnProfile(userId: string): Promise<Sponsor> {
    const sponsor = await this.requireOwnProfile(userId);
    return this.serializeWithAggregates(sponsor);
  }

  /** POST/PATCH /api/sponsors/profile — edit name/country/currency/anonymity. */
  async upsertOwnProfile(
    userId: string,
    dto: UpsertSponsorProfileInput,
  ): Promise<Sponsor> {
    const sponsor = await this.requireOwnProfile(userId);
    const data: Prisma.SponsorProfileUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.anonymousByDefault !== undefined)
      data.anonymousByDefault = dto.anonymousByDefault;

    const updated = await this.prisma.sponsorProfile.update({
      where: { id: sponsor.id },
      data,
      include: { user: true },
    });
    return this.serializeWithAggregates(updated);
  }

  // ─────────────────── Dashboard (ARCHITECTURE §7.8) ───────────────────

  /** GET /api/sponsors/me/dashboard — giving KPIs, my students, recent gifts. */
  async dashboard(userId: string) {
    const sponsor = await this.requireOwnProfile(userId);
    const [profile, students, recentPayments] = await Promise.all([
      this.serializeWithAggregates(sponsor),
      this.myStudents(userId),
      this.sentPayments(userId, {}, 5),
    ]);

    return {
      sponsor: profile,
      kpis: {
        totalGiven: profile.totalGiven,
        studentsSponsored: profile.studentsSponsored,
        activeRecurring: profile.activeRecurring,
        monthlyCommitment: profile.monthlyCommitment,
      },
      myStudents: students,
      recentPayments: recentPayments.rows,
    };
  }

  // ─────────────────── My Students ───────────────────

  /**
   * GET /api/sponsors/me/students — every student this sponsor has funded
   * (via a confirmed one-time gift or an active/paused recurring gift).
   */
  async myStudents(userId: string): Promise<Student[]> {
    const sponsor = await this.requireOwnProfile(userId);

    const [paidTo, subscribedTo] = await Promise.all([
      this.prisma.payment.findMany({
        where: { sponsorId: sponsor.id, status: 'CONFIRMED' },
        distinct: ['religiousId'],
        select: { religiousId: true },
      }),
      this.prisma.sponsorship.findMany({
        where: { sponsorId: sponsor.id, status: { not: 'CANCELLED' } },
        distinct: ['religiousId'],
        select: { religiousId: true },
      }),
    ]);

    const ids = Array.from(
      new Set([
        ...paidTo.map((p) => p.religiousId),
        ...subscribedTo.map((s) => s.religiousId),
      ]),
    );
    if (!ids.length) return [];

    const profiles = await this.prisma.religiousProfile.findMany({
      where: { id: { in: ids } },
      include: { bills: { where: { status: { not: 'ARCHIVED' } } } },
    });
    // Sponsor is not an admin — anonymity of *other* donors stays hidden.
    return profiles.map((p) => serializeStudent(p));
  }

  // ─────────────────── Sent payments (giving history) ───────────────────

  /**
   * GET /api/sponsors/me/payments — the sponsor's giving history, one row
   * per funded bill (split). Abandoned PENDING intents are excluded.
   */
  async sentPayments(
    userId: string,
    query: SentPaymentsQuery,
    limit?: number,
  ): Promise<{ rows: SentPaymentRow[]; meta: PaginationMeta }> {
    const sponsor = await this.requireOwnProfile(userId);

    const where: Prisma.PaymentSplitWhereInput = {
      payment: {
        sponsorId: sponsor.id,
        status: { in: ['CONFIRMED', 'FAILED', 'REFUNDED'] },
      },
    };
    if (query.from || query.to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.from) createdAt.gte = new Date(query.from);
      if (query.to) {
        const to = new Date(query.to);
        to.setHours(23, 59, 59, 999);
        createdAt.lte = to;
      }
      (where.payment as Prisma.PaymentWhereInput).createdAt = createdAt;
    }

    const { page, perPage, skip, take } = parsePagination(
      query.page,
      query.perPage,
    );

    const [splits, total] = await Promise.all([
      this.prisma.paymentSplit.findMany({
        where,
        include: {
          bill: { include: { religious: true } },
          payment: true,
        },
        orderBy: { payment: { createdAt: 'desc' } },
        ...(limit ? { take: limit } : { skip, take }),
      }),
      this.prisma.paymentSplit.count({ where }),
    ]);

    const rows: SentPaymentRow[] = splits.map((s) => ({
      id: s.id,
      billId: s.billId,
      studentId: s.bill.religiousId,
      studentName: s.bill.religious.fullName,
      studentPhoto: s.bill.religious.photoUrl ?? '',
      billName: s.bill.name,
      // The sponsor is viewing their OWN gifts, so they always see their name.
      donorName: resolveDonorName(
        s.payment.isAnonymous,
        sponsor.fullName,
        true,
      ),
      anonymous: s.payment.isAnonymous,
      amount: centsToUnits(s.amountCents),
      date: (s.payment.confirmedAt ?? s.payment.createdAt).toISOString(),
      transactionId: s.payment.gatewayTxId,
      status: paymentStatusToApi[s.payment.status],
      recurring: s.payment.isRecurring,
    }));

    return {
      rows,
      meta: limit
        ? paginationMeta(1, rows.length || 1, rows.length)
        : paginationMeta(page, perPage, total),
    };
  }

  // ─────────────────── Recurring sponsorships (PRD §7.4) ───────────────────

  /** GET /api/sponsors/me/recurring — the sponsor's monthly gifts. */
  async recurring(userId: string) {
    const sponsor = await this.requireOwnProfile(userId);
    const subs = await this.prisma.sponsorship.findMany({
      where: { sponsorId: sponsor.id, status: { not: 'CANCELLED' } },
      include: { religious: true, bill: true },
      orderBy: { createdAt: 'desc' },
    });
    return subs.map((s) => serializeRecurring(s));
  }

  private async requireOwnSponsorship(userId: string, sponsorshipId: string) {
    const sponsor = await this.requireOwnProfile(userId);
    const sub = await this.prisma.sponsorship.findUnique({
      where: { id: sponsorshipId },
      include: { religious: true, bill: true },
    });
    if (!sub || sub.sponsorId !== sponsor.id) {
      throw AppException.notFound(
        'Recurring gift not found',
        'SPONSORSHIP_NOT_FOUND',
      );
    }
    return { sponsor, sub };
  }

  /** PATCH /api/sponsors/me/recurring/:id/pause — pause or resume a monthly gift. */
  async setPaused(userId: string, sponsorshipId: string, paused: boolean) {
    const { sub } = await this.requireOwnSponsorship(userId, sponsorshipId);
    if (sub.status === 'CANCELLED') {
      throw AppException.unprocessable(
        'This recurring gift has been cancelled',
        'SPONSORSHIP_CANCELLED',
      );
    }

    if (sub.gatewaySubId) {
      const gw = this.gatewayFor(sub.gateway);
      if (paused) await gw.pauseSubscription(sub.gatewaySubId);
      else await gw.resumeSubscription(sub.gatewaySubId);
    }

    const updated = await this.prisma.sponsorship.update({
      where: { id: sub.id },
      data: { status: paused ? 'PAUSED' : 'ACTIVE' },
      include: { religious: true, bill: true },
    });
    return serializeRecurring(updated);
  }

  /**
   * DELETE /api/sponsors/me/recurring/:id — cancel a monthly gift.
   * Never deletes the row (preserves giving history); flips it to CANCELLED
   * and cancels the gateway subscription.
   */
  async cancelRecurring(userId: string, sponsorshipId: string) {
    const { sponsor, sub } = await this.requireOwnSponsorship(
      userId,
      sponsorshipId,
    );
    if (sub.status === 'CANCELLED') {
      return { id: sub.id, cancelled: true };
    }

    if (sub.gatewaySubId) {
      await this.gatewayFor(sub.gateway).cancelSubscription(sub.gatewaySubId);
    }

    await this.prisma.sponsorship.update({
      where: { id: sub.id },
      data: { status: 'CANCELLED' },
    });

    await this.notifications.sendEmail({
      to: sponsor.user.email,
      template: 'sponsorship-cancelled',
      subject: 'Your recurring gift has been cancelled',
      data: {
        name: sponsor.fullName,
        studentName: sub.religious.fullName,
        billName: sub.bill.name,
      },
    });

    return { id: sub.id, cancelled: true };
  }
}
