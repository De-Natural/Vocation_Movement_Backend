import { Body, Controller, Delete, Param, Patch } from '@nestjs/common';
import { SponsorsService } from './sponsors.service';
import { ok } from '../common/http/response';
import { Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';

/**
 * Dedicated controller for recurring sponsorship lifecycle endpoints:
 * PATCH /api/recurring/:id (pause/resume)
 * DELETE /api/recurring/:id (cancel)
 */
@Roles('SPONSOR')
@Controller('recurring')
export class RecurringController {
  constructor(private readonly sponsors: SponsorsService) {}

  // PATCH /api/recurring/:id — toggle or set pause/resume
  @Patch(':id')
  async updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body?: { status?: string; paused?: boolean; action?: string },
  ) {
    let shouldPause = true;
    if (body) {
      if (
        body.action === 'resume' ||
        body.status?.toLowerCase() === 'active' ||
        body.paused === false
      ) {
        shouldPause = false;
      }
    }
    const sub = await this.sponsors.setPaused(user.userId, id, shouldPause);
    return ok(
      sub,
      shouldPause ? 'Recurring gift paused. You can resume anytime.' : 'Recurring gift resumed.',
    );
  }

  // PATCH /api/recurring/:id/pause — explicit pause
  @Patch(':id/pause')
  async pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const sub = await this.sponsors.setPaused(user.userId, id, true);
    return ok(sub, 'Recurring gift paused. You can resume anytime.');
  }

  // PATCH /api/recurring/:id/resume — explicit resume
  @Patch(':id/resume')
  async resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const sub = await this.sponsors.setPaused(user.userId, id, false);
    return ok(sub, 'Recurring gift resumed.');
  }

  // DELETE /api/recurring/:id — cancel
  @Delete(':id')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const res = await this.sponsors.cancelRecurring(user.userId, id);
    return ok(res, 'Recurring gift cancelled.');
  }
}

