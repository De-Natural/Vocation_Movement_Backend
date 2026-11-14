import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AppException } from '../common/http/app-exception';
import { roleFromApi, stageFromApi } from '../common/serializers/enum-maps';
import { slugify, computeProfileCompletion } from '../common/utils/profile';
import { NotificationsService } from '../notifications/notifications.module';
import { TokenService } from './token.service';
import {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.dto';
import { isStaff } from '../common/auth/staff';
import { SettingsService } from '../settings/settings.service';
import { MAINTENANCE_MESSAGE } from '../common/auth/maintenance.guard';

const BCRYPT_COST = 12; // PRD §5.2
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h verify
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h reset

export type UserWithProfiles = Prisma.UserGetPayload<{
  include: { religiousProfile: true; sponsorProfile: true };
}>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─────────────────────────── Register ───────────────────────────
  async register(input: RegisterInput): Promise<{ userId: string; role: Role }> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw AppException.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }

    const role = roleFromApi[input.role]; // 'student'|'sponsor' → RELIGIOUS|SPONSOR
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const { anonymousDefault } = await this.settings.effective();

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          role,
          // Sponsors are usable immediately once email-verified;
          // students require admin approval before going public.
          isApproved: false,
          isVerified: false,
        },
      });

      if (role === 'RELIGIOUS') {
        const completion = computeProfileCompletion({
          formationStage: input.formationStage,
          congregationName: input.congregation,
          schoolName: input.school,
          country: input.country,
        });
        await tx.religiousProfile.create({
          data: {
            userId: created.id,
            slug: await this.uniqueSlug(tx, slugify(input.fullName)),
            fullName: input.fullName,
            formationStage: stageFromApi[input.formationStage!],
            congregationName: input.congregation!,
            schoolName: input.school!,
            country: input.country ?? '',
            verificationState: 'PENDING',
            profileCompletion: completion,
          },
        });
      } else {
        await tx.sponsorProfile.create({
          data: {
            userId: created.id,
            fullName: input.fullName,
            country: input.country ?? '',
            currency: this.config.defaults.currency,
            // Platform default (admin setting); the sponsor can change it later.
            anonymousByDefault: anonymousDefault,
          },
        });
      }
      return created;
    });

    // Email verification token + email
    await this.sendVerificationEmail(user);

    // Notify admins of a new student submission (PRD §7)
    if (role === 'RELIGIOUS') {
      await this.notifyAdminsNewSubmission(input.fullName);
    }

    return { userId: user.id, role: user.role };
  }

  // ─────────────────────────── Login ───────────────────────────
  async login(input: LoginInput): Promise<{ user: UserWithProfiles; tokens: AuthTokens }> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { religiousProfile: true, sponsorProfile: true },
    });

    // Constant-ish message to avoid leaking which emails exist.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw AppException.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.isSuspended) {
      throw AppException.forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED');
    }
    // If the sign-in page sent a role tab, it must match. Staff share the
    // "admin" tab, so a super-admin may sign in from it too.
    const tabRole = input.role ? roleFromApi[input.role] : undefined;
    const tabMatches =
      !tabRole ||
      tabRole === user.role ||
      (isStaff(tabRole) && isStaff(user.role));
    if (!tabMatches) {
      throw AppException.forbidden(
        'This account is not registered for the selected role',
        'ROLE_MISMATCH',
      );
    }

    if (!isStaff(user.role) && (await this.settings.effective()).maintenanceMode) {
      throw AppException.serviceUnavailable(MAINTENANCE_MESSAGE, 'MAINTENANCE_MODE');
    }

    const tokens = await this.issueTokens(user);
    // "Last active" for staff monitoring (best effort).
    await this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined);
    return { user, tokens };
  }

  // ─────────────────────────── Refresh ───────────────────────────
  async refresh(rawRefreshToken: string): Promise<AuthTokens & { role: Role }> {
    const { userId, refreshToken } =
      await this.tokens.rotateRefreshToken(rawRefreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isSuspended) {
      throw AppException.unauthorized('Account no longer active');
    }
    const accessToken = await this.tokens.signAccessToken(user);
    return { accessToken, refreshToken, role: user.role };
  }

  // ─────────────────────────── Logout ───────────────────────────
  async logout(rawRefreshToken?: string): Promise<void> {
    if (rawRefreshToken) {
      await this.tokens.revokeRefreshToken(rawRefreshToken);
    }
  }

  // ─────────────────────────── Verify email ───────────────────────────
  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.emailToken.findUnique({ where: { token } });
    if (
      !record ||
      record.purpose !== 'verify-email' ||
      record.usedAt ||
      record.expires < new Date()
    ) {
      throw AppException.badRequest('Invalid or expired verification link', 'INVALID_TOKEN');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { isVerified: true },
      }),
      this.prisma.emailToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);
    await this.autoApproveIfEnabled(record.userId);
  }

  /**
   * Auto-approve (Super-Admin setting, off by default). Normally every student
   * is reviewed one by one by an admin. Only while the Super-Admin has
   * auto-approve switched on does a student whose profile is still pending go
   * live as soon as they verify their email (registration + document uploads
   * are done by then). The approval is written to the activity log as a system
   * action so staff can see which profiles were never reviewed by a person.
   */
  private async autoApproveIfEnabled(userId: string): Promise<void> {
    const { autoApprove } = await this.settings.effective();
    if (!autoApprove) return;
    const profile = await this.prisma.religiousProfile.findUnique({
      where: { userId },
      include: { user: { select: { email: true, isSuspended: true } } },
    });
    if (!profile || profile.verificationState !== 'PENDING' || profile.user.isSuspended) return;

    await this.prisma.$transaction([
      this.prisma.religiousProfile.update({
        where: { id: profile.id },
        data: { verificationState: 'VERIFIED', rejectionReason: null },
      }),
      this.prisma.user.update({ where: { id: userId }, data: { isApproved: true } }),
      this.prisma.adminAction.create({
        data: {
          actorId: null,
          actorLabel: 'Auto-approve (system)',
          targetUserId: userId,
          targetLabel: profile.fullName,
          action: 'VERIFY_PROFILE',
          reason: 'Auto-approve was switched on by the Super-Admin',
        },
      }),
    ]);

    await this.notifications.notify({
      userId,
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
  }

  // ─────────────────────────── Resend verification ───────────────────────────
  async resendVerification(rawEmail: string): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Succeed silently for unknown or already-verified emails — never reveal
    // which addresses have accounts.
    if (!user || user.isVerified) return;
    await this.sendVerificationEmail(user);
  }

  // ─────────────────────────── Forgot / reset ───────────────────────────
  async forgotPassword(input: ForgotPasswordInput): Promise<void> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always succeed silently — never reveal whether the email exists.
    if (!user) return;

    const token = randomUUID() + randomUUID();
    await this.prisma.emailToken.create({
      data: {
        userId: user.id,
        token,
        purpose: 'reset-password',
        expires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });
    const link = `${this.config.frontendUrl}/reset-password?token=${token}`;
    await this.notifications.sendEmail({
      to: user.email,
      template: 'password-reset',
      subject: 'Reset your Vocation Movement password',
      data: { link, expiresInMinutes: 60 },
    });
  }

  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const record = await this.prisma.emailToken.findUnique({
      where: { token: input.token },
    });
    if (
      !record ||
      record.purpose !== 'reset-password' ||
      record.usedAt ||
      record.expires < new Date()
    ) {
      throw AppException.badRequest('Invalid or expired reset link', 'INVALID_TOKEN');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      this.prisma.emailToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  // ─────────────────────────── me ───────────────────────────
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { religiousProfile: true, sponsorProfile: true },
    });
    if (!user) throw AppException.notFound('User not found');
    return user;
  }

  // ─────────────────────────── helpers ───────────────────────────
  private async issueTokens(user: User): Promise<AuthTokens> {
    const accessToken = await this.tokens.signAccessToken(user);
    const refreshToken = await this.tokens.issueRefreshToken(user.id);
    return { accessToken, refreshToken };
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const token = randomUUID() + randomUUID();
    await this.prisma.emailToken.create({
      data: {
        userId: user.id,
        token,
        purpose: 'verify-email',
        expires: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      },
    });
    // Link to the frontend page, which calls GET /api/auth/verify-email/:token
    // and shows the result (the raw API URL would only render JSON).
    const link = `${this.config.frontendUrl}/verify-email?token=${token}`;
    await this.notifications.sendEmail({
      to: user.email,
      template: 'email-verify',
      subject: 'Verify your email — Vocation Movement',
      data: { link, expiresInHours: 24 },
    });
  }

  private async notifyAdminsNewSubmission(studentName: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, isSuspended: false },
      select: { id: true, email: true },
    });
    await Promise.all(
      admins.map((a) =>
        this.notifications.sendEmail({
          to: a.email,
          template: 'new-student-submission',
          subject: 'New student profile awaiting verification',
          data: { studentName, submittedAt: new Date().toISOString() },
        }),
      ),
    );
  }

  private async uniqueSlug(
    tx: Pick<PrismaService, 'religiousProfile'>,
    base: string,
  ): Promise<string> {
    let slug = base || 'student';
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = await tx.religiousProfile.findUnique({ where: { slug } });
      if (!exists) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }
}
