import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AggregationService } from '../aggregation/aggregation.service';
import { UploadsService, IncomingFile } from '../uploads/uploads.service';
import { NotificationsService } from '../notifications/notifications.module';
import {
  serializeStudent,
  serializeContribution,
  categoryFromApi,
  stageFromApi,
} from '../common/serializers';
import { computeProfileCompletion, slugify } from '../common/utils/profile';
import { AppException } from '../common/http/app-exception';
import { parsePagination, paginationMeta } from '../common/utils/pagination';
import { Student } from '../common/serializers/api-types';
import { PaginationMeta } from '../common/http/response';
import {
  ListReligiousQuery,
  UpsertReligiousProfileInput,
} from './religious.dto';

// Full include for a public/detail student view: bills with their
// confirmed contribution splits (for the donate widget's history).
const detailInclude = {
  bills: {
    where: { status: { not: 'ARCHIVED' as const } },
    orderBy: { createdAt: 'asc' as const },
    include: {
      paymentSplits: {
        where: { payment: { status: 'CONFIRMED' as const } },
        include: { payment: { include: { sponsor: true } } },
      },
    },
  },
} satisfies Prisma.ReligiousProfileInclude;

// Lean include for list cards: bills only (raised is stored on the row).
const listInclude = {
  bills: {
    where: { status: { not: 'ARCHIVED' as const } },
  },
} satisfies Prisma.ReligiousProfileInclude;

/** Funding urgency 0-100 = lowest funded % among active bills (frontend parity). */
function urgency(student: Student): number {
  const active = student.bills.filter(
    (b) => b.status !== 'Fully Funded' && b.status !== 'Archived',
  );
  if (!active.length) return 100;
  return Math.min(
    ...active.map((b) =>
      b.total <= 0 ? 100 : Math.round((b.raised / b.total) * 100),
    ),
  );
}

