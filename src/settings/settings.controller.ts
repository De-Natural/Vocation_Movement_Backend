import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/auth/decorators';
import { centsToUnits } from '../common/serializers';
import { SettingsService } from './settings.service';

/**
 * GET /api/settings/public — the settings the public site needs before
 * anyone signs in: whether the platform is in maintenance, the minimum gift,
 * and the default anonymity for gifts. Reachable during maintenance.
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get('public')
  async publicSettings() {
    const s = await this.settings.effective();
    return {
      organizationName: s.organizationName,
      supportEmail: s.supportEmail,
      currency: s.defaultCurrency,
      maintenanceMode: s.maintenanceMode,
      minGift: centsToUnits(s.minGiftCents),
      anonymousDefault: s.anonymousDefault,
      platformFeePercent: s.platformFeePercent,
    };
  }
}
