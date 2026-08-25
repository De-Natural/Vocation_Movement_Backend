import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { STORAGE_PROVIDER } from './storage/storage.interface';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { EMAIL_PROVIDER } from './email/email.interface';
import { StubEmailProvider } from './email/stub-email.provider';
import {
  PAYSTACK_GATEWAY,
  STRIPE_GATEWAY,
} from './payments/gateway.interface';
import { StubGateway } from './payments/stub-gateway.provider';

/**
 * Global providers module — binds each external-service interface to a
 * concrete implementation based on PROVIDER_MODE.
 *
 *   stub → local disk, logged emails, simulated gateways (no accounts)
 *   live → real SDK adapters (wire in when keys are supplied)
 *
 * To go live: implement S3StorageProvider / CloudinaryProvider,
 * ResendEmailProvider, StripeGateway, PaystackGateway and select them
 * here when config.providerMode === 'live'.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        // if (config.providerMode === 'live') return new S3/CloudinaryProvider(config);
        return new LocalStorageProvider(config.apiUrl);
      },
    },
    {
      provide: EMAIL_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (_config: AppConfig) => {
        // if (config.providerMode === 'live') return new ResendEmailProvider(config);
        return new StubEmailProvider();
      },
    },
    {
      provide: STRIPE_GATEWAY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        // if (config.providerMode === 'live') return new StripeGateway(config);
        return new StubGateway(
          'STRIPE',
          config.stripe.webhookSecret || 'stub-webhook-secret',
        );
      },
    },
    {
      provide: PAYSTACK_GATEWAY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        // if (config.providerMode === 'live') return new PaystackGateway(config);
        return new StubGateway(
          'PAYSTACK',
          config.paystack.webhookSecret || 'stub-webhook-secret',
        );
      },
    },
  ],
  exports: [STORAGE_PROVIDER, EMAIL_PROVIDER, STRIPE_GATEWAY, PAYSTACK_GATEWAY],
})
export class ProvidersModule {}