@Injectable()
export class ReligiousService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly uploads: UploadsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─────────────────── Public browse / search (PRD 3.2) ───────────────────
  /**
   * List VERIFIED students only (verification gates public visibility per
   * ARCHITECTURE §7.5). DB handles exact-match filters + search; the
   * derived urgency sort / hide-funded run in memory to exactly mirror
   * students/page.tsx. Pagination is applied after sorting.
   */
  async list(query: ListReligiousQuery): Promise<{
    students: Student[];
    meta: PaginationMeta;
  }> {
    const where: Prisma.ReligiousProfileWhereInput = {
      verificationState: 'VERIFIED',
      user: { isSuspended: false },
    };

    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { congregationName: { contains: query.search, mode: 'insensitive' } },
        { schoolName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.congregation) where.congregationName = query.congregation;
    if (query.school) where.schoolName = query.school;
    if (query.country) where.country = query.country;
    if (query.stage) where.formationStage = stageFromApi[query.stage];
    if (query.billType) {
      where.bills = {
        some: {
          category: categoryFromApi[query.billType],
          status: { not: 'FUNDED' },
        },
      };
    }

    const rows = await this.prisma.religiousProfile.findMany({
      where,
      include: listInclude,
    });

    let students = rows.map((r) => serializeStudent(r));

    if (query.hideFunded) {
      students = students.filter((s) => urgency(s) < 100);
    }

    switch (query.sort) {
      case 'urgent':
        students.sort((a, b) => urgency(a) - urgency(b));
        break;
      case 'newest':
        students.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        break;
      case 'alpha':
        students.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'sponsored':
        students.sort((a, b) => b.sponsorCount - a.sponsorCount);
        break;
    }

    const total = students.length;
    const { page, perPage, skip, take } = parsePagination(
      query.page,
      query.perPage,
    );
    const paged = students.slice(skip, skip + take);
    return { students: paged, meta: paginationMeta(page, perPage, total) };
  }

  // ─────────────────── Get one (by id or slug) ───────────────────
  async getPublic(idOrSlug: string): Promise<Student> {
    const profile = await this.prisma.religiousProfile.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: detailInclude,
    });
    if (!profile) throw AppException.notFound('Student not found', 'STUDENT_NOT_FOUND');
    // Public visibility: only verified profiles are exposed by slug/id.
    if (profile.verificationState !== 'VERIFIED') {
      throw AppException.notFound('Student not found', 'STUDENT_NOT_FOUND');
    }
    return serializeStudent(profile);
  }

  /** Resolve the ReligiousProfile row owned by a user (throws if none). */
  private async requireOwnProfile(userId: string) {
    const profile = await this.prisma.religiousProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw AppException.notFound(
        'No religious profile for this account',
        'PROFILE_NOT_FOUND',
      );
    }
    return profile;
  }

  // ─────────────────── Upsert own profile ───────────────────
  async upsertOwnProfile(
    userId: string,
    dto: UpsertReligiousProfileInput,
  ): Promise<Student> {
    const existing = await this.requireOwnProfile(userId);

    const data: Prisma.ReligiousProfileUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.biography !== undefined) data.biography = dto.biography;
    if (dto.formationStage !== undefined)
      data.formationStage = stageFromApi[dto.formationStage];
    if (dto.congregation !== undefined) data.congregationName = dto.congregation;
    if (dto.school !== undefined) data.schoolName = dto.school;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.phoneNumber !== undefined) data.phoneNumber = dto.phoneNumber;
    if (dto.dateOfBirth !== undefined)
      data.dateOfBirth = new Date(dto.dateOfBirth);
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.yearOfFormation !== undefined)
      data.yearOfFormation = dto.yearOfFormation;
    if (dto.expectedYear !== undefined) data.expectedYear = dto.expectedYear;

    // Keep the slug meaningful if the name changed and it hasn't diverged.
    if (dto.fullName && dto.fullName !== existing.fullName) {
      data.slug = await this.uniqueSlug(dto.fullName, existing.id);
    }

    // Recompute completion from the merged view (existing row + this patch).
    data.profileCompletion = computeProfileCompletion({
      photoUrl: existing.photoUrl,
      biography: (data.biography as string) ?? existing.biography,
      formationStage: (data.formationStage as string) ?? existing.formationStage,
      congregationName:
        (data.congregationName as string) ?? existing.congregationName,
      schoolName: (data.schoolName as string) ?? existing.schoolName,
      country: (data.country as string) ?? existing.country,
      location: (data.location as string) ?? existing.location,
      phoneNumber: (data.phoneNumber as string) ?? existing.phoneNumber,
      dateOfBirth: (data.dateOfBirth as Date) ?? existing.dateOfBirth,
      gender: (data.gender as string) ?? existing.gender,
      yearOfFormation:
        (data.yearOfFormation as number) ?? existing.yearOfFormation,
      expectedYear: (data.expectedYear as number) ?? existing.expectedYear,
    });

    const updated = await this.prisma.religiousProfile.update({
      where: { id: existing.id },
      data,
      include: detailInclude,
    });
    return serializeStudent(updated);
  }

  // ─────────────────── Profile photo (PRD §6) ───────────────────
  async uploadPhoto(userId: string, file: IncomingFile): Promise<Student> {
    const profile = await this.requireOwnProfile(userId);
    const stored = await this.uploads.store('photos', file);
    const updated = await this.prisma.religiousProfile.update({
      where: { id: profile.id },
      data: {
        photoUrl: stored.url,
        profileCompletion: computeProfileCompletion({
          ...profile,
          photoUrl: stored.url,
        }),
      },
      include: detailInclude,
    });
    return serializeStudent(updated);
  }

  // ─────────────────── Verification documents (PRD §6 / §7.5) ───────────────────
  async addVerificationDoc(
    userId: string,
    label: string,
    file: IncomingFile,
  ): Promise<{ id: string; label: string; mimeType: string; sizeBytes: number }> {
    const profile = await this.requireOwnProfile(userId);
    const stored = await this.uploads.store('documents', file);
    const doc = await this.prisma.verificationDoc.create({
      data: {
        religiousId: profile.id,
        label,
        fileUrl: stored.key, // private bucket key; admins fetch via signed URL
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
      },
    });
    return {
      id: doc.id,
      label: doc.label,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
    };
  }

  async listOwnDocuments(userId: string) {
    const profile = await this.requireOwnProfile(userId);
    const docs = await this.prisma.verificationDoc.findMany({
      where: { religiousId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
    return docs.map((d) => ({
      id: d.id,
      label: d.label,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  // ─────────────────── Student dashboard (ARCHITECTURE §7.8) ───────────────────
  async dashboard(userId: string) {
    const profile = await this.prisma.religiousProfile.findUnique({
      where: { userId },
      include: detailInclude,
    });
    if (!profile) {
      throw AppException.notFound(
        'No religious profile for this account',
        'PROFILE_NOT_FOUND',
      );
    }
    const student = serializeStudent(profile);

    const totalNeeded = student.bills.reduce((s, b) => s + b.total, 0);
    const totalRaised = student.bills.reduce((s, b) => s + b.raised, 0);
    const overviewPct =
      totalNeeded <= 0 ? 0 : Math.round((totalRaised / totalNeeded) * 100);

    const pendingBills = student.bills
      .filter((b) => b.status !== 'Fully Funded' && b.status !== 'Archived')
      .sort((a, b) => {
        const pa = a.total <= 0 ? 100 : (a.raised / a.total) * 100;
        const pb = b.total <= 0 ? 100 : (b.raised / b.total) * 100;
        return pa - pb;
      });

    const [recentPayments, unreadMessages, anonSplits] = await Promise.all([
      this.receivedPayments(userId, 5),
      this.prisma.message.count({
        where: { studentId: profile.id, read: false },
      }),
      this.prisma.payment.findMany({
        where: {
          religiousId: profile.id,
          status: 'CONFIRMED',
          isAnonymous: true,
        },
        distinct: ['sponsorId'],
        select: { sponsorId: true },
      }),
    ]);

    return {
      student,
      kpis: {
        totalRaised,
        totalNeeded,
        overviewPct,
        sponsorCount: profile.sponsorCount,
        anonymousSponsors: anonSplits.length,
        unreadMessages,
        profileCompletion: profile.profileCompletion,
      },
      pendingBills,
      recentPayments,
    };
  }

  // ─────────────────── Received payments (contributions) ───────────────────
  /** Flattened confirmed contribution splits addressed to this student. */
  async receivedPayments(userId: string, limit?: number) {
    const profile = await this.requireOwnProfile(userId);
    const splits = await this.prisma.paymentSplit.findMany({
      where: {
        bill: { religiousId: profile.id },
        payment: { status: 'CONFIRMED' },
      },
      include: { payment: { include: { sponsor: true } } },
      orderBy: { payment: { confirmedAt: 'desc' } },
      ...(limit ? { take: limit } : {}),
    });
    // Student view is NOT admin — anonymous donors stay hidden.
    return splits.map((s) => serializeContribution(s));
  }

  // ─────────────────── helpers ───────────────────
  private async uniqueSlug(name: string, selfId?: string): Promise<string> {
    const base = slugify(name) || 'student';
    let candidate = base;
    let n = 1;
    // Avoid colliding with a different profile's slug.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await this.prisma.religiousProfile.findUnique({
        where: { slug: candidate },
      });
      if (!clash || clash.id === selfId) return candidate;
      candidate = `${base}-${++n}`;
    }
  }
}
