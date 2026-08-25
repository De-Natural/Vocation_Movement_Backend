import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/configuration';

/**
 * Application entrypoint (PRD §9).
 *
 * Notable bootstrap choices:
 *  - `rawBody: true` — the payment webhook controller verifies gateway
 *    signatures against the exact bytes received, so it needs `req.rawBody`.
 *  - Static `/storage` handler — the local-disk upload stub serves files from
 *    ./storage; this route sits OUTSIDE the `/api` prefix, matching the URLs
 *    the storage provider hands back.
 *  - Global guards / interceptor / filter are registered inside AppModule via
 *    APP_GUARD / APP_INTERCEPTOR / APP_FILTER, so they are NOT re-registered
 *    here (doing so would run them twice).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = new Logger('Bootstrap');

  // Security headers. crossOriginResourcePolicy is relaxed so the frontend
  // (a different origin) can load uploaded images served from /storage.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Signed refresh-token cookies are httpOnly; the parser reads them back.
  app.use(cookieParser());

  // The SPA calls the API from its own origin with credentials (refresh cookie).
  app.enableCors({
    origin: config.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Serve locally-stored uploads (dev/stub storage) at /storage/*.
  app.useStaticAssets(join(process.cwd(), 'storage'), { prefix: '/storage/' });

  // A defensive body-size / DTO guard for any class-validator DTOs; Zod pipes
  // handle their own routes, so this is a harmless global backstop.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );

  // Every controller route lives under /api; /storage above is unaffected.
  app.setGlobalPrefix('api');

  await app.listen(config.port);
  logger.log(`API listening on ${config.apiUrl} (prefix /api)`);
  logger.log(
    `Provider mode: ${config.providerMode.toUpperCase()} · env: ${config.nodeEnv}`,
  );
  if (config.clock.nowOverride) {
    logger.warn(
      `Clock frozen at ${config.clock.nowOverride.toISOString()} (NOW_OVERRIDE)`,
    );
  }
}

void bootstrap();
