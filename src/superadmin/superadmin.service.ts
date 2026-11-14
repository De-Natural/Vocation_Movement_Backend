import { Injectable } from '@nestjs/common';
import { AdminActionType, Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.module';
import { AppException } from '../common/http/app-exception';
import { parsePagination, paginationMeta } from '../common/utils/pagination';
import { centsToUnits, verificationToApi } from '../common/serializers/enum-maps';
import { ActivityQuery, CreateAdminInput, UsersQuery } from './superadmin.dto';

const BCRYPT_COST = 12; // same as auth.service (PRD §5.2)

/** A staff account as shown on the Manage Admins page. */
export interface StaffRow {
  id: string;
  name: string;
  email: string;
  tier: 'admin' | 'superadmin';
  status: 'Active' | 'Suspended';
  createdAt: string;
  lastActive?: string;
  actionsCount: number;
}

/** A student or sponsor account as shown on the Users page. */
export interface UserRow {
  id: string;
  profileId?: string;
  slug?: string;
  role: 'student' | 'sponsor';
  name: string;
  email: string;
  emailVerified: boolean;
  status: 'Active' | 'Suspended';
  verification?: string; // students only
  createdAt: string;
  lastActive?: string;
  /** Student: total raised. Sponsor: total given (confirmed). */
  amount: number;
}

export interface ActivityRow {
  id: string;
  action: AdminActionType;
  actorId: string | null;
  actorName: string;
  targetUserId: string | null;
  targetName: string | null;
  reason: string | null;
  createdAt: string;
}

const staffName = (u: Pick<User, 'name' | 'email'>) => u.name?.trim() || u.email;

/**
 * Super-Admin oversight (SUPERADMIN only): staff management, a directory of
 * every student & sponsor, and the platform-wide audit log.
 */
@Injectable()
export class SuperAdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════ Staff (admins) ═══════════════════

  async listStaff(): Promise<StaffRow[]> {
    const staff = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERADMIN'] } },
      include: { _count: { select: { adminActionsActor: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return staff
      .map((u): StaffRow => ({
        id: u.id,
        name: staffName(u),
        email: u.email,
        tier: u.role === 'SUPERADMIN' ? 'superadmin' : 'admin',
        status: u.isSuspended ? 'Suspended' : 'Active',
        createdAt: u.createdAt.toISOString(),
        lastActive: u.lastLoginAt?.toISOString(),
        actionsCount: u._count.adminActionsActor,
      }))
      // Super-admins first, then admins by creation date.
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'superadmin' ? -1 : 1));
  }

  async createAdmin(actorId: string, dto: CreateAdminInput): Promise<StaffRow> {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) {
      throw AppException.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          role: 'ADMIN',
          name: dto.name,
          // Provisioned by the super-admin: no email-verification step.
          isVerified: true,
          isApproved: true,
        },
      });
      await tx.adminAction.create({
        data: { actorId, targetUserId: created.id, targetLabel: dto.name, action: 'CREATE_ADMIN' },
      });
      return created;
    });
    return {
      id: user.id,
      name: staffName(user),
      email: user.email,
      tier: 'admin',
      status: 'Active',
      createdAt: user.createdAt.toISOString(),
      actionsCount: 0,
    };
  }

  /** A normal ADMIN the super-admin may act on (never self, never another super-admin). */
  private async requireManageableAdmin(actorId: string, id: string) {
    if (id === actorId) {
      throw AppException.forbidden('You cannot change your own account here', 'CANNOT_TARGET_SELF');
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERADMIN')) {
      throw AppException.notFound('Admin not found', 'ADMIN_NOT_FOUND');
    }
    if (user.role === 'SUPERADMIN') {
      throw AppException.forbidden(
        'Super-Admin accounts cannot be changed here',
        'CANNOT_TARGET_SUPERADMIN',
      );
    }
    return user;
  }

  async setAdminSuspended(actorId: string, id: string, suspended: boolean, reason: string) {
    const user = await this.requireManageableAdmin(actorId, id);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { isSuspended: suspended } }),
      this.prisma.adminAction.create({
        data: {
          actorId,
          targetUserId: id,
          targetLabel: staffName(user),
          action: suspended ? 'SUSPEND_USER' : 'UNSUSPEND_USER',
          reason,
        },
      }),
    ]);
    return { id, status: suspended ? 'Suspended' : 'Active' };
  }

  /**
   * Permanently delete an admin. Their audit history is kept: past actions
   * are re-labelled "<name> (deleted)" and the actor link is cleared by the
   * foreign key's ON DELETE SET NULL.
   */
  async deleteAdmin(actorId: string, id: string, reason: string) {
    const user = await this.requireManageableAdmin(actorId, id);
    const label = `${staffName(user)} (deleted)`;
    await this.prisma.$transaction([
      this.prisma.adminAction.updateMany({ where: { actorId: id }, data: { actorLabel: label } }),
      this.prisma.adminAction.updateMany({ where: { targetUserId: id }, data: { targetLabel: label } }),
      this.prisma.adminAction.create({
        data: { actorId, targetLabel: label, action: 'DELETE_ADMIN', reason },
      }),
      this.prisma.user.delete({ where: { id } }),
    ]);
    return { id, deleted: true };
  }

  // ═══════════════════ Students & sponsors ═══════════════════

  async listUsers(query: UsersQuery) {
    const roles: Role[] =
      query.role === 'student'
        ? ['RELIGIOUS']
        : query.role === 'sponsor'
          ? ['SPONSOR']
          : ['RELIGIOUS', 'SPONSOR'];
    const where: Prisma.UserWhereInput = { role: { in: roles } };
    if (query.status === 'active') where.isSuspended = false;
    if (query.status === 'suspended') where.isSuspended = true;
    if (query.search) {
      const q = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { email: q },
        { religiousProfile: { fullName: q } },
        { sponsorProfile: { fullName: q } },
      ];
    }
    const { page, perPage, skip, take } = parsePagination(query.page, query.perPage);
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { religiousProfile: true, sponsorProfile: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    // Sponsors' lifetime giving (confirmed payments) in one query.
    const sponsorIds = users
      .map((u) => u.sponsorProfile?.id)
      .filter((x): x is string => !!x);
    const given = sponsorIds.length
      ? await this.prisma.payment.groupBy({
          by: ['sponsorId'],
          where: { sponsorId: { in: sponsorIds }, status: 'CONFIRMED' },
          _sum: { amountCents: true },
        })
      : [];
    const givenBy = new Map(given.map((g) => [g.sponsorId, g._sum.amountCents ?? 0]));

    const rows: UserRow[] = users.map((u) => {
      const student = u.religiousProfile;
      const sponsor = u.sponsorProfile;
      return {
        id: u.id,
        profileId: student?.id ?? sponsor?.id,
        slug: student?.slug,
        role: u.role === 'RELIGIOUS' ? 'student' : 'sponsor',
        name: student?.fullName ?? sponsor?.fullName ?? u.email,
        email: u.email,
        emailVerified: u.isVerified,
        status: u.isSuspended ? 'Suspended' : 'Active',
        verification: student ? verificationToApi[student.verificationState] : undefined,
        createdAt: u.createdAt.toISOString(),
        lastActive: u.lastLoginAt?.toISOString(),
        amount: student
          ? centsToUnits(student.totalRaisedCents)
          : centsToUnits(sponsor ? givenBy.get(sponsor.id) ?? 0 : 0),
      };
    });
    return { rows, meta: paginationMeta(page, perPage, total) };
  }

  /** Lift a suspension on a student or sponsor. */
  async reactivateUser(actorId: string, id: string, reason: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { religiousProfile: true, sponsorProfile: true },
    });
    if (!user || (user.role !== 'RELIGIOUS' && user.role !== 'SPONSOR')) {
      throw AppException.notFound('User not found', 'USER_NOT_FOUND');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { isSuspended: false } });
      // A suspended student goes back to review rather than straight to public.
      if (user.religiousProfile?.verificationState === 'SUSPENDED') {
        await tx.religiousProfile.update({
          where: { id: user.religiousProfile.id },
          data: { verificationState: 'PENDING' },
        });
      }
      await tx.adminAction.create({
        data: {
          actorId,
          targetUserId: id,
          targetLabel:
            user.religiousProfile?.fullName ?? user.sponsorProfile?.fullName ?? user.email,
          action: 'UNSUSPEND_USER',
          reason,
        },
      });
    });
    return { id, status: 'Active' };
  }

  // ═══════════════════ Audit log & overview ═══════════════════

  async activity(query: ActivityQuery) {
    const where: Prisma.AdminActionWhereInput = query.actorId ? { actorId: query.actorId } : {};
    const { page, perPage, skip, take } = parsePagination(query.page, query.perPage);
    const [actions, total] = await Promise.all([
      this.prisma.adminAction.findMany({
        where,
        include: {
          actor: true,
          targetUser: { include: { religiousProfile: true, sponsorProfile: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.adminAction.count({ where }),
    ]);
    const rows: ActivityRow[] = actions.map((a) => ({
      id: a.id,
      action: a.action,
      actorId: a.actorId,
      actorName: a.actor ? staffName(a.actor) : a.actorLabel ?? 'Deleted admin',
      targetUserId: a.targetUserId,
      targetName: a.targetUser
        ? a.targetUser.religiousProfile?.fullName ??
          a.targetUser.sponsorProfile?.fullName ??
          a.targetUser.name ??
          a.targetUser.email
        : a.targetLabel,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    }));
    return { rows, meta: paginationMeta(page, perPage, total) };
  }

  async overview() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [byRole, suspended, byVerification, funds, recent, actions30d] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { isSuspended: true },
        _count: { _all: true },
      }),
      this.prisma.religiousProfile.groupBy({
        by: ['verificationState'],
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        _sum: { amountCents: true },
        where: { status: 'CONFIRMED' },
      }),
      this.activity({ perPage: 8 }),
      this.prisma.adminAction.count({ where: { createdAt: { gte: since } } }),
    ]);
    const count = (rows: { role: Role; _count: { _all: number } }[], role: Role) =>
      rows.find((r) => r.role === role)?._count._all ?? 0;
    const verification: Record<string, number> = {};
    for (const v of byVerification) {
      verification[verificationToApi[v.verificationState]] = v._count._all;
    }
    return {
      counts: {
        superAdmins: count(byRole, 'SUPERADMIN'),
        admins: count(byRole, 'ADMIN'),
        students: count(byRole, 'RELIGIOUS'),
        sponsors: count(byRole, 'SPONSOR'),
        suspendedAdmins: count(suspended, 'ADMIN'),
        suspendedStudents: count(suspended, 'RELIGIOUS'),
        suspendedSponsors: count(suspended, 'SPONSOR'),
      },
      verification,
      fundsRaised: centsToUnits(funds._sum.amountCents ?? 0),
      staffActionsLast30Days: actions30d,
      recentActivity: recent.rows,
    };
  }
}
