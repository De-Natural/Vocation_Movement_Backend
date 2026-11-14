import { Module } from '@nestjs/common';
import { SuperAdminController } from './superadmin.controller';
import { SuperAdminService } from './superadmin.service';

/**
 * Super-Admin oversight — staff management (create / suspend / delete
 * admins), a directory of every student & sponsor, and the audit log.
 * Every route is @Roles('SUPERADMIN'); SUPERADMIN also inherits every
 * @Roles('ADMIN') route through the RolesGuard.
 */
@Module({
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
})
export class SuperAdminModule {}
