/**
 * Typed application configuration, loaded once at boot from env vars.
 * Validates required values and, in development, auto-generates an
 * ephemeral RS256 keypair when JWT keys are not supplied.
 */
import { generateKeyPairSync } from 'crypto';

export type ProviderMode = 'stub' | 'live';

export interface AppConfig {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  frontendUrl: string;
  apiUrl: string;

  databaseUrl: string;
  redisUrl: string;

  jwt: {
    privateKey: string;
    publicKey: string;
    accessTtl: string; // e.g. "15m"
    refreshTtlSeconds: number;
  };

  providerMode: ProviderMode;

  stripe: { secretKey: string; webhookSecret: string };
  paystack: { secretKey: string; webhookSecret: string };
  aws: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region: string;
  };
  cloudinaryUrl: string;
  email: { resendApiKey: string; from: string };

  defaults: {
    currency: string;
    minGiftCents: number;
    platformFeePercent: number;
  };

  /**
   * Optional frozen "now". The seed data and the frontend treat
   * 2026-08-18 as the present, so overdue-bill logic must reckon against
   * the same instant to stay consistent in the demo. When null the real
   * system clock is used. Token expiry always uses the real clock.
   */
  clock: { nowOverride: Date | null };

  seedAdmin: { email: string; password: string };
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Decode a key that may be provided with escaped newlines on one line. */
function decodeKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  // ─── JWT keys ───
  let privateKey = process.env.JWT_PRIVATE_KEY
    ? decodeKey(process.env.JWT_PRIVATE_KEY)
    : '';
  let publicKey = process.env.JWT_PUBLIC_KEY
    ? decodeKey(process.env.JWT_PUBLIC_KEY)
    : '';

  if (!privateKey || !publicKey) {
    if (isProd) {
      throw new Error(
        'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production.',
      );
    }
    // Dev convenience: generate an ephemeral RS256 pair (rotates each boot).
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    // eslint-disable-next-line no-console
    console.warn(
      '⚠  JWT keys not set — generated an ephemeral RS256 keypair (dev only). ' +
        'Tokens will invalidate on restart.',
    );
  }

  const providerMode: ProviderMode =
    process.env.PROVIDER_MODE === 'live' ? 'live' : 'stub';

  cached = {
    nodeEnv,
    isProd,
    port: parseInt(process.env.PORT ?? '4000', 10),
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    apiUrl: process.env.API_URL ?? 'http://localhost:4000',

    databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

    jwt: {
      privateKey,
      publicKey,
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTtlSeconds: parseInt(
        process.env.JWT_REFRESH_TTL_SECONDS ?? '604800',
        10,
      ),
    },

    providerMode,

    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    },
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
      webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? '',
    },
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      bucket: process.env.AWS_S3_BUCKET ?? '',
      region: process.env.AWS_REGION ?? 'us-east-1',
    },
    cloudinaryUrl: process.env.CLOUDINARY_URL ?? '',
    email: {
      resendApiKey: process.env.RESEND_API_KEY ?? '',
      from:
        process.env.EMAIL_FROM ??
        'Vocation Movement <no-reply@vocationmovement.org>',
    },

    defaults: {
      currency: process.env.DEFAULT_CURRENCY ?? 'USD',
      minGiftCents: parseInt(process.env.MIN_GIFT_CENTS ?? '100', 10),
      platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0'),
    },

    clock: {
      nowOverride: process.env.NOW_OVERRIDE
        ? new Date(process.env.NOW_OVERRIDE)
        : null,
    },

    seedAdmin: {
      email: process.env.SEED_ADMIN_EMAIL ?? 'admin@vocationmovement.org',
      password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!Admin123',
    },
  };

  return cached;
}

/** Injection token for the loaded config. */
export const APP_CONFIG = 'APP_CONFIG';
