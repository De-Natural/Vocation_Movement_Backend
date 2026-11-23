import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { STORAGE_PROVIDER } from './storage/storage.interface';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { EMAIL_PROVIDER } from './email/email.interface';
import { StubEmailProvider } from './email/stub-email.provider';
import { SmtpEmailProvider } from './email/smtp-email.provider';
import { SMS_PROVIDER } from './sms/sms.interface';
import { TermiiSmsProvider } from './sms/termii-sms.provider';
import { StubSmsProvider } from './sms/stub-sms.provider';
import { PAYOUT_PROVIDER } from './payouts/payout.interface';
import { PaystackPayoutProvider } from './payouts/paystack-payout.provider';
import { StubPayoutProvider } from './payouts/stub-payout.provider';
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
      useFactory: (config: AppConfig) => {
        // Real email as soon as SMTP is configured (independent of PROVIDER_MODE).
        if (config.email.smtp.host) {
          return new SmtpEmailProvider(config.email.smtp, config.email.from);
        }
        return new StubEmailProvider();
      },
    },
    {
      provide: SMS_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.sms.termiiApiKey
          ? new TermiiSmsProvider(config.sms.termiiApiKey, config.sms.termiiSenderId, config.sms.termiiChannel)
          : new StubSmsProvider(),
    },
    {
      provide: PAYOUT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        // Real money only when explicitly switched on.
        config.payouts.live && config.paystack.secretKey
          ? new PaystackPayoutProvider(config.paystack.secretKey)
          : new StubPayoutProvider(),
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
  exports: [
    STORAGE_PROVIDER,
    EMAIL_PROVIDER,
    SMS_PROVIDER,
    PAYOUT_PROVIDER,
    STRIPE_GATEWAY,
    PAYSTACK_GATEWAY,
  ],
})
export class ProvidersModule {}
