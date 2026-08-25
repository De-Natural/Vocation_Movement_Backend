import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SponsorsService } from './sponsors.service';
import { ok } from '../common/http/response';
import { Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  upsertSponsorProfileSchema,
  UpsertSponsorProfileInput,
  sentPaymentsQuerySchema,
  SentPaymentsQuery,
} from './sponsors.dto';

// Every sponsor route is authenticated as a SPONSOR.
@Roles('SPONSOR')
@Controller('sponsors')
export class SponsorsController {
  constructor(private readonly sponsors: SponsorsService) {}

  // GET /api/sponsors/me — own profile + derived aggregates
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return ok(await this.sponsors.getOwnProfile(user.userId));
  }

  // GET /api/sponsors/me/dashboard — giving KPIs, my students, recent gifts
  @Get('me/dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    return ok(await this.sponsors.dashboard(user.userId));
  }

  // GET /api/sponsors/me/students — students this sponsor has funded
  @Get('me/students')
  async students(@CurrentUser() user: AuthUser) {
    return ok(await this.sponsors.myStudents(user.userId));
  }

  // GET /api/sponsors/me/payments — giving history (filterable, paginated)
  @Get('me/payments')
  async payments(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(sentPaymentsQuerySchema))
    query: SentPaymentsQuery,
  ) {
    const { rows, meta } = await this.sponsors.sentPayments(user.userId, query);
    return ok(rows, undefined, meta);
  }

  // GET /api/sponsors/me/recurring — monthly gifts
  @Get('me/recurring')
  async recurring(@CurrentUser() user: AuthUser) {
    return ok(await this.sponsors.recurring(user.userId));
  }

  // POST /api/sponsors/profile — create/update own profile
  @Post('profile')
  async upsertProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(upsertSponsorProfileSchema))
    dto: UpsertSponsorProfileInput,
  ) {
    const sponsor = await this.sponsors.upsertOwnProfile(user.userId, dto);
    return ok(sponsor, 'Profile saved');
  }

  // PATCH /api/sponsors/profile — alias for partial edits
  @Patch('profile')
  async patchProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(upsertSponsorProfileSchema))
    dto: UpsertSponsorProfileInput,
  ) {
    const sponsor = await this.sponsors.upsertOwnProfile(user.userId, dto);
    return ok(sponsor, 'Profile updated');
  }

  // PATCH /api/sponsors/me/recurring/:id/pause — pause a monthly gift
  @Patch('me/recurring/:id/pause')
  async pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const sub = await this.sponsors.setPaused(user.userId, id, true);
    return ok(sub, 'Recurring gift paused. You can resume anytime.');
  }

  // PATCH /api/sponsors/me/recurring/:id/resume — resume a monthly gift
  @Patch('me/recurring/:id/resume')
  async resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const sub = await this.sponsors.setPaused(user.userId, id, false);
    return ok(sub, 'Recurring gift resumed.');
  }

  // DELETE /api/sponsors/me/recurring/:id — cancel a monthly gift
  @Delete('me/recurring/:id')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const res = await this.sponsors.cancelRecurring(user.userId, id);
    return ok(res, 'Recurring gift cancelled.');
  }
}
