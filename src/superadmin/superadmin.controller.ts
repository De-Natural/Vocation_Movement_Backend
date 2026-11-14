import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ok } from '../common/http/response';
import { Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SuperAdminService } from './superadmin.service';
import {
  activityQuerySchema,
  ActivityQuery,
  createAdminSchema,
  CreateAdminInput,
  reasonSchema,
  ReasonInput,
  usersQuerySchema,
  UsersQuery,
} from './superadmin.dto';

// SUPERADMIN only — plain ADMINs are refused by the RolesGuard.
@Roles('SUPERADMIN')
@Controller('superadmin')
export class SuperAdminController {
  constructor(private readonly sa: SuperAdminService) {}

  // GET /api/superadmin/overview
  @Get('overview')
  async overview() {
    return ok(await this.sa.overview());
  }

  // GET /api/superadmin/admins
  @Get('admins')
  async admins() {
    return ok(await this.sa.listStaff());
  }

  // POST /api/superadmin/admins
  @Post('admins')
  async createAdmin(
    @CurrentUser() me: AuthUser,
    @Body(new ZodValidationPipe(createAdminSchema)) dto: CreateAdminInput,
  ) {
    return ok(await this.sa.createAdmin(me.userId, dto), 'Admin account created');
  }

  // PATCH /api/superadmin/admins/:id/suspend
  @Patch('admins/:id/suspend')
  async suspendAdmin(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) dto: ReasonInput,
  ) {
    return ok(await this.sa.setAdminSuspended(me.userId, id, true, dto.reason), 'Admin suspended');
  }

  // PATCH /api/superadmin/admins/:id/reactivate
  @Patch('admins/:id/reactivate')
  async reactivateAdmin(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) dto: ReasonInput,
  ) {
    return ok(
      await this.sa.setAdminSuspended(me.userId, id, false, dto.reason),
      'Admin reactivated',
    );
  }

  // DELETE /api/superadmin/admins/:id   body: { reason }
  @Delete('admins/:id')
  async deleteAdmin(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) dto: ReasonInput,
  ) {
    return ok(await this.sa.deleteAdmin(me.userId, id, dto.reason), 'Admin deleted');
  }

  // GET /api/superadmin/users?role=&status=&search=&page=
  @Get('users')
  async users(@Query(new ZodValidationPipe(usersQuerySchema)) query: UsersQuery) {
    const { rows, meta } = await this.sa.listUsers(query);
    return ok(rows, undefined, meta);
  }

  // PATCH /api/superadmin/users/:id/reactivate
  @Patch('users/:id/reactivate')
  async reactivateUser(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reasonSchema)) dto: ReasonInput,
  ) {
    return ok(await this.sa.reactivateUser(me.userId, id, dto.reason), 'Account reactivated');
  }

  // GET /api/superadmin/activity?actorId=&page=
  @Get('activity')
  async activity(@Query(new ZodValidationPipe(activityQuerySchema)) query: ActivityQuery) {
    const { rows, meta } = await this.sa.activity(query);
    return ok(rows, undefined, meta);
  }
}
