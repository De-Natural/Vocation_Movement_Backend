import { Module } from '@nestjs/common';
import { ReligiousController } from './religious.controller';
import { ReligiousService } from './religious.service';

/**
 * Religious (student) module — PRD 3.2 / ARCHITECTURE §7.2, §7.8.
 * Public browse & profile reads + the student's own profile, photo,
 * verification-doc uploads, dashboard, and received payments.
 *
 * Depends on the global Prisma/Uploads/Aggregation/Notifications modules.
 */
@Module({
  controllers: [ReligiousController],
  providers: [ReligiousService],
  exports: [ReligiousService],
})
export class ReligiousModule {}
