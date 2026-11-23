import { Global, Injectable, Module } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { OtpCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AppException } from '../common/http/app-exception';

export type OtpPurpose = 'email-verify' | 'phone-verify' | 'payout-account' | 'withdrawal';

const CODE_TTL_MS = 10 * 60 * 1000; // a code lives 10 minutes
const MAX_ATTEMPTS = 5; // wrong guesses allowed per code
const RESEND_COOLDOWN_MS = 60 * 1000; // one new code per minute
const MAX_SENDS_PER_HOUR = 5;

const hashCode = (userId: string, code: string) =>
  createHash('sha256').update(`${userId}:${code}`).digest('hex');

/**
 * One-time numeric codes sent by email or SMS. Only a hash is stored, a
 * new code replaces any earlier one for the same purpose, and each code
 * allows a few wrong guesses before it is burned.
 */
@Injectable()
export class OtpService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a fresh 6-digit code and return it (for the caller to send). */
  async issue(params: {
    userId: string;
    purpose: OtpPurpose;
    target: string;
    ref?: string;
  }): Promise<string> {
    const now = Date.now();
    const recent = await this.prisma.otpCode.findMany({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        createdAt: { gte: new Date(now - 3600_000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent[0] && now - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - recent[0].createdAt.getTime())) / 1000);
      throw AppException.tooManyRequests(`Please wait ${wait} seconds before requesting a new code.`, 'OTP_COOLDOWN');
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw AppException.tooManyRequests('Too many codes requested. Please try again in an hour.', 'OTP_LIMIT');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.$transaction([
      // Retire earlier codes so only the newest one works.
      this.prisma.otpCode.updateMany({
        where: { userId: params.userId, purpose: params.purpose, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.otpCode.create({
        data: {
          userId: params.userId,
          purpose: params.purpose,
          target: params.target,
          ref: params.ref,
          codeHash: hashCode(params.userId, code),
          expires: new Date(now + CODE_TTL_MS),
        },
      }),
    ]);
    return code;
  }

  /** Check a code; on success it is consumed and the record returned. */
  async verify(params: {
    userId: string;
    purpose: OtpPurpose;
    code: string;
    ref?: string;
  }): Promise<OtpCode> {
    const record = await this.prisma.otpCode.findFirst({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        usedAt: null,
        ...(params.ref ? { ref: params.ref } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.expires.getTime() < Date.now()) {
      throw AppException.badRequest('This code has expired. Please request a new one.', 'OTP_EXPIRED');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw AppException.badRequest('Too many wrong attempts. Please request a new code.', 'OTP_LOCKED');
    }

    const given = Buffer.from(hashCode(params.userId, (params.code || '').trim()));
    const stored = Buffer.from(record.codeHash);
    const match = given.length === stored.length && timingSafeEqual(given, stored);
    if (!match) {
      const updated = await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      const left = MAX_ATTEMPTS - updated.attempts;
      throw AppException.badRequest(
        left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.',
        left > 0 ? 'OTP_INVALID' : 'OTP_LOCKED',
      );
    }

    // Consume atomically so the same code can't be used twice in parallel.
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw AppException.badRequest('This code has already been used.', 'OTP_USED');
    }
    return record;
  }
}

@Global()
@Module({ providers: [OtpService], exports: [OtpService] })
export class OtpModule {}
