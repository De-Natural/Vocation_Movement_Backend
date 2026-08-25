import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { InquiriesService } from './inquiries.service';
import { ok } from '../common/http/response';
import { Roles, Public, CurrentUser, RateLimit } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  createInquirySchema,
  CreateInquiryInput,
  listInquiriesQuerySchema,
  ListInquiriesQuery,
} from './inquiries.dto';

/**
 * Contact inquiry endpoints (ARCHITECTURE §7.7).
 * Submission is public (rate-limited by IP to deter spam); the inbox and its
 * management actions are admin-only.
 */
@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  // POST /api/inquiries — public contact form submission
  @Public()
  @RateLimit({ limit: 5, windowSeconds: 3600, by: 'ip', name: 'inquiry' })
  @Post()
  async create(
    @Body(new ZodValidationPipe(createInquirySchema)) dto: CreateInquiryInput,
  ) {
    const inquiry = await this.inquiries.create(dto);
    return ok(
      inquiry,
      'Thank you for reaching out. Your message has been sent to our team.',
    );
  }

  // GET /api/inquiries?filter= — admin inbox
  @Roles('ADMIN')
  @Get()
  async list(
    @Query(new ZodValidationPipe(listInquiriesQuerySchema))
    query: ListInquiriesQuery,
  ) {
    const { inquiries, total, unread } = await this.inquiries.list(query);
    return ok(inquiries, undefined, { total, unread });
  }

  // PATCH /api/inquiries/:id/read — admin marks an inquiry read
  @Roles('ADMIN')
  @Patch(':id/read')
  async markRead(@Param('id') id: string) {
    return ok(await this.inquiries.markRead(id));
  }

  // DELETE /api/inquiries/:id — admin deletes an inquiry (audit-logged)
  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    const res = await this.inquiries.remove(admin.userId, id);
    return ok(res, 'Inquiry deleted.');
  }
}
