import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

// Infrastructure (all @Global)
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ProvidersModule } from './providers/providers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UploadsModule } from './uploads/uploads.module';
import { AggregationModule } from './aggregation/aggregation.module';
import { SettingsModule } from './settings/settings.module';

// Feature modules
import { AuthModule } from './auth/auth.module';
import { ReligiousModule } from './religious/religious.module';
import { BillsModule } from './bills/bills.module';
import { AdminModule } from './admin/admin.module';
import { PaymentsModule } from './payments/payments.module';
import { SponsorsModule } from './sponsors/sponsors.module';
import { MessagesModule } from './messages/messages.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { JobsModule } from './jobs/jobs.module';

// Global guards / interceptor / filter
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { RateLimitGuard } from './common/auth/rate-limit.guard';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';

/**
 * Root module — wires the whole application.
 *
 * The three global guards run in the order they are registered:
 *   1. JwtAuthGuard   — authenticates the Bearer token (skips @Public)
 *   2. RolesGuard     — enforces @Roles(...) role checks
 *   3. RateLimitGuard — applies @RateLimit(...) Redis counters
 * The ResponseInterceptor wraps every result in the success envelope and
 * the AllExceptionsFilter renders every error into the error envelope.
 *
 * ScheduleModule.forRoot() activates the @Cron sweeps declared in JobsService
 * (overdue bills, token cleanup, recurring charges).
 */
@Module({
  imports: [
    // Infrastructure
    ConfigModule,
    PrismaModule,
    RedisModule,
    ProvidersModule,
    NotificationsModule,
    UploadsModule,
    AggregationModule,
    SettingsModule,
    ScheduleModule.forRoot(),

    // Features
    AuthModule,
    ReligiousModule,
    BillsModule,
    AdminModule,
    PaymentsModule,
    SponsorsModule,
    MessagesModule,
    InquiriesModule,
    JobsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
