import { Inject, Injectable } from '@nestjs/common';
import { Prisma, VerificationState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.module';
import { UploadsService } from '../uploads/uploads.service';
import { AppException } from '../common/http/app-exception';
import { parsePagination, paginationMeta } from '../common/utils/pagination';
import { PaginationMeta } from '../common/http/response';
import {
  serializeStudent,
  verificationToApi,
  centsToUnits,
} from '../common/serializers';
import { VerificationStatus } from '../common/serializers/api-types';
import {
  GenerateReportInput,
  TransactionsQuery,
  UpdateSettingsInput,
} from './admin.dto';

const SETTINGS_ID = 'singleton';

// Map the frontend verification filter to the DB enum (or undefined = all).
const verificationFilterToDb: Record<
  Exclude<VerificationStatus, never> | 'all',
  VerificationState | undefined
> = {
  'Pending Verification': 'PENDING',
  Verified: 'VERIFIED',
  Rejected: 'REJECTED',
  Suspended: 'SUSPENDED',
  all: undefined,
};

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly uploads: UploadsService,
  ) {}

  // ═══════════════════ Verification workflow (§7.5) ═══════════════════

  /** GET /api/admin/verifications?status= — the review roster. */
  async verificationQueue(status: VerificationStatus | 'all') {
    const state = verificationFilterToDb[status];
    const profiles = await this.prisma.religiousProfile.findMany({
      where: state ? { verificationState: state } : {},
      include: {
        bills: { where: { status: { not: 'ARCHIVED' } } },
        verificationDocs: true,
        user: { select: { email: true, isSuspended: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      profiles.map(async (p) => {
        const student = serializeStudent(p, { viewerIsAdmin: true });
        // Sign each doc so the admin UI can open it (private bucket).
        const documents = await Promise.all(
          p.verificationDocs.map(async (d) => ({
            id: d.id,
            label: d.label,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            url: await this.uploads.signedUrl(d.fileUrl),
            createdAt: d.createdAt.toISOString(),
          })),
        );
        return { ...student, email: p.user.email, documents };
      }),
    );
  }

  /** GET /api/admin/pending — shorthand for the pending queue + count. */
  async pending() {
    const queue = await this.verificationQueue('Pending Verification');
    return { count: queue.length, students: queue };
  }

  private async requireProfile(religiousId: string) {
    const profile = await this.prisma.religiousProfile.findUnique({
      where: { id: religiousId },
      include: { user: true },
    });
    if (!profile) {
      throw AppException.notFound('Student not found', 'STUDENT_NOT_FOUND');
    }
    return profile;
  }

  /** Approve a profile → Verified + isApproved, making it public. */
  async verify(adminUserId: string, religiousId: string) {
    const profile = await this.requireProfile(religiousId);

    await this.prisma.$transaction([
      this.prisma.religiousProfile.update({
        where: { id: religiousId },
        data: { verificationState: 'VERIFIED', rejectionReason: null },
      }),
      this.prisma.user.update({
        where: { id: profile.userId },
        data: { isApproved: true, isSuspended: false },
      }),
      this.prisma.adminAction.create({
        data: {
          actorId: adminUserId,
          targetUserId: profile.userId,
          action: 'VERIFY_PROFILE',
        },
      }),
    ]);

    await this.notifications.notify({
      userId: profile.userId,
      type: 'PROFILE_APPROVED',
      title: 'Your profile is verified',
      body: 'Your profile is now live and visible to sponsors. Thank you!',
    });
    await this.notifications.sendEmail({
      to: profile.user.email,
      template: 'profile-approved',
      subject: 'Your Vocation Movement profile is verified',
      data: { name: profile.fullName },
    });

    return { id: religiousId, verification: verificationToApi['VERIFIED'] };
  }

  /** Reject a profile with a reason (emailed to the student). */
  async reject(adminUserId: string, religiousId: string, reason: string) {
    const profile = await this.requireProfile(religiousId);

    await this.prisma.$transaction([
      this.prisma.religiousProfile.update({
        where: { id: religiousId },
        data: { verificationState: 'REJECTED', rejectionReason: reason },
      }),
      this.prisma.user.update({
        where: { id: profile.userId },
        data: { isApproved: false },
      }),
      this.prisma.adminAction.create({
        data: {
          actorId: adminUserId,
          targetUserId: profile.userId,
          action: 'REJECT_PROFILE',
          reason,
        },
      }),
    ]);

    await this.notifications.notify({
      userId: profile.userId,
      type: 'PROFILE_REJECTED',
      title: 'Your profile needs changes',
      body: reason,
    });
    await this.notifications.sendEmail({
      to: profile.user.email,
      template: 'profile-rejected',
      subject: 'Your Vocation Movement profile needs changes',
      data: { name: profile.fullName, reason },
    });

    return { id: religiousId, verification: verificationToApi['REJECTED'] };
  }

  /** Request more information (stays Pending, records the ask, emails student). */
  async requestInfo(adminUserId: string, religiousId: string, reason: string) {
    const profile = await this.requireProfile(religiousId);

    await this.prisma.adminAction.create({
      data: {
        actorId: adminUserId,
        targetUserId: profile.userId,
        action: 'REQUEST_INFO',
        reason,
      },
    });

    await this.notifications.notify({
      userId: profile.userId,
      type: 'SYSTEM',
      title: 'More information requested',
      body: reason,
    });
    await this.notifications.sendEmail({
      to: profile.user.email,
      template: 'info-requested',
      subject: 'More information needed for your Vocation Movement profile',
      data: { name: profile.fullName, reason },
    });

    return { id: religiousId, requested: true };
  }

  /** Suspend a user (hides their profile; reason emailed). */
  async suspend(adminUserId: string, targetUserId: string, reason: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { religiousProfile: true },
    });
    if (!user) throw AppException.notFound('User not found', 'USER_NOT_FOUND');
    if (user.role === 'ADMIN') {
      throw AppException.forbidden('Admins cannot be suspended', 'CANNOT_SUSPEND_ADMIN');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: { isSuspended: true },
      });
      if (user.religiousProfile) {
        await tx.religiousProfile.update({
          where: { id: user.religiousProfile.id },
          data: { verificationState: 'SUSPENDED' },
        });
      }
      await tx.adminAction.create({
        data: {
          actorId: adminUserId,
          targetUserId,
          action: 'SUSPEND_USER',
          reason,
        },
      });
    });

    await this.notifications.notify({
      userId: targetUserId,
      type: 'SYSTEM',
      title: 'Your account has been suspended',
      body: reason,
    });
    await this.notifications.sendEmail({
      to: user.email,
      template: 'account-suspended',
      subject: 'Your Vocation Movement account has been suspended',
      data: { reason },
    });

    return { userId: targetUserId, suspended: true };
  }

  // ═══════════════════ Transactions feed (§7.8) ═══════════════════

  /** GET /api/admin/transactions — global, filterable payment feed. */
  async transactions(query: TransactionsQuery): Promise<{
    rows: TransactionRow[];
    totalAmount: number;
    meta: PaginationMeta;
  }> {
    const where: Prisma.PaymentWhereInput = {};

    if (query.status) {
      // "Failed" in the UI covers both FAILED and REFUNDED in the DB.
      where.status =
        query.status === 'Failed'
          ? { in: ['FAILED', 'REFUNDED'] }
          : query.status === 'Confirmed'
            ? 'CONFIRMED'
            : 'PENDING';
    }
    if (query.donorType === 'named') where.isAnonymous = false;
    if (query.donorType === 'anonymous') where.isAnonymous = true;
    if (query.congregation) {
      where.religious = { congregationName: query.congregation };
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) {
        const to = new Date(query.to);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const { page, perPage, skip, take } = parsePagination(
      query.page,
      query.perPage,
    );

    const [payments, total, sumAgg] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          sponsor: true,
          religious: true,
          splits: { include: { bill: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ _sum: { amountCents: true }, where }),
    ]);

    const rows: TransactionRow[] = payments.map((p) => ({
      id: p.id,
      date: (p.confirmedAt ?? p.createdAt).toISOString(),
      // Admin sees the real donor name even when anonymous (audit view).
      donorName: p.sponsor.fullName,
      anonymous: p.isAnonymous,
      studentName: p.religious.fullName,
      congregation: p.religious.congregationName,
      billName: p.splits.map((s) => s.bill.name).join(', ') || '—',
      amount: centsToUnits(p.amountCents),
      currency: p.currency,
      transactionId: p.gatewayTxId,
      status:
        p.status === 'CONFIRMED'
          ? 'Confirmed'
          : p.status === 'PENDING'
            ? 'Pending'
            : 'Failed',
      recurring: p.isRecurring,
    }));

    return {
      rows,
      totalAmount: centsToUnits(sumAgg._sum.amountCents ?? 0),
      meta: paginationMeta(page, perPage, total),
    };
  }

  // ═══════════════════ KPIs / overview (§7.8) ═══════════════════

  /** GET /api/admin/kpis — the overview dashboard metrics. */
  async kpis() {
    const [
      totalStudents,
      pendingCount,
      fundsAgg,
      unreadInquiries,
      sponsorCount,
      activeRecurring,
    ] = await Promise.all([
      this.prisma.religiousProfile.count(),
      this.prisma.religiousProfile.count({
        where: { verificationState: 'PENDING' },
      }),
      this.prisma.payment.aggregate({
        _sum: { amountCents: true },
        where: { status: 'CONFIRMED' },
      }),
      this.prisma.contactInquiry.count({ where: { status: 'UNREAD' } }),
      this.prisma.sponsorProfile.count(),
      this.prisma.sponsorship.count({ where: { status: 'ACTIVE' } }),
    ]);

    // Overdue bills, joined with student for the "needs attention" list.
    const overdue = await this.prisma.bill.findMany({
      where: { status: 'OVERDUE' },
      include: { religious: true },
      orderBy: { dueDate: 'asc' },
      take: 10,
    });

    const pendingQueue = await this.prisma.religiousProfile.findMany({
      where: { verificationState: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const recentInquiries = await this.prisma.contactInquiry.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    return {
      kpis: {
        studentsSupported: totalStudents,
        pendingVerification: pendingCount,
        fundsRaised: centsToUnits(fundsAgg._sum.amountCents ?? 0),
        unreadInquiries,
        sponsors: sponsorCount,
        activeSponsorships: activeRecurring,
      },
      verificationQueue: pendingQueue.map((s) => ({
        id: s.id,
        name: s.fullName,
        photo: s.photoUrl ?? '',
        congregation: s.congregationName,
        createdAt: s.createdAt.toISOString(),
      })),
      overdueBills: overdue.map((b) => ({
        id: b.id,
        billName: b.name,
        studentName: b.religious.fullName,
        studentPhoto: b.religious.photoUrl ?? '',
        dueDate: b.dueDate.toISOString(),
        gap: centsToUnits(Math.max(0, b.totalCents - b.raisedCents)),
      })),
      recentInquiries: recentInquiries.map((i) => ({
        id: i.id,
        name: i.name,
        message: i.message,
        date: i.createdAt.toISOString(),
        read: i.status !== 'UNREAD',
      })),
    };
  }

  // ═══════════════════ Settings (§7.9) ═══════════════════

  async getSettings() {
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return this.serializeSettings(settings);
  }

  async updateSettings(adminUserId: string, dto: UpdateSettingsInput) {
    const data: Prisma.PlatformSettingsUpdateInput = {};
    if (dto.organizationName !== undefined) data.organizationName = dto.organizationName;
    if (dto.supportEmail !== undefined) data.supportEmail = dto.supportEmail;
    if (dto.defaultCurrency !== undefined) data.defaultCurrency = dto.defaultCurrency;
    if (dto.platformFeePercent !== undefined)
      data.platformFeePercent = dto.platformFeePercent;
    if (dto.minGift !== undefined) data.minGiftCents = Math.round(dto.minGift * 100);
    if (dto.autoApprove !== undefined) data.autoApprove = dto.autoApprove;
    if (dto.maintenanceMode !== undefined) data.maintenanceMode = dto.maintenanceMode;
    if (dto.anonymousDefault !== undefined) data.anonymousDefault = dto.anonymousDefault;
    if (dto.emailReceipts !== undefined) data.emailReceipts = dto.emailReceipts;

    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...(data as Prisma.PlatformSettingsCreateInput) },
      update: data,
    });

    await this.prisma.adminAction.create({
      data: {
        actorId: adminUserId,
        action: 'UPDATE_SETTINGS',
        meta: dto as Prisma.InputJsonValue,
      },
    });

    return this.serializeSettings(settings);
  }

  private serializeSettings(s: {
    organizationName: string;
    supportEmail: string;
    defaultCurrency: string;
    platformFeePercent: number;
    minGiftCents: number;
    autoApprove: boolean;
    maintenanceMode: boolean;
    anonymousDefault: boolean;
    emailReceipts: boolean;
  }) {
    return {
      organizationName: s.organizationName,
      supportEmail: s.supportEmail,
      defaultCurrency: s.defaultCurrency,
      platformFeePercent: s.platformFeePercent,
      minGift: centsToUnits(s.minGiftCents),
      autoApprove: s.autoApprove,
      maintenanceMode: s.maintenanceMode,
      anonymousDefault: s.anonymousDefault,
      emailReceipts: s.emailReceipts,
    };
  }

  // ═══════════════════ Reports (§7.9) ═══════════════════

  /** GET /api/admin/reports — funding totals grouped by congregation. */
  async reports() {
    const grouped = await this.prisma.religiousProfile.groupBy({
      by: ['congregationName'],
      _sum: { totalRaisedCents: true, totalNeededCents: true },
      _count: { _all: true },
      orderBy: { congregationName: 'asc' },
    });

    const generated = await this.prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      byCongregation: grouped.map((g) => ({
        congregation: g.congregationName,
        students: g._count._all,
        raised: centsToUnits(g._sum.totalRaisedCents ?? 0),
        needed: centsToUnits(g._sum.totalNeededCents ?? 0),
      })),
      generated: generated.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        fileUrl: r.fileUrl,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Record a report generation request. Actual PDF rendering is handed to
   * the storage/report provider; here we persist the metadata row so the
   * admin UI can list & download it. The stub writes a placeholder file.
   */
  async generateReport(adminUserId: string, dto: GenerateReportInput) {
    const title =
      dto.kind === 'congregation' && dto.congregation
        ? `Congregation report — ${dto.congregation}`
        : dto.kind === 'monthly' && dto.month
          ? `Monthly report — ${dto.month}`
          : 'Platform report';

    // Placeholder document (a real generator would produce a PDF buffer).
    const stored = await this.uploads.store('reports', {
      originalname: `${dto.kind}-report.pdf`,
      mimetype: 'application/pdf',
      size: 20,
      buffer: Buffer.from('%PDF-1.4\n% Vocation Movement report\n'),
    });

    const report = await this.prisma.report.create({
      data: {
        kind: dto.kind,
        title,
        fileUrl: stored.key,
        params: dto as Prisma.InputJsonValue,
        generatedBy: adminUserId,
      },
    });

    return {
      id: report.id,
      title: report.title,
      url: await this.uploads.signedUrl(stored.key),
      createdAt: report.createdAt.toISOString(),
    };
  }
}

// ─── Shapes returned to the admin UI ───
export interface TransactionRow {
  id: string;
  date: string;
  donorName: string;
  anonymous: boolean;
  studentName: string;
  congregation: string;
  billName: string;
  amount: number;
  currency: string;
  transactionId: string;
  status: 'Confirmed' | 'Pending' | 'Failed';
  recurring: boolean;
}
