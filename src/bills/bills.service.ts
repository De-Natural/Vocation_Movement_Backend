import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AggregationService } from '../aggregation/aggregation.service';
import { AppException } from '../common/http/app-exception';
import {
  serializeBill,
  serializeContribution,
  categoryFromApi,
  unitsToCents,
} from '../common/serializers';
import { Bill, Contribution } from '../common/serializers/api-types';
import { CreateBillInput, UpdateBillInput } from './bills.dto';

// Include used whenever we return a full Bill (with its contributions).
const billInclude = {
  paymentSplits: {
    where: { payment: { status: 'CONFIRMED' as const } },
    include: { payment: { include: { sponsor: true } } },
  },
} satisfies Prisma.BillInclude;

@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
  ) {}

  /** Resolve the ReligiousProfile id owned by a user (throws if none). */
  private async ownProfileId(userId: string): Promise<string> {
    const profile = await this.prisma.religiousProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      throw AppException.notFound(
        'No religious profile for this account',
        'PROFILE_NOT_FOUND',
      );
    }
    return profile.id;
  }

  // ─────────────────── List a student's bills (public) ───────────────────
  /** GET /api/bills/religious/:id — non-archived bills for a student. */
  async listForReligious(
    religiousId: string,
    opts: { includeArchived?: boolean; viewerIsAdmin?: boolean } = {},
  ): Promise<Bill[]> {
    const bills = await this.prisma.bill.findMany({
      where: {
        religiousId,
        ...(opts.includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      },
      include: billInclude,
      orderBy: { createdAt: 'asc' },
    });
    return bills.map((b) =>
      serializeBill(b, { viewerIsAdmin: opts.viewerIsAdmin }),
    );
  }

  // ─────────────────── Get one bill ───────────────────
  async getOne(
    billId: string,
    opts: { viewerIsAdmin?: boolean } = {},
  ): Promise<Bill> {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: billInclude,
    });
    if (!bill) throw AppException.notFound('Bill not found', 'BILL_NOT_FOUND');
    return serializeBill(bill, opts);
  }

  // ─────────────────── Create (student only) ───────────────────
  async create(userId: string, dto: CreateBillInput): Promise<Bill> {
    const religiousId = await this.ownProfileId(userId);
    const totalCents = unitsToCents(dto.total);

    const created = await this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.create({
        data: {
          religiousId,
          name: dto.name,
          category: categoryFromApi[dto.category],
          totalCents,
          dueDate: new Date(dto.dueDate),
          description: dto.description,
          status: 'ACTIVE',
        },
      });
      // A new bill changes the student's totalNeeded aggregate.
      await this.aggregation.recomputeReligiousAggregates(religiousId, tx);
      return bill;
    });

    return this.getOne(created.id);
  }

  // ─────────────────── Update (owner only) ───────────────────
  async update(
    userId: string,
    billId: string,
    dto: UpdateBillInput,
  ): Promise<Bill> {
    const religiousId = await this.ownProfileId(userId);
    const bill = await this.prisma.bill.findUnique({ where: { id: billId } });
    if (!bill || bill.religiousId !== religiousId) {
      throw AppException.notFound('Bill not found', 'BILL_NOT_FOUND');
    }
    if (bill.status === 'ARCHIVED') {
      throw AppException.unprocessable(
        'Archived bills cannot be edited',
        'BILL_ARCHIVED',
      );
    }

    const data: Prisma.BillUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.category !== undefined) data.category = categoryFromApi[dto.category];
    if (dto.dueDate !== undefined) data.dueDate = new Date(dto.dueDate);
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.total !== undefined) {
      const totalCents = unitsToCents(dto.total);
      if (totalCents < bill.raisedCents) {
        throw AppException.unprocessable(
          'New total cannot be less than the amount already raised',
          'TOTAL_BELOW_RAISED',
        );
      }
      data.totalCents = totalCents;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bill.update({ where: { id: billId }, data });
      // Total or due-date change can flip status (FUNDED/OVERDUE/ACTIVE).
      await this.aggregation.recomputeBill(billId, tx);
      await this.aggregation.recomputeReligiousAggregates(religiousId, tx);
    });

    return this.getOne(billId);
  }

  // ─────────────────── Archive (owner only) ───────────────────
  /** Soft-hide from public view (never deletes — preserves contributions). */
  async archive(userId: string, billId: string): Promise<Bill> {
    const religiousId = await this.ownProfileId(userId);
    const bill = await this.prisma.bill.findUnique({ where: { id: billId } });
    if (!bill || bill.religiousId !== religiousId) {
      throw AppException.notFound('Bill not found', 'BILL_NOT_FOUND');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bill.update({
        where: { id: billId },
        data: { status: 'ARCHIVED' },
      });
      // Archived bills drop out of totalNeeded.
      await this.aggregation.recomputeReligiousAggregates(religiousId, tx);
    });

    return this.getOne(billId, { viewerIsAdmin: true });
  }

  // ─────────────────── Contributions for a bill ───────────────────
  /** GET /api/bills/:id/contributions — confirmed splits, most recent first. */
  async contributions(
    billId: string,
    opts: { viewerIsAdmin?: boolean } = {},
  ): Promise<Contribution[]> {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      select: { id: true },
    });
    if (!bill) throw AppException.notFound('Bill not found', 'BILL_NOT_FOUND');

    const splits = await this.prisma.paymentSplit.findMany({
      where: { billId, payment: { status: 'CONFIRMED' } },
      include: { payment: { include: { sponsor: true } } },
      orderBy: { payment: { confirmedAt: 'desc' } },
    });
    return splits.map((s) => serializeContribution(s, opts));
  }
}
