import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, loadConfig } from './configuration';

/**
 * Global config module. Exposes the fully-typed AppConfig via the
 * APP_CONFIG token so any provider can inject it.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
