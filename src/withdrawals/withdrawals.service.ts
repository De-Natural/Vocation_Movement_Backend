import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ReligiousProfile, Withdrawal, WithdrawalStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AppException } from '../common/http/app-exception';
import { OtpService } from '../otp/otp.service';
import { NotificationsService } from '../notifications/notifications.module';
import { SMS_PROVIDER, SmsProvider, maskPhone, normalizePhone } from '../providers/sms/sms.interface';
import { StubSmsProvider } from '../providers/sms/stub-sms.provider';
import { SettingsService } from '../settings/settings.service';
import { PAYOUT_PROVIDER, PayoutProvider } from '../providers/payouts/payout.interface';
import { paginationMeta, parsePagination } from '../common/utils/pagination';

/** Only naira balances can be withdrawn (Paystack transfers go to Nigerian banks). */
const PAYOUT_CURRENCY = 'NGN';
/** An unconfirmed withdrawal holds its amount for this long, then lapses. */
const OTP_HOLD_MS = 10 * 60 * 1000;

const naira = (cents: number) =>
  `₦${(cents / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const maskAccount = (n: string) => (n.length > 4 ? `******${n.slice(-4)}` : n);

export interface WithdrawalView {
  id: string;
  amount: number;
  currency: string;
  status: 'awaiting_otp' | 'processing' | 'paid' | 'failed' | 'cancelled';
  bankName: string;
  accountNumber: string;
  accountName: string;
  reference: string;
  failureReason?: string;
  createdAt: string;
  completedAt?: string;
}

const view = (w: Withdrawal): WithdrawalView => ({
  id: w.id,
  amount: w.amountCents / 100,
  currency: w.currency,
  status: w.status.toLowerCase() as WithdrawalView['status'],
  bankName: w.bankName,
  accountNumber: maskAccount(w.accountNumber),
  accountName: w.accountName,
  reference: w.reference,
  failureReason: w.failureReason ?? undefined,
  createdAt: w.createdAt.toISOString(),
  completedAt: w.completedAt?.toISOString(),
});

/**
 * Student withdrawals. Safety rules:
 *  - a verified phone is required, and every bank-account change and
 *    every withdrawal is confirmed with an SMS code sent to it;
 *  - a verified phone can't be swapped by the student (stops someone who
 *    stole the password from redirecting the codes);
 *  - balance and limits are re-checked under a per-student lock when the
 *    code is confirmed, so two withdrawals can't spend the same money;
 *  - a transfer whose outcome is unknown (timeout) stays PROCESSING and
 *    keeps its amount reserved until the gateway's webhook settles it.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly notifications: NotificationsService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PAYOUT_PROVIDER) private readonly payouts: PayoutProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Test mode only: with no SMS service connected and no real payouts, the
   * code is handed back so it can be shown on screen (like the test card).
   * Switches off by itself once TERMII_API_KEY is set or payouts go live.
   */
  private get showTestCode(): boolean {
    return this.sms instanceof StubSmsProvider && !this.payouts.live;
  }

  // ─────────────────────────── helpers ───────────────────────────
  private async student(userId: string): Promise<ReligiousProfile & { user: { email: string } }> {
    const p = await this.prisma.religiousProfile.findUnique({
      where: { userId },
      include: { user: { select: { email: true } } },
    });
    if (!p) throw AppException.notFound('Student profile not found', 'PROFILE_NOT_FOUND');
    return p;
  }

  private verifiedPhone(p: ReligiousProfile): string {
    const phone = normalizePhone(p.phoneNumber);
    if (!p.phoneVerifiedAt || !phone) {
      throw AppException.badRequest('Please verify your phone number first.', 'PHONE_NOT_VERIFIED');
    }
    return phone;
  }

  /** `{ testCode }` in test mode only (see showTestCode), otherwise nothing. */
  private testCode(code: string): { testCode?: string } {
    return this.showTestCode ? { testCode: code } : {};
  }

  private async sendCode(phone: string, code: string, what: string): Promise<void> {
    try {
      await this.sms.send(phone, `${code} is your Vocation Movement code to ${what}. It expires in 10 minutes. Never share it.`);
    } catch (err) {
      this.logger.error(`SMS failed: ${(err as Error).message}`);
      throw AppException.serviceUnavailable('We could not send the SMS code. Please try again shortly.', 'SMS_FAILED');
    }
  }

  /**
   * Gifts received per currency (net of the platform fee) and their naira
   * value, locked when each gift was confirmed (or when the Super-Admin first
   * set a rate for its currency). `pendingCents` is the part with no rate yet:
   * shown to the student but not withdrawable.
   */
  private async receivedByCurrency(
    tx: Prisma.TransactionClient | PrismaService,
    religiousId: string,
  ) {
    const [locked, pending] = await Promise.all([
      tx.payment.groupBy({
        by: ['currency'],
        where: { religiousId, status: 'CONFIRMED', nairaNetCents: { not: null } },
        _sum: { netAmountCents: true, nairaNetCents: true },
      }),
      tx.payment.groupBy({
        by: ['currency'],
        where: { religiousId, status: 'CONFIRMED', nairaNetCents: null },
        _sum: { netAmountCents: true },
      }),
    ]);
    const currencies = new Set([...locked, ...pending].map((g) => g.currency));
    return [...currencies].map((currency) => {
      const l = locked.find((g) => g.currency === currency);
      const cents = l?._sum.netAmountCents ?? 0;
      const nairaCents = l?._sum.nairaNetCents ?? 0;
      return {
        currency,
        cents,
        nairaCents,
        // Average locked rate (gifts may have been locked at different rates).
        rate: cents > 0 ? Math.round((nairaCents / cents) * 100) / 100 : null,
        pendingCents: pending.find((g) => g.currency === currency)?._sum.netAmountCents ?? 0,
      };
    });
  }

  /** Money a student can withdraw now, in kobo. */
  private async availableCents(
    tx: Prisma.TransactionClient | PrismaService,
    religiousId: string,
  ): Promise<number> {
    const [received, held] = await Promise.all([
      this.receivedByCurrency(tx, religiousId),
      tx.withdrawal.aggregate({
        where: {
          religiousId,
          currency: PAYOUT_CURRENCY,
          OR: [
            { status: { in: ['PROCESSING', 'PAID'] } },
            { status: 'AWAITING_OTP', createdAt: { gte: new Date(Date.now() - OTP_HOLD_MS) } },
          ],
        },
        _sum: { amountCents: true },
      }),
    ]);
    const receivedNaira = received.reduce((sum, r) => sum + r.nairaCents, 0);
    return Math.max(0, receivedNaira - (held._sum.amountCents ?? 0));
  }

  // ─────────────────────────── summary ───────────────────────────
  async summary(userId: string) {
    const p = await this.student(userId);
    const [account, availableCents, received, recent] = await Promise.all([
      this.prisma.payoutAccount.findUnique({ where: { religiousId: p.id } }),
      this.availableCents(this.prisma, p.id),
      this.receivedByCurrency(this.prisma, p.id),
      this.prisma.withdrawal.findMany({
        where: { religiousId: p.id, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    const phone = normalizePhone(p.phoneNumber);
    return {
      currency: PAYOUT_CURRENCY,
      available: availableCents / 100,
      // Foreign-currency gifts converted to naira at the Super-Admin's payout rate.
      converted: received
        .filter((r) => r.currency !== PAYOUT_CURRENCY && r.cents > 0)
        .map((r) => ({ currency: r.currency, amount: r.cents / 100, rate: r.rate ?? 0, naira: r.nairaCents / 100 })),
      // Gifts in a currency with no exchange rate yet: shown, but not withdrawable.
      otherBalances: received
        .filter((r) => r.pendingCents > 0)
        .map((r) => ({ currency: r.currency, amount: r.pendingCents / 100 })),
      phone: {
        number: phone ? maskPhone(phone) : null,
        verified: !!p.phoneVerifiedAt && !!phone,
      },
      account: account
        ? {
            bankName: account.bankName,
            accountNumber: maskAccount(account.accountNumber),
            accountName: account.accountName,
          }
        : null,
      limits: {
        min: this.config.payouts.minCents / 100,
        max: this.config.payouts.maxCents / 100,
        dailyMax: this.config.payouts.dailyMaxCents / 100,
      },
      liveTransfers: this.payouts.live,
      testCodes: this.showTestCode,
      withdrawals: recent.map(view),
    };
  }

  // ─────────────────────────── phone ───────────────────────────
  async sendPhoneOtp(userId: string, rawPhone: string) {
    const p = await this.student(userId);
    // The page shows the saved number masked ("+234 706 *** 1635"); sending it
    // back unchanged (or empty) means "use the number already on my profile".
    const useSaved = !rawPhone?.trim() || rawPhone.includes('*');
    const phone = normalizePhone(useSaved ? p.phoneNumber : rawPhone);
    if (!phone) throw AppException.badRequest('Please enter a valid phone number, e.g. 08031234567.', 'INVALID_PHONE');
    const current = normalizePhone(p.phoneNumber);
    if (p.phoneVerifiedAt && current && current !== phone) {
      throw AppException.forbidden(
        'Your phone number is already verified. To change it, please contact the administrator.',
        'PHONE_LOCKED',
      );
    }
    if (p.phoneVerifiedAt && current === phone) return { sentTo: maskPhone(phone), alreadyVerified: true };
    const code = await this.otp.issue({ userId, purpose: 'phone-verify', target: phone });
    await this.sendCode(phone, code, 'verify your phone number');
    return { sentTo: maskPhone(phone), alreadyVerified: false, ...this.testCode(code) };
  }

  async verifyPhone(userId: string, code: string) {
    const p = await this.student(userId);
    const record = await this.otp.verify({ userId, purpose: 'phone-verify', code });
    await this.prisma.religiousProfile.update({
      where: { id: p.id },
      data: { phoneNumber: record.target, phoneVerifiedAt: new Date() },
    });
    return { number: maskPhone(record.target), verified: true };
  }

  // ─────────────────────────── bank account ───────────────────────────
  async banks() {
    try {
      return await this.payouts.listBanks();
    } catch (err) {
      this.logger.error(`Bank list failed: ${(err as Error).message}`);
      throw AppException.serviceUnavailable('Could not load the list of banks. Please try again.', 'BANKS_UNAVAILABLE');
    }
  }

  private async resolve(p: ReligiousProfile, bankCode: string, accountNumber: string) {
    const banks = await this.banks();
    const bank = banks.find((b) => b.code === bankCode);
    if (!bank) throw AppException.badRequest('Please choose a bank from the list.', 'UNKNOWN_BANK');
    try {
      const { accountName } = await this.payouts.resolveAccount(accountNumber, bankCode, p.fullName);
      return { bank, accountName };
    } catch {
      throw AppException.badRequest(
        'We could not verify this account with the bank. Check the number and bank, then try again.',
        'ACCOUNT_NOT_RESOLVED',
      );
    }
  }

  /** Look up the account holder's name (shown to the student before saving). */
  async resolveAccount(userId: string, bankCode: string, accountNumber: string) {
    const p = await this.student(userId);
    const { bank, accountName } = await this.resolve(p, bankCode, accountNumber);
    return { bankName: bank.name, accountNumber, accountName };
  }

  /** Step 1 of saving an account: send an SMS code to the verified phone. */
  async requestAccountChange(userId: string, bankCode: string, accountNumber: string) {
    const p = await this.student(userId);
    const phone = this.verifiedPhone(p);
    const { bank, accountName } = await this.resolve(p, bankCode, accountNumber);
    const code = await this.otp.issue({
      userId,
      purpose: 'payout-account',
      target: phone,
      ref: `${bankCode}:${accountNumber}`,
    });
    await this.sendCode(phone, code, 'save your bank account');
    return { sentTo: maskPhone(phone), bankName: bank.name, accountName, ...this.testCode(code) };
  }

  /** Step 2: the code confirms the change; the account is re-verified and saved. */
  async confirmAccountChange(userId: string, code: string) {
    const p = await this.student(userId);
    this.verifiedPhone(p);
    const record = await this.otp.verify({ userId, purpose: 'payout-account', code });
    const [bankCode, accountNumber] = (record.ref ?? '').split(':');
    const { bank, accountName } = await this.resolve(p, bankCode, accountNumber);
    const saved = await this.prisma.payoutAccount.upsert({
      where: { religiousId: p.id },
      create: { religiousId: p.id, bankCode, bankName: bank.name, accountNumber, accountName },
      // A new account needs a new transfer recipient.
      update: { bankCode, bankName: bank.name, accountNumber, accountName, recipientCode: null, verifiedAt: new Date() },
    });
    return { bankName: saved.bankName, accountNumber: maskAccount(saved.accountNumber), accountName: saved.accountName };
  }

  // ─────────────────────────── withdraw ───────────────────────────
  /** Step 1: create the withdrawal and text a code to the verified phone. */
  async start(userId: string, amount: number) {
    const p = await this.student(userId);
    const phone = this.verifiedPhone(p);
    const account = await this.prisma.payoutAccount.findUnique({ where: { religiousId: p.id } });
    if (!account) throw AppException.badRequest('Please add your bank account first.', 'NO_PAYOUT_ACCOUNT');

    const amountCents = Math.round(amount * 100);
    const { minCents, maxCents } = this.config.payouts;
    if (amountCents < minCents) throw AppException.badRequest(`The minimum withdrawal is ${naira(minCents)}.`, 'BELOW_MINIMUM');
    if (amountCents > maxCents) throw AppException.badRequest(`The maximum per withdrawal is ${naira(maxCents)}.`, 'ABOVE_MAXIMUM');
    const available = await this.availableCents(this.prisma, p.id);
    if (amountCents > available) {
      throw AppException.badRequest(`You can withdraw up to ${naira(available)}.`, 'INSUFFICIENT_BALANCE');
    }

    // Only one unconfirmed withdrawal at a time: replace any earlier one.
    await this.prisma.withdrawal.updateMany({
      where: { religiousId: p.id, status: 'AWAITING_OTP' },
      data: { status: 'CANCELLED' },
    });
    const w = await this.prisma.withdrawal.create({
      data: {
        religiousId: p.id,
        amountCents,
        currency: PAYOUT_CURRENCY,
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        reference: `vm-wd-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      },
    });
    let code: string;
    try {
      code = await this.otp.issue({ userId, purpose: 'withdrawal', target: phone, ref: w.id });
      await this.sendCode(phone, code, `confirm a withdrawal of ${naira(amountCents)}`);
    } catch (err) {
      await this.prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'CANCELLED' } });
      throw err;
    }
    return { withdrawal: view(w), sentTo: maskPhone(phone), ...this.testCode(code) };
  }

  /** Step 2: the SMS code confirms the withdrawal and the transfer is sent. */
  async confirm(userId: string, withdrawalId: string, code: string) {
    const p = await this.student(userId);
    const w = await this.prisma.withdrawal.findFirst({ where: { id: withdrawalId, religiousId: p.id } });
    if (!w) throw AppException.notFound('Withdrawal not found', 'NOT_FOUND');
    if (w.status === 'PROCESSING' || w.status === 'PAID') {
      throw AppException.badRequest('This withdrawal was already confirmed.', 'ALREADY_CONFIRMED');
    }
    if (w.status !== 'AWAITING_OTP' || w.createdAt.getTime() < Date.now() - OTP_HOLD_MS) {
      throw AppException.badRequest('This withdrawal has expired. Please start again.', 'WITHDRAWAL_EXPIRED');
    }
    await this.otp.verify({ userId, purpose: 'withdrawal', code, ref: w.id });

    // Re-check balance and the daily limit under a per-student lock.
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.id}))`;
      const fresh = await tx.withdrawal.findUnique({ where: { id: w.id } });
      if (!fresh || fresh.status !== 'AWAITING_OTP') return null;
      // Balance without this withdrawal's own hold.
      const available = (await this.availableCents(tx, p.id)) + fresh.amountCents;
      if (fresh.amountCents > available) {
        throw AppException.badRequest('Your available balance has changed. Please start again.', 'INSUFFICIENT_BALANCE');
      }
      const today = await tx.withdrawal.aggregate({
        where: {
          religiousId: p.id,
          status: { in: ['PROCESSING', 'PAID'] },
          confirmedAt: { gte: new Date(Date.now() - 24 * 3600_000) },
        },
        _sum: { amountCents: true },
      });
      if ((today._sum.amountCents ?? 0) + fresh.amountCents > this.config.payouts.dailyMaxCents) {
        throw AppException.badRequest(
          `This would pass the daily limit of ${naira(this.config.payouts.dailyMaxCents)}.`,
          'DAILY_LIMIT',
        );
      }
      return tx.withdrawal.update({
        where: { id: w.id },
        data: { status: 'PROCESSING', confirmedAt: new Date() },
      });
    });
    if (!claimed) throw AppException.badRequest('This withdrawal was already confirmed.', 'ALREADY_CONFIRMED');

    return view(await this.sendTransfer(claimed, p));
  }

  private async sendTransfer(w: Withdrawal, p: ReligiousProfile & { user: { email: string } }): Promise<Withdrawal> {
    let account = await this.prisma.payoutAccount.findUnique({ where: { religiousId: p.id } });
    try {
      if (!account) throw new Error('Bank account missing');
      if (!account.recipientCode) {
        const recipientCode = await this.payouts.createRecipient({
          name: account.accountName,
          accountNumber: account.accountNumber,
          bankCode: account.bankCode,
        });
        account = await this.prisma.payoutAccount.update({ where: { id: account.id }, data: { recipientCode } });
      }
      const result = await this.payouts.transfer({
        amountCents: w.amountCents,
        recipientCode: account.recipientCode!,
        reference: w.reference,
        reason: 'Vocation Movement withdrawal',
      });
      if (result.status === 'failed') {
        return this.settle(w.reference, 'FAILED', result.message ?? 'The bank declined the transfer.');
      }
      const updated = await this.prisma.withdrawal.update({
        where: { id: w.id },
        data: { transferCode: result.transferCode },
      });
      return result.status === 'success' ? this.settle(w.reference, 'PAID') : updated;
    } catch (err) {
      const e = err as Error;
      const unknownOutcome = e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError;
      if (unknownOutcome) {
        // The transfer may have gone through: keep it PROCESSING (money stays
        // reserved) until the webhook or an admin settles it.
        this.logger.error(`Transfer outcome unknown for ${w.reference}: ${e.message}`);
        return this.prisma.withdrawal.update({
          where: { id: w.id },
          data: { failureReason: 'Waiting for the bank to confirm.' },
        });
      }
      this.logger.error(`Transfer failed for ${w.reference}: ${e.message}`);
      return this.settle(w.reference, 'FAILED', 'The transfer could not be started. Your balance has been restored.');
    }
  }

  /** Move a PROCESSING withdrawal to PAID or FAILED (idempotent) and tell the student. */
  private async settle(reference: string, status: 'PAID' | 'FAILED', reason?: string): Promise<Withdrawal> {
    const res = await this.prisma.withdrawal.updateMany({
      where: { reference, status: 'PROCESSING' },
      data: { status, completedAt: new Date(), failureReason: status === 'FAILED' ? reason : null },
    });
    const w = await this.prisma.withdrawal.findUniqueOrThrow({
      where: { reference },
      include: { religious: { include: { user: { select: { email: true } } } } },
    });
    if (res.count === 1) {
      const paid = status === 'PAID';
      const data = {
        name: w.religious.fullName,
        amount: naira(w.amountCents),
        bank: w.bankName,
        account: maskAccount(w.accountNumber),
        reference: w.reference,
        reason,
      };
      await this.notifications.notify({
        userId: w.religious.userId,
        type: paid ? 'WITHDRAWAL_PAID' : 'WITHDRAWAL_FAILED',
        title: paid ? 'Withdrawal sent' : 'Withdrawal failed',
        body: paid
          ? `${data.amount} has been sent to ${w.bankName} ${data.account}.`
          : `${data.amount} could not be sent and is back in your balance.`,
        meta: { withdrawalId: w.id },
      });
      await this.notifications.sendEmail({
        to: w.religious.user.email,
        template: paid ? 'withdrawal-paid' : 'withdrawal-failed',
        subject: paid ? `Your withdrawal of ${data.amount} has been sent` : `Your withdrawal of ${data.amount} failed`,
        data,
      });
    }
    return w;
  }

  // ─────────────────────────── webhook ───────────────────────────
  async handlePaystackWebhook(raw: Buffer, signature: string | undefined) {
    if (!this.payouts.verifyWebhook(raw, signature)) {
      throw AppException.unauthorized('Invalid signature', 'INVALID_SIGNATURE');
    }
    const event = JSON.parse(raw.toString('utf8')) as { event?: string; data?: { reference?: string; reason?: string } };
    const reference = event.data?.reference;
    if (!reference || !reference.startsWith('vm-wd-')) return { received: true };
    if (event.event === 'transfer.success') await this.settle(reference, 'PAID');
    if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
      await this.settle(reference, 'FAILED', event.data?.reason || 'The bank reversed the transfer.');
    }
    return { received: true };
  }

  // ─────────────────────────── history / admin ───────────────────────────
  async history(userId: string, page?: string, perPage?: string) {
    const p = await this.student(userId);
    const pg = parsePagination(page, perPage);
    const where = { religiousId: p.id, status: { not: WithdrawalStatus.CANCELLED } };
    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return { items: rows.map(view), meta: paginationMeta(pg.page, pg.perPage, total) };
  }

  async adminList(page?: string, perPage?: string, status?: string) {
    const pg = parsePagination(page, perPage);
    const s = status?.toUpperCase() as WithdrawalStatus | undefined;
    const where: Prisma.WithdrawalWhereInput = s && s in WithdrawalStatus
      ? { status: s }
      : { status: { not: 'CANCELLED' } };
    const [rows, total, sums] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
        include: { religious: { select: { fullName: true, slug: true } } },
      }),
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.groupBy({ by: ['status'], _sum: { amountCents: true }, _count: { _all: true } }),
    ]);
    return {
      items: rows.map((w) => ({ ...view(w), studentName: w.religious.fullName, studentSlug: w.religious.slug })),
      totals: Object.fromEntries(
        sums.map((g) => [g.status.toLowerCase(), { count: g._count._all, amount: (g._sum.amountCents ?? 0) / 100 }]),
      ),
      liveTransfers: this.payouts.live,
      meta: paginationMeta(pg.page, pg.perPage, total),
    };
  }
}
