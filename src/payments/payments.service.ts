import { Inject, Injectable, Logger } from '@nestjs/common';
import { Gateway, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { AggregationService } from '../aggregation/aggregation.service';
import { NotificationsService } from '../notifications/notifications.module';
import { SettingsService } from '../settings/settings.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AppException } from '../common/http/app-exception';
import { AuthUser } from '../common/auth/jwt-payload';
import {
  centsToUnits,
  unitsToCents,
  paymentStatusToApi,
  resolveDonorName,
} from '../common/serializers';
import {
  PaymentGateway,
  STRIPE_GATEWAY,
  PAYSTACK_GATEWAY,
  NormalizedWebhookEvent,
} from '../providers/payments/gateway.interface';
import { StubGateway } from '../providers/payments/stub-gateway.provider';
import {
  CreateIntentInputDto,
  ConfirmInputDto,
  RecurringInputDto,
} from './payments.dto';

// Frontend payment-method label → DB Gateway enum.
const methodToGateway: Record<'card' | 'paystack', Gateway> = {
  card: 'STRIPE',
  paystack: 'PAYSTACK',
};

// Unique placeholder for gatewayTxId (has a @unique constraint) that lives
// only between row creation and the gateway returning its real id.
const pendingTxId = () => `pending_${randomUUID()}`;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: AggregationService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STRIPE_GATEWAY) private readonly stripe: PaymentGateway,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaymentGateway,
  ) {}

  private gatewayFor(gateway: Gateway): PaymentGateway {
    return gateway === 'STRIPE' ? this.stripe : this.paystack;
  }

  /**
   * Fee Model A breakdown for a gift, using the current effective platform
   * fee %. Returns the platform fee and the net credited to the bill; the
   * sponsor is still charged the full `amountCents` (gross). With fee% = 0
   * (the default) feeCents is 0 and netAmountCents == amountCents.
   */
  private async feeFor(
    amountCents: number,
  ): Promise<{ feeCents: number; netAmountCents: number }> {
    const { platformFeePercent } = await this.settings.effective();
    const { feeCents, netCents } = this.settings.computeFee(
      amountCents,
      platformFeePercent,
    );
    return { feeCents, netAmountCents: netCents };
  }

  /** Resolve the SponsorProfile (+user email) owned by a user. */
  private async ownSponsor(userId: string) {
    const sponsor = await this.prisma.sponsorProfile.findUnique({
      where: { userId },
      include: { user: { select: { email: true } } },
    });
    if (!sponsor) {
      throw AppException.notFound(
        'No sponsor profile for this account',
        'SPONSOR_PROFILE_NOT_FOUND',
      );
    }
    return sponsor;
  }

  /** Load a fundable bill with its student (owner) attached. */
  private async fundableBill(billId: string) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { religious: { include: { user: true } } },
    });
    if (!bill) throw AppException.notFound('Bill not found', 'BILL_NOT_FOUND');
    if (bill.status === 'ARCHIVED') {
      throw AppException.unprocessable(
        'This bill is no longer accepting contributions',
        'BILL_NOT_AVAILABLE',
      );
    }
    if (bill.religious.verificationState !== 'VERIFIED') {
      throw AppException.unprocessable(
        'This student is not currently accepting contributions',
        'STUDENT_NOT_AVAILABLE',
      );
    }
    return bill;
  }

  // ═══════════════════ One-time gift (PRD §4.1) ═══════════════════

  /**
   * POST /api/payments/intent — create a PENDING payment and hand back a
   * clientSecret the frontend uses to collect the card directly with the
   * gateway. Card data never touches this server (PRD §5.2 / PCI).
   */
  async createIntent(userId: string, dto: CreateIntentInputDto) {
    const sponsor = await this.ownSponsor(userId);
    const bill = await this.fundableBill(dto.billId);

    const gateway = methodToGateway[dto.method];
    const amountCents = unitsToCents(dto.amount);
    const currency = sponsor.currency || this.config.defaults.currency;
    const isAnonymous = dto.anonymous ?? sponsor.anonymousByDefault;
    const { feeCents, netAmountCents } = await this.feeFor(amountCents);

    // Create the PENDING payment + its single split first so we have an id
    // to correlate the webhook against.
    const payment = await this.prisma.payment.create({
      data: {
        sponsorId: sponsor.id,
        religiousId: bill.religiousId,
        amountCents,
        feeCents,
        netAmountCents,
        currency,
        isAnonymous,
        status: 'PENDING',
        gateway,
        gatewayTxId: pendingTxId(),
        isRecurring: false,
        splits: { create: [{ billId: bill.id, amountCents, netAmountCents }] },
      },
    });

    const intent = await this.gatewayFor(gateway).createIntent({
      amountCents,
      currency,
      paymentId: payment.id,
      sponsorEmail: sponsor.user.email,
      metadata: { paymentId: payment.id, billId: bill.id },
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayTxId: intent.gatewayTxId, gatewayRef: intent.clientSecret },
    });

    return {
      paymentId: payment.id,
      gateway: intent.gateway,
      clientSecret: intent.clientSecret,
      amount: centsToUnits(amountCents),
      currency,
      // In stub mode the client can immediately POST /confirm to simulate
      // the gateway callback; in live mode confirmation arrives by webhook.
      providerMode: this.config.providerMode,
    };
  }

  // ═══════════════════ Confirm (stub self-drive / live poll) ═══════════════════

  /**
   * POST /api/payments/confirm — in stub mode this self-signs a
   * 'payment.succeeded' webhook and runs it through the same verification
   * path, so the demo completes end-to-end. In live mode the real webhook
   * confirms the charge; here we simply report the current status.
   */
  async confirm(userId: string, dto: ConfirmInputDto) {
    const sponsor = await this.ownSponsor(userId);
    const payment = await this.prisma.payment.findUnique({
      where: { id: dto.paymentId },
    });
    if (!payment || payment.sponsorId !== sponsor.id) {
      throw AppException.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    }
    if (payment.status === 'CONFIRMED') {
      return { paymentId: payment.id, status: paymentStatusToApi.CONFIRMED };
    }

    if (this.config.providerMode === 'stub') {
      const gw = this.gatewayFor(payment.gateway);
      if (gw instanceof StubGateway) {
        const { body, signature } = gw.buildTestWebhook({
          type: 'payment.succeeded',
          gatewayTxId: payment.gatewayTxId,
          paymentId: payment.id,
          amountCents: payment.amountCents,
          currency: payment.currency,
        });
        await this.handleWebhook(payment.gateway, Buffer.from(body), signature);
      }
    }

    const fresh = await this.prisma.payment.findUnique({
      where: { id: payment.id },
    });
    return {
      paymentId: payment.id,
      status: paymentStatusToApi[fresh?.status ?? 'PENDING'],
    };
  }

  // ═══════════════════ Recurring monthly gift (PRD §4 / §7.4) ═══════════════════

  /**
   * POST /api/payments/recurring — open a monthly sponsorship. Creates the
   * Sponsorship, the first PENDING payment, and a gateway subscription. The
   * first charge is confirmed via the normal confirm/webhook path; later
   * charges are driven by the recurring-charge cron (§8).
   */
  async createRecurring(userId: string, dto: RecurringInputDto) {
    const sponsor = await this.ownSponsor(userId);
    const bill = await this.fundableBill(dto.billId);

    const gateway = methodToGateway[dto.method];
    const amountCents = unitsToCents(dto.amount);
    const currency = sponsor.currency || this.config.defaults.currency;
    const isAnonymous = dto.anonymous ?? sponsor.anonymousByDefault;
    const { feeCents, netAmountCents } = await this.feeFor(amountCents);

    const nextChargeDate = new Date();
    nextChargeDate.setMonth(nextChargeDate.getMonth() + 1);

    const { sponsorship, payment } = await this.prisma.$transaction(
      async (tx) => {
        const sub = await tx.sponsorship.create({
          data: {
            sponsorId: sponsor.id,
            religiousId: bill.religiousId,
            billId: bill.id,
            amountCents,
            currency,
            status: 'ACTIVE',
            gateway,
            nextChargeDate,
            isAnonymous,
          },
        });
        const pay = await tx.payment.create({
          data: {
            sponsorId: sponsor.id,
            religiousId: bill.religiousId,
            amountCents,
            feeCents,
            netAmountCents,
            currency,
            isAnonymous,
            status: 'PENDING',
            gateway,
            gatewayTxId: pendingTxId(),
            isRecurring: true,
            sponsorshipId: sub.id,
            splits: { create: [{ billId: bill.id, amountCents, netAmountCents }] },
          },
        });
        return { sponsorship: sub, payment: pay };
      },
    );

    const result = await this.gatewayFor(gateway).createSubscription({
      amountCents,
      currency,
      sponsorshipId: sponsorship.id,
      sponsorEmail: sponsor.user.email,
      metadata: { sponsorshipId: sponsorship.id, paymentId: payment.id },
    });

    await this.prisma.$transaction([
      this.prisma.sponsorship.update({
        where: { id: sponsorship.id },
        data: { gatewaySubId: result.gatewaySubId },
      }),
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { gatewayRef: result.clientSecret },
      }),
    ]);

    return {
      sponsorshipId: sponsorship.id,
      paymentId: payment.id,
      gateway: result.gateway,
      clientSecret: result.clientSecret,
      amount: centsToUnits(amountCents),
      currency,
      nextChargeDate: nextChargeDate.toISOString(),
      providerMode: this.config.providerMode,
    };
  }

  // ═══════════════════ Webhooks (PRD §5.2, §7.3) ═══════════════════

  /**
   * Verify a gateway webhook signature, normalise it, and apply the state
   * change. Idempotent — a duplicate 'succeeded' delivery is a no-op. This
   * is the ONLY place a Payment becomes CONFIRMED and `raised` moves.
   */
  async handleWebhook(
    gateway: Gateway,
    rawBody: Buffer,
    signature: string,
  ): Promise<{ received: true }> {
    let event: NormalizedWebhookEvent;
    try {
      event = this.gatewayFor(gateway).verifyAndParseWebhook(rawBody, signature);
    } catch {
      // PRD §5.2 — reject unverified webhooks outright.
      throw AppException.unauthorized(
        'Invalid webhook signature',
        'INVALID_WEBHOOK_SIGNATURE',
      );
    }

    switch (event.type) {
      case 'payment.succeeded':
        await this.markSucceeded(event);
        break;
      case 'subscription.charged':
        await this.recordRecurringCharge(event);
        break;
      case 'payment.failed':
        await this.markFailed(event);
        break;
      default:
        this.logger.warn(`Ignoring unhandled webhook type: ${event.type}`);
    }

    return { received: true };
  }

  /** Confirm a payment and move all the money it touches. */
  private async markSucceeded(event: NormalizedWebhookEvent): Promise<void> {
    const payment = await this.locatePayment(event);
    if (!payment) {
      this.logger.warn(
        `succeeded webhook for unknown payment ${event.paymentId ?? event.gatewayTxId}`,
      );
      return;
    }
    if (payment.status === 'CONFIRMED') return; // idempotent

    const billIds = payment.splits.map((s) => s.billId);

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          gatewayRef: null, // clear the transient client secret
        },
      });
      // Move every progress bar this payment feeds, then the student totals.
      for (const billId of billIds) {
        await this.aggregation.recomputeBill(billId, tx);
      }
      await this.aggregation.recomputeReligiousAggregates(
        payment.religiousId,
        tx,
      );
    });

    await this.announceConfirmed(payment.id);
  }

  /** Record a recurring charge as a fresh confirmed payment + advance the schedule. */
  private async recordRecurringCharge(
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    // If the event already carries a concrete paymentId (the first charge),
    // just confirm it like any other.
    if (event.paymentId) {
      await this.markSucceeded(event);
      return;
    }
    if (!event.sponsorshipId) return;

    const sponsorship = await this.prisma.sponsorship.findUnique({
      where: { id: event.sponsorshipId },
    });
    if (!sponsorship || sponsorship.status !== 'ACTIVE') return;

    const chargeCents = event.amountCents ?? sponsorship.amountCents;
    const { feeCents, netAmountCents } = await this.feeFor(chargeCents);

    const created = await this.prisma.$transaction(async (tx) => {
      const pay = await tx.payment.create({
        data: {
          sponsorId: sponsorship.sponsorId,
          religiousId: sponsorship.religiousId,
          amountCents: chargeCents,
          feeCents,
          netAmountCents,
          currency: event.currency ?? sponsorship.currency,
          isAnonymous: sponsorship.isAnonymous,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          gateway: sponsorship.gateway,
          gatewayTxId: event.gatewayTxId,
          isRecurring: true,
          sponsorshipId: sponsorship.id,
          splits: {
            create: [
              {
                billId: sponsorship.billId,
                amountCents: chargeCents,
                netAmountCents,
              },
            ],
          },
        },
      });
      await this.aggregation.recomputeBill(sponsorship.billId, tx);
      await this.aggregation.recomputeReligiousAggregates(
        sponsorship.religiousId,
        tx,
      );
      // Advance the next charge date by a month.
      const next = new Date(sponsorship.nextChargeDate);
      next.setMonth(next.getMonth() + 1);
      await tx.sponsorship.update({
        where: { id: sponsorship.id },
        data: { nextChargeDate: next },
      });
      return pay;
    });

    await this.announceConfirmed(created.id);
  }

  /** Mark a payment failed (records the reason; does not move any totals). */
  private async markFailed(event: NormalizedWebhookEvent): Promise<void> {
    const payment = await this.locatePayment(event);
    if (!payment || payment.status === 'CONFIRMED') return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        failureReason: 'Payment failed at the gateway',
      },
    });

    // If this was a recurring charge, flag the sponsor.
    if (payment.sponsorshipId) {
      const sponsor = await this.prisma.sponsorProfile.findUnique({
        where: { id: payment.sponsorId },
        include: { user: true },
      });
      if (sponsor) {
        await this.notifications.notify({
          userId: sponsor.userId,
          type: 'RECURRING_FAILED',
          title: 'A recurring gift could not be processed',
          body: 'We could not charge your saved payment method. Please update it to keep your monthly sponsorship active.',
        });
        await this.notifications.sendEmail({
          to: sponsor.user.email,
          template: 'recurring-failed',
          subject: 'Your recurring gift could not be processed',
          data: { name: sponsor.fullName },
        });
      }
    }
  }

  /**
   * Find the payment a webhook refers to — by our metadata paymentId first
   * (exact), then by the gateway's tx id.
   */
  private async locatePayment(event: NormalizedWebhookEvent) {
    const include = { splits: true } satisfies Prisma.PaymentInclude;
    if (event.paymentId) {
      const byId = await this.prisma.payment.findUnique({
        where: { id: event.paymentId },
        include,
      });
      if (byId) return byId;
    }
    return this.prisma.payment.findUnique({
      where: { gatewayTxId: event.gatewayTxId },
      include,
    });
  }

  /** Notify the student + email a receipt to the sponsor after a confirmed gift. */
  private async announceConfirmed(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        sponsor: { include: { user: true } },
        religious: { include: { user: true } },
        splits: { include: { bill: true } },
      },
    });
    if (!payment) return;

    const billNames = payment.splits.map((s) => s.bill.name).join(', ');
    const amount = centsToUnits(payment.amountCents);
    const formatted = `${payment.currency} ${amount.toFixed(2)}`;
    // Anonymity is enforced here too — the student never sees a hidden donor.
    const donorLabel = payment.isAnonymous
      ? 'An anonymous sponsor'
      : payment.sponsor.fullName;

    // 1) In-app notification + email to the student who received the gift.
    await this.notifications.notify({
      userId: payment.religious.userId,
      type: 'PAYMENT_RECEIVED',
      title: 'You received a gift!',
      body: `${donorLabel} gave ${formatted} toward ${billNames}.`,
      meta: { paymentId: payment.id },
    });
    await this.notifications.sendEmail({
      to: payment.religious.user.email,
      template: 'payment-received',
      subject: 'You received a new gift on Vocation Movement',
      data: {
        name: payment.religious.fullName,
        donor: donorLabel,
        amount: formatted,
        billName: billNames,
      },
    });

    // 2) Emailed receipt to the sponsor (if the platform has receipts on).
    const settings = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (settings?.emailReceipts ?? true) {
      await this.notifications.sendEmail({
        to: payment.sponsor.user.email,
        template: 'payment-receipt',
        subject: 'Your Vocation Movement gift receipt',
        data: {
          name: payment.sponsor.fullName,
          amount: formatted,
          studentName: payment.religious.fullName,
          billName: billNames,
          transactionId: payment.gatewayTxId,
          date: (payment.confirmedAt ?? payment.createdAt).toISOString(),
        },
      });
    }
  }

  // ═══════════════════ Recurring-charge worker (PRD §8) ═══════════════════

  /**
   * Charge every ACTIVE sponsorship whose next charge date has arrived.
   *
   * In LIVE mode the gateway drives subscription renewals itself and calls
   * our webhook, so this is a safety sweep that only logs. In STUB mode
   * there is no external scheduler, so we synthesise a signature-verified
   * `subscription.charged` webhook per due sponsorship and run it through
   * the same idempotent path a real callback would — keeping the webhook the
   * single place money moves. Honours the frozen clock via `aggregation.now`.
   */
  async chargeDueRecurring(): Promise<{
    due: number;
    charged: number;
    skipped: number;
  }> {
    const now = this.aggregation.now();
    const due = await this.prisma.sponsorship.findMany({
      where: { status: 'ACTIVE', nextChargeDate: { lte: now } },
    });

    let charged = 0;
    let skipped = 0;
    for (const sub of due) {
      const gw = this.gatewayFor(sub.gateway);
      if (!(gw instanceof StubGateway)) {
        // Live gateway renews on its own schedule — nothing to drive here.
        skipped += 1;
        continue;
      }
      try {
        const { body, signature } = gw.buildTestWebhook({
          type: 'subscription.charged',
          gatewayTxId: `${sub.gateway.toLowerCase()}_recur_${randomUUID()}`,
          sponsorshipId: sub.id,
          amountCents: sub.amountCents,
          currency: sub.currency,
        });
        await this.handleWebhook(sub.gateway, Buffer.from(body), signature);
        charged += 1;
      } catch (err) {
        this.logger.error(
          `Recurring charge failed for sponsorship ${sub.id}`,
          err as Error,
        );
        skipped += 1;
      }
    }

    if (due.length) {
      this.logger.log(
        `Recurring sweep: ${due.length} due, ${charged} charged, ${skipped} skipped`,
      );
    }
    return { due: due.length, charged, skipped };
  }

  // ═══════════════════ Receipt (PRD §4.4) ═══════════════════

  /** GET /api/payments/:id/receipt — owner (sponsor) or admin only. */
  async receipt(user: AuthUser, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        sponsor: { include: { user: true } },
        religious: true,
        splits: { include: { bill: true } },
      },
    });
    if (!payment) {
      throw AppException.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    }

    const isAdmin = user.role === 'ADMIN';
    const isOwner = payment.sponsor.userId === user.userId; // sponsor who paid
    if (!isAdmin && !isOwner) {
      throw AppException.forbidden(
        'You cannot view this receipt',
        'NOT_RECEIPT_OWNER',
      );
    }

    return {
      id: payment.id,
      transactionId: payment.gatewayTxId,
      date: (payment.confirmedAt ?? payment.createdAt).toISOString(),
      status: paymentStatusToApi[payment.status],
      amount: centsToUnits(payment.amountCents),
      currency: payment.currency,
      recurring: payment.isRecurring,
      // The receipt is the sponsor's own record, so they always see their name;
      // anonymity only hides the donor from the student/public.
      donorName: resolveDonorName(
        payment.isAnonymous,
        payment.sponsor.fullName,
        isAdmin || isOwner,
      ),
      anonymous: payment.isAnonymous,
      studentName: payment.religious.fullName,
      congregation: payment.religious.congregationName,
      items: payment.splits.map((s) => ({
        billName: s.bill.name,
        amount: centsToUnits(s.amountCents),
      })),
      organizationName: 'Vocation Movement',
    };
  }
}
