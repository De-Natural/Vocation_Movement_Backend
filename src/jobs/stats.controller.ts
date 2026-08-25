import { Controller, Get } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { ok } from '../common/http/response';
import { Public } from '../common';

/**
 * Public platform statistics (ARCHITECTURE PlatformStats). Feeds the
 * marketing homepage headline numbers; no authentication required.
 */
@Controller('stats')
export class StatsController {
  constructor(private readonly jobs: JobsService) {}

  // GET /api/stats/platform — live headline totals
  @Public()
  @Get('platform')
  async platform() {
    return ok(await this.jobs.platformStats());
  }
}
