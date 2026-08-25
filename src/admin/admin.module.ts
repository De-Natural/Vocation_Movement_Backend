import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Admin module — PRD 3.7 / ARCHITECTURE §7.5, §7.8, §7.9.
 * Verification workflow (with audit trail + student emails), global
 * transaction feed, platform KPIs, user suspension, settings, and
 * congregation reports. Every route is @Roles('ADMIN').
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
