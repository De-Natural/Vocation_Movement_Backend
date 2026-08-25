import { Module } from '@nestjs/common';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';

/**
 * Inquiries module — ARCHITECTURE §7.7.
 *
 * Public contact-form submissions (rate-limited by IP) land in an admin
 * inbox; the support team is emailed on each new message. Admins can mark
 * inquiries read and delete them, with deletes recorded in the audit log.
 */
@Module({
  controllers: [InquiriesController],
  providers: [InquiriesService],
  exports: [InquiriesService],
})
export class InquiriesModule {}
