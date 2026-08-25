import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { ok } from '../common/http/response';
import { Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  rejectSchema,
  RejectInput,
  requestInfoSchema,
  RequestInfoInput,
  suspendSchema,
  SuspendInput,
  transactionsQuerySchema,
  TransactionsQuery,
  verificationsQuerySchema,
  VerificationsQuery,
  updateSettingsSchema,
  UpdateSettingsInput,
  generateReportSchema,
  GenerateReportInput,
} from './admin.dto';

// Every route here is admin-only.
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // GET /api/admin/kpis — overview dashboard metrics
  @Get('kpis')
  async kpis() {
    return ok(await this.admin.kpis());
  }

  // GET /api/admin/overview — alias the frontend overview page can call
  @Get('overview')
  async overview() {
    return ok(await this.admin.kpis());
  }

  // GET /api/admin/pending — pending verification queue + count
  @Get('pending')
  async pending() {
    return ok(await this.admin.pending());
  }

  // GET /api/admin/verifications?status=
  @Get('verifications')
  async verifications(
    @Query(new ZodValidationPipe(verificationsQuerySchema))
    query: VerificationsQuery,
  ) {
    const students = await this.admin.verificationQueue(query.status);
    return ok(students);
  }

  // POST /api/admin/verify/:id
  @Post('verify/:id')
  async verify(@CurrentUser() admin: AuthUser, @Param('id') religiousId: string) {
    const res = await this.admin.verify(admin.userId, religiousId);
    return ok(res, 'Profile verified and now visible to sponsors');
  }

  // POST /api/admin/reject/:id
  @Post('reject/:id')
  async reject(
    @CurrentUser() admin: AuthUser,
    @Param('id') religiousId: string,
    @Body(new ZodValidationPipe(rejectSchema)) dto: RejectInput,
  ) {
    const res = await this.admin.reject(admin.userId, religiousId, dto.reason);
    return ok(res, 'Profile rejected — the student has been notified');
  }

  // POST /api/admin/request-info/:id
  @Post('request-info/:id')
  async requestInfo(
    @CurrentUser() admin: AuthUser,
    @Param('id') religiousId: string,
    @Body(new ZodValidationPipe(requestInfoSchema)) dto: RequestInfoInput,
  ) {
    const res = await this.admin.requestInfo(admin.userId, religiousId, dto.reason);
    return ok(res, 'Information request sent to the student');
  }

  // POST /api/admin/suspend/:userId
  @Post('suspend/:userId')
  async suspend(
    @CurrentUser() admin: AuthUser,
    @Param('userId') targetUserId: string,
    @Body(new ZodValidationPipe(suspendSchema)) dto: SuspendInput,
  ) {
    const res = await this.admin.suspend(admin.userId, targetUserId, dto.reason);
    return ok(res, 'Account suspended');
  }

  // GET /api/admin/transactions?filters
  @Get('transactions')
  async transactions(
    @Query(new ZodValidationPipe(transactionsQuerySchema))
    query: TransactionsQuery,
  ) {
    const { rows, totalAmount, meta } = await this.admin.transactions(query);
    return ok({ transactions: rows, totalAmount }, undefined, meta);
  }

  // GET /api/admin/reports
  @Get('reports')
  async reports() {
    return ok(await this.admin.reports());
  }

  // POST /api/admin/reports — generate a report
  @Post('reports')
  async generateReport(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodValidationPipe(generateReportSchema)) dto: GenerateReportInput,
  ) {
    const res = await this.admin.generateReport(admin.userId, dto);
    return ok(res, 'Report generated');
  }

  // GET /api/admin/settings
  @Get('settings')
  async getSettings() {
    return ok(await this.admin.getSettings());
  }

  // PATCH /api/admin/settings
  @Patch('settings')
  async updateSettings(
    @CurrentUser() admin: AuthUser,
    @Body(new ZodValidationPipe(updateSettingsSchema)) dto: UpdateSettingsInput,
  ) {
    const res = await this.admin.updateSettings(admin.userId, dto);
    return ok(res, 'Platform settings saved');
  }
}
