import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { FxRatesService } from './fx-rates.service';

/**
 * Global settings module. Exposes the shared {@link SettingsService} reader
 * (the effective platform settings + the Fee Model A math) so payments, auth
 * and the maintenance guard can inject it without importing the module. The
 * admin module keeps its own upsert writer for `PATCH /admin/settings`.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, FxRatesService],
  exports: [SettingsService, FxRatesService],
})
export class SettingsModule {}
