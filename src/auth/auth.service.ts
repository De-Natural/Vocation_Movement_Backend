import { Inject, Injectable, Logger } from '@nestjs/common';
import { Role, User } from '@prisma/client';
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

const BCRYPT_COST = 12; // PRD §5.2
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h verify
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h reset

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
  async login(input: LoginInput): Promise<{ user: User; tokens: AuthTokens }> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Constant-ish message to avoid leaking which emails exist.
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw AppException.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.isSuspended) {
      throw AppException.forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED');
    }
    // If the sign-in page sent a role tab, it must match.
    if (input.role && roleFromApi[input.role] !== user.role) {
      throw AppException.forbidden(
        'This account is not registered for the selected role',
        'ROLE_MISMATCH',
      );
    }

    const tokens = await this.issueTokens(user);
    return { user, tokens };
  }

  // ─────────────────────────── Refresh ───────────────────────────
  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const { userId, refreshToken } =
      await this.tokens.rotateRefreshToken(rawRefreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isSuspended) {
      throw AppException.unauthorized('Account no longer active');
    }
    const accessToken = await this.tokens.signAccessToken(user);
    return { accessToken, refreshToken };
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
    const link = `${this.config.apiUrl}/api/auth/verify-email/${token}`;
    await this.notifications.sendEmail({
      to: user.email,
      template: 'email-verify',
      subject: 'Verify your email — Vocation Movement',
      data: { link, expiresInHours: 24 },
    });
  }

  private async notifyAdminsNewSubmission(studentName: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
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
