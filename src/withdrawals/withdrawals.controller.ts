import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { WithdrawalsService } from './withdrawals.service';
import { ok } from '../common/http/response';
import { CurrentUser, Public, RateLimit, Roles } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AppException } from '../common/http/app-exception';
import {
  AccountInput,
  accountSchema,
  CodeInput,
  codeSchema,
  SendPhoneOtpInput,
  sendPhoneOtpSchema,
  StartWithdrawalInput,
  startWithdrawalSchema,
} from './withdrawals.dto';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  // GET /api/withdrawals/me — balance, phone, bank account, recent withdrawals
  @Roles('RELIGIOUS')
  @Get('me')
  async summary(@CurrentUser() user: AuthUser) {
    return ok(await this.withdrawals.summary(user.userId));
  }

  // GET /api/withdrawals/me/history?page=&perPage=
  @Roles('RELIGIOUS')
  @Get('me/history')
  async history(@CurrentUser() user: AuthUser, @Query('page') page?: string, @Query('perPage') perPage?: string) {
    const { items, meta } = await this.withdrawals.history(user.userId, page, perPage);
    return ok(items, undefined, meta);
  }

  // POST /api/withdrawals/phone/send-otp { phone }
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 5, windowSeconds: 3600, by: 'user', name: 'phone-otp' })
  @Post('phone/send-otp')
  async sendPhoneOtp(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(sendPhoneOtpSchema)) dto: SendPhoneOtpInput) {
    return ok(await this.withdrawals.sendPhoneOtp(user.userId, dto.phone), 'Code sent');
  }

  // POST /api/withdrawals/phone/verify { code }
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 15, windowSeconds: 900, by: 'user', name: 'phone-verify' })
  @Post('phone/verify')
  async verifyPhone(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(codeSchema)) dto: CodeInput) {
    return ok(await this.withdrawals.verifyPhone(user.userId, dto.code), 'Phone number verified');
  }

  // GET /api/withdrawals/banks
  @Roles('RELIGIOUS')
  @Get('banks')
  async banks() {
    return ok(await this.withdrawals.banks());
  }

  // POST /api/withdrawals/account/resolve { bankCode, accountNumber } — preview the account name
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 20, windowSeconds: 3600, by: 'user', name: 'account-resolve' })
  @Post('account/resolve')
  async resolve(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(accountSchema)) dto: AccountInput) {
    return ok(await this.withdrawals.resolveAccount(user.userId, dto.bankCode, dto.accountNumber));
  }

  // POST /api/withdrawals/account { bankCode, accountNumber } — texts a code to the verified phone
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 5, windowSeconds: 3600, by: 'user', name: 'account-change' })
  @Post('account')
  async requestAccount(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(accountSchema)) dto: AccountInput) {
    return ok(await this.withdrawals.requestAccountChange(user.userId, dto.bankCode, dto.accountNumber), 'Code sent');
  }

  // POST /api/withdrawals/account/confirm { code }
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 15, windowSeconds: 900, by: 'user', name: 'account-confirm' })
  @Post('account/confirm')
  async confirmAccount(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(codeSchema)) dto: CodeInput) {
    return ok(await this.withdrawals.confirmAccountChange(user.userId, dto.code), 'Bank account saved');
  }

  // POST /api/withdrawals { amount } — texts a code to confirm
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 10, windowSeconds: 3600, by: 'user', name: 'withdraw-start' })
  @Post()
  async start(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(startWithdrawalSchema)) dto: StartWithdrawalInput) {
    return ok(await this.withdrawals.start(user.userId, dto.amount), 'Code sent');
  }

  // POST /api/withdrawals/:id/confirm { code } — sends the money
  @Roles('RELIGIOUS')
  @RateLimit({ limit: 15, windowSeconds: 900, by: 'user', name: 'withdraw-confirm' })
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(codeSchema)) dto: CodeInput,
  ) {
    return ok(await this.withdrawals.confirm(user.userId, id, dto.code));
  }

  // GET /api/withdrawals/admin?status=&page= — all withdrawals (admins)
  @Roles('ADMIN')
  @Get('admin')
  async adminList(@Query('page') page?: string, @Query('perPage') perPage?: string, @Query('status') status?: string) {
    const { items, meta, totals, liveTransfers } = await this.withdrawals.adminList(page, perPage, status);
    return ok({ items, totals, liveTransfers }, undefined, meta);
  }

  // POST /api/withdrawals/webhooks/paystack — transfer.success / failed / reversed
  @Public()
  @Post('webhooks/paystack')
  async paystackWebhook(@Req() req: RawBodyRequest, @Headers('x-paystack-signature') signature?: string) {
    if (!req.rawBody) throw AppException.badRequest('Missing body', 'NO_BODY');
    return this.withdrawals.handlePaystackWebhook(req.rawBody, signature);
  }
}
