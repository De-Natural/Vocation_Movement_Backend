import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { ok } from '../common/http/response';
import { Public, Roles, CurrentUser, RateLimit } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { AppException } from '../common/http/app-exception';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  createIntentSchema,
  CreateIntentInputDto,
  confirmSchema,
  ConfirmInputDto,
  recurringSchema,
  RecurringInputDto,
} from './payments.dto';

/** Express request that carries the raw body (NestFactory rawBody:true). */
type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // POST /api/payments/intent — start a one-time gift (sponsor only)
  @Roles('SPONSOR')
  @RateLimit({ limit: 30, windowSeconds: 3600, by: 'user', name: 'payment-intent' })
  @Post('intent')
  async createIntent(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createIntentSchema)) dto: CreateIntentInputDto,
  ) {
    const res = await this.payments.createIntent(user.userId, dto);
    return ok(res, 'Payment initiated — complete it with your card');
  }

  // POST /api/payments/confirm — finalise a collected gift (sponsor only)
  @Roles('SPONSOR')
  @Post('confirm')
  async confirm(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(confirmSchema)) dto: ConfirmInputDto,
  ) {
    const res = await this.payments.confirm(user.userId, dto);
    return ok(res);
  }

  // POST /api/payments/recurring — start a monthly sponsorship (sponsor only)
  @Roles('SPONSOR')
  @RateLimit({ limit: 20, windowSeconds: 3600, by: 'user', name: 'payment-recurring' })
  @Post('recurring')
  async recurring(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(recurringSchema)) dto: RecurringInputDto,
  ) {
    const res = await this.payments.createRecurring(user.userId, dto);
    return ok(res, 'Monthly sponsorship started — thank you!');
  }

  // GET /api/payments/:id/receipt — sponsor (owner) or admin
  @Get(':id/receipt')
  async receipt(@CurrentUser() user: AuthUser, @Param('id') paymentId: string) {
    const res = await this.payments.receipt(user, paymentId);
    return ok(res);
  }

  // ─────────────────── Webhooks (public, signature-verified) ───────────────────

  // POST /api/payments/webhooks/stripe
  @Public()
  @Post('webhooks/stripe')
  async stripeWebhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature?: string,
  ) {
    const raw = this.requireRawBody(req);
    const res = await this.payments.handleWebhook('STRIPE', raw, signature ?? '');
    return res;
  }

  // POST /api/payments/webhooks/paystack
  @Public()
  @Post('webhooks/paystack')
  async paystackWebhook(
    @Req() req: RawBodyRequest,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    const raw = this.requireRawBody(req);
    const res = await this.payments.handleWebhook('PAYSTACK', raw, signature ?? '');
    return res;
  }

  /** The raw request body is required to verify a gateway signature (PRD §5.2). */
  private requireRawBody(req: RawBodyRequest): Buffer {
    if (!req.rawBody || req.rawBody.length === 0) {
      throw AppException.badRequest(
        'Missing raw request body for webhook verification',
        'MISSING_RAW_BODY',
      );
    }
    return req.rawBody;
  }
}
